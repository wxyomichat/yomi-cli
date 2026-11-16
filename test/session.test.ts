import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ApiError, Gateway, NotSignedIn, refreshLockPath } from '../src/core/api.js';
import {
  asciiJson,
  type Credential,
  FileStore,
  KeychainStore,
  keychainOutput,
} from '../src/core/credentials.js';
import { resolveEnvironment } from '../src/core/env.js';
import { acquireProcessLock, withFileLock } from '../src/core/lock.js';

/**
 * The session across processes: the refresh lock, adopting a pair another process stored, signing
 * out only when the refresh token itself is refused, and keychain values that read back intact.
 */

const env = { ...resolveEnvironment({}, {}), apiOrigin: 'https://gateway.example.test' };

const credential = (patch: Partial<Credential> = {}): Credential => ({
  version: 1,
  env: 'test',
  apiOrigin: env.apiOrigin,
  userId: '7300000000000000101',
  deviceId: '42',
  authToken: 'at_0',
  refreshToken: 'rt_0',
  email: 'lin@example.com',
  displayName: '林夏',
  createdAt: 0,
  refreshedAt: 0,
  ...patch,
});

const tempDir = () => mkdtempSync(join(tmpdir(), 'yomi-session-'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A gateway that rotates both tokens on every refresh and refuses a refresh token once used,
 * like the account service: the second trader of the same token loses.
 */
function rotatingGateway(options: { refreshDelayMs?: number; failRefresh?: () => Response } = {}) {
  let generation = 0;
  const validAuth = new Set(['at_0']);
  let validRefresh = 'rt_0';
  const refreshCalls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('refresh_auth_token')) {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      refreshCalls.push(body.refresh_token);
      await sleep(options.refreshDelayMs ?? 0);
      if (options.failRefresh) return options.failRefresh();
      if (body.refresh_token !== validRefresh)
        return new Response('{"base_resp":{"status_code":1101010111,"status_msg":"expired"}}');
      generation += 1;
      validAuth.clear();
      validAuth.add(`at_${generation}`);
      validRefresh = `rt_${generation}`;
      return new Response(
        `{"data":{"auth_token":"at_${generation}","refresh_token":"rt_${generation}"},"base_resp":{"status_code":0}}`,
      );
    }
    const token = (init?.headers as Record<string, string>)['X-Token'];
    if (!validAuth.has(token))
      return new Response('{"base_resp":{"status_code":401}}', { status: 401 });
    return new Response('{"data":{"ok":true},"base_resp":{"status_code":0}}');
  }) as typeof fetch;
  return {
    fetcher,
    refreshCalls,
    expireAuth: () => validAuth.clear(),
  };
}

function gatewayFor(dir: string, store: FileStore, fetcher: typeof fetch) {
  return new Gateway({
    env,
    idfv: 'x',
    store,
    account: 'test',
    credential: store.get('test'),
    fetch: fetcher,
    lockPath: refreshLockPath('test', dir),
  });
}

describe('refreshing the session', () => {
  it('two processes with the same stale token trade it once; neither is signed out', async () => {
    const dir = tempDir();
    const store = new FileStore(join(dir, 'credentials.json'));
    store.set('test', credential());
    const server = rotatingGateway({ refreshDelayMs: 80 });
    // Two clients that share nothing but the store and the lock, as `yomi relay` and `yomi create`.
    const relay = gatewayFor(dir, store, server.fetcher);
    const create = gatewayFor(dir, store, server.fetcher);
    server.expireAuth();
    const [a, b] = await Promise.all([
      relay.requestData('account/get_account'),
      create.requestData('account/get_account'),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(server.refreshCalls).toEqual(['rt_0']);
    expect(store.get('test')).toMatchObject({ authToken: 'at_1', refreshToken: 'rt_1' });
    expect(relay.credential?.authToken).toBe('at_1');
    expect(create.credential?.authToken).toBe('at_1');
  });

  it('keeps the credential when the refresh fails for a passing reason', async () => {
    const dir = tempDir();
    const store = new FileStore(join(dir, 'credentials.json'));
    store.set('test', credential());
    for (const failure of [
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('{"base_resp":{"status_code":50001,"status_msg":"busy"}}'),
    ]) {
      const server = rotatingGateway({ failRefresh: failure });
      const gateway = gatewayFor(dir, store, server.fetcher);
      server.expireAuth();
      const error = await gateway.request('account/get_account').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(NotSignedIn);
      expect(store.get('test')).toMatchObject({ refreshToken: 'rt_0' });
    }
  });

  it('signs out when the refresh token is refused, unless a newer pair was stored meanwhile', async () => {
    const dir = tempDir();
    const store = new FileStore(join(dir, 'credentials.json'));
    store.set('test', credential({ refreshToken: 'rt_spent' }));
    const server = rotatingGateway();
    const gateway = gatewayFor(dir, store, server.fetcher);
    server.expireAuth();
    await expect(gateway.request('account/get_account')).rejects.toBeInstanceOf(NotSignedIn);
    expect(store.get('test')).toBeNull();

    // `yomi login` wrote a new session while the doomed refresh was out: it is adopted, not deleted.
    store.set('test', credential({ refreshToken: 'rt_spent' }));
    const slow = rotatingGateway({ refreshDelayMs: 50 });
    const late = gatewayFor(dir, store, slow.fetcher);
    slow.expireAuth();
    const pending = late.request('account/get_account').catch((e: unknown) => e);
    await sleep(10);
    store.set('test', credential({ authToken: 'at_relogin', refreshToken: 'rt_relogin' }));
    await pending;
    expect(store.get('test')).toMatchObject({ refreshToken: 'rt_relogin' });
    expect(late.credential?.authToken).toBe('at_relogin');
  });

  it('never writes a refreshed pair over another login, and stays signed out after yomi logout', async () => {
    const dir = tempDir();
    const store = new FileStore(join(dir, 'credentials.json'));
    store.set('test', credential());
    const slow = rotatingGateway({ refreshDelayMs: 60 });
    const gateway = gatewayFor(dir, store, slow.fetcher);
    slow.expireAuth();
    const pending = gateway.request('account/get_account').catch((e: unknown) => e);
    await sleep(10);
    // Another account signs in on this computer while the refresh is out.
    store.set(
      'test',
      credential({ userId: '7300000000000000999', authToken: 'at_b', refreshToken: 'rt_b' }),
    );
    await pending;
    expect(store.get('test')).toMatchObject({
      userId: '7300000000000000999',
      refreshToken: 'rt_b',
    });
    expect(gateway.reloadCredential()).toBe('otherAccount');

    store.set('test', credential());
    const again = rotatingGateway({ refreshDelayMs: 60 });
    const relay = gatewayFor(dir, store, again.fetcher);
    again.expireAuth();
    const out = relay.request('account/get_account').catch((e: unknown) => e);
    await sleep(10);
    store.delete('test');
    expect(await out).toBeInstanceOf(NotSignedIn);
    expect(store.get('test')).toBeNull();
  });

  it('does not take back an older stored pair after its own could not be saved', async () => {
    const dir = tempDir();
    const store = new FileStore(join(dir, 'credentials.json'));
    store.set('test', credential({ refreshedAt: 1 }));
    const failing = Object.assign(Object.create(store) as FileStore, {
      set: () => {
        throw new Error('keychain locked');
      },
    });
    const server = rotatingGateway();
    const gateway = new Gateway({
      env,
      idfv: 'x',
      store: failing,
      account: 'test',
      credential: store.get('test'),
      fetch: server.fetcher,
      lockPath: refreshLockPath('test', dir),
    });
    server.expireAuth();
    expect((await gateway.requestData('account/get_account')).ok).toBe(true);
    expect(gateway.credential?.refreshToken).toBe('rt_1');
    // The next refresh trades the new pair, not the stale stored one, and nobody is signed out.
    server.expireAuth();
    expect((await gateway.requestData('account/get_account')).ok).toBe(true);
    expect(server.refreshCalls).toEqual(['rt_0', 'rt_1']);
    expect(store.get('test')).not.toBeNull();
  });

  it('reloads what another process stored', () => {
    const dir = tempDir();
    const store = new FileStore(join(dir, 'credentials.json'));
    store.set('test', credential());
    const gateway = gatewayFor(dir, store, fetch);
    expect(gateway.reloadCredential()).toBe('same');
    store.set('test', credential({ authToken: 'at_9', refreshToken: 'rt_9' }));
    expect(gateway.reloadCredential()).toBe('updated');
    expect(gateway.credential?.refreshToken).toBe('rt_9');
    store.set('test', credential({ userId: '7300000000000000999' }));
    expect(gateway.reloadCredential()).toBe('otherAccount');
    expect(gateway.credential?.userId).toBe('7300000000000000101');
    store.delete('test');
    expect(gateway.reloadCredential()).toBe('signedOut');
    expect(gateway.credential).toBeNull();
  });
});

describe('the keychain', () => {
  /** `security` as it behaves: `-w` prints a value that is not plain ASCII as hex. */
  function fakeSecurity() {
    const items = new Map<string, Buffer>();
    const argv: string[][] = [];
    const exec = (command: string, args: string[], input?: string) => {
      argv.push([command, ...args]);
      if (args[0] === '-i') {
        const match = /-a "([^"]+)" -s "yomi-cli" -l "[^"]*" -X ([0-9a-f]+)/.exec(input ?? '');
        if (!match) return { status: 1, stdout: '', stderr: 'parse' };
        items.set(match[1], Buffer.from(match[2], 'hex'));
        return { status: 0, stdout: '', stderr: '' };
      }
      const account = args[args.indexOf('-a') + 1];
      if (args[0] === 'find-generic-password') {
        const value = items.get(account);
        if (!value) return { status: 44, stdout: '', stderr: 'not found' };
        const ascii = [...value].every((byte) => byte >= 0x20 && byte < 0x7f);
        return {
          status: 0,
          stdout: (ascii ? value.toString('utf8') : value.toString('hex')) + '\n',
          stderr: '',
        };
      }
      if (args[0] === 'delete-generic-password')
        return { status: items.delete(account) ? 0 : 44, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    };
    return { exec, items, argv };
  }

  it('stores a session with a non-ASCII name and reads it back', () => {
    const security = fakeSecurity();
    const store = new KeychainStore(security.exec);
    store.set('test', credential());
    expect(store.get('test')).toMatchObject({ displayName: '林夏', authToken: 'at_0' });
    // Secrets go through stdin, never argv; the binary is the absolute /usr/bin/security.
    expect(security.argv.every(([command]) => command === '/usr/bin/security')).toBe(true);
    expect(security.argv.flat().join(' ')).not.toContain('at_0');
  });

  it('reads a value an older version stored as UTF-8 (printed as hex)', () => {
    const security = fakeSecurity();
    security.items.set('test', Buffer.from(JSON.stringify(credential()), 'utf8'));
    expect(new KeychainStore(security.exec).get('test')).toMatchObject({ displayName: '林夏' });
    expect(keychainOutput('abc123')).toBe('abc123');
    expect(asciiJson({ name: '林夏' })).toBe('{"name":"\\u6797\\u590f"}');
  });

  it('keeps other secrets under their own names', () => {
    const security = fakeSecurity();
    const store = new KeychainStore(security.exec);
    store.set('test', credential());
    store.setSecret('telegram-bot:test', '123456:ABC-def_ghi');
    expect(store.getSecret('telegram-bot:test')).toBe('123456:ABC-def_ghi');
    expect(store.get('test')?.authToken).toBe('at_0');
    expect(store.deleteSecret('telegram-bot:test')).toBe(true);
    expect(store.getSecret('telegram-bot:test')).toBeNull();
    expect(store.get('test')).not.toBeNull();
  });

  it('keeps file secrets apart from the sessions (0600)', () => {
    const dir = tempDir();
    const store = new FileStore(join(dir, 'credentials.json'));
    store.setSecret('telegram-bot:test', '123:abc');
    expect(store.get('telegram-bot:test')).toBeNull();
    expect(store.getSecret('telegram-bot:test')).toBe('123:abc');
    expect(store.deleteSecret('telegram-bot:test')).toBe(true);
    expect(store.getSecret('telegram-bot:test')).toBeNull();
  });
});

describe('the lock file', () => {
  it('serialises holders and lets nobody in twice', async () => {
    const dir = tempDir();
    const path = join(dir, 'locks', 'x.lock');
    const log: string[] = [];
    const holder = (name: string) =>
      withFileLock(path, async () => {
        log.push(`${name}+`);
        await sleep(30);
        log.push(`${name}-`);
      });
    await Promise.all([holder('a'), holder('b'), holder('c')]);
    for (let index = 0; index < log.length; index += 2)
      expect(log[index].slice(0, -1)).toBe(log[index + 1].slice(0, -1));
  });

  it('takes over a lock whose process is gone', async () => {
    const dir = tempDir();
    const path = join(dir, 'gone.lock');
    // A pid that is certainly not running: a child that already exited.
    const child = spawn(process.execPath, ['-e', '0']);
    await new Promise((resolve) => child.on('exit', resolve));
    writeFileSync(path, JSON.stringify({ pid: child.pid, at: Date.now(), token: 'dead' }));
    await expect(withFileLock(path, async () => 'ran', { timeoutMs: 1000 })).resolves.toBe('ran');
  });

  it('treats a lock from before this boot as stale (its pid may be reused)', () => {
    const dir = tempDir();
    const path = join(dir, 'boot.lock');
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: 1, token: 'old' }));
    const lock = acquireProcessLock(path);
    expect('release' in lock).toBe(true);
    if ('release' in lock) lock.release();
  });

  it('keeps out a second long-running process', () => {
    const dir = tempDir();
    const path = join(dir, 'relay.lock');
    const first = acquireProcessLock(path);
    expect('release' in first).toBe(true);
    const second = acquireProcessLock(path);
    expect(second).toEqual({ heldBy: process.pid });
    if ('release' in first) first.release();
    const third = acquireProcessLock(path);
    expect('release' in third).toBe(true);
    if ('release' in third) third.release();
  });
});

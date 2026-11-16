import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type Credential,
  FileStore,
  KeychainStore,
  SecretServiceStore,
} from '../src/core/credentials.js';
import { LocalState } from '../src/core/state.js';
import { VERSION } from '../src/core/version.js';

const credential: Credential = {
  version: 1,
  env: 'test',
  apiOrigin: 'https://x',
  userId: '1',
  deviceId: '2',
  authToken: 'at_secret',
  refreshToken: 'rt_secret',
  email: '',
  displayName: '',
  createdAt: 0,
  refreshedAt: 0,
};

describe('local state', () => {
  it('keeps request IDs stable per method, key and body', () => {
    const state = new LocalState('test', '1', mkdtempSync(join(tmpdir(), 'yomi-state-')));
    const a = state.receipt('create_ugc_character', 'k', { a: 1 });
    expect(state.receipt('create_ugc_character', 'k', { a: 1 })).toBe(a);
    expect(state.receipt('create_ugc_character', 'k', { a: 2 })).not.toBe(a);
    state.dropReceipt('create_ugc_character', 'k', { a: 1 });
    expect(state.receipt('create_ugc_character', 'k', { a: 1 })).not.toBe(a);
  });

  it('takes ordered preview IDs as the app does, saved before use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-state-'));
    const state = new LocalState('test', '1', dir);
    const draft = state.draft('/x/c.yaml');
    expect(draft.draftId).toMatch(/^draft_[0-9a-f]{32}$/);
    const first = state.nextPreviewId('/x/c.yaml', 1000);
    const second = state.nextPreviewId('/x/c.yaml', 10);
    const stream = createHash('sha256').update(draft.draftId).digest('hex').slice(0, 32);
    expect(first).toMatch(new RegExp(`^pv2_${stream}_1000_[0-9a-f]{32}$`));
    expect(second).toMatch(new RegExp(`^pv2_${stream}_1001_[0-9a-f]{32}$`));
    expect(first.length).toBeLessThanOrEqual(89);
    // A new process reads the counter back.
    expect(new LocalState('test', '1', dir).nextPreviewId('/x/c.yaml', 5)).toContain('_1002_');
    expect(statSync(state.path).mode & 0o777).toBe(0o600);
  });
});

describe('credential stores', () => {
  it('file: 0600, per account', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'yomi-cred-')), 'credentials.json');
    const store = new FileStore(path);
    store.set('test', credential);
    store.set('prod', { ...credential, userId: '9' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.get('test')?.userId).toBe('1');
    expect(store.delete('test')).toBe(true);
    expect(store.get('test')).toBeNull();
    expect(store.get('prod')?.userId).toBe('9');
  });

  it('keychain: the secret goes through stdin, never the command line', () => {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    let stored = '';
    const store = new KeychainStore((command, args, input) => {
      calls.push({ command, args, input });
      if (args[0] === '-i') {
        stored = Buffer.from(/-X ([0-9a-f]+)/.exec(input ?? '')![1], 'hex').toString('utf8');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'find-generic-password')
        return { status: stored ? 0 : 44, stdout: stored + '\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    store.set('test', credential);
    expect(store.get('test')?.refreshToken).toBe('rt_secret');
    for (const call of calls) expect(call.args.join(' ')).not.toContain('secret');
    expect(calls[0].input).toContain('-s "yomi-cli"');
  });

  it('secret service: the secret goes through stdin', () => {
    const calls: { args: string[]; input?: string }[] = [];
    const store = new SecretServiceStore((_command, args, input) => {
      calls.push({ args, input });
      return { status: 0, stdout: JSON.stringify(credential), stderr: '' };
    });
    store.set('test', credential);
    expect(calls[0].args).toEqual([
      'store',
      '--label=Yomi CLI (test)',
      'service',
      'yomi-cli',
      'account',
      'test',
    ]);
    expect(calls[0].input).toContain('rt_secret');
    expect(store.get('test')?.userId).toBe('1');
  });
});

describe('package', () => {
  it('reports the version in package.json', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe(VERSION);
  });
});

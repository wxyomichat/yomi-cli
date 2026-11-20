import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { FileStore } from '../src/core/credentials.js';
import { VERSION } from '../src/core/version.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
import { authorizeLikeTheBrowser as authorizeWith } from './helpers/authorize.js';
import { memoryIo } from './helpers/io.js';
import { solidPng } from './helpers/png.js';

/**
 * The CLI end to end against the mock gateway (no real service): login through the authorize
 * page and the loopback callback, whoami, create, preview with streamed replies and the paid
 * confirmation, logout. Credentials go to a temporary file store, never the system keychain.
 */

let mock: MockServer;
let dir: string;
const example = resolve('examples/character.yaml');
const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}

/** What a browser does on the authorize page (see helpers/authorize.ts). */
const authorizeLikeTheBrowser = (url: string, options?: Parameters<typeof authorizeWith>[2]) =>
  authorizeWith(mock, url, options);

async function run(args: string[], options: Parameters<typeof memoryIo>[0] = {}) {
  process.exitCode = undefined;
  const terminal = memoryIo(options);
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
}

beforeAll(async () => {
  mock = await startMockServer();
  dir = mkdtempSync(join(tmpdir(), 'yomi-cli-e2e-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_CONFIG_DIR: dir,
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
});

afterAll(async () => {
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('yomi against the mock gateway', () => {
  it('needs a sign-in first', async () => {
    const result = await run(['whoami']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('还没有登录');
  });

  it('can be cancelled on the authorize page', async () => {
    const terminal = memoryIo();
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
    const response = await authorizeLikeTheBrowser(url, { action: 'cancel' });
    expect(response.status).toBe(200);
    expect(await pending).toBe(1);
    expect(terminal.err).toContain('已在网页上取消授权');
    expect(mock.state.logins).toHaveLength(0);
    expect(mock.state.exchanges).toHaveLength(0);
  });

  it('logs in through the web and keeps its own session', async () => {
    const terminal = memoryIo();
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
    const code = (await terminal.waitFor(/确认码：(\S+)/))[1];
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const response = await authorizeLikeTheBrowser(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('已授权 Yomi CLI');
    expect(await pending).toBe(0);
    // The account as the server names it, never as the page posted it.
    // An exchange answers no email: the UID people see in the app tells the account apart.
    expect(terminal.out).toContain(
      '✓ 已登录账号「Mock Creator」（user_id 7300000000000000101，UID 10086）',
    );
    // Nobody could confirm it: said so, with what to do if it was not theirs.
    expect(terminal.err).toContain('没有人确认这个账号（非交互运行）');
    // A one-time code with the PKCE verifier, for a session of the CLI's own that signs nobody
    // out elsewhere; no Firebase token at all.
    expect(mock.state.logins).toHaveLength(0);
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    const [exchange] = mock.state.exchanges;
    expect(exchange).toMatchObject({
      state: params.get('state'),
      callback_port: Number(params.get('port')),
      client_version: VERSION,
      device_info: { os: 3 },
    });
    expect(mock.state.sessions.at(-1)?.platform).toBe('cli');
    const file = join(dir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // The code and the verifier were used once and never stored or printed.
    for (const secret of [String(exchange.code), String(exchange.code_verifier)]) {
      expect(readFileSync(file, 'utf8')).not.toContain(secret);
      expect(terminal.out + terminal.err).not.toContain(secret);
    }
    // The callback is one-shot.
    const again = await authorizeLikeTheBrowser(url).catch(() => null);
    expect(again === null || again.status >= 400).toBe(true);
  });

  it('shows who is signed in (i64 IDs intact)', async () => {
    const result = await run(['whoami']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Mock Creator');
    expect(result.out).toContain('user_id 7300000000000000101');
    expect(result.out).toContain('钻石：25');
  });

  it('lists voices and tags (all pages)', async () => {
    const voices = await run(['voices']);
    expect(voices.out).toContain('voice_warm_f');
    const tags = await run(['tags']);
    expect(tags.out).toContain('Romance');
    expect(tags.out).toContain('校园');
  });

  it('refuses to create without the declaration when nobody can confirm it', async () => {
    const result = await run(['create', '-f', example]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('没有确认声明，未提交');
    expect(mock.state.characters.size).toBe(0);
  });

  it('creates a character once, uploads reviewed pictures, and recognizes a repeat', async () => {
    const result = await run([
      'create',
      '-f',
      example,
      '--accept-declaration',
      '--tag',
      'Romance',
      '--tag',
      '校园',
    ]);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/✓ 已创建角色 \d{19}/);
    expect(result.out).toContain('状态：审核中');
    expect(mock.state.characters.size).toBe(1);
    const [created] = [...mock.state.characters.values()];
    expect(created.content).toMatchObject({
      name: '林夏',
      gender: 2,
      visibility: 2,
      declaration_accepted: true,
      content_format: 'plain',
      tag_ids: ['9100000000000000001', '9100000000000000003'],
      features: { voice_configuration: { voices: [{ voice_id: 'voice_warm_f', weight: 100 }] } },
    });
    // The signed PUT went without the gateway's credentials (the mock refuses X-Token there).
    const uploads = [...mock.state.uploads.values()];
    expect(uploads.map((upload) => upload.status)).toEqual([1, 1]);
    const repeat = await run([
      'create',
      '-f',
      example,
      '--accept-declaration',
      '--tag',
      'Romance',
      '--tag',
      '校园',
    ]);
    expect(repeat.out).toContain('已经创建过角色');
    expect(mock.state.characters.size).toBe(1);
  });

  it('reports a refused text review and keeps nothing frozen', async () => {
    const file = join(dir, 'bad.yaml');
    writeFileSync(
      file,
      readFileSync(example, 'utf8')
        .replace('海边小镇', 'REJECT_TEXT 海边小镇')
        .replace(/\.\/(cover|avatar)\.png/g, resolve('examples') + '/$1.png'),
    );
    const result = await run(['create', '-f', file, '--accept-declaration']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('角色文本没有通过审核');
    expect(mock.state.characters.size).toBe(1);
  });

  it('refuses a picture with the wrong shape before uploading', async () => {
    const file = join(dir, 'wide.yaml');
    writeFileSync(join(dir, 'wide.png'), solidPng(800, 600, [1, 2, 3]));
    writeFileSync(
      file,
      readFileSync(example, 'utf8')
        .replace('./cover.png', join(dir, 'wide.png'))
        .replace('./avatar.png', resolve('examples/avatar.png')),
    );
    const uploads = mock.state.uploads.size;
    const result = await run(['create', '-f', file, '--accept-declaration']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('比例要 1:2');
    expect(mock.state.uploads.size).toBe(uploads);
  });

  it('previews the draft with streamed replies and shows the free messages first', async () => {
    const result = await run([
      'preview',
      '-f',
      example,
      '--accept-declaration',
      '-m',
      '你好',
      '-m',
      '最近在读什么？',
    ]);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const out = result.out;
    expect(out.indexOf('剩余 3 条免费消息')).toBeGreaterThan(-1);
    expect(out.indexOf('剩余 3 条免费消息')).toBeLessThan(out.indexOf('你：你好'));
    expect(out).toContain('林夏：这本，你一定会喜欢。');
    expect(out).toContain('你好？这个问题，我想了很久。');
    expect(out).toContain('剩余 1 条免费消息');
    expect(out).toContain('预演已结束');
    expect([...mock.state.previews.values()].every((preview) => preview.closed)).toBe(true);
    expect(mock.state.sockets).toBeGreaterThan(0);
  });

  it('never spends gems without an explicit yes', async () => {
    const gems = mock.state.gems;
    const scripted = await run([
      'preview',
      '-f',
      example,
      '--accept-declaration',
      '-m',
      '第三句',
      '-m',
      '第四句',
    ]);
    expect(scripted.out).toContain('免费消息已用完');
    expect(scripted.err).toContain('--allow-paid');
    expect(mock.state.gems).toBe(gems);

    const declined = await run(['preview', '-f', example, '--accept-declaration'], {
      interactive: true,
      input: ['付费的一句', 'no', '/quit'],
    });
    expect(declined.out).toContain('继续并按标准费率扣除钻石？');
    expect(declined.out).toContain('未发送');
    expect(mock.state.gems).toBe(gems);

    const agreed = await run(['preview', '-f', example, '--accept-declaration'], {
      interactive: true,
      input: ['付费的一句', 'yes', '/quit'],
    });
    expect(agreed.out).toContain('当前余额 25 钻石');
    expect(agreed.out).toContain('付费的一句？这个问题，我想了很久。');
    expect(mock.state.gems).toBe(gems - 10);
  });

  it('signs out and revokes the session', async () => {
    const result = await run(['logout']);
    expect(result.out).toContain('已退出账号 7300000000000000101');
    expect(mock.state.sessions.every((session) => session.revoked)).toBe(true);
    const after = await run(['whoami']);
    expect(after.code).toBe(1);
  });

  it('asks whose account it is; a forged callback turned down is revoked and the real one still lands', async () => {
    const terminal = memoryIo({ interactive: true });
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    // Someone who learned the state posts first, with a token of their own.
    const forged = await fetch(`http://127.0.0.1:${params.get('port')}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: mock.origin },
      body: new URLSearchParams({
        state: params.get('state') ?? '',
        id_token: mock.idToken(),
        email: 'victim@example.com',
      }).toString(),
    });
    expect(forged.status).toBe(200);
    await terminal.waitFor(/以这个账号登录 Yomi CLI？/);
    // What the forged post claimed is not shown: only what the server says.
    expect(terminal.out).not.toContain('victim@example.com');
    const sessions = mock.state.sessions.length;
    terminal.stdin.write('n\n');
    await terminal.waitFor(/继续等待网页授权（Ctrl\+C 取消）/);
    expect(mock.state.sessions).toHaveLength(sessions);
    expect(mock.state.sessions.at(-1)?.revoked).toBe(true);
    // The port is still held: the person's own click reaches the CLI.
    const response = await authorizeLikeTheBrowser(url);
    expect(response.status).toBe(200);
    await terminal.waitFor(/以这个账号登录 Yomi CLI？[\s\S]*以这个账号登录 Yomi CLI？/);
    terminal.stdin.write('y\n');
    expect(await pending).toBe(0);
    expect(terminal.out).toContain('✓ 已登录账号「Mock Creator」');
    expect(mock.state.sessions.at(-1)?.revoked).toBe(false);
    expect((await run(['whoami'])).code).toBe(0);
  });
});

/** The login's answers to forged callbacks, refusals, Ctrl+C and a store that will not write. */
describe('yomi login when something is off', () => {
  const urlPattern = /http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/;
  const paramsOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1));
  /** A callback posted by someone who learned the state (not through the page). */
  const forge = (url: string, fields: Record<string, string>) => {
    const params = paramsOf(url);
    return fetch(`http://127.0.0.1:${params.get('port')}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: mock.origin },
      body: new URLSearchParams({ state: params.get('state') ?? '', ...fields }).toString(),
    });
  };
  /** True when nothing else can bind the port (the CLI still holds it). */
  const portHeld = (port: number) =>
    new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(true));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
    });
  const signedOut = async () => {
    await run(['logout']);
    expect((await run(['whoami'])).code).toBe(1);
  };

  it('asks about a cancellation it did not see coming, and keeps the port when it was not the person', async () => {
    await signedOut();
    const terminal = memoryIo({ interactive: true });
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    expect((await forge(url, { error: 'access_denied' })).status).toBe(200);
    await terminal.waitFor(/网页上取消了这次授权。输入 y 结束登录/);
    expect(await portHeld(Number(paramsOf(url).get('port')))).toBe(true);
    terminal.stdin.write('n\n');
    await terminal.waitFor(/继续等待网页授权（Ctrl\+C 取消）/);
    expect((await authorizeLikeTheBrowser(url)).status).toBe(200);
    await terminal.waitFor(/以这个账号登录 Yomi CLI？/);
    terminal.stdin.write('y\n');
    expect(await pending).toBe(0);
    expect((await run(['whoami'])).code).toBe(0);
  });

  it('without a terminal, a cancellation ends the login with a warning', async () => {
    await signedOut();
    const terminal = memoryIo();
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    await forge(url, { error: 'access_denied' });
    expect(await pending).toBe(1);
    expect(terminal.err).toContain('如果不是你在网页上点的取消，不要再在网页上授权');
    expect(terminal.err).toContain('已在网页上取消授权');
  });

  it('drops an Enter pressed while waiting: only an answer typed at the question counts', async () => {
    await signedOut();
    const terminal = memoryIo({ interactive: true });
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    terminal.stdin.write('\n');
    terminal.stdin.write('y\n');
    await authorizeLikeTheBrowser(url);
    await terminal.waitFor(/以这个账号登录 Yomi CLI？/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Neither the typed-ahead Enter nor the typed-ahead y decided anything.
    expect(terminal.out).not.toContain('已拒绝这个账号');
    expect(terminal.out).not.toContain('✓ 已登录');
    expect(mock.state.sessions.at(-1)?.revoked).toBe(false);
    terminal.stdin.write('maybe\n');
    await terminal.waitFor(/以这个账号登录 Yomi CLI？[\s\S]*以这个账号登录 Yomi CLI？/);
    terminal.stdin.write('y\n');
    expect(await pending).toBe(0);
    expect(terminal.out).toContain('✓ 已登录');
  });

  it('revokes a turned-down session even after its auth token went stale', async () => {
    await signedOut();
    const terminal = memoryIo({ interactive: true });
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    await forge(url, { id_token: mock.idToken() });
    await terminal.waitFor(/以这个账号登录 Yomi CLI？/);
    const turnedDown = mock.state.sessions.at(-1)!;
    mock.expireAuthTokens();
    terminal.stdin.write('n\n');
    await terminal.waitFor(/继续等待网页授权（Ctrl\+C 取消）/);
    expect(terminal.err).toContain('已拒绝这个账号，刚建立的会话已撤销');
    expect(turnedDown.revoked).toBe(true);
    // Nothing was stored for it.
    expect((await run(['whoami'])).code).toBe(1);
    await authorizeLikeTheBrowser(url);
    await terminal.waitFor(/以这个账号登录 Yomi CLI？[\s\S]*以这个账号登录 Yomi CLI？/);
    terminal.stdin.write('y\n');
    expect(await pending).toBe(0);
  });

  it('revokes a session whose read-back failed, says why, and keeps waiting', async () => {
    await signedOut();
    const terminal = memoryIo();
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    mock.state.accountFailures = 1;
    const before = mock.state.sessions.length;
    await authorizeLikeTheBrowser(url);
    await terminal.waitFor(/继续等待网页授权/);
    expect(terminal.err).toContain('网页交来的凭证没能换出会话（50300：system busy）');
    expect(mock.state.sessions).toHaveLength(before + 1);
    expect(mock.state.sessions.at(-1)?.revoked).toBe(true);
    // The person tries again: the page is still there, the port still held.
    await authorizeLikeTheBrowser(url);
    expect(await pending).toBe(0);
    expect(mock.state.sessions.at(-1)?.revoked).toBe(false);
  });

  it('names the last refusal when the time runs out', async () => {
    await signedOut();
    const terminal = memoryIo();
    const pending = main(['login', '--no-browser', '--timeout', '2'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    const before = mock.state.sessions.length;
    // A refusal the protocol does not name: the code is spent, the wait goes on as for any other.
    mock.state.exchangeRefusal = { code: 1101000009, message: 'account blocked in this region' };
    await authorizeLikeTheBrowser(url);
    expect(await pending).toBe(1);
    expect(terminal.err).toContain('没能换出会话（1101000009：account blocked in this region）');
    expect(terminal.err).toContain(
      '2 秒内没有完成授权，请重新运行 yomi login（服务端最后一次拒绝：1101000009：account blocked in this region）',
    );
    expect(mock.state.sessions).toHaveLength(before);
  });

  it('cancels on Ctrl+C while the session is being made, and revokes it', async () => {
    await signedOut();
    const terminal = memoryIo();
    const listeners = new Set(process.listeners('SIGINT'));
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    const before = mock.state.sessions.length;
    mock.state.exchangeDelayMs = 300;
    try {
      void authorizeLikeTheBrowser(url);
      await terminal.waitFor(/正在建立 CLI 会话/);
      // As the signal would: only the listener the command added.
      for (const listener of process.listeners('SIGINT'))
        if (!listeners.has(listener)) (listener as () => void)();
      expect(await pending).toBe(1);
    } finally {
      mock.state.exchangeDelayMs = 0;
    }
    expect(terminal.err).toContain('已取消登录');
    // The exchange was let finish, and the session it made was revoked before the exit.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const made = mock.state.sessions.slice(before);
    expect(made).toHaveLength(1);
    expect(made.every((session) => session.revoked)).toBe(true);
    expect((await run(['whoami'])).code).toBe(1);
    expect(process.listeners('SIGINT').filter((listener) => !listeners.has(listener))).toHaveLength(
      0,
    );
  });

  it('revokes the session on Ctrl+C at the account question', async () => {
    await signedOut();
    const terminal = memoryIo({ interactive: true });
    const listeners = new Set(process.listeners('SIGINT'));
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    await authorizeLikeTheBrowser(url);
    await terminal.waitFor(/以这个账号登录 Yomi CLI？/);
    const asked = mock.state.sessions.at(-1)!;
    for (const listener of process.listeners('SIGINT'))
      if (!listeners.has(listener)) (listener as () => void)();
    expect(await pending).toBe(1);
    expect(terminal.err).toContain('已取消登录');
    expect(asked.revoked).toBe(true);
    expect((await run(['whoami'])).code).toBe(1);
  });

  it('revokes the session when the input has ended before the question', async () => {
    await signedOut();
    const terminal = memoryIo({ interactive: true });
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    terminal.stdin.end();
    await authorizeLikeTheBrowser(url);
    expect(await pending).toBe(1);
    expect(terminal.err).toContain('输入已结束，没有登录（刚建立的会话已撤销）');
    expect(mock.state.sessions.at(-1)?.revoked).toBe(true);
  });

  it('revokes the session it replaces even when another process refreshed it meanwhile', async () => {
    await signedOut();
    const first = memoryIo();
    const signingIn = main(['login', '--no-browser', '--timeout', '20'], first.io);
    // Signed in through an older page: the server keeps that session apart from the CLI's
    // sessions from codes (a code would replace it there), so revoking it is the CLI's job.
    await authorizeLikeTheBrowser((await first.waitFor(urlPattern))[0], { page: 'old' });
    expect(await signingIn).toBe(0);
    const old = mock.state.sessions.at(-1)!;
    const terminal = memoryIo();
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(urlPattern);
    // Meanwhile a `yomi relay` refreshes the stored pair (the old one rotates on the server).
    mock.expireAuthTokens();
    expect((await run(['whoami'])).code).toBe(0);
    await authorizeLikeTheBrowser(url);
    expect(await pending).toBe(0);
    expect(old.revoked).toBe(true);
    expect(terminal.err).not.toContain('没能在服务端撤销');
  });

  it('keeps the old sign-in when the new one cannot be stored, and revokes the new one', async () => {
    const first = memoryIo();
    const signingIn = main(['login', '--no-browser', '--timeout', '20'], first.io);
    // An older page's session, which a code does not replace on the server (see above).
    await authorizeLikeTheBrowser((await first.waitFor(urlPattern))[0], { page: 'old' });
    expect(await signingIn).toBe(0);
    const old = mock.state.sessions.at(-1)!;
    // The store refuses to write (a locked keychain, a full disk).
    const refuse = vi.spyOn(FileStore.prototype, 'set').mockImplementationOnce(() => {
      throw new Error('the keychain is locked');
    });
    try {
      const terminal = memoryIo();
      const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
      await authorizeLikeTheBrowser((await terminal.waitFor(urlPattern))[0]);
      expect(await pending).toBe(1);
      expect(terminal.err).toContain('the keychain is locked');
    } finally {
      refuse.mockRestore();
    }
    expect(mock.state.sessions.at(-1)?.revoked).toBe(true);
    expect(old.revoked).toBe(false);
    expect((await run(['whoami'])).code).toBe(0);
  });
});

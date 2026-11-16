import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
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

/**
 * What a browser does on the authorize page: the page reads `port` and `state` from the
 * fragment (never sent to the server) and posts its form, from the web's origin.
 */
async function authorizeLikeTheBrowser(url: string, action: 'authorize' | 'cancel' = 'authorize') {
  const link = new URL(url);
  expect(link.search).toBe('');
  const params = new URLSearchParams(link.hash.slice(1));
  const page = await (await fetch(link.origin + link.pathname)).text();
  const form = [...page.matchAll(/<form method="POST" data-kind="(\w+)">([\s\S]*?)<\/form>/g)].find(
    (match) => match[1] === action,
  )!;
  const fields = Object.fromEntries(
    [...form[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  fields.state = params.get('state') ?? '';
  return fetch(`http://127.0.0.1:${params.get('port')}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: mock.origin },
    body: new URLSearchParams(fields).toString(),
  });
}

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
    const response = await authorizeLikeTheBrowser(url, 'cancel');
    expect(response.status).toBe(200);
    expect(await pending).toBe(1);
    expect(terminal.err).toContain('已在网页上取消授权');
    expect(mock.state.logins).toHaveLength(0);
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
    expect(terminal.out).toContain('✓ 已登录账号 7300000000000000101');
    // The CLI's own session never signs the person out elsewhere.
    expect(mock.state.logins[0]).toMatchObject({
      login_type: 3,
      os: 3,
      not_logout_other_device: true,
    });
    const file = join(dir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // The Firebase token was used once and never stored or printed.
    expect(readFileSync(file, 'utf8')).not.toContain(String(mock.state.logins[0].firebase_token));
    expect(terminal.out).not.toContain(String(mock.state.logins[0].firebase_token));
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
});

import { copyFileSync, mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startCallbackServer } from '../src/auth/loopback.js';
import { main } from '../src/cli.js';
import { currentLanguage } from '../src/core/device.js';
import { setLanguage } from '../src/core/i18n.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
import { COMMANDS, relayTexts } from '../src/relay/texts.js';
import { memoryIo } from './helpers/io.js';

/**
 * The CLI in English, end to end against the mock gateway: what it prints has no Chinese of its own.
 * The mock answers in the language the CLI asks for (`sys_language`), except for some of its data
 * (model, style and persona names), which pass through as the server's text.
 */

let mock: MockServer;
let work: string;
const saved: Record<string, string | undefined> = {};
const CJK = /[㐀-鿿＀-￯　-〿]/;
/** The mock's own Chinese data that may show up (server text, not the CLI's). */
const SERVER_TEXT = ['标准', '旅人', '动漫', '写实', '写真', '轻量'];
const noChinese = (text: string) => {
  let rest = text;
  for (const word of SERVER_TEXT) rest = rest.replaceAll(word, '');
  const at = rest.search(CJK);
  return at < 0 ? '' : rest.slice(Math.max(0, at - 40), at + 40);
};

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function run(args: string[]) {
  const terminal = memoryIo();
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err, all: terminal.out + terminal.err };
}

async function signIn() {
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  const link = new URL(url);
  const params = new URLSearchParams(link.hash.slice(1));
  const page = await (await fetch(link.origin + link.pathname)).text();
  const form = [...page.matchAll(/<form method="POST" data-kind="(\w+)">([\s\S]*?)<\/form>/g)].find(
    (match) => match[1] === 'authorize',
  )!;
  const fields = Object.fromEntries(
    [...form[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  fields.state = params.get('state') ?? '';
  await fetch(`http://127.0.0.1:${params.get('port')}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: mock.origin },
    body: new URLSearchParams(fields).toString(),
  });
  expect(await pending).toBe(0);
  return terminal.out + terminal.err;
}

beforeAll(async () => {
  mock = await startMockServer();
  mock.state.gems = 5000;
  work = mkdtempSync(join(tmpdir(), 'yomi-cli-en-'));
  for (const name of ['character.en.yaml', 'cover.png', 'avatar.png'])
    copyFileSync(resolve('examples', name), join(work, name));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_CONFIG_DIR: join(work, 'config'),
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'en',
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

describe('yomi in English', () => {
  it('signs in, says who is signed in, and checks a file', async () => {
    const login = await signIn();
    expect(login).toContain('Confirmation code: ');
    expect(login).toContain('✓ Signed in with account "Mock Creator"');
    expect(noChinese(login)).toBe('');
    const whoami = await run(['whoami']);
    expect(whoami.out).toContain('Account: Mock Creator');
    expect(noChinese(whoami.all)).toBe('');
    const check = await run(['check', '-f', join(work, 'character.en.yaml')]);
    expect(check.code).toBe(0);
    expect(check.out).toContain('✓ Nova: local checks passed');
  });

  it('generates pictures and a video, previews and creates, all in English', async () => {
    const file = join(work, 'character.en.yaml');
    const out = join(work, 'media');
    const image = await run([
      'image',
      '-p',
      'anime portrait, young woman with long dark hair, soft window light',
      '--count',
      '2',
      '--pick',
      '1',
      '--into',
      file,
      '--as',
      'both',
      '--accept-price',
      '--out',
      out,
    ]);
    expect(image.code).toBe(0);
    expect(image.out).toContain('✓ Wrote image 1 into');
    expect(noChinese(image.all)).toBe('');
    const video = await run(['video', '-f', file, '--accept-price', '--out', out]);
    expect(video.code).toBe(0);
    expect(video.out).toContain('Kept as the dynamic cover');
    expect(noChinese(video.all)).toBe('');
    const preview = await run([
      'preview',
      '-f',
      file,
      '--accept-declaration',
      '-m',
      'What should I read tonight',
    ]);
    expect(preview.code).toBe(0);
    // The declaration in English only, and the mock's reply in English too.
    expect(preview.out).toContain(
      'My characters are 18+, and I have the rights to these materials.',
    );
    expect(preview.out).toContain('Nova: She closes the book and looks at you.');
    expect(noChinese(preview.all)).toBe('');
    const create = await run(['create', '-f', file, '--accept-declaration']);
    expect(create.code).toBe(0);
    expect(create.out).toMatch(/✓ Created character \d+/);
    expect(create.out).toContain('status: in review');
    expect(noChinese(create.all)).toBe('');
    const persona = await run([
      'persona',
      'avatar',
      '-p',
      'short hair',
      '--count',
      '1',
      '--pick',
      '1',
      '--accept-price',
      '--out',
      out,
    ]);
    expect(persona.code).toBe(0);
    expect(noChinese(persona.all)).toBe('');
  });

  it('prints help and usage errors in English, wherever --lang stands', async () => {
    const help = await run(['--lang', 'en', 'help', 'image']);
    expect(help.out).toContain('yomi image');
    expect(noChinese(help.out)).toBe('');
    const global = await run(['--help']);
    expect(global.out).toContain('--lang zh|en');
    expect(noChinese(global.out)).toBe('');
    const unknown = await run(['nonsense']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Unknown command: nonsense');
    const bad = await run(['whoami', '--lang', 'fr']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--lang must be zh, en, es or pt');
  });

  it('switches with --lang and falls back to the system locale', async () => {
    const zh = await run(['--lang', 'zh', 'whoami']);
    expect(zh.out).toContain('账号：');
    setEnv({
      YOMI_LANG: undefined,
      LC_ALL: undefined,
      LC_MESSAGES: undefined,
      LANG: 'zh_CN.UTF-8',
    });
    expect((await run(['whoami'])).out).toContain('账号：');
    setEnv({ LANG: 'de_DE.UTF-8' });
    expect((await run(['whoami'])).out).toContain('Account: ');
    setEnv({ YOMI_LANG: 'en' });
  });

  it('has the relay speak English in Telegram and serves the callback pages in English', async () => {
    setLanguage('en');
    try {
      expect(relayTexts(currentLanguage())).toBe(relayTexts('en'));
      expect(COMMANDS.en.every((command) => !CJK.test(command.description))).toBe(true);
      const server = await startCallbackServer({
        state: 's'.repeat(43),
        expectedOrigin: 'https://web.example.test',
        timeoutMs: 5000,
      });
      const page = await new Promise<string>((done) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: server.port,
            method: 'GET',
            path: '/other',
            headers: { Host: `127.0.0.1:${server.port}` },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString()));
            res.on('end', () => done(body));
          },
        );
        req.end();
      });
      server.close();
      expect(page).toContain('lang="en"');
      expect(page.search(CJK)).toBe(-1);
    } finally {
      setLanguage(null);
    }
  });
});

import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { currentLanguage } from '../src/core/device.js';
import { setLanguage } from '../src/core/i18n.js';
import { MOCK_NPCS, type MockServer, startMockServer } from '../src/mock/server.js';
import { QQ_CONNECT_TEST } from '../src/relay/channels/qq-connect.js';
import { QQ_CONSOLE_ZH } from '../src/relay/channels/qq-guide.js';
import { COMMANDS, relayCommands, relayTexts } from '../src/relay/texts.js';
import { authorizeLikeTheBrowser } from './helpers/authorize.js';
import { fakeConnectChild, processGone, SCAN_URL } from './helpers/fake-connect.js';
import { memoryIo } from './helpers/io.js';

/**
 * Spanish and Portuguese: the CLI's own text in either language, end to end against the mock (which,
 * like the server, writes only Chinese or English: it gets `sys_language` en), and the relay's
 * Telegram tables complete in both.
 */

let mock: MockServer;
let work: string;
const saved: Record<string, string | undefined> = {};
const CJK = /[㐀-鿿＀-￯　-〿]/;

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

async function signIn(lang: string) {
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20', '--lang', lang], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  await authorizeLikeTheBrowser(mock, url);
  expect(await pending).toBe(0);
  return terminal.out + terminal.err;
}

beforeAll(async () => {
  mock = await startMockServer();
  work = mkdtempSync(join(tmpdir(), 'yomi-cli-es-pt-'));
  for (const name of ['character.en.yaml', 'cover.png', 'avatar.png'])
    copyFileSync(resolve('examples', name), join(work, name));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_CONFIG_DIR: join(work, 'config'),
    YOMI_CREDENTIAL_STORE: 'file',
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

const CASES = [
  {
    lang: 'es',
    locale: 'es_MX.UTF-8',
    code: 'Código de confirmación: ',
    account: 'Cuenta: Mock Creator',
    checked: '✓ Nova: comprobaciones locales superadas',
    declaration: 'Declaración',
    step: 'Paso 3 de 7 · Escribe el AppID y el AppSecret',
    appId: /AppID \(solo se muestran los dígitos\):/,
    quit: 'Saliste; no se guardó nada.',
    scan: /Escanea el código QR de arriba con QQ en tu teléfono:\n {2}m: escribirlos a mano · q: salir $/,
    thirdParty: 'La página del escaneo dice',
  },
  {
    lang: 'pt',
    locale: 'pt_BR.UTF-8',
    code: 'Código de confirmação: ',
    account: 'Conta: Mock Creator',
    checked: '✓ Nova: as verificações locais passaram',
    declaration: 'Declaração',
    step: 'Passo 3 de 7 · Digite o AppID e o AppSecret',
    appId: /AppID \(só os dígitos aparecem\):/,
    quit: 'Você saiu; nada foi salvo.',
    scan: /Escaneie o código QR acima com o QQ no celular:\n {2}m: digitar manualmente · q: sair $/,
    thirdParty: 'A página do escaneamento diz',
  },
] as const;

describe.each(CASES)('yomi in $lang', (c) => {
  it('signs in, says who is signed in, checks a file and previews in that language', async () => {
    const login = await signIn(c.lang);
    expect(login).toContain(c.code);
    expect(login.search(CJK)).toBe(-1);
    // the system locale alone is enough
    setEnv({ YOMI_LANG: undefined, LC_ALL: undefined, LC_MESSAGES: undefined, LANG: c.locale });
    try {
      const whoami = await run(['whoami']);
      expect(whoami.out).toContain(c.account);
      const check = await run(['check', '-f', join(work, 'character.en.yaml')]);
      expect(check.out).toContain(c.checked);
      const preview = await run([
        'preview',
        '-f',
        join(work, 'character.en.yaml'),
        '--accept-declaration',
        '-m',
        'Hello',
      ]);
      expect(preview.code).toBe(0);
      expect(preview.out).toContain(c.declaration);
      expect(preview.all.search(CJK)).toBe(-1);
      // the server writes in English for this language (the mock's reply)
      expect(preview.out).toContain('She closes the book and looks at you.');
    } finally {
      setEnv({ YOMI_LANG: 'zh-Hans', LANG: saved.LANG });
    }
  });

  it('guides a QQ setup in that language, up to the AppID', async () => {
    const terminal = memoryIo({ interactive: true });
    const pending = main(['relay', '--setup', '--allow-file-store', '--lang', c.lang], terminal.io);
    await terminal.waitFor(/\(.*\):\n$/);
    terminal.stdin.write(`${MOCK_NPCS.single}\n`);
    await terminal.waitFor(/\[y\/n\] $/);
    terminal.stdin.write('y\n');
    await terminal.waitFor(/ · q: (salir|sair) $/);
    terminal.stdin.write('\n');
    await terminal.waitFor(c.appId);
    terminal.stdin.write('q\n');
    expect(await pending).toBe(0);
    const all = terminal.out + terminal.err;
    expect(all).toContain(c.step);
    expect(all).toContain(c.quit);
    let rest = all;
    for (const word of [...Object.values(QQ_CONSOLE_ZH), '林夏']) rest = rest.replaceAll(word, '');
    expect(rest.search(CJK)).toBe(-1);
  });

  it('offers the QR scan in that language', async () => {
    // A fake of Tencent's connector, against a loopback QQ address: nothing leaves this computer.
    const child = fakeConnectChild(work, `scan-${c.lang}`, [
      { send: { type: 'qr', url: SCAN_URL } },
    ]);
    QQ_CONNECT_TEST.child = child.path;
    setEnv({ YOMI_QQ_API_ORIGIN: 'http://127.0.0.1:9' });
    try {
      const terminal = memoryIo({ interactive: true });
      const pending = main(
        ['relay', '--setup', '--allow-file-store', '--lang', c.lang],
        terminal.io,
      );
      await terminal.waitFor(/\(.*\):\n$/);
      terminal.stdin.write(`${MOCK_NPCS.single}\n`);
      await terminal.waitFor(/\[y\/n\] $/);
      terminal.stdin.write('y\n');
      await terminal.waitFor(/ · q: (salir|sair) $/);
      terminal.stdin.write('\n');
      await terminal.waitFor(c.scan);
      terminal.stdin.write('q\n');
      expect(await pending).toBe(0);
      const all = terminal.out + terminal.err;
      expect(all).toContain(`${c.thirdParty} ${QQ_CONSOLE_ZH.thirdParty}`);
      expect(all).toContain(c.quit);
      let rest = all;
      for (const word of [...Object.values(QQ_CONSOLE_ZH), '林夏'])
        rest = rest.replaceAll(word, '');
      expect(rest.search(CJK)).toBe(-1);
      expect(await processGone(child.record().pid)).toBe(true);
    } finally {
      QQ_CONNECT_TEST.child = '';
      setEnv({ YOMI_QQ_API_ORIGIN: undefined });
    }
  });

  it('prints its help in that language', async () => {
    const help = await run(['--help', '--lang', c.lang]);
    expect(help.out).toContain('--lang zh|en|es|pt');
    expect(help.out.search(CJK)).toBe(-1);
    const english = await run(['--help', '--lang', 'en']);
    expect(help.out).not.toBe(english.out);
  });

  it('has complete relay texts and commands, and sends sys_language en', () => {
    const table = relayTexts(c.lang);
    const en = relayTexts('en');
    expect(table).not.toBe(en);
    expect(Object.keys(table).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(table)) {
      // a message, or the function that builds it (its source holds all of its text)
      expect(typeof value, key).toBe(typeof en[key as keyof typeof en]);
      expect(String(value).search(CJK), key).toBe(-1);
    }
    const commands = relayCommands(c.lang);
    expect(commands).toBe(COMMANDS[c.lang]);
    expect(commands.map((item) => item.command)).toEqual(COMMANDS.en.map((item) => item.command));
    setLanguage(c.lang);
    try {
      expect(currentLanguage()).toBe('en');
    } finally {
      setLanguage(null);
    }
  });
});

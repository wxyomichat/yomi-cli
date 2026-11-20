import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { QrConnectCallbacks, QrConnectOptions } from '@tencent-connect/qqbot-connector';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { setLanguage } from '../src/core/i18n.js';
import { terminalRows } from '../src/core/ui.js';
import {
  childEnvironment,
  childMessage,
  connectChild,
  QQ_CONNECT_TEST,
  type ScanEvent,
  startScan,
  trustedScanUrl,
} from '../src/relay/channels/qq-connect.js';
import {
  CHILD_MARK,
  type ConnectMessage,
  serveConnect,
} from '../src/relay/channels/qq-connect-child.js';
import { QQ_CONSOLE_ZH, scannedApp } from '../src/relay/channels/qq-guide.js';
import { GuideCancelled, GuideUi } from '../src/relay/guide/steps.js';
import { type FakeStep, fakeConnectChild, processGone, SCAN_URL } from './helpers/fake-connect.js';

/**
 * Step 3's scan of `yomi relay --setup`, the parts on their own: what the child may say and what it
 * may not, the environment it gets, the child's own use of Tencent's connector (a fake one here:
 * nothing reaches Tencent), and a scan with a fake child process: its events, its timeouts, and
 * the child killed whichever way the scan ends.
 */

const URL_OK = SCAN_URL;
const work = mkdtempSync(join(tmpdir(), 'yomi-qq-connect-'));
const saved = process.env.YOMI_QQ_API_ORIGIN;

afterEach(() => {
  QQ_CONNECT_TEST.child = '';
  setLanguage(null);
  if (saved === undefined) delete process.env.YOMI_QQ_API_ORIGIN;
  else process.env.YOMI_QQ_API_ORIGIN = saved;
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the child's messages", () => {
  it('takes a QR link only on https and q.qq.com, in plain characters', () => {
    expect(trustedScanUrl(URL_OK)).toBe(URL_OK);
    // What is drawn is the link as read here, not as the child spelled it.
    expect(trustedScanUrl('https://q.qq.com/a/../qqbot/x?y=1')).toBe(
      'https://q.qq.com/qqbot/x?y=1',
    );
    for (const bad of [
      'http://q.qq.com/qqbot/openclaw/connect.html',
      'https://q.qq.com.example.com/x',
      'https://evil.example/q.qq.com',
      'https://qq.com/x',
      'https://q.qq.com:8443/x',
      'https://q.qq.com:443/x',
      'https://user:pass@q.qq.com/x',
      // Read as q.qq.com here (a backslash is a slash to WHATWG), as another host by the parsers
      // that split a login off at '@' or take a backslash as it is: a phone's scanner could.
      'https://q.qq.com\\@evil.example/x',
      'https://q.qq.com\\\\@evil.example/x',
      'https:\\\\q.qq.com\\x',
      'https:q.qq.com/x',
      'https:/q.qq.com/x',
      'https://q.qq.com#@evil.example/',
      'https://q.qq.com?@evil.example/',
      'https://q.qq.com/@evil.example/x',
      'https://q.qq.com/x?next=https://a@evil.example/',
      'https://Q.QQ.COM/x',
      'HTTPS://q.qq.com/x',
      'https://q.qq.com./x',
      'https://q.qq.com',
      'https://q.qq.com/x\u001b[2J',
      'https://q.qq.com/x y',
      `https://q.qq.com/${'a'.repeat(1100)}`,
      'javascript:alert(1)',
      'not a url',
      42,
      null,
    ])
      expect(trustedScanUrl(bad)).toBeNull();
  });

  it('takes the three kinds of message with their own fields only', () => {
    expect(childMessage({ type: 'qr', url: URL_OK })).toEqual({ kind: 'qr', url: URL_OK });
    expect(
      childMessage({ type: 'credentials', appId: '102000078', appSecret: 'Secret-0123456789' }),
    ).toEqual({ kind: 'credentials', app: { appId: '102000078', secret: 'Secret-0123456789' } });
    expect(childMessage({ type: 'failed', reason: 'load' })).toEqual({
      kind: 'failed',
      why: 'load',
    });
    expect(childMessage({ type: 'failed', reason: 'service' })).toEqual({
      kind: 'failed',
      why: 'service',
    });
    for (const bad of [
      null,
      'qr',
      [],
      { type: 'qr' },
      { type: 'qr', url: 'http://q.qq.com/x' },
      { type: 'qr', url: 'https://q.qq.com\\@phish.example/connect.html' },
      { type: 'qr', url: URL_OK, extra: 1 },
      { type: 'credentials', appId: 'abc12345', appSecret: 'Secret-0123456789' },
      { type: 'credentials', appId: '1234', appSecret: 'Secret-0123456789' },
      { type: 'credentials', appId: 102000078, appSecret: 'Secret-0123456789' },
      { type: 'credentials', appId: '102000078', appSecret: 'short' },
      { type: 'credentials', appId: '102000078', appSecret: 'has a space 0123' },
      { type: 'credentials', appId: '102000078', appSecret: 'x'.repeat(129) },
      { type: 'credentials', appId: '102000078', appSecret: 'Secret-0123456789', userOpenid: 'u' },
      { type: 'failed', reason: 'other' },
      { type: 'failed', reason: 'load', message: 'HTTP 500 from somewhere' },
      { type: 'log', text: 'hello' },
    ])
      expect(childMessage(bad)).toBeNull();
  });
});

describe("the child's environment", () => {
  it('keeps PATH, LANG, LC_* and TZ, and nothing else', () => {
    expect(
      childEnvironment({
        PATH: '/usr/bin',
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8',
        LC_CTYPE: 'UTF-8',
        TZ: 'Asia/Shanghai',
        HOME: '/Users/someone',
        USER: 'someone',
        NODE_OPTIONS: '--require /tmp/x.js',
        YOMI_CONFIG_DIR: '/tmp/yomi',
        YOMI_QQ_API_ORIGIN: 'http://127.0.0.1:1',
        HTTPS_PROXY: 'http://proxy:1',
        lc_all: 'x',
        LC_: 'x',
        UNSET: undefined,
      }),
    ).toEqual({
      PATH: '/usr/bin',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      LC_CTYPE: 'UTF-8',
      TZ: 'Asia/Shanghai',
    });
  });
});

describe('which child runs', () => {
  it("never Tencent's connector against a loopback mock, only a test's child", () => {
    process.env.YOMI_QQ_API_ORIGIN = 'http://127.0.0.1:9';
    expect(connectChild()).toBeNull();
    QQ_CONNECT_TEST.child = '/tmp/fake-child.mjs';
    expect(connectChild()).toBe('/tmp/fake-child.mjs');
    // Not a QQ address at all: no scan.
    process.env.YOMI_QQ_API_ORIGIN = 'https://example.com';
    expect(connectChild()).toBeNull();
  });

  it("runs the built child for QQ's real API, and offers no scan from the sources", () => {
    delete process.env.YOMI_QQ_API_ORIGIN;
    QQ_CONNECT_TEST.child = '/tmp/fake-child.mjs';
    // The tests run the TypeScript sources, where the child is not built: nothing is started.
    expect(connectChild()).toBeNull();
  });
});

/** A fake `startQrConnect`: what it was given, and its callbacks to call. */
function fakeConnector() {
  const seen = {
    callbacks: null as QrConnectCallbacks | null,
    options: null as QrConnectOptions | null | undefined,
    stopped: 0,
  };
  const connect = (callbacks: QrConnectCallbacks, options?: QrConnectOptions) => {
    seen.callbacks = callbacks;
    seen.options = options;
    return () => {
      seen.stopped += 1;
    };
  };
  return { seen, connect };
}

describe("the child's use of the connector", () => {
  it('passes on each QR link, then the first bot only, then nothing; prints nothing', () => {
    const { seen, connect } = fakeConnector();
    const sent: ConnectMessage[] = [];
    serveConnect(connect, (message) => sent.push(message));
    // No console output, and no `source`: the scan page names a third-party bot.
    expect(seen.options).toEqual({ displayQrCodeToConsole: false });
    seen.callbacks!.onQrDisplayed!(URL_OK);
    // An expired code is followed by a new one: only the links matter.
    expect(seen.callbacks!.onQrExpired).toBeUndefined();
    seen.callbacks!.onQrDisplayed!(`${URL_OK}#2`);
    seen.callbacks!.onSuccess([
      { appId: '102000078', appSecret: 'Secret-0123456789', userOpenid: 'OPENID' },
      { appId: '102000079', appSecret: 'Other-0123456789' },
    ]);
    seen.callbacks!.onFailure(new Error('late'));
    seen.callbacks!.onQrDisplayed!(URL_OK);
    expect(sent).toEqual([
      { type: 'qr', url: URL_OK },
      { type: 'qr', url: `${URL_OK}#2` },
      { type: 'credentials', appId: '102000078', appSecret: 'Secret-0123456789' },
    ]);
  });

  it("says a failure without the connector's words, and stops it when asked", () => {
    const { seen, connect } = fakeConnector();
    const sent: ConnectMessage[] = [];
    serveConnect(connect, (message) => sent.push(message));
    seen.callbacks!.onFailure(new Error('HTTP 502 from https://q.qq.com/lite/create_bind_task'));
    expect(sent).toEqual([{ type: 'failed', reason: 'service' }]);

    const other = fakeConnector();
    const later: ConnectMessage[] = [];
    const stop = serveConnect(other.connect, (message) => later.push(message));
    stop();
    expect(other.seen.stopped).toBe(1);
    other.seen.callbacks!.onSuccess([{ appId: '102000078', appSecret: 'Secret-0123456789' }]);
    expect(later).toEqual([]);
  });

  it('runs nothing when imported (only as the child it was started as)', () => {
    expect(CHILD_MARK).toBe('--yomi-qq-connect');
    expect(process.argv).not.toContain(CHILD_MARK);
  });
});

const fakeChild = (name: string, steps: FakeStep[]) => fakeConnectChild(work, name, steps);
const gone = processGone;

async function events(scan: ReturnType<typeof startScan>): Promise<ScanEvent[]> {
  const seen: ScanEvent[] = [];
  for (;;) {
    const event = await scan.next();
    seen.push(event);
    if (event.kind !== 'qr') return seen;
  }
}

const TIMING = { startMs: 3000, overallMs: 6000 };

describe('a scan with a child process', () => {
  it('gives the QR links, then the AppID and AppSecret, and kills the child', async () => {
    const child = fakeChild('ok', [
      { send: { type: 'qr', url: URL_OK } },
      { send: { type: 'qr', url: `${URL_OK}2` } },
      { after: 50, send: { type: 'credentials', appId: '102000078', appSecret: 'Sec-0123456789' } },
    ]);
    const scan = startScan(child.path, TIMING);
    expect(await events(scan)).toEqual([
      { kind: 'qr', url: URL_OK },
      { kind: 'qr', url: `${URL_OK}2` },
      { kind: 'credentials', app: { appId: '102000078', secret: 'Sec-0123456789' } },
    ]);
    const { pid, argv } = child.record();
    expect(argv).toEqual([CHILD_MARK]);
    expect(await gone(pid)).toBe(true);
  });

  it('gets an environment of PATH, LANG, LC_* and TZ at most: no Yomi setting, no HOME', async () => {
    const before = { ...process.env };
    Object.assign(process.env, {
      YOMI_QQ_API_ORIGIN: 'http://127.0.0.1:9',
      YOMI_CONFIG_DIR: '/tmp/yomi-config',
      HOME: '/tmp/home',
      NODE_OPTIONS: '--no-warnings',
      LC_CTYPE: 'UTF-8',
    });
    try {
      const child = fakeChild('env', [{ send: { type: 'failed', reason: 'service' } }]);
      expect(await events(startScan(child.path, TIMING))).toEqual([
        { kind: 'failed', why: 'service' },
      ]);
      const { env, pid } = child.record();
      expect(env).toContain('LC_CTYPE');
      // macOS adds its text encoding to every process's environment itself.
      const own = (key: string) =>
        process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING';
      expect(env.filter((key) => !/^(PATH|LANG|TZ|LC_[A-Z]+)$/.test(key) && !own(key))).toEqual([]);
      expect(env.some((key) => key.startsWith('YOMI_') || key === 'HOME')).toBe(false);
      expect(await gone(pid)).toBe(true);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  it('fails on a message it may not send, on its own end, and on silence; kills it', async () => {
    const invalid = fakeChild('invalid', [{ send: { type: 'qr', url: 'http://q.qq.com/x' } }]);
    expect(await events(startScan(invalid.path, TIMING))).toEqual([
      { kind: 'failed', why: 'invalid' },
    ]);
    expect(await gone(invalid.record().pid)).toBe(true);

    const crash = fakeChild('crash', [
      { send: { type: 'qr', url: URL_OK } },
      { after: 100, exit: 3 },
    ]);
    expect(await events(startScan(crash.path, TIMING))).toEqual([
      { kind: 'qr', url: URL_OK },
      { kind: 'failed', why: 'crash' },
    ]);

    const silent = fakeChild('silent', []);
    expect(await events(startScan(silent.path, { startMs: 200, overallMs: 5000 }))).toEqual([
      { kind: 'failed', why: 'start' },
    ]);
    expect(await gone(silent.record().pid)).toBe(true);

    const slow = fakeChild('slow', [{ send: { type: 'qr', url: URL_OK } }]);
    expect(await events(startScan(slow.path, { startMs: 2000, overallMs: 300 }))).toEqual([
      { kind: 'qr', url: URL_OK },
      { kind: 'failed', why: 'timeout' },
    ]);
    expect(await gone(slow.record().pid)).toBe(true);

    const missing = startScan(join(work, 'no-such-child.mjs'), TIMING);
    expect((await events(missing)).at(-1)).toEqual({ kind: 'failed', why: 'crash' });
  });

  it('kills the child when stopped', async () => {
    const child = fakeChild('stopped', [{ send: { type: 'qr', url: URL_OK } }]);
    const scan = startScan(child.path, TIMING);
    expect(await scan.next()).toEqual({ kind: 'qr', url: URL_OK });
    scan.stop();
    expect(await gone(child.record().pid)).toBe(true);
  });
});

/** A guide on a terminal `columns` wide (or not a terminal), and what it wrote since `taken`. */
function screen(tty: boolean, columns = 40) {
  let out = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        out += chunk.toString();
        done();
      },
    }),
    tty ? { isTTY: true, columns } : {},
  );
  const ui = new GuideUi({
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    interactive: true,
    colour: false,
  });
  return {
    ui,
    taken() {
      const written = out;
      out = '';
      return written;
    },
  };
}

describe('the code erased from the terminal', () => {
  it('takes back every row written in the region, a wrapped line and the prompt too', () => {
    const { ui, taken } = screen(true);
    ui.say('before');
    const region = ui.region();
    ui.say('a');
    // 52 columns: two rows of 40.
    ui.lines('x'.repeat(50));
    ui.write('  m: … ');
    taken();
    region.clear();
    expect(taken()).toBe('\r\u001b[3A\u001b[J');
    // The region goes on after a clear (a new code drawn), counted from there.
    ui.say('b');
    taken();
    region.close();
    expect(taken()).toBe('\r\u001b[1A\u001b[J');
    // Closed: nothing is counted or erased any more.
    ui.say('after');
    region.close();
    expect(taken()).toBe('after\n');
  });

  it('erases nothing elsewhere than at a terminal', () => {
    const { ui, taken } = screen(false);
    const region = ui.region();
    ui.say('a');
    taken();
    region.close();
    expect(taken()).toBe('');
  });
});

/**
 * A terminal `columns` wide for the guide: keys come one by one in raw mode (Ctrl+C is a byte
 * there, not SIGINT), and what was written is read back.
 */
function terminal(columns: number) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    },
  });
  let out = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        out += chunk.toString();
        done();
      },
    }),
    { isTTY: true, columns },
  );
  const ui = new GuideUi({
    stdin,
    stdout,
    stderr: new PassThrough(),
    interactive: true,
    colour: false,
  });
  return { ui, stdin, out: () => out };
}

async function waitFor(read: () => string, pattern: RegExp, ms = 5000) {
  for (const started = Date.now(); !pattern.test(read()); ) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${pattern}\n${read()}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** The guide taking back rows: up that many (none: the line it is on), then clear below. */
const ERASE = /\r(?:\u001b\[(\d+)A)?\u001b\[J/g;
/** A line of the drawn code (half blocks, no colours). */
const DRAWN = /^[█▀▄ ]{20,}$/m;
const SCANNED = { type: 'credentials', appId: '102000078', appSecret: 'Sec-0123456789' };

/** What was shown between the last two erases, and how many rows the last one went up. */
function lastShown(out: string) {
  const erases = [...out.matchAll(ERASE)];
  expect(erases.length).toBeGreaterThanOrEqual(2);
  const [before, last] = erases.slice(-2);
  return {
    shown: out.slice(before.index! + before[0].length, last.index),
    up: Number(last[1] ?? 0),
    after: out.slice(last.index! + last[0].length),
  };
}

describe("the scan at the guide's terminal", () => {
  it('prints the link when the terminal is too narrow for the code, and erases every row of it', async () => {
    setLanguage('zh');
    process.env.YOMI_QQ_API_ORIGIN = 'http://127.0.0.1:9';
    const child = fakeChild('narrow', [
      { send: { type: 'qr', url: URL_OK } },
      { after: 300, send: SCANNED },
    ]);
    QQ_CONNECT_TEST.child = child.path;
    const screen = terminal(30);
    expect(await scannedApp(screen.ui)).toEqual({ appId: '102000078', secret: 'Sec-0123456789' });
    const out = screen.out();
    expect(out).not.toMatch(/[█▀▄]/);
    const { shown, up, after } = lastShown(out);
    expect(shown).toContain('终端太窄，画不下二维码');
    expect(shown).toContain(`\n  ${URL_OK}\n`);
    // The link and the Chinese lines wrap on 30 columns: the cursor goes up past all their rows.
    const rows = terminalRows(shown.replace(/\n$/, ''), 30);
    expect(rows).toBeGreaterThan(shown.split('\n').length + 3);
    expect(up).toBe(rows);
    // Printed once, and erased: after it only the scan's result.
    expect(out.split(URL_OK).length - 1).toBe(1);
    expect(after).toBe('  ✓ 扫码完成：AppID 102000078\n');
    expect(screen.stdin.isRaw).toBe(false);
    expect(await gone(child.record().pid)).toBe(true);
  });

  it('prints a link too long for a code in the language asked for, and erases it', async () => {
    setLanguage('en');
    process.env.YOMI_QQ_API_ORIGIN = 'http://127.0.0.1:9';
    // Longer than a code of the highest version drawn takes (213 bytes), but a link taken.
    const long = `${URL_OK}&pad=${'a'.repeat(300)}`;
    expect(trustedScanUrl(long)).toBe(long);
    const child = fakeChild('too-long', [
      { send: { type: 'qr', url: long } },
      { after: 300, send: SCANNED },
    ]);
    QQ_CONNECT_TEST.child = child.path;
    const screen = terminal(200);
    expect(await scannedApp(screen.ui)).toEqual({ appId: '102000078', secret: 'Sec-0123456789' });
    const out = screen.out();
    expect(out).not.toMatch(/[█▀▄]/);
    const { shown, up, after } = lastShown(out);
    expect(shown).toContain('The terminal is too narrow to draw the QR code');
    expect(shown).toContain(`\n  ${long}\n`);
    expect(up).toBe(terminalRows(shown.replace(/\n$/, ''), 200));
    expect(after).toBe('  ✓ Scanned: AppID 102000078\n');
    expect(out.replaceAll(QQ_CONSOLE_ZH.thirdParty, '')).not.toMatch(/[㐀-鿿＀-￯　-〿]/);
    expect(await gone(child.record().pid)).toBe(true);
  });

  it('leaves on Ctrl+C at the terminal (a byte in raw mode), erasing the code and killing the child', async () => {
    setLanguage('zh');
    process.env.YOMI_QQ_API_ORIGIN = 'http://127.0.0.1:9';
    const child = fakeChild('raw-interrupt', [{ send: { type: 'qr', url: URL_OK } }]);
    QQ_CONNECT_TEST.child = child.path;
    const screen = terminal(100);
    const pending = scannedApp(screen.ui);
    await waitFor(screen.out, /扫上面的二维码：\n {2}m：改为手动输入 · q：退出 $/);
    expect(screen.out()).toMatch(DRAWN);
    screen.stdin.write('\u0003');
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GuideCancelled);
    expect((error as GuideCancelled).how).toBe('interrupt');
    // The code is taken back from the terminal before the guide ends: the cursor is still on the
    // prompt's line (Ctrl+C ended no line), so up past every row above it.
    const { shown, up, after } = lastShown(screen.out());
    expect(shown).toMatch(DRAWN);
    expect(shown).toMatch(/q：退出 $/);
    expect(up).toBe(terminalRows(shown, 100) - 1);
    expect(after).toBe('');
    expect(screen.stdin.isRaw).toBe(false);
    expect(await gone(child.record().pid)).toBe(true);
  });

  it('gives the scan up on m at the terminal, and kills the child', async () => {
    setLanguage('zh');
    process.env.YOMI_QQ_API_ORIGIN = 'http://127.0.0.1:9';
    const child = fakeChild('raw-manual', [{ send: { type: 'qr', url: URL_OK } }]);
    QQ_CONNECT_TEST.child = child.path;
    const screen = terminal(100);
    const pending = scannedApp(screen.ui);
    await waitFor(screen.out, /扫上面的二维码：\n {2}m：改为手动输入 · q：退出 $/);
    screen.stdin.write('m');
    expect(await pending).toBe('manual');
    expect(lastShown(screen.out()).after).toBe('');
    expect(screen.stdin.isRaw).toBe(false);
    expect(await gone(child.record().pid)).toBe(true);
  });
});

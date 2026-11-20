import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { configDir } from '../src/core/files.js';
import { type MockQq, type MockQqApp, startMockQq } from '../src/mock/qq.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import { QQ_CONNECT_TEST } from '../src/relay/channels/qq-connect.js';
import { GUIDE_TIMINGS } from '../src/relay/guide/steps.js';
import { BotRegistry } from '../src/relay/registry.js';
import { authorizeLikeTheBrowser } from './helpers/authorize.js';
import { type FakeStep, fakeConnectChild, processGone, SCAN_URL } from './helpers/fake-connect.js';
import { memoryIo } from './helpers/io.js';

/**
 * Step 3 of `yomi relay --setup` with the QR scan, end to end against the mock gateway and the mock
 * QQ: a fake child process stands for Tencent's connector (`QQ_CONNECT_TEST.child`, honoured only
 * with the loopback mock), giving a QR link and then the AppID and AppSecret of a bot of the mock,
 * which the guide checks with QQ like typed ones. The scan ends in typing them when it is given up
 * (m), times out, its child ends or says something it may not, or the connector cannot load; q and
 * Ctrl+C leave. Whichever way it ends, the child is killed. Nothing reaches the network.
 */

vi.mock('../src/relay/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/service.js')>();
  return {
    ...real,
    servicePid: () => 0,
    pauseService: () => undefined,
    resumeService: () => true,
    installService: () => undefined,
    uninstallService: () => true,
  };
});

let mock: MockServer;
let qq: MockQq;
let home: string;
let work: string;
const saved: Record<string, string | undefined> = {};
const npc = MOCK_NPCS.single;
const timings = { ...GUIDE_TIMINGS };

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const registry = () => BotRegistry.open(createContext(memoryIo().io, {}).account);
const forgetAll = async () =>
  expect(await main(['relay', '--forget', '--all'], memoryIo().io)).toBe(0);

/** `yomi relay --setup` in an interactive in-memory terminal (relay-setup.e2e.test.ts). */
function guided() {
  process.exitCode = undefined;
  const terminal = memoryIo({ interactive: true });
  let seen = 0;
  const done = main(['relay', '--setup', '--allow-file-store'], terminal.io);
  const next = async (pattern: RegExp, timeoutMs = 10_000) => {
    const started = Date.now();
    for (;;) {
      const match = pattern.exec(terminal.out.slice(seen));
      if (match) {
        seen += (match.index ?? 0) + match[0].length;
        return match;
      }
      if (Date.now() - started > timeoutMs)
        throw new Error(`timed out waiting for ${pattern}\n${terminal.out}\n${terminal.err}`);
      await sleep(15);
    }
  };
  return {
    done,
    next,
    async answer(pattern: RegExp, text: string) {
      await next(pattern);
      terminal.stdin.write(`${text}\n`);
    },
    get out() {
      return terminal.out;
    },
    get all() {
      return terminal.out + terminal.err;
    },
  };
}

type Guided = ReturnType<typeof guided>;

const CHARACTER_PROMPT = /粘贴链接或角色 ID（只显示其中的数字）：/;
const IS_IT = /是这个角色吗？\[y\/n\] /;
const CHECKPOINT = /q：退出 /;
const SCAN_PROMPT = /m：改为手动输入 · q：退出 /;
const APPID = /AppID（只显示数字(；直接回车沿用 \d+)?）：/;
const APPSECRET = /AppSecret（输入时不显示）：/;
const RUN_CHOICE = /选一个（q：退出）： /;
/** A line of the drawn code (half blocks, no colours). */
const DRAWN = /^[█▀▄ ]{20,}$/m;

/** Steps 1 and 2, up to step 3 with the scan's child `steps` (a fake of the connector). */
async function toScan(name: string, steps: FakeStep[]) {
  const child = fakeConnectChild(work, name, steps);
  QQ_CONNECT_TEST.child = child.path;
  const session = guided();
  await session.answer(CHARACTER_PROMPT, npc);
  await session.answer(IS_IT, 'y');
  await session.next(/下一步用手机 QQ 扫码取得参数（扫不了的话，再从这页复制），先别离开。/);
  await session.answer(CHECKPOINT, '');
  await session.next(/第 3 步，共 7 步 · 输入 AppID 和 AppSecret/);
  await session.next(/扫码页上会显示「第三方机器人」：那就是这里的 yomi。/);
  return { child, session };
}

/** The AppID and AppSecret typed, then QQ's check, the bot saved, and q at step 5. */
async function typedAndSaved(session: Guided, app: MockQqApp) {
  await session.next(/在「设置 AI 服务」 → 「手动绑定参数」里复制/);
  await session.answer(APPID, app.appId);
  await session.answer(APPSECRET, app.secret);
  await session.next(new RegExp(`✓ QQ 接受了：机器人「.+」（AppID ${app.appId}）`));
  await session.next(/✓ 已添加 bot /);
  await session.answer(RUN_CHOICE, 'q');
  expect(await session.done).toBe(0);
}

const credentials = (app: MockQqApp) => ({
  type: 'credentials',
  appId: app.appId,
  appSecret: app.secret,
});

beforeAll(async () => {
  mock = await startMockServer();
  qq = await startMockQq({ botName: 'Scan QQ bot' });
  home = mkdtempSync(join(tmpdir(), 'yomi-relay-scan-home-'));
  work = mkdtempSync(join(tmpdir(), 'yomi-relay-scan-child-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_QQ_API_ORIGIN: qq.origin,
    YOMI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'yomi-relay-scan-')),
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
    HOME: home,
  });
  mock.state.relayPolicy = { enabled: true, features: { free_only: true, spend_cap: true } };
  Object.assign(GUIDE_TIMINGS, { identifyIntervalMs: 400, notConnectedMs: 1500 });
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  await authorizeLikeTheBrowser(mock, url);
  expect(await pending).toBe(0);
});

afterEach(async () => {
  QQ_CONNECT_TEST.child = '';
  Object.assign(GUIDE_TIMINGS, {
    scanStartMs: timings.scanStartMs,
    scanMs: timings.scanMs,
  });
  await forgetAll();
});

afterAll(async () => {
  Object.assign(GUIDE_TIMINGS, timings);
  await qq.shutdown();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('step 3 scans with QQ on the phone first', () => {
  it('draws the code, takes the AppID and AppSecret QQ accepts, and kills the child', async () => {
    const app = qq.addApp({ botName: 'Scanned Lin' });
    const { child, session } = await toScan('scanned', [
      { send: { type: 'qr', url: SCAN_URL } },
      // The code expired: a new one.
      { after: 150, send: { type: 'qr', url: `${SCAN_URL}2` } },
      { after: 150, send: credentials(app) },
    ]);
    await session.next(/用手机 QQ 扫上面的二维码：/);
    await session.next(/二维码过期了，换了一个新的（第 2 个）。用手机 QQ 扫码：/);
    await session.next(new RegExp(`✓ 扫码完成：AppID ${app.appId}`));
    await session.next(/正在向 QQ 核对……/);
    await session.next(new RegExp(`✓ QQ 接受了：机器人「Scanned Lin」（AppID ${app.appId}）`));
    await session.next(/第 4 步，共 7 步 · 检查私聊权限并保存/);
    await session.next(/✓ 已添加 bot qq-\d{4}，固定和林夏/);
    await session.answer(RUN_CHOICE, 'q');
    expect(await session.done).toBe(0);
    // Drawn, never printed as a link; nothing to type; the AppSecret only in the keychain's file.
    expect(session.out).toMatch(DRAWN);
    expect(session.all).not.toContain(SCAN_URL);
    expect(session.out).not.toMatch(APPID);
    expect(session.all).not.toContain(app.secret);
    expect(readFileSync(join(configDir(), 'secrets.json'), 'utf8')).toContain(app.secret);
    expect(registry().byPlatform('qq', app.appId)).toBeTruthy();
    // Started as the scan's child, and killed once it gave the AppID and AppSecret.
    expect(child.record().argv).toEqual(['--yomi-qq-connect']);
    expect(await processGone(child.record().pid)).toBe(true);
  });

  it('gives the child PATH, LANG, LC_* and TZ at most: no Yomi setting, no HOME', async () => {
    const app = qq.addApp({ botName: 'Env Lin' });
    const { child, session } = await toScan('environment', [
      { send: { type: 'qr', url: SCAN_URL } },
      { after: 100, send: credentials(app) },
    ]);
    await session.next(/✓ 已添加 bot /);
    await session.answer(RUN_CHOICE, 'q');
    expect(await session.done).toBe(0);
    const { env } = child.record();
    // macOS adds its text encoding to every process's environment itself.
    const own = (key: string) => process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING';
    expect(env.filter((key) => !/^(PATH|LANG|TZ|LC_[A-Z]+)$/.test(key) && !own(key))).toEqual([]);
    expect(env.some((key) => key.startsWith('YOMI_'))).toBe(false);
    expect(env).not.toContain('HOME');
  });

  it('checks what the scan gave with QQ, and asks for it typed when QQ refuses it', async () => {
    const app = qq.addApp({ botName: 'Refused Scan Lin' });
    app.failNext('token', { code: 100016 });
    const { session } = await toScan('refused', [
      { send: { type: 'qr', url: SCAN_URL } },
      { after: 100, send: credentials(app) },
    ]);
    await session.next(/✗ QQ 不接受这对 AppID 和 AppSecret（100016）/);
    // The AppID scanned is kept on Enter.
    await session.answer(new RegExp(`AppID（只显示数字；直接回车沿用 ${app.appId}）：`), '');
    await session.answer(APPSECRET, app.secret);
    await session.next(/✓ 已添加 bot /);
    await session.answer(RUN_CHOICE, 'q');
    expect(await session.done).toBe(0);
    expect(session.all).not.toContain(app.secret);
  });
});

describe('the scan falls back to typing the AppID and AppSecret', () => {
  it('on m, with the child killed', async () => {
    const app = qq.addApp({ botName: 'Typed Lin' });
    const { child, session } = await toScan('given-up', [{ send: { type: 'qr', url: SCAN_URL } }]);
    await session.next(/用手机 QQ 扫上面的二维码：/);
    await session.answer(SCAN_PROMPT, 'm');
    await typedAndSaved(session, app);
    expect(session.all).not.toMatch(/✗/);
    expect(await processGone(child.record().pid)).toBe(true);
  });

  it('when not scanned in time', async () => {
    GUIDE_TIMINGS.scanMs = 600;
    const app = qq.addApp({ botName: 'Late Lin' });
    const { child, session } = await toScan('late', [{ send: { type: 'qr', url: SCAN_URL } }]);
    await session.next(/✗ 扫码超时了。改为手动输入。/);
    await typedAndSaved(session, app);
    expect(await processGone(child.record().pid)).toBe(true);
  });

  it('when the child ends on its own', async () => {
    const app = qq.addApp({ botName: 'Crash Lin' });
    const { session } = await toScan('crash', [
      { send: { type: 'qr', url: SCAN_URL } },
      { after: 150, exit: 7 },
    ]);
    await session.next(/✗ 腾讯的扫码组件意外退出了。改为手动输入。/);
    await typedAndSaved(session, app);
  });

  it('when the child says what it may not, never printing it, and kills it', async () => {
    const app = qq.addApp({ botName: 'Invalid Lin' });
    const evil = 'https://evil.example/connect?task_id=x';
    const { child, session } = await toScan('invalid', [{ send: { type: 'qr', url: evil } }]);
    await session.next(/✗ 腾讯的扫码组件发来了不该有的内容，已经停掉它。改为手动输入。/);
    await typedAndSaved(session, app);
    expect(session.all).not.toContain('evil.example');
    expect(session.out).not.toMatch(DRAWN);
    expect(await processGone(child.record().pid)).toBe(true);

    // Credentials of the wrong shape are not checked with QQ either.
    await forgetAll();
    const calls = app.calls.length;
    const other = await toScan('invalid-credentials', [
      { send: { type: 'qr', url: SCAN_URL } },
      { after: 100, send: { type: 'credentials', appId: 'not-digits', appSecret: app.secret } },
    ]);
    await other.session.next(/✗ 腾讯的扫码组件发来了不该有的内容/);
    await other.session.answer(APPID, 'q');
    expect(await other.session.done).toBe(0);
    expect(app.calls.length).toBe(calls);
    expect(other.session.all).not.toContain(app.secret);
  });

  it('when the connector cannot load, or gives no code in time', async () => {
    const app = qq.addApp({ botName: 'Unloaded Lin' });
    const { session } = await toScan('unloaded', [{ send: { type: 'failed', reason: 'load' } }]);
    await session.next(/✗ 没能启动腾讯的扫码组件。改为手动输入。/);
    await typedAndSaved(session, app);

    await forgetAll();
    GUIDE_TIMINGS.scanStartMs = 300;
    const silent = await toScan('silent', []);
    await silent.session.next(/正在准备二维码……/);
    await silent.session.next(
      /✗ 没能拿到二维码（网络，或者腾讯的扫码服务暂时不可用）。改为手动输入。/,
    );
    await silent.session.answer(APPID, 'q');
    expect(await silent.session.done).toBe(0);
    expect(await processGone(silent.child.record().pid)).toBe(true);
  });
});

describe('leaving during the scan', () => {
  it('q quits with nothing saved, and kills the child', async () => {
    const { child, session } = await toScan('quit', [{ send: { type: 'qr', url: SCAN_URL } }]);
    await session.next(/用手机 QQ 扫上面的二维码：/);
    await session.answer(SCAN_PROMPT, 'q');
    expect(await session.done).toBe(0);
    expect(session.out).toContain('已退出，什么都没有保存。');
    expect(registry().list()).toEqual([]);
    expect(await processGone(child.record().pid)).toBe(true);
  });

  it('Ctrl+C ends it with 130, nothing saved, and kills the child', async () => {
    const { child, session } = await toScan('interrupted', [
      { send: { type: 'qr', url: SCAN_URL } },
    ]);
    await session.next(SCAN_PROMPT);
    await sleep(100);
    process.emit('SIGINT');
    expect(await session.done).toBe(130);
    expect(session.out).toContain('已退出，什么都没有保存。');
    expect(session.all).not.toMatch(/意外退出/);
    expect(registry().list()).toEqual([]);
    expect(await processGone(child.record().pid)).toBe(true);
  });
});

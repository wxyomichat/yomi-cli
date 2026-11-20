import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { pairedLines } from '../src/commands/relay-setup.js';
import { configDir } from '../src/core/files.js';
import { acquireProcessLock } from '../src/core/lock.js';
import { sha256 } from '../src/core/state.js';
import { type MockQq, type MockQqApp, startMockQq } from '../src/mock/qq.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import { noPrivateChatText } from '../src/relay/channels/qq-gateway.js';
import { BotRegistry } from '../src/relay/registry.js';
import { servicePlan } from '../src/relay/service.js';
import { GUIDE_TIMINGS, GuideUi } from '../src/relay/guide/steps.js';
import { RelayState, relayStatePath } from '../src/relay/state.js';
import { authorizeLikeTheBrowser } from './helpers/authorize.js';
import { memoryIo } from './helpers/io.js';

/**
 * `yomi relay --setup` end to end, against the mock gateway (src/mock/server.ts) and the mock QQ
 * (src/mock/qq.ts), answering the guide's prompts one by one in an in-memory terminal: the steps
 * from nothing to a paired bot (each way it can run after), what each error in a step says and
 * that it stays in its step, leaving and going on again, Ctrl+C, the background service stopped
 * for saving and pairing, and what refuses the guide before its first step. Nothing reaches the
 * network; no service manager or browser is asked (the service module and the browser are the
 * test's).
 */

const service = vi.hoisted(() => ({
  pid: 0,
  paused: 0,
  resumed: 0,
  installed: 0,
  /** The service manager refuses the next installs. */
  failInstall: false,
  onPause: null as (() => void) | null,
  onResume: null as (() => void) | null,
}));

vi.mock('../src/relay/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/service.js')>();
  const { rmSync: remove } = await import('node:fs');
  return {
    ...real,
    servicePid: () => service.pid,
    pauseService: () => {
      service.paused += 1;
      service.onPause?.();
    },
    resumeService: () => {
      service.resumed += 1;
      service.onResume?.();
      return true;
    },
    installService: () => {
      if (service.failInstall) throw new Error('the service manager refused the unit');
      service.installed += 1;
    },
    uninstallService: (plan: { path: string }) => {
      remove(plan.path, { force: true });
      return true;
    },
  };
});

const browser = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock('../src/auth/browser.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth/browser.js')>();
  return {
    ...real,
    openBrowser: async (url: string) => {
      browser.opened.push(url);
      return true;
    },
  };
});

const production = vi.hoisted(() => ({ on: false }));

vi.mock('../src/core/env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/env.js')>();
  return {
    ...real,
    isProduction: (env: Parameters<typeof real.isProduction>[0]) =>
      production.on || real.isProduction(env),
  };
});

let mock: MockServer;
let qq: MockQq;
let home: string;
const saved: Record<string, string | undefined> = {};
const OWNER = 'OPENID_OWNER_SETUP';
const npc = MOCK_NPCS.single;

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(args: string[], options: Parameters<typeof memoryIo>[0] = {}) {
  process.exitCode = undefined;
  const terminal = memoryIo(options);
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
}

const context = () => createContext(memoryIo().io, {});
const registry = () => BotRegistry.open(context().account);
const hash = () => sha256(context().account).slice(0, 16);
const stateFor = (name: string) => {
  const { account } = context();
  const record = registry().find(name)!;
  return new RelayState(relayStatePath(account, record.scope), record.scope, account, 'qq');
};
const ownerOf = (name: string) => stateFor(name).data.owner;
/** The bot `name` paired with `openid` already (as a pairing in the chat would leave it). */
const ownedBy = (name: string, openid: string) =>
  stateFor(name).bindOwner({
    userId: openid,
    chatId: openid,
    name: '',
    language: 'zh',
    pairedAt: Date.now(),
  });

/**
 * `yomi relay --setup` in an interactive in-memory terminal: `next` waits for a pattern after what
 * it waited for before, `answer` then types a line (a key prompt takes its first character, an
 * empty line is Enter).
 */
function guided(args: string[] = []) {
  process.exitCode = undefined;
  const terminal = memoryIo({ interactive: true });
  let seen = 0;
  const done = main(['relay', '--setup', '--allow-file-store', ...args], terminal.io);
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
    terminal,
    done,
    next,
    async answer(pattern: RegExp, text: string) {
      await next(pattern);
      terminal.stdin.write(`${text}\n`);
    },
    type(text: string) {
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
const APPID = /AppID（只显示数字(；直接回车沿用 \d+)?）：/;
const APPSECRET = /AppSecret（输入时不显示）：/;
const RUN_CHOICE = /选一个（q：退出）： /;
const CODE = /\/pair ([A-Z2-9]{4}-[A-Z2-9]{4})/;

/** Steps 1 to 4 for `app` with `character`, up to the bot saved. */
async function throughSave(session: Guided, app: MockQqApp, character: string = npc) {
  await session.answer(CHARACTER_PROMPT, character);
  await session.answer(IS_IT, 'y');
  await session.answer(CHECKPOINT, '');
  await session.answer(APPID, app.appId);
  await session.answer(APPSECRET, app.secret);
  await session.next(/✓ 已添加 bot /);
}

beforeAll(async () => {
  mock = await startMockServer();
  qq = await startMockQq({ botName: 'Lin QQ bot' });
  home = mkdtempSync(join(tmpdir(), 'yomi-relay-setup-home-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_QQ_API_ORIGIN: qq.origin,
    YOMI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'yomi-relay-setup-')),
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
    // Never the real ~/Library/LaunchAgents or ~/.config/systemd/user.
    HOME: home,
  });
  mock.state.relayPolicy = { enabled: true, features: { free_only: true, spend_cap: true } };
  mock.state.chatFreeLimit = 1000;
  mock.state.gems = 500;
  Object.assign(GUIDE_TIMINGS, { identifyIntervalMs: 400, notConnectedMs: 1500 });
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  await authorizeLikeTheBrowser(mock, url);
  expect(await pending).toBe(0);
});

afterEach(async () => {
  Object.assign(service, {
    pid: 0,
    paused: 0,
    resumed: 0,
    installed: 0,
    failInstall: false,
    onPause: null,
    onResume: null,
  });
  browser.opened.length = 0;
  production.on = false;
  qq.clearFailures();
  expect((await run(['relay', '--forget', '--all'])).code).toBe(0);
});

afterAll(async () => {
  await qq.shutdown();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * The background service's unit, as `--install-service` would write it (the hub's, or a channel's
 * of before it), under the test's HOME.
 */
function installHubService(channel: 'hub' | 'telegram' = 'hub'): string {
  const path = servicePlan({
    account: context().account,
    channel,
    node: process.execPath,
    script: 'cli.js',
    args: [],
    environment: {},
    logDir: join(home, 'logs'),
  }).path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '# installed\n');
  return path;
}

/**
 * The background service running: its unit installed, its process this one's, holding the
 * environment's lock; stopped, it lets go of the lock, and started again, it takes it again.
 */
function runningService(channel: 'hub' | 'telegram' = 'hub') {
  const path = installHubService(channel);
  const file = join(configDir(), 'locks', `relay-env-${hash()}.lock`);
  let held: { release: () => void } | null = null;
  const take = () => {
    const lock = acquireProcessLock(file, { channel: 'qq' });
    held = 'release' in lock ? lock : null;
  };
  take();
  Object.assign(service, {
    pid: process.pid,
    onPause: () => {
      held?.release();
      held = null;
    },
    onResume: take,
  });
  return {
    stop() {
      held?.release();
      held = null;
      service.pid = 0;
      rmSync(path, { force: true });
    },
  };
}

/** A QQ bot added with `--set-app` (not paired), with `args` (`--bot`, `--character`). */
async function addedWithSetApp(app: MockQqApp, args: string[]) {
  const added = await run(
    ['relay', '--channel', 'qq', '--set-app', '--token-stdin', '--allow-file-store', ...args],
    { input: [app.appId, app.secret] },
  );
  expect(added.code, added.err).toBe(0);
}

/** Pairs a guided session's bot once its code shows (as `friend` or not). */
async function pairs(session: Guided, app: MockQqApp, friend = true) {
  const code = (await session.next(CODE))[1];
  app.userSends(OWNER, `/pair ${code}`, { friend });
  await session.next(/✓ 已配对：QQ 用户 OP…UP/);
}

describe('yomi relay --setup, from nothing to a paired bot', () => {
  it('goes through the seven steps, pairs in the same process, and only pairs (3)', async () => {
    const app = qq.addApp({ botName: 'Bookshop Lin' });
    const identified = app.identifiedAt.length;
    const session = guided();
    await session.next(/通道：QQ（Telegram 用 --set-token/);
    await session.next(/· 服务端没有确认这个通道（QQ）：这不是正式环境/);
    await session.next(/第 1 步，共 7 步 · 选择角色/);
    await session.answer(CHARACTER_PROMPT, `https://www.yomichat.io/character/${npc}?from=share`);
    await session.next(new RegExp(`林夏（${npc}）`));
    await session.answer(IS_IT, 'y');
    await session.next(/第 2 步，共 7 步 · 在 QQ 开放平台创建机器人/);
    // o opens the console in the browser, and asks again.
    await session.answer(CHECKPOINT, 'o');
    await session.next(/已在浏览器里打开 https:\/\/q\.qq\.com\/#\/apps/);
    expect(browser.opened).toEqual(['https://q.qq.com/#/apps']);
    await session.answer(CHECKPOINT, '');
    await session.next(/第 3 步，共 7 步 · 输入 AppID 和 AppSecret/);
    await session.answer(APPID, app.appId);
    await session.answer(APPSECRET, app.secret);
    await session.next(new RegExp(`✓ QQ 接受了：机器人「Bookshop Lin」（AppID ${app.appId}）`));
    await session.next(/第 4 步，共 7 步 · 检查私聊权限并保存/);
    await session.next(/今天还剩 \d+ 次；这次检查用 1 次，配对再用 1 次。/);
    await session.next(/✓ 能收到私聊消息。/);
    const name = (await session.next(/✓ 已添加 bot (qq-\d{4})，固定和林夏/))[1];
    await session.next(/第 5 步，共 7 步 · 之后怎样运行/);
    await session.answer(RUN_CHOICE, '3');
    await session.next(/第 6 步，共 7 步 · 加机器人为 QQ 好友/);
    await session.answer(CHECKPOINT, '');
    await session.next(/第 7 步，共 7 步 · 连接并配对/);
    await session.next(
      /✓ 已连上（q\.qq\.com 上这个机器人应该显示「在线」）。在手机 QQ 里打开和「Bookshop Lin」的私聊/,
    );
    await pairs(session, app);
    await session.next(/✓ 机器人已在 QQ 里回复：配对结果、封面、简介和开场白。/);
    await session.next(
      /relay 已停止：现在发给机器人的消息它收不到。运行 yomi relay --allow-file-store（终端）或 yomi relay --allow-file-store --install-service（后台服务）以后/,
    );
    expect(await session.done).toBe(0);
    // What reached QQ is said once, by the guide: not the relay's own line about the welcome.
    expect(session.out).not.toContain('已向主人发送');
    // Two connections: the check and the pairing, QQ's spacing kept between them.
    const times = app.identifiedAt.slice(identified);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(GUIDE_TIMINGS.identifyIntervalMs - 20);
    // The welcome: the pairing with the character and the notice, the cover, the introduction.
    expect(app.messages(OWNER).map((message) => message.kind)).toEqual(['text', 'media', 'text']);
    // The AppSecret is only in the keychain's file; the run's own log lines are the guide's.
    expect(session.all).not.toContain(app.secret);
    expect(session.all).not.toContain(OWNER);
    expect(session.out).not.toContain('relay 运行中');
    expect(readFileSync(join(configDir(), 'secrets.json'), 'utf8')).toContain(app.secret);
    expect(ownerOf(name)?.userId).toBe(OWNER);
    const listed = await run(['relay', '--list']);
    expect(listed.out).toContain(`${name}  QQ  Bookshop Lin`);
    expect(listed.out).toContain(`角色：林夏（${npc}）`);
    expect(listed.out).toContain('主人：OP…UP');

    // Set up already: --setup sets its AppSecret again, in two steps, without the gateway.
    const reset = guided(['--bot', name]);
    await reset.next(/第 1 步，共 2 步 · 在 q\.qq\.com 重置 AppSecret/);
    await reset.answer(CHECKPOINT, '');
    await reset.next(/第 2 步，共 2 步 · 输入新的 AppSecret/);
    await reset.answer(APPSECRET, app.resetSecret());
    await reset.next(new RegExp(`✓ 已保存 ${name} 的新 AppSecret`));
    await reset.next(/完成 · 列出 bot：yomi relay --list/);
    expect(await reset.done).toBe(0);
    expect(app.identifiedAt.length).toBe(identified + 2);
    expect(readFileSync(join(configDir(), 'secrets.json'), 'utf8')).toContain(app.secret);
    expect(reset.all).not.toContain(app.secret);
    // Without --bot, the bot set up is offered in a menu.
    const menu = guided();
    await menu.next(new RegExp(`这台电脑上已有 QQ bot：${name}（林夏，已配对）。`));
    await menu.answer(
      /1：再添加一个 QQ bot（和另一个角色聊天） · 2：重新设置某个 bot 的 AppSecret · q：退出 /,
      'q',
    );
    expect(await menu.done).toBe(0);
  });

  it('goes on running in this terminal after pairing (1), until Ctrl+C', async () => {
    const app = qq.addApp({ botName: 'Terminal Lin' });
    // --character answers step 1; its name is still confirmed.
    const session = guided(['--character', npc]);
    await session.next(/第 1 步，共 7 步 · 选择角色/);
    await session.next(new RegExp(`林夏（${npc}）`));
    await session.answer(IS_IT, 'y');
    await session.answer(CHECKPOINT, '');
    await session.answer(APPID, app.appId);
    await session.answer(APPSECRET, app.secret);
    await session.next(/✓ 已添加 bot /);
    expect(session.out).not.toMatch(CHARACTER_PROMPT);
    await session.answer(RUN_CHOICE, '1');
    await session.answer(CHECKPOINT, '');
    await pairs(session, app);
    await session.next(/✓ relay 接着在这个终端里运行：直接回复，就是在和林夏聊天。/);
    await app.waitFor(() => app.messages(OWNER).length >= 3);
    const asked = app.userSends(OWNER, '你好');
    await app.waitFor(
      () =>
        app
          .messages(OWNER)
          .find(
            (message) => message.replyTo === asked && message.kind === 'stream' && message.done,
          ),
      15_000,
    );
    // Its log is the relay's own now, on stderr with times.
    await sleep(100);
    process.emit('SIGINT');
    expect(await session.done).toBe(130);
    expect(session.out).toContain('relay 已停止。');
    expect(session.terminal.err).toMatch(/^\d{4}-\d\d-\d\dT/m);
  });

  it('installs the background service after pairing (2), with the cap asked for', async () => {
    const app = qq.addApp({ botName: 'Service Lin' });
    // --bot with a new name names the new bot.
    const session = guided(['--bot', 'svc']);
    await throughSave(session, app);
    expect(session.out).toContain('✓ 已添加 bot svc，固定和林夏');
    await session.answer(RUN_CHOICE, '2');
    await session.answer(/所有 bot 合计的花费上限（钻石，只显示数字）/, '200');
    await session.next(/配对完成后马上安装并启动后台服务。/);
    await session.answer(CHECKPOINT, '');
    await pairs(session, app);
    await session.next(/正在安装后台服务……/);
    await session.next(/✓ 后台服务已启动，svc 在里面运行：直接回复，就是在和林夏聊天。/);
    await session.next(/完成 · 查看状态：yomi relay --service-status/);
    // Its own setup lock was never held across the steps: the install took it.
    expect(await session.done).toBe(0);
    expect(service.installed).toBe(1);
    expect(session.out).toContain('本机允许 relay 最多花 200 钻石（累计）。');
    const unit = readFileSync(installHubServicePath(), 'utf8');
    expect(unit).toContain('--max-spend');
    expect(unit).toContain('200');

    // Installed but not running: started again with its own arguments, no cap asked.
    const second = qq.addApp({ botName: 'Second Lin' });
    const again = guided();
    await again.answer(/1：再添加一个 QQ bot（和另一个角色聊天）/, '1');
    await throughSave(again, second, MOCK_NPCS.group);
    await again.next(
      /2 {2}用原来的参数启动后台服务：yomi relay --allow-file-store --max-spend 200 --install-service/,
    );
    await again.answer(RUN_CHOICE, '2');
    await again.answer(CHECKPOINT, '');
    await pairs(again, second);
    await again.next(/✓ 后台服务已启动，qq-\d{4} 在里面运行：直接回复，就是在和雾港聊天。/);
    expect(await again.done).toBe(0);
    expect(again.out).not.toContain('花费上限（钻石');
    expect(service.installed).toBe(2);
    expect(readFileSync(installHubServicePath(), 'utf8')).toContain('200');
  });

  it('says when QQ would not let the bot answer the pairing: no friend yet (40054004)', async () => {
    const app = qq.addApp({ botName: 'Stranger Lin' });
    const session = guided();
    await throughSave(session, app);
    await session.answer(RUN_CHOICE, '3');
    await session.answer(CHECKPOINT, '');
    app.unfriend(OWNER);
    await pairs(session, app, false);
    await session.next(/✗ 配对成功了，但 QQ 不让机器人回复你：你还不是它的好友（40054004）。/);
    expect(await session.done).toBe(0);
    expect(app.messages(OWNER)).toEqual([]);
    // Nothing went out: no grey line says it did, or names another cause.
    expect(session.out).not.toContain('已向主人发送');
    expect(session.out).not.toContain('屏蔽');
  });

  it('keeps the cap typed at step 5 in what to run when installing the service fails', async () => {
    rmSync(installHubServicePath(), { force: true });
    const app = qq.addApp({ botName: 'Unlucky Lin' });
    service.failInstall = true;
    try {
      const session = guided();
      await throughSave(session, app);
      await session.answer(RUN_CHOICE, '2');
      await session.answer(/所有 bot 合计的花费上限（钻石，只显示数字）/, '200');
      await session.answer(CHECKPOINT, '');
      await pairs(session, app);
      await session.next(/正在安装后台服务……/);
      expect(await session.done).toBe(1);
      expect(session.terminal.err).toContain('the service manager refused the unit');
      expect(session.terminal.err).toMatch(
        /qq-\d{4} 已配对；修好后运行 yomi relay --allow-file-store --max-spend 200 --install-service。/,
      );
    } finally {
      rmSync(installHubServicePath(), { force: true });
    }
  });

  it('ends when its bot stops for good before pairing, though other bots run in this terminal (1)', async () => {
    const other = qq.addApp({ botName: 'Paired Other' });
    await addedWithSetApp(other, ['--bot', 'paired', '--character', MOCK_NPCS.group]);
    ownedBy('paired', 'OPENID_OTHER_OWNER');
    const closed = qq.addApp({ botName: 'Stopping Lin', c2c: false });
    const session = guided();
    await session.answer(/1：再添加一个 QQ bot（和另一个角色聊天）/, '1');
    await throughSaveUntilCheck(session, closed);
    await session.answer(/s：先保存，配对时会再检查一次 · q：退出，不保存 /, 's');
    await session.next(/✓ 已添加 bot/);
    await session.answer(RUN_CHOICE, '1');
    await session.answer(CHECKPOINT, '');
    // QQ refuses the new bot's private chats while the paired one runs on: the guide ends.
    expect(await session.done).toBe(1);
    expect(session.terminal.err).toMatch(/\[qq-\d{4}\] [^\n]*4014/);
    expect(session.terminal.err).toMatch(
      /qq-\d{4} 已保存，还没有配对。修好后运行 yomi relay --setup 接着配对。/,
    );
    expect(session.out).not.toContain('✓ 已配对');
  });

  it('says the pairing was answered, claiming nothing more, when the channel does not report', () => {
    const terminal = memoryIo();
    pairedLines(new GuideUi(terminal.io), { owner: 'OPENID_SOMEONE', report: null, gated: false });
    expect(terminal.out).toContain('✓ 已配对：QQ 用户 OP…NE');
    expect(terminal.out).toContain(
      '已在 QQ 里回复配对结果。没看到的话，确认已经加了好友，再发一条消息。',
    );
    expect(terminal.out).not.toContain('✓ 机器人已在 QQ 里回复');
  });
});

/** Where the hub's unit is under the test's HOME. */
function installHubServicePath(): string {
  return servicePlan({
    account: context().account,
    channel: 'hub',
    node: process.execPath,
    script: 'cli.js',
    args: [],
    environment: {},
    logDir: join(home, 'logs'),
  }).path;
}

describe('what yomi relay --setup refuses before its first step', () => {
  it('needs a terminal, takes only its own flags, QQ, the keychain, and no relay running', async () => {
    const script = await run(['relay', '--setup', '--allow-file-store']);
    expect(script.code).toBe(1);
    expect(script.err).toContain('--setup 要在终端里一步步回答，不能在脚本或管道里用。脚本里用：');
    expect(script.err).toContain('--set-app --token-stdin --character <ID>');
    const flags = await run(['relay', '--setup', '--token-stdin'], { interactive: true });
    expect(flags.code).toBe(1);
    expect(flags.err).toContain('--setup 不能和 --token-stdin 一起用');
    const telegram = await run(['relay', '--setup', '--telegram'], { interactive: true });
    expect(telegram.err).toContain('yomi relay --telegram --set-token');
    const wechat = await run(['relay', '--setup', '--channel', 'wechat'], { interactive: true });
    expect(wechat.err).toContain('yomi relay --channel wechat --experimental --login');
    const keychain = await run(['relay', '--setup'], { interactive: true });
    expect(keychain.code).toBe(1);
    expect(keychain.err).toContain('--allow-file-store');
    expect(keychain.out).not.toContain('第 1 步');
    // A WeChat bot named.
    const { account } = context();
    BotRegistry.open(account).add({
      kind: 'wechat',
      stored: { platformId: 'wx-bot-setup', scope: 'wx:setup', lockName: 'wx-setup' },
      name: 'wx-lin',
      character: { npcId: MOCK_NPCS.group, name: '雾港', group: true },
    });
    const other = await run(['relay', '--setup', '--bot', 'wx-lin', '--allow-file-store'], {
      interactive: true,
    });
    expect(other.code).toBe(1);
    expect(other.err).toContain('"wx-lin" 是微信的 bot，不是 QQ 的。');
    // Its character is another channel's bot's: refused, with how to rebind it.
    const taken = await run(
      ['relay', '--setup', '--character', MOCK_NPCS.group, '--allow-file-store'],
      { interactive: true },
    );
    expect(taken.code).toBe(1);
    expect(taken.err).toContain(
      '雾港已经绑在 bot wx-lin 上（一个角色只能绑一个 bot）。换一个角色，或者先给 wx-lin 换绑：yomi relay --bot wx-lin --character <ID>',
    );
    // A relay running in a terminal.
    const held = acquireProcessLock(join(configDir(), 'locks', `relay-env-${hash()}.lock`), {
      channel: 'qq',
      bots: JSON.stringify([{ kind: 'qq', name: 'qq-9999', label: 'Lin' }]),
    });
    if (!('release' in held)) throw new Error('the environment lock is taken');
    try {
      const refused = await run(['relay', '--setup', '--allow-file-store'], { interactive: true });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(`relay 正在运行（QQ bot Lin，进程 ${process.pid}）`);
      expect(refused.err).toContain('再 --setup。');
      expect(refused.out).not.toContain('第 1 步');
    } finally {
      held.release();
    }
    // In a terminal, no bot yet: the error says how to set one up step by step.
    expect((await run(['relay', '--forget', '--all'])).code).toBe(0);
    const none = await run(['relay', '--allow-file-store'], { interactive: true });
    expect(none.err).toContain('或者运行 yomi relay --setup 按步骤设置一个 QQ bot。');
    const unattended = await run(['relay', '--allow-file-store']);
    expect(unattended.err).not.toContain('--setup');
  });

  it('refuses --character for a bot bound to another character, before the first step', async () => {
    const app = qq.addApp({ botName: 'Bound Lin' });
    await addedWithSetApp(app, ['--bot', 'bound', '--character', npc]);
    const refused = await run(
      ['relay', '--setup', '--bot', 'bound', '--character', MOCK_NPCS.group, '--allow-file-store'],
      { interactive: true },
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      `bound 已经固定和林夏（${npc}）聊天，--setup 不会给它换角色。要换角色：yomi relay --bot bound --character <ID>`,
    );
    expect(refused.out).not.toContain('第 1 步');
    expect(registry().find('bound')?.character?.npcId).toBe(npc);
  });

  it("refuses another --max-spend than the background service's, before the first step", async () => {
    const path = installHubService();
    try {
      const refused = await run(['relay', '--setup', '--max-spend', '50', '--allow-file-store'], {
        interactive: true,
      });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('去掉 --max-spend 50');
      expect(refused.out).not.toContain('第 1 步');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('says when the server has not enabled QQ in production; q leaves, 1 sets it up anyway', async () => {
    production.on = true;
    const left = guided();
    await left.answer(/输入 prod 确认：/, 'prod');
    await left.next(/服务端还没有开放 QQ 通道（也可能是现在读不到服务端的设置）/);
    await left.answer(/1：照样设置 · q：退出 /, 'q');
    expect(await left.done).toBe(0);
    expect(left.out).not.toContain('第 1 步');
    expect(left.out).toContain('已退出，什么都没有保存。');

    const app = qq.addApp({ botName: 'Gated Lin' });
    const session = guided();
    await session.answer(/输入 prod 确认：/, 'prod');
    await session.answer(/1：照样设置 · q：退出 /, '1');
    await throughSave(session, app);
    await session.answer(RUN_CHOICE, '3');
    await session.answer(CHECKPOINT, '');
    await pairs(session, app);
    await session.next(
      /已配对。服务端还没有开放 QQ 通道：开放之前，每条消息都只会收到“服务端已关闭”的答复/,
    );
    expect(await session.done).toBe(0);
    // Said once, before step 1: the run's own line about it is not said again.
    expect(session.out).not.toContain('· 服务端还没有开放这个通道（QQ）');
    // The welcome waits for the server: only the pairing (and the character) went.
    expect(app.messages(OWNER).map((message) => message.kind)).toEqual(['text']);
  });
});

describe('errors inside a step: said, and the step asked again', () => {
  it('asks the AppID and AppSecret again, keeps the AppID on Enter, and saves nothing meanwhile', async () => {
    const app = qq.addApp({ botName: 'Retry Lin' });
    const session = guided();
    await session.answer(CHARACTER_PROMPT, npc);
    await session.answer(IS_IT, 'y');
    await session.answer(CHECKPOINT, '');
    const calls = app.calls.length;
    await session.answer(APPID, '12ab');
    await session.answer(/这不像 QQ 机器人的 AppID（5 到 20 位数字）。再输一次：/, app.appId);
    await session.answer(APPSECRET, 'has space');
    await session.answer(
      /这不像 AppSecret（8 到 128 个字母、数字或符号，不能有空格）。再输一次：/,
      app.secret,
    );
    // Asked nothing of QQ while they did not look right.
    await session.next(/正在向 QQ 核对……/);
    expect(app.calls.length).toBeGreaterThan(calls);
    // (the next check fails first: 100016)
    await session.next(/✓ QQ 接受了/);
    await session.answer(RUN_CHOICE, 'q');
    expect(await session.done).toBe(0);

    expect((await run(['relay', '--forget', '--all'])).code).toBe(0);
    const again = guided();
    await again.answer(CHARACTER_PROMPT, npc);
    await again.answer(IS_IT, 'y');
    await again.answer(CHECKPOINT, '');
    app.failNext('token', { code: 100016 });
    await again.answer(APPID, app.appId);
    await again.answer(APPSECRET, 'not-the-secret-1234');
    await again.next(
      /✗ QQ 不接受这对 AppID 和 AppSecret（100016）。AppID 是「APPID 接入凭证」里那串数字/,
    );
    // Enter keeps the AppID.
    await again.answer(new RegExp(`AppID（只显示数字；直接回车沿用 ${app.appId}）：`), '');
    app.failNext('token', { code: 100007 });
    await again.answer(APPSECRET, app.secret);
    await again.next(
      /✗ QQ 说没有这个机器人，或者它已被封禁、删除（100007）。核对 AppID；删除后 7 天内/,
    );
    app.failNext('token', { code: 100001 });
    await again.answer(APPID, '');
    await again.answer(APPSECRET, app.secret);
    await again.next(/QQ 说请求太频繁（100001）。等一会儿再按回车重试（QQ 没说要等多久）。/);
    expect(registry().list()).toEqual([]);
    app.failNext('token', { code: 502 });
    await again.answer(/回车：重试 · q：退出 /, '');
    await again.next(/QQ 暂时出错（HTTP 502）。按回车重试。/);
    await again.answer(/回车：重试 · q：退出 /, '');
    await again.next(/✓ QQ 接受了/);
    await again.answer(RUN_CHOICE, 'q');
    expect(await again.done).toBe(0);
    expect(again.all).not.toContain('not-the-secret');
    expect(again.all).not.toContain(app.secret);
  });

  it("says QQ's own refusal safe to print, an unreachable QQ, and stops after five checks", async () => {
    const app = qq.addApp({ botName: 'Refused Lin' });
    const session = guided();
    await session.answer(CHARACTER_PROMPT, npc);
    await session.answer(IS_IT, 'y');
    await session.answer(CHECKPOINT, '');
    // Nothing listens there: no answer at all.
    setEnv({ YOMI_QQ_API_ORIGIN: 'http://127.0.0.1:9' });
    await session.answer(APPID, app.appId);
    await session.answer(APPSECRET, app.secret);
    await session.next(/✗ 连不上 QQ（api\.bot\.qq\.com）：检查网络和代理，然后按回车重试。/);
    setEnv({ YOMI_QQ_API_ORIGIN: qq.origin });
    app.failNext('token', { code: 11298, message: 'ip\u001b[2J not allowed' });
    await session.answer(/回车：重试 · q：退出 /, '');
    await session.next(
      /✗ QQ 拒绝了（11298：ip\?\[2J not allowed）。如果在「服务器 IP 白名单」里加过 IP/,
    );
    expect(session.out).not.toContain('\u001b');
    app.failNext('token', { code: 100016 }, 3);
    await session.answer(/回车：重试 · q：退出 /, '');
    for (let index = 0; index < 2; index++) {
      await session.answer(APPID, '');
      await session.answer(APPSECRET, app.secret);
    }
    await session.answer(APPID, '');
    await session.answer(APPSECRET, app.secret);
    expect(await session.done).toBe(1);
    expect(session.terminal.err).toContain('这次已经向 QQ 核对了 5 次，先停在这里。');
    expect(registry().list()).toEqual([]);
  });

  it('refuses a character that is not there, or is another bot’s, and goes on with one not set up', async () => {
    const other = qq.addApp({ botName: 'Other Lin' });
    await addedWithSetApp(other, ['--bot', 'other', '--character', MOCK_NPCS.group]);
    const session = guided();
    await session.answer(/还没设置完。接着设置？\[y\/n\] /, 'n');
    await session.answer(CHARACTER_PROMPT, 'nothing here');
    await session.answer(/这不像角色链接或角色 ID。再输一次：/, MOCK_NPCS.removed);
    await session.answer(/找不到这个已发布的角色。再输一次：/, MOCK_NPCS.group);
    // Bound to a QQ bot not set up yet: going on with it is offered.
    await session.answer(/雾港已经绑在 other 上，它还没设置完。接着设置 other 吗？\[y\/n\] /, 'y');
    await session.next(/✓ 第 2 步，共 7 步 · 在 QQ 开放平台创建机器人/);
    await session.next(/✓ 第 4 步，共 7 步 · 检查私聊权限并保存/);
    await session.next(/第 5 步，共 7 步 · 之后怎样运行/);
    await session.answer(RUN_CHOICE, 'q');
    expect(await session.done).toBe(0);
    expect(session.out).toContain('已退出：other 已保存，运行 yomi relay --setup 接着设置。');
  });

  it('offers to set the AppSecret of an AppID registered already, without the gateway', async () => {
    const app = qq.addApp({ botName: 'Twin Lin' });
    await addedWithSetApp(app, ['--bot', 'twin', '--character', npc]);
    const identified = app.identifiedAt.length;
    const session = guided();
    await session.answer(/twin（林夏，还没有配对）还没设置完。接着设置？\[y\/n\] /, 'n');
    await session.answer(CHARACTER_PROMPT, MOCK_NPCS.group);
    await session.answer(IS_IT, 'y');
    await session.answer(CHECKPOINT, '');
    await session.answer(APPID, app.appId);
    await session.answer(APPSECRET, app.secret);
    await session.answer(
      new RegExp(`AppID ${app.appId} 已经是 bot twin。要重新设置它的 AppSecret 吗？\\[y/n\\] `),
      'y',
    );
    await session.next(/✓ QQ 接受了/);
    await session.next(/✓ 已保存 twin 的新 AppSecret/);
    await session.next(/twin 固定和林夏（7300000000000009001）聊天，没有改成刚才选的雾港。/);
    await session.answer(RUN_CHOICE, 'q');
    expect(await session.done).toBe(0);
    expect(app.identifiedAt.length).toBe(identified);
  });

  it('never shows a secret pasted at the character, the AppID or a key prompt', async () => {
    const app = qq.addApp({ botName: 'Paste Lin' });
    const session = guided();
    await session.answer(CHARACTER_PROMPT, app.secret);
    await session.next(/这像是粘贴了 AppSecret：没有显示，也没有保存。/);
    await session.answer(/再输一次：/, npc);
    await session.answer(IS_IT, 'y');
    await session.answer(CHECKPOINT, app.secret);
    await session.next(/这像是粘贴了 AppSecret/);
    // Something else pasted there (the AppID) is a paste, not called an AppSecret.
    session.type(app.appId);
    await session.next(/这像是粘贴的内容，没有显示。这里只按一个键。/);
    session.type('');
    await session.answer(APPID, app.secret);
    await session.next(/这像是粘贴了 AppSecret/);
    await session.answer(/再输一次：/, 'q');
    expect(await session.done).toBe(0);
    expect(session.all).not.toContain(app.secret);
    expect(registry().list()).toEqual([]);
  });
});

describe('the check of the gateway', () => {
  it('without the private-chat permission (4014): s saves, q saves nothing; no check again', async () => {
    const closed = qq.addApp({ botName: 'Closed Lin', c2c: false });
    const quit = guided();
    await throughSaveUntilCheck(quit, closed);
    await quit.next(/✗ QQ 说这个 bot 没有私聊（单聊）消息事件的权限（4014）/);
    // The relay's one text for 4014, as `yomi relay` and `--set-app` say it: never worded twice.
    expect(quit.out).toContain(`✗ ${noPrivateChatText()}\n`);
    const options = await quit.next(/s：先保存，配对时会再检查一次 · q：退出，不保存 /);
    expect(options[0]).not.toContain('r：');
    quit.type('q');
    expect(await quit.done).toBe(0);
    expect(registry().list()).toEqual([]);
    const save = guided();
    await throughSaveUntilCheck(save, closed);
    await save.answer(/s：先保存，配对时会再检查一次 · q：退出，不保存 /, 's');
    await save.next(/✓ 已添加 bot qq-\d{4}/);
    await save.answer(RUN_CHOICE, 'q');
    expect(await save.done).toBe(0);
  });

  it('says an outdated yomi for 4013, and saves and ends on s', async () => {
    const app = qq.addApp({ botName: 'Protocol Lin' });
    app.closeIdentifyWith(4013);
    try {
      const session = guided();
      await throughSaveUntilCheck(session, app);
      await session.next(
        /✗ 这个版本的 yomi 和 QQ 网关的协议对不上（4013，无效的 intent）。请升级 yomi：npm i -g @yomichat\/cli/,
      );
      await session.answer(
        /s：保存后结束，升级后运行 yomi relay --setup 接着做 · q：退出，不保存 /,
        's',
      );
      await session.next(/升级 yomi 之后，运行 yomi relay --setup 接着设置。/);
      expect(await session.done).toBe(0);
      expect(session.out).not.toContain('第 5 步');
      expect(registry().list('qq')).toHaveLength(1);
    } finally {
      app.closeIdentifyWith(null);
    }
  });

  it('saves nothing for a bot QQ delisted (4914), and offers no way on', async () => {
    const app = qq.addApp({ botName: 'Delisted Lin' });
    app.closeIdentifyWith(4914);
    try {
      const session = guided();
      await throughSaveUntilCheck(session, app);
      expect(await session.done).toBe(1);
      expect(session.terminal.err).toContain(
        'QQ 说这个机器人已下架（4914）：没有保存。请在 q.qq.com 查看它的状态。',
      );
      expect(session.out).not.toContain('s：先保存');
      expect(registry().list()).toEqual([]);
    } finally {
      app.closeIdentifyWith(null);
    }
  });

  it('checks again at most twice when the gateway could not be reached', async () => {
    const app = qq.addApp({ botName: 'Flaky Lin' });
    app.closeIdentifyWith(4900);
    try {
      const session = guided();
      await throughSaveUntilCheck(session, app);
      const choice = /没能连上 QQ 网关（网络、代理，或者 QQ 暂时不可用）。\n {2}(.*) $/m;
      expect((await session.next(choice))[1]).toBe('r：再检查一次 · s：先保存 · q：退出');
      session.type('r');
      await session.next(/（QQ 要求两次连接之间隔 5 秒，稍等）/);
      expect((await session.next(choice))[1]).toBe('r：再检查一次 · s：先保存 · q：退出');
      session.type('r');
      expect((await session.next(choice))[1]).toBe('s：先保存 · q：退出');
      session.type('s');
      await session.next(/✓ 已添加 bot/);
      await session.answer(RUN_CHOICE, 'q');
      expect(await session.done).toBe(0);
    } finally {
      app.closeIdentifyWith(null);
    }
  });

  it('skips the check with 5 connections or fewer left today, and ends with none left', async () => {
    const few = qq.addApp({
      botName: 'Few Lin',
      sessionLimit: { remaining: 3, resetAfterMs: 60_000 },
    });
    const skipped = guided();
    await throughSaveUntilCheck(skipped, few);
    await skipped.next(/QQ 今天只剩 3 次连接，留给配对和运行：这次跳过检查，配对时一起检查。/);
    await skipped.next(/✓ 已添加 bot/);
    await skipped.answer(RUN_CHOICE, 'q');
    expect(await skipped.done).toBe(0);
    expect(few.identifies).toBe(0);
    // No check, so nothing says it uses a connection.
    expect(skipped.out).not.toContain('这次检查用 1 次');
    expect((await run(['relay', '--forget', '--all'])).code).toBe(0);
    const none = qq.addApp({
      botName: 'None Lin',
      sessionLimit: { remaining: 0, resetAfterMs: 60_000 },
    });
    const ended = guided();
    await throughSaveUntilCheck(ended, none);
    await ended.next(/✓ 已添加 bot/);
    await ended.next(
      /QQ 今天的连接次数用完了，\d\d:\d\d 后恢复。bot 已保存，到时运行 yomi relay --setup 接着配对。/,
    );
    expect(await ended.done).toBe(0);
    expect(ended.out).not.toContain('第 5 步');
    expect(ended.out).not.toContain('这次检查用 1 次');
  });

  it('asks Enter to save again once another relay that started meanwhile stopped', async () => {
    const app = qq.addApp({ botName: 'Busy Lin' });
    const session = guided();
    await session.answer(CHARACTER_PROMPT, npc);
    await session.answer(IS_IT, 'y');
    await session.answer(CHECKPOINT, '');
    await session.answer(APPID, app.appId);
    // Another relay starts in a terminal while the AppSecret is typed.
    const held = acquireProcessLock(join(configDir(), 'locks', `relay-env-${hash()}.lock`), {
      channel: 'qq',
    });
    if (!('release' in held)) throw new Error('the environment lock is taken');
    try {
      await session.answer(APPSECRET, app.secret);
      await session.next(
        new RegExp(
          `另一个终端里有 relay 在运行（进程 ${process.pid}）：先在那边按 Ctrl\\+C 停止它，然后按回车重试保存。`,
        ),
      );
      await session.next(/回车：重试 · q：退出 /);
      expect(registry().list()).toEqual([]);
    } finally {
      held.release();
    }
    session.type('');
    await session.next(/✓ 已添加 bot/);
    await session.answer(RUN_CHOICE, 'q');
    expect(await session.done).toBe(0);
  });
});

/** Steps 1 to 3 for `app`, up to step 4's check. */
async function throughSaveUntilCheck(session: Guided, app: MockQqApp) {
  await session.answer(CHARACTER_PROMPT, npc);
  await session.answer(IS_IT, 'y');
  await session.answer(CHECKPOINT, '');
  await session.answer(APPID, app.appId);
  await session.answer(APPSECRET, app.secret);
  await session.next(/第 4 步，共 \d 步 · 检查私聊权限并保存/);
}

describe('leaving and going on', () => {
  it('keeps nothing when left before saving, and goes on from step 5 once saved', async () => {
    const left = guided();
    await left.answer(CHARACTER_PROMPT, npc);
    await left.answer(IS_IT, 'y');
    await left.next(/第 2 步，共 7 步/);
    left.terminal.stdin.end();
    expect(await left.done).toBe(0);
    expect(left.out).toContain('已退出，什么都没有保存。');
    expect(registry().list()).toEqual([]);

    const app = qq.addApp({ botName: 'Resume Lin' });
    const saved = guided();
    await throughSave(saved, app);
    await saved.answer(RUN_CHOICE, 'q');
    expect(await saved.done).toBe(0);
    const name = (saved.out.match(/✓ 已添加 bot (qq-\d{4})/) ?? [])[1];
    expect(saved.out).toContain(`已退出：${name} 已保存，运行 yomi relay --setup 接着设置。`);
    const again = guided();
    await again.answer(
      new RegExp(`${name}（林夏，还没有配对）还没设置完。接着设置？\\[y/n\\] `),
      'y',
    );
    for (const step of [
      '选择角色',
      '在 QQ 开放平台创建机器人',
      '输入 AppID 和 AppSecret',
      '检查私聊权限并保存',
    ])
      await again.next(new RegExp(`✓ 第 \\d 步，共 7 步 · ${step}`));
    await again.answer(RUN_CHOICE, '3');
    await again.answer(CHECKPOINT, '');
    await pairs(again, app);
    expect(await again.done).toBe(0);
    expect(ownerOf(name)?.userId).toBe(OWNER);
  });

  it('lists the QQ bots not set up yet when there are several', async () => {
    await addedWithSetApp(qq.addApp({ botName: 'One' }), ['--bot', 'one']);
    await addedWithSetApp(qq.addApp({ botName: 'Two' }), ['--bot', 'two']);
    const session = guided();
    await session.next(
      /这些 QQ bot 还没设置完：\n {2}1 {2}one（还没有角色，还没有配对）\n {2}2 {2}two（还没有角色，还没有配对）/,
    );
    await session.answer(/选一个接着设置 · n：新建一个 · q：退出 /, '2');
    // two has no character yet: step 1 binds it.
    await session.answer(CHARACTER_PROMPT, npc);
    await session.answer(IS_IT, 'y');
    await session.next(/已把 bot two 换绑到林夏（7300000000000009001）/);
    await session.next(/✓ 第 2 步，共 7 步/);
    await session.answer(RUN_CHOICE, 'q');
    expect(await session.done).toBe(0);
    expect(registry().find('two')?.character?.npcId).toBe(npc);
  });

  it('says why the second item is not recommended when yomi runs from a temporary directory', async () => {
    const work = mkdtempSync(join(tmpdir(), 'yomi-setup-npx-'));
    const script = join(work, '_npx', 'yomi', 'cli.js');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, '');
    const argv = process.argv[1];
    process.argv[1] = script;
    try {
      const app = qq.addApp({ botName: 'Npx Lin' });
      const session = guided();
      await throughSave(session, app);
      await session.next(/当前 yomi 像是从临时目录运行的（npx 或缓存）/);
      const offered = await session.next(/2 {2}(装成后台服务[^\n]*)/);
      expect(offered[1]).toBe('装成后台服务，登录这台电脑后一直运行');
      await session.answer(RUN_CHOICE, 'q');
      expect(await session.done).toBe(0);
    } finally {
      process.argv[1] = argv;
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('Ctrl+C and the background service', () => {
  it('says why the pairing is not connected yet, and Ctrl+C then leaves the bot saved', async () => {
    const app = qq.addApp({ botName: 'Waiting Lin' });
    const session = guided();
    await throughSave(session, app);
    // QQ's connections for today run out before the pairing connects.
    app.setSessionLimit(0, 3_600_000);
    await session.answer(RUN_CHOICE, '3');
    await session.answer(CHECKPOINT, '');
    await session.next(
      /还没连上 QQ：QQ 今天的连接次数已用完，\d\d:\d\d 再试。可以继续等；按 Ctrl\+C 退出，bot 已保存。/,
    );
    process.emit('SIGINT');
    expect(await session.done).toBe(130);
    expect(session.out).toMatch(/已退出：qq-\d{4} 已保存，还没有配对。/);
  });

  it('ends at a checkpoint with 130, nothing saved, the running service never stopped', async () => {
    const running = runningService();
    try {
      const session = guided();
      await session.next(/第 1 步，共 6 步 · 选择角色/);
      await session.answer(CHARACTER_PROMPT, npc);
      await session.answer(IS_IT, 'y');
      await session.next(CHECKPOINT);
      process.emit('SIGINT');
      expect(await session.done).toBe(130);
      expect(session.out).toContain('已退出，什么都没有保存。');
      expect(service).toMatchObject({ paused: 0, resumed: 0 });
    } finally {
      running.stop();
    }
  });

  it('leaves at once on Ctrl+C while QQ does not answer the check', async () => {
    const stalled = createServer(() => undefined);
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const { port } = stalled.address() as AddressInfo;
    try {
      const app = qq.addApp({ botName: 'Stalled Lin' });
      const session = guided();
      await session.answer(CHARACTER_PROMPT, npc);
      await session.answer(IS_IT, 'y');
      await session.answer(CHECKPOINT, '');
      // QQ takes the request and never answers.
      setEnv({ YOMI_QQ_API_ORIGIN: `http://127.0.0.1:${port}` });
      await session.answer(APPID, app.appId);
      await session.answer(APPSECRET, app.secret);
      await session.next(/正在向 QQ 核对……/);
      await sleep(100);
      const started = Date.now();
      process.emit('SIGINT');
      expect(await session.done).toBe(130);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(session.out).toContain('已退出，什么都没有保存。');
    } finally {
      setEnv({ YOMI_QQ_API_ORIGIN: qq.origin });
      stalled.closeAllConnections();
      stalled.close();
    }
  });

  it('waits for Enter while another relay runs before pairing, without saying it is connecting', async () => {
    const app = qq.addApp({ botName: 'Queued Lin' });
    const session = guided();
    await throughSave(session, app);
    await session.answer(RUN_CHOICE, '3');
    await session.next(/第 6 步，共 7 步/);
    await session.next(CHECKPOINT);
    const held = acquireProcessLock(join(configDir(), 'locks', `relay-env-${hash()}.lock`), {
      channel: 'qq',
    });
    if (!('release' in held)) throw new Error('the environment lock is taken');
    try {
      session.type('');
      await session.next(
        /另一个终端里有 relay 在运行（进程 \d+）：先在那边按 Ctrl\+C 停止它，然后按回车接着配对。/,
      );
      await session.next(/回车：重试 · q：退出 /);
      await sleep(GUIDE_TIMINGS.notConnectedMs + 300);
      expect(session.out).not.toContain('还没连上 QQ');
    } finally {
      held.release();
    }
    session.type('');
    await pairs(session, app);
    expect(await session.done).toBe(0);
  });

  it('sets an AppSecret again with the running service stopped only to save it', async () => {
    const app = qq.addApp({ botName: 'Renew Lin' });
    await addedWithSetApp(app, ['--bot', 'renew', '--character', npc]);
    ownedBy('renew', OWNER);
    const running = runningService();
    try {
      const session = guided(['--bot', 'renew']);
      await session.next(/后台服务在运行：保存（几秒）时会先停止它/);
      await session.next(/renew 正在后台服务里运行：重置以后它下次换令牌时会停下/);
      await session.answer(CHECKPOINT, '');
      expect(service).toMatchObject({ paused: 0, resumed: 0 });
      await session.answer(APPSECRET, app.resetSecret());
      await session.next(/✓ 已保存 renew 的新 AppSecret/);
      expect(await session.done).toBe(0);
      expect(service).toMatchObject({ paused: 1, resumed: 1 });
      expect(session.all).not.toContain(app.secret);
    } finally {
      running.stop();
    }
  });

  it('does not say an older service of another channel runs the bot, and offers to replace it', async () => {
    const running = runningService('telegram');
    try {
      const app = qq.addApp({ botName: 'Legacy Lin' });
      const session = guided();
      await throughSave(session, app);
      // The older service runs only Telegram bots: how this one runs is still asked.
      await session.next(/第 5 步，共 7 步 · 之后怎样运行/);
      await session.next(/是旧版的，只运行 Telegram 的 bot：它不会运行这个 QQ bot/);
      await session.next(
        /2 {2}换成运行所有 bot 的后台服务（沿用原来的参数）：yomi relay --install-service/,
      );
      expect(session.out).not.toContain('1  在这个终端里运行');
      await session.answer(RUN_CHOICE, '3');
      await session.answer(CHECKPOINT, '');
      await pairs(session, app);
      await session.next(
        /qq-\d{4} 已配对，但正在运行的旧版后台服务不运行它：现在发给机器人的消息它收不到。/,
      );
      expect(await session.done).toBe(0);
      expect(session.out).not.toContain('后台服务已重新启动，');
      // Stopped to save and to pair, started again both times.
      expect(service).toMatchObject({ paused: 2, resumed: 2 });
    } finally {
      running.stop();
    }
  });

  it('stops the running service only to save and to pair, six steps, and Ctrl+C at /pair starts it again', async () => {
    const running = runningService();
    try {
      const app = qq.addApp({ botName: 'Hub Lin' });
      const session = guided();
      await session.next(/后台服务在运行：保存（几秒）和配对（等你发 \/pair）时会先停止它/);
      await session.next(/第 1 步，共 6 步 · 选择角色/);
      await throughSaveUntilCheck(session, app);
      await session.next(/后台服务重启、配对、配对后服务再重启，最多再用 3 次/);
      await session.next(/✓ 已添加 bot/);
      expect(service).toMatchObject({ paused: 1, resumed: 1 });
      // Stopped only to save: the steps and the check of the gateway went on beside it.
      const at = (text: string) => session.out.indexOf(text);
      expect(at('✓ 能收到私聊消息。')).toBeGreaterThan(0);
      expect(at('✓ 能收到私聊消息。')).toBeLessThan(at('正在停止后台服务'));
      expect(at('正在停止后台服务')).toBeLessThan(at('已重新启动后台服务'));
      expect(at('已重新启动后台服务')).toBeLessThan(at('✓ 已添加 bot'));
      await session.next(/第 5 步，共 6 步 · 加机器人为 QQ 好友/);
      expect(session.out).not.toContain('之后怎样运行');
      await session.answer(CHECKPOINT, '');
      await session.next(CODE);
      expect(service).toMatchObject({ paused: 2, resumed: 1 });
      process.emit('SIGINT');
      expect(await session.done).toBe(130);
      expect(service).toMatchObject({ paused: 2, resumed: 2 });
      const name = (session.out.match(/✓ 已添加 bot (qq-\d{4})/) ?? [])[1];
      expect(session.out).toContain(`已退出：${name} 已保存，还没有配对。`);

      // Going on: paired under the service stopped, which starts again once paired.
      const again = guided();
      await again.answer(/还没设置完。接着设置？\[y\/n\] /, 'y');
      await again.answer(CHECKPOINT, '');
      await pairs(again, app);
      await again.next(
        new RegExp(`✓ 后台服务已重新启动，${name} 在里面运行：直接回复，就是在和林夏聊天。`),
      );
      expect(await again.done).toBe(0);
      expect(service).toMatchObject({ paused: 3, resumed: 3 });
    } finally {
      running.stop();
    }
  });
});

describe('nobody signed in', () => {
  it('signs in to Yomi first, as a step of its own', async () => {
    expect((await run(['logout'])).code).toBe(0);
    const session = guided();
    await session.next(/第 1 步，共 8 步 · 登录 Yomi/);
    const [url] = await session.next(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
    await authorizeLikeTheBrowser(mock, url);
    // In a terminal, login asks to confirm the account the web authorized.
    await session.answer(/以这个账号登录 Yomi CLI？/, 'y');
    await session.next(/✓ 已登录/);
    await session.next(/第 2 步，共 8 步 · 选择角色/);
    await session.answer(CHARACTER_PROMPT, 'q');
    expect(await session.done).toBe(0);
    expect(context().gateway.credential).not.toBeNull();
  });
});

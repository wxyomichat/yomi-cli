import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { describeEnvironment } from '../src/core/env.js';
import { configDir } from '../src/core/files.js';
import { acquireProcessLock, type LockNote } from '../src/core/lock.js';
import { sha256 } from '../src/core/state.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
import { type MockTelegram, startMockTelegram } from '../src/mock/telegram.js';
import type { ChannelKind } from '../src/relay/channels/index.js';
import { servicePlan } from '../src/relay/service.js';
import { RelayState, relayStatePath } from '../src/relay/state.js';
import { TelegramBot } from '../src/relay/telegram.js';
import { type FakeSwitch, StoppingChannel } from './helpers/fakeSetup.js';
import { memoryIo } from './helpers/io.js';

/**
 * One relay per Yomi account and environment, whatever the channel, Telegram included (design
 * §5.2, decision §12.2): every relay holds the environment's lock (`relay-env-<sha256(account)
 * [0:16]>.lock`) besides its bot's; a second relay is refused with the channel, bot and process
 * of the one that runs; `--set-app` and `--login` are refused while a relay runs (and hold the
 * lock themselves); `--install-service` is refused beside another channel's installed service;
 * the lock of a process that is gone is taken over. QQ and WeChat run as scripted channels
 * (`fakeSetup`), Telegram against the mock Bot API.
 */

const fake: FakeSwitch = vi.hoisted(() => ({ on: false, opened: [] }));

vi.mock('../src/relay/channels/qq.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/channels/qq.js')>();
  const { fakeSetup } = await import('./helpers/fakeSetup.js');
  return { ...real, qqSetup: fakeSetup(real.qqSetup, fake) };
});
vi.mock('../src/relay/channels/wechat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/channels/wechat.js')>();
  const { fakeSetup } = await import('./helpers/fakeSetup.js');
  return { ...real, wechatSetup: fakeSetup(real.wechatSetup, fake) };
});

let mock: MockServer;
let tg: MockTelegram;
/** A second bot: the same environment can only have one token at a time, but it can change. */
let other: MockTelegram;
const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  }
}

async function run(args: string[]) {
  process.exitCode = undefined;
  const terminal = memoryIo();
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
}

/** Runs `body` with the CLI in English. */
async function inEnglish<T>(body: () => Promise<T>): Promise<T> {
  setEnv({ YOMI_LANG: 'en' });
  try {
    return await body();
  } finally {
    setEnv({ YOMI_LANG: 'zh-Hans' });
  }
}

/** The web authorize page's part of `yomi login`, as the e2e tests do it. */
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
}

/** This environment's account key and credential store, as the command sees them. */
const context = () => createContext(memoryIo().io, {});

/** The environment's lock file, as design §5.2 names it. */
const environmentLock = () =>
  join(configDir(), 'locks', `relay-env-${sha256(context().account).slice(0, 16)}.lock`);

/** Gives a scripted channel's relay an owner, as a pairing or login would. */
function paired(kind: 'qq' | 'wechat') {
  const { account } = context();
  const scope = `fake:${kind}`;
  new RelayState(relayStatePath(account, scope), scope, account, kind).update({
    owner: { userId: 'owner-1', chatId: 'owner-1', name: '', language: '', pairedAt: Date.now() },
  });
}

/** No owner: a relay of this scope cannot install a service (it stops at "not paired yet"). */
function unpaired(scope: string, kind: ChannelKind) {
  const { account } = context();
  const state = new RelayState(relayStatePath(account, scope), scope, account, kind);
  state.resetOwner();
  expect(new RelayState(state.path, scope, account, kind).data.owner).toBeNull();
}

/** A pid that is certainly not running: a child that already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

/** A Telegram relay of `tg` running in this process (pairing, so it starts unpaired too). */
async function startTelegram() {
  const { store, account } = context();
  store.setSecret(`telegram-bot:${account}`, tg.token);
  const polls = tg.calls.filter((call) => call.method === 'getUpdates').length;
  const terminal = memoryIo();
  const pending = main(['relay', '--telegram', '--allow-file-store', '--pair'], terminal.io);
  await tg.waitFor(() => terminal.out.includes('relay 运行中：@lin_env_bot ⇄ Yomi'));
  await tg.waitFor(() => tg.calls.filter((call) => call.method === 'getUpdates').length > polls);
  return {
    terminal,
    /** A second poller: Telegram's 409 stops the relay, which ends without failing. */
    async stop() {
      await new TelegramBot(tg.token, { apiOrigin: tg.origin }).getUpdates(-1, 0).catch(() => {});
      expect(await pending).toBe(0);
      expect(terminal.err).toContain('另一个程序正在用这个 bot 收消息');
    },
  };
}

beforeAll(async () => {
  mock = await startMockServer();
  tg = await startMockTelegram({ username: 'lin_env_bot' });
  other = await startMockTelegram({ username: 'lin_other_bot', botId: 8_123_456_790 });
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_TELEGRAM_API_ORIGIN: tg.origin,
    YOMI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'yomi-relay-env-')),
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
  await signIn();
  fake.on = true;
});

afterEach(() => {
  fake.on = true;
  fake.opened.length = 0;
  fake.setCredentials = undefined;
});

afterAll(async () => {
  fake.on = false;
  await other.close();
  await tg.close();
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('one relay per Yomi account and environment', () => {
  it('refuses a second relay, whatever its channel, naming the channel, bot and process that runs', async () => {
    paired('qq');
    const running = await startTelegram();
    try {
      // The lock says who holds it.
      expect(JSON.parse(readFileSync(environmentLock(), 'utf8'))).toMatchObject({
        pid: process.pid,
        note: { channel: 'telegram', bot: '@lin_env_bot' },
      });
      expect(existsSync(join(configDir(), 'locks', `relay-${tg.botId}.lock`))).toBe(true);
      const where = describeEnvironment(context().env);
      const qq = await run(['relay', '--channel', 'qq', '--allow-file-store']);
      expect(qq.code).toBe(1);
      expect(qq.err).toContain(
        `这个 Yomi 账号（${where}）已经有另一个 relay 在运行：Telegram bot @lin_env_bot，进程 ${process.pid}。同一个账号和环境同时只能运行一个 relay：先停止它（Ctrl+C，或 yomi relay --telegram --uninstall-service）。`,
      );
      expect(qq.out).not.toContain('relay 运行中');
      const wechat = await run([
        'relay',
        '--channel',
        'wechat',
        '--experimental',
        '--allow-file-store',
      ]);
      expect(wechat.code).toBe(1);
      expect(wechat.err).toContain('已经有另一个 relay 在运行：Telegram bot @lin_env_bot');

      // A second Telegram bot of the same environment too (it ran beside the first before).
      const { store, account } = context();
      setEnv({ YOMI_TELEGRAM_API_ORIGIN: other.origin });
      store.setSecret(`telegram-bot:${account}`, other.token);
      let second;
      try {
        second = await run(['relay', '--telegram', '--allow-file-store']);
      } finally {
        setEnv({ YOMI_TELEGRAM_API_ORIGIN: tg.origin });
        store.setSecret(`telegram-bot:${account}`, tg.token);
      }
      expect(second.code).toBe(1);
      expect(second.err).toContain(
        `已经有另一个 relay 在运行：Telegram bot @lin_env_bot，进程 ${process.pid}。`,
      );
      expect(other.calls.some((call) => call.method === 'getUpdates')).toBe(false);
      // Refused on the environment's lock, it let go of its bot's lock too.
      expect(existsSync(join(configDir(), 'locks', `relay-${other.botId}.lock`))).toBe(false);
      // The same bot is still refused by its own lock, in the words it always had.
      const same = await run(['relay', '--telegram', '--allow-file-store']);
      expect(same.code).toBe(1);
      expect(same.err).toContain(
        `这个 bot 已经有一个 relay 在运行（进程 ${process.pid}）。同一个 bot 只能运行一个。`,
      );

      const [english, whereEnglish] = await inEnglish(
        async () =>
          [
            await run(['relay', '--channel', 'qq', '--allow-file-store']),
            describeEnvironment(context().env),
          ] as const,
      );
      expect(english.err).toContain(
        `Another relay is already running for this Yomi account (${whereEnglish}): Telegram bot @lin_env_bot, process ${process.pid}. Only one relay per Yomi account and environment can run at a time: stop it first (Ctrl+C, or yomi relay --telegram --uninstall-service).`,
      );
    } finally {
      await running.stop();
    }
    // Released with the relay: the next one of any channel runs.
    expect(existsSync(environmentLock())).toBe(false);
    const qq = await run(['relay', '--channel', 'qq', '--allow-file-store']);
    expect(qq.code).toBe(0);
    expect(qq.out).toContain('relay 运行中：Lin bot ⇄ Yomi');
    expect(qq.err).toContain(StoppingChannel.message);
  });

  it('refuses --set-app and --login while a relay of the environment runs', async () => {
    const running = await startTelegram();
    try {
      const setApp = await run(['relay', '--channel', 'qq', '--set-app', '--allow-file-store']);
      expect(setApp.code).toBe(1);
      expect(setApp.err).toContain(
        `relay 正在运行（Telegram bot @lin_env_bot，进程 ${process.pid}）：先停止它（Ctrl+C，或 yomi relay --telegram --uninstall-service），再 --set-app。`,
      );
      const login = await run([
        'relay',
        '--channel',
        'wechat',
        '--experimental',
        '--login',
        '--allow-file-store',
      ]);
      expect(login.code).toBe(1);
      expect(login.err).toContain(
        `relay 正在运行（Telegram bot @lin_env_bot，进程 ${process.pid}）：先停止它（Ctrl+C，或 yomi relay --telegram --uninstall-service），再 --login。`,
      );
      const english = await inEnglish(() =>
        run(['relay', '--channel', 'qq', '--set-app', '--allow-file-store']),
      );
      expect(english.err).toContain(
        `Relay is running (Telegram bot @lin_env_bot, process ${process.pid}): stop it first (Ctrl+C, or yomi relay --telegram --uninstall-service), then --set-app.`,
      );
      // Telegram's own --set-token is not affected (here it stops at the keychain check).
      const token = await run(['relay', '--telegram', '--set-token', '--token-stdin']);
      expect(token.err).toContain('--allow-file-store');
      expect(token.err).not.toContain('relay 正在运行');
      // What a channel cannot do at all it says first, relay or not: the stubs are not available.
      fake.on = false;
      const stub = await run(['relay', '--channel', 'qq', '--set-app', '--allow-file-store']);
      expect(stub.code).toBe(1);
      expect(stub.err).toContain('QQ 通道还在开发中，暂时不能使用');
      expect(stub.err).not.toContain('relay 正在运行');
      fake.on = true;
    } finally {
      await running.stop();
    }
    // With no relay running they run, holding the environment's lock, and release it after.
    const held: unknown[] = [];
    fake.setCredentials = () => {
      held.push(JSON.parse(readFileSync(environmentLock(), 'utf8')));
    };
    const setApp = await run(['relay', '--channel', 'qq', '--set-app', '--allow-file-store']);
    expect(setApp.code).toBe(0);
    const login = await run([
      'relay',
      '--channel',
      'wechat',
      '--experimental',
      '--login',
      '--allow-file-store',
    ]);
    expect(login.code).toBe(0);
    expect(held).toEqual([
      expect.objectContaining({ pid: process.pid, note: { channel: 'qq', flag: '--set-app' } }),
      expect.objectContaining({ pid: process.pid, note: { channel: 'wechat', flag: '--login' } }),
    ]);
    expect(existsSync(environmentLock())).toBe(false);
    // And the stubs say what they always said.
    fake.on = false;
    const stub = await run(['relay', '--channel', 'qq', '--set-app', '--allow-file-store']);
    expect(stub.code).toBe(1);
    expect(stub.err).toContain('QQ 通道还在开发中，暂时不能使用');
    expect(existsSync(environmentLock())).toBe(false);
  });

  it('names whoever holds the lock: a relay of another channel, or --set-app / --login', async () => {
    const { store, account } = context();
    store.setSecret(`telegram-bot:${account}`, tg.token);
    const hold = (note: LockNote) => {
      const lock = acquireProcessLock(environmentLock(), note);
      if (!('release' in lock)) throw new Error('the environment lock is taken');
      return lock;
    };
    const qq = hold({ channel: 'qq', bot: 'Lin bot' });
    try {
      const telegram = await run(['relay', '--telegram', '--allow-file-store']);
      expect(telegram.code).toBe(1);
      expect(telegram.err).toContain(
        `已经有另一个 relay 在运行：QQ bot Lin bot，进程 ${process.pid}。同一个账号和环境同时只能运行一个 relay：先停止它（Ctrl+C，或 yomi relay --channel qq --uninstall-service）。`,
      );
    } finally {
      qq.release();
    }

    const setApp = hold({ channel: 'qq', flag: '--set-app' });
    try {
      paired('qq');
      for (const args of [['--channel', 'qq'], ['--telegram']]) {
        const refused = await run(['relay', ...args, '--allow-file-store']);
        expect(refused.code, args.join(' ')).toBe(1);
        expect(refused.err, args.join(' ')).toContain(
          `yomi relay --channel qq --set-app 正在运行（进程 ${process.pid}）：等它结束后再启动 relay。`,
        );
      }
      const login = await run([
        'relay',
        '--channel',
        'wechat',
        '--experimental',
        '--login',
        '--allow-file-store',
      ]);
      expect(login.code).toBe(1);
      expect(login.err).toContain(
        `yomi relay --channel qq --set-app 正在运行（进程 ${process.pid}）：等它结束后再 --login。`,
      );
      const english = await inEnglish(() => run(['relay', '--telegram', '--allow-file-store']));
      expect(english.err).toContain(
        `yomi relay --channel qq --set-app is running (process ${process.pid}): wait for it to finish, then start the relay.`,
      );
    } finally {
      setApp.release();
    }
    // A lock file of an older yomi (no note) still names the process.
    const plain = acquireProcessLock(environmentLock());
    try {
      const refused = await run(['relay', '--telegram', '--allow-file-store']);
      expect(refused.err).toContain(
        `已经有另一个 relay 在运行：进程 ${process.pid}。同一个账号和环境同时只能运行一个 relay：先停止它（Ctrl+C，或 --uninstall-service）。`,
      );
    } finally {
      if ('release' in plain) plain.release();
    }
  });

  it('takes over the lock of a relay that crashed, or of one from before this boot', async () => {
    const path = environmentLock();
    mkdirSync(dirname(path), { recursive: true });
    const crashed = {
      pid: await deadPid(),
      at: Date.now(),
      token: 'crashed',
      note: { channel: 'qq', bot: 'Lin bot' },
    };
    writeFileSync(path, JSON.stringify(crashed));
    const running = await startTelegram();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      pid: process.pid,
      note: { channel: 'telegram', bot: '@lin_env_bot' },
    });
    await running.stop();
    expect(existsSync(path)).toBe(false);

    // A live pid written before this machine booted may be anyone's now.
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, at: 1, token: 'old', note: { channel: 'telegram' } }),
    );
    paired('qq');
    const qq = await run(['relay', '--channel', 'qq', '--allow-file-store']);
    expect(qq.code).toBe(0);
    expect(qq.out).toContain('relay 运行中：Lin bot ⇄ Yomi');
    expect(existsSync(path)).toBe(false);
  });
});

describe('--install-service beside another channel', () => {
  const home = mkdtempSync(join(tmpdir(), 'yomi-relay-home-'));
  /** Where a channel's service of this environment is installed, under the test's HOME. */
  const servicePath = (channel: ChannelKind) =>
    servicePlan({
      account: context().account,
      channel,
      node: process.execPath,
      script: 'cli.js',
      args: [],
      environment: {},
      logDir: join(home, 'logs'),
    }).path;
  const install = (channel: ChannelKind) => {
    const path = servicePath(channel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# installed\n');
    return path;
  };

  beforeAll(() => {
    // Never the real ~/Library/LaunchAgents or ~/.config/systemd/user.
    setEnv({ HOME: home });
    expect(servicePath('telegram').startsWith(home)).toBe(true);
    // Unpaired: if a refusal were missed, the install would stop at "not paired yet".
    unpaired(String(tg.botId), 'telegram');
    unpaired('fake:qq', 'qq');
    unpaired('fake:wechat', 'wechat');
    const { store, account } = context();
    store.setSecret(`telegram-bot:${account}`, tg.token);
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("is refused while another channel's service of this environment is installed, saying how to remove it", async () => {
    const qqService = install('qq');
    const telegram = await run(['relay', '--telegram', '--install-service', '--allow-file-store']);
    expect(telegram.code).toBe(1);
    expect(telegram.err).toContain(
      `这个环境已经安装了 QQ 的 relay 后台服务（${qqService}）。同一个账号和环境同时只能运行一个 relay：先用 yomi relay --channel qq --uninstall-service 删除它，再安装这个。`,
    );
    const english = await inEnglish(() =>
      run(['relay', '--telegram', '--install-service', '--allow-file-store']),
    );
    expect(english.err).toContain(
      `A QQ relay service is already installed for this environment (${qqService}). Only one relay per Yomi account and environment can run at a time: remove it first with yomi relay --channel qq --uninstall-service, then install this one.`,
    );
    rmSync(qqService);

    const telegramService = install('telegram');
    for (const args of [
      ['--channel', 'qq'],
      ['--channel', 'wechat', '--experimental'],
    ]) {
      const refused = await run(['relay', ...args, '--install-service', '--allow-file-store']);
      expect(refused.code, args.join(' ')).toBe(1);
      expect(refused.err, args.join(' ')).toContain(
        `这个环境已经安装了 Telegram 的 relay 后台服务（${telegramService}）。同一个账号和环境同时只能运行一个 relay：先用 yomi relay --telegram --uninstall-service 删除它，再安装这个。`,
      );
    }
    expect(fake.opened).toEqual([]);

    // A channel's own service is no reason: it goes on (here to "not paired yet").
    const again = await run(['relay', '--telegram', '--install-service', '--allow-file-store']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('还没有配对：先在终端里运行一次 yomi relay --telegram 完成配对');
    expect(readFileSync(telegramService, 'utf8')).toBe('# installed\n');
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { configDir, readJsonFile } from '../src/core/files.js';
import { acquireProcessLock } from '../src/core/lock.js';
import { sha256 } from '../src/core/state.js';
import { MOCK_NPCS, type MockServer, startMockServer } from '../src/mock/server.js';
import {
  type MockTelegram,
  type MockTelegramBot,
  startMockTelegram,
} from '../src/mock/telegram.js';
import type { ChannelSetup } from '../src/relay/channels/setup.js';
import { hubStatusPath } from '../src/relay/hub/hub.js';
import { LedgerFileStore, ledgerPath } from '../src/relay/hub/ledger.js';
import { BotRegistry, MAX_BOTS_PER_KIND, registryPath } from '../src/relay/registry.js';
import { servicePlan } from '../src/relay/service.js';
import { RelayState, relayStatePath } from '../src/relay/state.js';
import { TelegramBot } from '../src/relay/telegram.js';
import { authorizeLikeTheBrowser } from './helpers/authorize.js';
import { memoryIo } from './helpers/io.js';

/**
 * Adding, signing in again and removing bots through `yomi relay` (multi-bot design §1.1–§1.3,
 * with the user's decision for a running service), against the mock gateway and the mock Bot API:
 * a bot added with its character and a name of its own; duplicates (character, bot, name) refused
 * before anything is asked, and checked again where the bot is kept, leaving nothing behind;
 * credentials set again only for the same bot; the flags of before the registry mapped onto the
 * bots; `--forget --bot`, `--channel K --forget` and `--forget --all`; one change at a time (the
 * setup lock); and a running background service stopped for a change (a pairing included) and
 * started again after. Nothing is installed and no service manager is asked: the service module's
 * process, stop and start are the test's.
 */

/** The background service as the test plays it: its process, and what stopping it does. */
const service = vi.hoisted(() => ({
  pid: 0,
  paused: 0,
  resumed: 0,
  onPause: null as (() => void) | null,
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
      return true;
    },
    installService: () => undefined,
    uninstallService: (plan: { path: string }) => {
      remove(plan.path, { force: true });
      return true;
    },
  };
});

/**
 * Where the Telegram setup hands new credentials over to be kept: run once before (`beforeSave`),
 * or written with them as their state (`state`, which Telegram has none of).
 */
const hooks = vi.hoisted(() => ({
  beforeSave: null as (() => void) | null,
  state: null as (() => void) | null,
}));

vi.mock('../src/relay/channels/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/channels/telegram.js')>();
  const overrides: Partial<ChannelSetup> = {
    setCredentials: (context, request) =>
      real.telegramSetup.setCredentials(context, {
        ...request,
        save: (bot, state) => {
          const hook = hooks.beforeSave;
          hooks.beforeSave = null;
          hook?.();
          const write = hooks.state;
          return request.save(bot, write ? () => write() : state);
        },
      }),
  };
  return {
    ...real,
    telegramSetup: Object.assign(Object.create(real.telegramSetup) as ChannelSetup, overrides),
  };
});

let mock: MockServer;
let tg: MockTelegram;
let second: MockTelegramBot;
let third: MockTelegramBot;
let home: string;
const saved: Record<string, string | undefined> = {};
const owner = { id: 5580101, first_name: 'Ada', language_code: 'en' };

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  }
}

async function run(args: string[], options: Parameters<typeof memoryIo>[0] = {}) {
  process.exitCode = undefined;
  const terminal = memoryIo(options);
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
}

const context = () => createContext(memoryIo().io, {});
const registry = () => BotRegistry.open(context().account);
const hash = () => sha256(context().account).slice(0, 16);

/** `--set-token` of `bot`'s token from stdin, with `args` after it. */
const setToken = (bot: MockTelegramBot, args: string[] = []) =>
  run(['relay', '--telegram', '--set-token', '--token-stdin', '--allow-file-store', ...args], {
    input: [bot.token],
  });

/** The keychain entries the file store holds now. */
const secretNames = () =>
  Object.keys(readJsonFile<Record<string, string>>(join(configDir(), 'secrets.json')) ?? {});

/** A relay of the bot `name` running in this process (the "service" of the tests below). */
async function runBot(name: string, bot: MockTelegramBot, args: string[] = []) {
  const polls = bot.calls.filter((call) => call.method === 'getUpdates').length;
  const terminal = memoryIo();
  // Paired again (nobody does): it runs whether or not its bot has an owner.
  const pending = main(
    ['relay', '--bot', name, '--pair', '--allow-file-store', ...args],
    terminal.io,
  );
  await bot.waitFor(() => bot.calls.filter((call) => call.method === 'getUpdates').length > polls);
  return {
    terminal,
    pending,
    /** A second poller: Telegram's 409 stops the relay, which ends without failing. */
    stop: () =>
      void new TelegramBot(bot.token, { apiOrigin: bot.origin }).getUpdates(-1, 0).catch(() => {}),
  };
}

/** The Telegram service's unit as `--install-service` would write it, under the test's HOME. */
function installTelegramService(): string {
  const path = servicePlan({
    account: context().account,
    channel: 'telegram',
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

beforeAll(async () => {
  mock = await startMockServer();
  tg = await startMockTelegram({ username: 'Lin_Bots_Bot' });
  second = tg.addBot({ username: 'harbor_bots_bot', botId: 7_000_000_301 });
  third = tg.addBot({ username: 'third_bots_bot', botId: 7_000_000_302 });
  home = mkdtempSync(join(tmpdir(), 'yomi-relay-bots-home-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_TELEGRAM_API_ORIGIN: tg.origin,
    YOMI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'yomi-relay-bots-')),
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
    // Never the real ~/Library/LaunchAgents or ~/.config/systemd/user.
    HOME: home,
  });
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  await authorizeLikeTheBrowser(mock, url);
  expect(await pending).toBe(0);
});

afterEach(() => {
  Object.assign(service, { pid: 0, paused: 0, resumed: 0, onPause: null });
  hooks.beforeSave = null;
  hooks.state = null;
});

afterAll(async () => {
  await tg.close();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('adding a bot', () => {
  it('registers it with its character under a name of its own, and its secret under its key', async () => {
    const added = await setToken(tg, ['--character', MOCK_NPCS.single]);
    expect(added.code).toBe(0);
    expect(added.err).toBe('');
    expect(added.out).toContain('已保存 @Lin_Bots_Bot 的 token');
    expect(added.out).toContain(`已添加 bot lin_bots_bot，固定和林夏（${MOCK_NPCS.single}）聊天。`);
    // Paired by its name: the command the CLI takes however many bots the channel has.
    expect(added.out).toContain(
      '接下来运行 yomi relay --bot lin_bots_bot --pair，在 Telegram 里完成配对。',
    );
    const [record] = registry().list();
    expect(record).toMatchObject({
      name: 'lin_bots_bot',
      kind: 'telegram',
      platformId: String(tg.botId),
      scope: String(tg.botId),
      lockName: String(tg.botId),
      secretName: `telegram-bot:${context().account}#${record.key}`,
      character: { npcId: MOCK_NPCS.single, name: '林夏' },
    });
    expect(context().store.getSecret(record.secretName)).toBe(tg.token);
    // Named, and without a character: bound later.
    const named = await setToken(second, ['--bot', 'harbor']);
    expect(named.code).toBe(0);
    expect(named.out).toContain(
      '已添加 bot harbor，还没有绑定角色：yomi relay --bot harbor --character ID',
    );
    expect(registry().find('harbor')).toMatchObject({ character: null, boundAt: 0 });
    const listed = await run(['--lang', 'en', 'relay', '--list']);
    expect(listed.out).toContain('  Status: needs pairing: yomi relay --bot harbor --pair');
  });

  it('refuses a character, a bot or a name another bot has, before anything is asked', async () => {
    const revision = registry().data.revision;
    const checks = () => third.calls.filter((call) => call.method === 'getMe').length;
    const asked = checks();
    const character = await setToken(third, ['--character', MOCK_NPCS.single]);
    expect(character.code).toBe(1);
    expect(character.err).toContain(
      `角色 ${MOCK_NPCS.single} 已经绑在 bot "lin_bots_bot" 上：一个角色只能绑一个 bot。`,
    );
    // The same bot again: named, with how to change it.
    const twice = await setToken(tg, ['--character', MOCK_NPCS.group]);
    expect(twice.code).toBe(1);
    expect(twice.err).toContain(
      '这个 bot 已经登记在这台电脑上了，名字是 "lin_bots_bot"。要重新设置它的凭证：yomi relay --telegram --bot lin_bots_bot --set-token；要给它换角色：yomi relay --bot lin_bots_bot --character ID',
    );
    const english = await run(
      [
        '--lang',
        'en',
        'relay',
        '--telegram',
        '--set-token',
        '--token-stdin',
        '--allow-file-store',
        '--character',
        MOCK_NPCS.group,
      ],
      { input: [tg.token] },
    );
    expect(english.err).toContain(
      'This bot is registered on this computer already, as "lin_bots_bot".',
    );
    const name = await setToken(third, ['--bot', 'Not A Name']);
    expect(name.code).toBe(1);
    expect(name.err).toContain('bot 名字 "Not A Name" 不能用');
    expect(checks()).toBe(asked);
    expect(registry().data.revision).toBe(revision);
    expect(secretNames().filter((key) => key.startsWith('telegram-bot:'))).toHaveLength(2);
    // A channel with as many bots as it may have: refused before Telegram is asked, too.
    const filler = (index: number) => ({
      key: `filler${index}`,
      name: `filler-${index}`,
      kind: 'telegram' as const,
      character: null,
      platformId: String(7_100_000_000 + index),
      label: `@filler_${index}_bot`,
      scope: String(7_100_000_000 + index),
      secretName: `telegram-bot:${context().account}#filler${index}`,
      lockName: String(7_100_000_000 + index),
      createdAt: Date.now(),
      boundAt: 0,
      generation: 0,
    });
    registry().commit((file) => {
      for (let index = file.bots.length; index < MAX_BOTS_PER_KIND; index++)
        file.bots.push(filler(index));
    });
    try {
      const full = await setToken(third, ['--character', MOCK_NPCS.group]);
      expect(full.code).toBe(1);
      expect(full.err).toContain(`bot 太多了：每个通道最多登记 ${MAX_BOTS_PER_KIND} 个。`);
      expect(checks()).toBe(asked);
    } finally {
      registry().commit((file) => {
        file.bots = file.bots.filter((record) => !record.key.startsWith('filler'));
      });
    }
  });

  it('checks again where the bot is kept, and leaves nothing behind when keeping it fails', async () => {
    const { store } = context();
    const before = secretNames();
    // Another command binds the character meanwhile (a WeChat scan may take minutes).
    hooks.beforeSave = () => {
      const harbor = registry().find('harbor')!;
      registry().rebind(harbor.key, { npcId: MOCK_NPCS.group, name: '雾港', group: true });
    };
    const raced = await setToken(third, ['--character', MOCK_NPCS.group]);
    expect(raced.code).toBe(1);
    expect(raced.err).toContain(`角色 ${MOCK_NPCS.group} 已经绑在 bot "harbor" 上`);
    expect(secretNames()).toEqual(before);
    expect(
      registry()
        .list()
        .map((record) => record.name),
    ).toEqual(['lin_bots_bot', 'harbor']);
    // Writing what goes with the secret fails after the secret was written: it is taken back.
    hooks.state = () => {
      throw new Error('the disk is full');
    };
    const failed = await setToken(third, ['--bot', 'third']);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('the disk is full');
    expect(secretNames()).toEqual(before);
    expect(registry().list()).toHaveLength(2);
    expect(store.getSecret(`telegram-bot:${context().account}`)).toBeNull();
  });
});

describe('the flags of before the registry', () => {
  it('set the one bot of a channel again, and ask which when it has several', async () => {
    const which = await setToken(tg);
    expect(which.code).toBe(1);
    expect(which.err).toContain(
      'Telegram 有多个 bot（lin_bots_bot、harbor）：重新设置其中一个的凭证用 yomi relay --bot 名字 --set-token，添加新的 bot 用 yomi relay --telegram --set-token --character ID。',
    );
    // By name: only its own token, refused before Telegram is asked: another registered bot's
    // is named, any other one's said to be another bot.
    const checks = () =>
      [second, third].map((bot) => bot.calls.filter((call) => call.method === 'getMe').length);
    const asked = checks();
    const registered = await run(
      ['relay', '--bot', 'lin_bots_bot', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [second.token] },
    );
    expect(registered.code).toBe(1);
    expect(registered.err).toContain('这个 bot 已经登记在这台电脑上了，名字是 "harbor"');
    const other = await run(
      ['relay', '--bot', 'lin_bots_bot', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [third.token] },
    );
    expect(other.code).toBe(1);
    expect(other.err).toContain('这些凭证属于另一个 bot，不是 lin_bots_bot，没有保存。');
    expect(checks()).toEqual(asked);
    const before = registry().find('lin_bots_bot')!;
    const own = await run(
      ['relay', '--bot', 'lin_bots_bot', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [tg.token] },
    );
    expect(own.code).toBe(0);
    expect(registry().find('lin_bots_bot')).toEqual({
      ...before,
      generation: before.generation + 1,
    });
    // A channel flag naming another channel than the bot's.
    const wrong = await run(['relay', '--channel', 'qq', '--bot', 'lin_bots_bot', '--set-app']);
    expect(wrong.err).toContain('"lin_bots_bot" 是 Telegram 的 bot，不是 QQ 的。');
  });
});

describe('one change at a time', () => {
  it('refuses a change while another one runs (the setup lock)', async () => {
    const lock = acquireProcessLock(join(configDir(), 'locks', `relay-setup-${hash()}.lock`), {
      channel: 'wechat',
      flag: '--login',
    });
    if (!('release' in lock)) throw new Error('the setup lock is taken');
    try {
      const refused = await run(['relay', '--forget', '--bot', 'harbor']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        `yomi relay --channel wechat --experimental --login 正在运行（进程 ${process.pid}）：等它结束后再 --forget。`,
      );
      // Nothing is asked before the lock is: the token waiting on stdin is never read.
      const renew = await run(
        ['relay', '--bot', 'harbor', '--set-token', '--token-stdin', '--allow-file-store'],
        { input: [second.token] },
      );
      expect(renew.code).toBe(1);
      expect(renew.err).toContain('--login 正在运行（进程');
      expect(renew.err).toContain('等它结束后再 --set-token。');
    } finally {
      lock.release();
    }
    expect(registry().find('harbor')).toBeDefined();
  });
});

describe('a background service running', () => {
  it('is stopped for a change and started again after, saying so', async () => {
    const path = installTelegramService();
    const label = servicePlan({
      account: context().account,
      channel: 'telegram',
      node: process.execPath,
      script: 'cli.js',
      args: [],
      environment: {},
      logDir: join(home, 'logs'),
    }).label;
    try {
      const running = await runBot('lin_bots_bot', tg);
      Object.assign(service, { pid: process.pid, onPause: running.stop });
      const added = await setToken(third, ['--bot', 'third']);
      expect(added.code, added.err).toBe(0);
      expect(service).toMatchObject({ paused: 1, resumed: 1 });
      expect(await running.pending).toBe(0);
      const said = (text: string) => added.out.indexOf(text);
      expect(said(`正在停止后台服务（${label}），改完后会重新启动它。`)).toBeGreaterThanOrEqual(0);
      expect(said('正在停止后台服务')).toBeLessThan(said('已保存 @third_bots_bot'));
      expect(said('已保存 @third_bots_bot')).toBeLessThan(said(`已重新启动后台服务（${label}）。`));
      // A change refused before anything is stopped (a character another bot has).
      const again = await runBot('lin_bots_bot', tg);
      Object.assign(service, { paused: 0, resumed: 0, onPause: again.stop });
      const bound = await run(['relay', '--bot', 'harbor', '--character', MOCK_NPCS.single]);
      expect(bound.code).toBe(1);
      expect(bound.err).toContain('已经绑在 bot "lin_bots_bot" 上');
      expect(service.paused).toBe(0);
      // Taken away while it runs.
      const removed = await run(['relay', '--forget', '--bot', 'third']);
      expect(removed.code).toBe(0);
      expect(service).toMatchObject({ paused: 1, resumed: 1 });
      expect(removed.out).toContain(`正在停止后台服务（${label}），改完后会重新启动它。`);
      expect(removed.out).toContain('已删除 bot third（Telegram @third_bots_bot）。');
      expect(removed.out).toContain(`已重新启动后台服务（${label}）。`);
      expect(await again.pending).toBe(0);
      expect(registry().find('third')).toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('is left alone when a relay runs in a terminal: the change is refused', async () => {
    const running = await runBot('lin_bots_bot', tg);
    try {
      const refused = await run(['relay', '--forget', '--bot', 'harbor']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        `relay 正在运行（Telegram bot @Lin_Bots_Bot，进程 ${process.pid}）：先停止它（Ctrl+C，或 yomi relay --telegram --uninstall-service），再 --forget。`,
      );
      expect(service.paused).toBe(0);
    } finally {
      running.stop();
      expect(await running.pending).toBe(0);
    }
  });

  it('is stopped while an owner pairs in this terminal, and started again once they did', async () => {
    const path = installTelegramService();
    try {
      const running = await runBot('lin_bots_bot', tg);
      Object.assign(service, { pid: process.pid, onPause: running.stop });
      const terminal = memoryIo();
      const pending = main(
        ['relay', '--bot', 'harbor', '--pair', '--allow-file-store'],
        terminal.io,
      );
      const code = (await terminal.waitFor(/\/start ([A-Z2-9]{8})/))[1];
      expect(await running.pending).toBe(0);
      expect(terminal.out).toContain('正在停止后台服务');
      expect(terminal.out).toContain('配对完成（或按 Ctrl+C）后，这次运行结束，后台服务重新启动。');
      await second.waitFor(() => second.calls.some((call) => call.method === 'getUpdates'));
      second.userSends(owner, `/start ${code}`);
      expect(await pending).toBe(0);
      expect(service).toMatchObject({ paused: 1, resumed: 1 });
      expect(terminal.out).toContain('已重新启动后台服务');
      expect(second.messages(owner.id)[0].text).toMatch(/^已配对/);
      const { account } = context();
      const harbor = registry().find('harbor')!;
      expect(
        new RelayState(relayStatePath(account, harbor.scope), harbor.scope, account).data.owner
          ?.userId,
      ).toBe(owner.id);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('a background service stopped for a change', () => {
  it('is started again when a signal ends this process before the change is over', async () => {
    const path = installTelegramService();
    const exits: (number | string | null | undefined)[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code) => {
      exits.push(code);
    }) as typeof process.exit);
    const listening = process.listenerCount('SIGHUP');
    try {
      const running = await runBot('lin_bots_bot', tg);
      Object.assign(service, { pid: process.pid, onPause: running.stop });
      // The terminal closes while the bot is being added (a QR scan may take minutes).
      let resumed = -1;
      hooks.beforeSave = () => {
        process.emit('SIGHUP', 'SIGHUP');
        resumed = service.resumed;
      };
      const added = await setToken(third, ['--bot', 'third']);
      expect(await running.pending).toBe(0);
      // Started again before this process would have ended (129: SIGHUP), and only once.
      expect(resumed).toBe(1);
      expect(exits).toEqual([129]);
      expect(added.code, added.err).toBe(0);
      expect(service).toMatchObject({ paused: 1, resumed: 1 });
      expect(process.listenerCount('SIGHUP')).toBe(listening);
    } finally {
      exit.mockRestore();
      rmSync(path, { force: true });
    }
    expect((await run(['relay', '--forget', '--bot', 'third'])).code).toBe(0);
  });

  it("pairs under the service's cap: the shared running total is kept", async () => {
    const path = installTelegramService();
    const { account } = context();
    const ledger = LedgerFileStore.open(account);
    ledger.bindAccount(context().gateway.credential!.userId);
    ledger.setAllowance({ maxSpend: 100, spent: 90, since: Date.now(), unmeasured: 0 });
    try {
      const running = await runBot('lin_bots_bot', tg, ['--max-spend', '100']);
      Object.assign(service, { pid: process.pid, onPause: running.stop });
      // Another cap typed with --pair is the service's to change: refused, nothing stopped.
      const other = await run([
        'relay',
        '--bot',
        'harbor',
        '--pair',
        '--max-spend',
        '50',
        '--allow-file-store',
      ]);
      expect(other.code).toBe(1);
      expect(other.err).toContain(
        '后台服务在运行，配对时用它的花费上限（100）：去掉 --max-spend 50 再 --pair；要改上限，加上它重新 --install-service。',
      );
      expect(service.paused).toBe(0);
      const polls = second.calls.filter((call) => call.method === 'getUpdates').length;
      const terminal = memoryIo();
      const pending = main(
        ['relay', '--bot', 'harbor', '--pair', '--allow-file-store'],
        terminal.io,
      );
      const code = (await terminal.waitFor(/\/start ([A-Z2-9]{8})/))[1];
      expect(await running.pending).toBe(0);
      expect(terminal.out).toContain('本机允许 relay 最多花 100 钻石');
      await second.waitFor(
        () => second.calls.filter((call) => call.method === 'getUpdates').length > polls,
      );
      second.userSends(owner, `/start ${code}`);
      expect(await pending).toBe(0);
      expect(service).toMatchObject({ paused: 1, resumed: 1 });
      // Neither the pairing run nor the service started again (same cap) starts the total over.
      expect(LedgerFileStore.open(account).allowance()).toMatchObject({ maxSpend: 100, spent: 90 });
    } finally {
      rmSync(path, { force: true });
      rmSync(ledgerPath(account), { force: true });
    }
  });
});

describe('removing bots', () => {
  it('takes one bot away by name, and refuses a channel of several or a plain --all', async () => {
    const { store, account } = context();
    const several = await run(['relay', '--telegram', '--forget']);
    expect(several.code).toBe(1);
    expect(several.err).toContain(
      'Telegram 有多个 bot（lin_bots_bot、harbor）：用 --forget --bot 名字删除其中一个（--forget --all 会删除这台电脑上所有通道的全部 bot）。',
    );
    const all = await run(['relay', '--all']);
    expect(all.err).toContain('--all 只和 --forget 一起用');
    const mixed = await run(['relay', '--forget', '--all', '--bot', 'harbor']);
    expect(mixed.err).toContain('--forget --all 删除全部 bot，不能再加 --bot 或通道。');
    const harbor = registry().find('harbor')!;
    expect(existsSync(relayStatePath(account, harbor.scope))).toBe(true);
    const removed = await run(['relay', '--forget', '--bot', 'harbor']);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain('已删除 bot harbor（Telegram @harbor_bots_bot）。');
    expect(removed.out).toContain('已删除本机保存的 bot token 和配对信息（1 份）。');
    expect(store.getSecret(harbor.secretName)).toBeNull();
    expect(existsSync(relayStatePath(account, harbor.scope))).toBe(false);
    expect(
      registry()
        .list()
        .map((record) => record.name),
    ).toEqual(['lin_bots_bot']);
    // The other one keeps its token and runs.
    expect(store.getSecret(registry().find('lin_bots_bot')!.secretName)).toBe(tg.token);
    const unknown = await run(['relay', '--forget', '--bot', 'harbor']);
    expect(unknown.err).toContain('没有叫 "harbor" 的 bot。');
  });

  it('refuses --forget --all while a relay runs in a terminal, after taking the services away', async () => {
    const { store } = context();
    const path = installTelegramService();
    const running = await runBot('lin_bots_bot', tg);
    try {
      const refused = await run(['relay', '--forget', '--all']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        `relay 正在运行（Telegram bot @Lin_Bots_Bot，进程 ${process.pid}）：先停止它（Ctrl+C，或 yomi relay --telegram --uninstall-service），再 --forget --all。`,
      );
      // The services go first (design §1.3); the bots stay, with their secrets and states.
      expect(refused.out).toContain(`已停止并删除后台服务（${path}）`);
      expect(existsSync(path)).toBe(false);
      const [record] = registry().list();
      expect(registry().list()).toHaveLength(1);
      expect(store.getSecret(record.secretName)).toBe(tg.token);
      expect(existsSync(relayStatePath(context().account, record.scope))).toBe(true);
      expect(service.paused).toBe(0);
    } finally {
      running.stop();
      expect(await running.pending).toBe(0);
      rmSync(path, { force: true });
    }
  });

  it('takes every bot away with --forget --all: services, secrets, states, ledger and registry', async () => {
    const { store, account } = context();
    const path = installTelegramService();
    // A secret of before the registry for another bot, and the ledger the bots shared.
    store.setSecret(`telegram-bot:${account}`, second.token);
    expect((await run(['relay', '--list'])).out).toContain(`telegram  Telegram  ${second.botId}`);
    writeFileSync(ledgerPath(account), '{}');
    writeFileSync(hubStatusPath(account), '{}');
    const removed = await run(['relay', '--forget', '--all']);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(`已停止并删除后台服务（${path}）`);
    expect(removed.out).toMatch(/已删除这台电脑上的 2 个 bot，以及它们的凭证、配对信息和花费记录/);
    expect(removed.out).toContain('如果 token 可能泄露');
    expect(existsSync(path)).toBe(false);
    for (const file of [ledgerPath(account), hubStatusPath(account), registryPath(account)])
      expect(existsSync(file), file).toBe(false);
    expect(secretNames().filter((key) => key.includes('-bot:'))).toEqual([]);
    const again = await run(['relay', '--forget', '--all']);
    expect(again.out).toContain('这台电脑上没有 bot，也没有保存的凭证或配对信息。');
    const english = await run(['--lang', 'en', 'relay', '--forget', '--all']);
    expect(english.out).toContain(
      'There are no bots on this computer, and no credentials or pairing info are saved.',
    );
  });
});

describe('a run of a channel without a bot', () => {
  it('only adds the bot while the background service runs, and says how to pair it', async () => {
    const path = installTelegramService();
    // The service holds the environment's lock, and lets go of it when it is stopped.
    const held = acquireProcessLock(join(configDir(), 'locks', `relay-env-${hash()}.lock`), {
      channel: 'qq',
    });
    if (!('release' in held)) throw new Error('the environment lock is taken');
    Object.assign(service, { pid: process.pid, onPause: () => held.release() });
    try {
      const polls = second.calls.filter((call) => call.method === 'getUpdates').length;
      const added = await run(['relay', '--telegram', '--token-stdin', '--allow-file-store'], {
        input: [second.token],
      });
      expect(added.code, added.err).toBe(0);
      expect(service).toMatchObject({ paused: 1, resumed: 1 });
      expect(added.out).toContain('正在停止后台服务');
      expect(added.out).toContain(
        '接下来运行 yomi relay --bot harbor_bots_bot --pair，在 Telegram 里完成配对。',
      );
      expect(added.out).toContain('已添加 bot harbor_bots_bot');
      expect(added.out).toContain('已重新启动后台服务');
      // Nothing ran beside the service started again.
      expect(added.out).not.toContain('relay 运行中');
      expect(second.calls.filter((call) => call.method === 'getUpdates')).toHaveLength(polls);
    } finally {
      held.release();
      rmSync(path, { force: true });
    }
    expect((await run(['relay', '--forget', '--all'])).code).toBe(0);
  });

  it("adds the bot as it starts, binds the run's --character, and goes on with it", async () => {
    const { account, store } = context();
    const started = await run(
      [
        'relay',
        '--telegram',
        '--token-stdin',
        '--allow-file-store',
        '--character',
        MOCK_NPCS.single,
      ],
      { input: [tg.token] },
    );
    expect(started.code, started.err).toBe(0);
    const [record] = registry().list();
    expect(registry().list()).toHaveLength(1);
    expect(record).toMatchObject({
      name: 'lin_bots_bot',
      secretName: `telegram-bot:${account}#${record.key}`,
      character: { npcId: MOCK_NPCS.single },
    });
    expect(store.getSecret(record.secretName)).toBe(tg.token);
    // Asked as the run started: what to run next is not said, the run goes on (to pairing,
    // which nobody can do here: said with the bot's own command).
    expect(started.out).not.toContain('已保存 @');
    expect(started.out).not.toContain('接下来运行');
    expect(started.err).toContain(
      '还没有配对：请在终端里运行一次 yomi relay --bot lin_bots_bot --pair，按提示在 Telegram 里发送配对码。',
    );
    // Without a token to read and nobody at a terminal: said, nothing added.
    expect((await run(['relay', '--forget', '--all'])).code).toBe(0);
    const nobody = await run(['relay', '--telegram', '--allow-file-store']);
    expect(nobody.code).toBe(0);
    expect(nobody.err).toContain('还没有设置 bot token：先运行 yomi relay --telegram --set-token');
    expect(registry().list()).toEqual([]);
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { configDir } from '../src/core/files.js';
import { acquireProcessLock, lockHolder } from '../src/core/lock.js';
import { sha256 } from '../src/core/state.js';
import { type MockQq, startMockQq } from '../src/mock/qq.js';
import { MOCK_NPCS, type MockServer, startMockServer } from '../src/mock/server.js';
import {
  type MockTelegram,
  type MockTelegramBot,
  startMockTelegram,
} from '../src/mock/telegram.js';
import type { ChannelKind } from '../src/relay/channels/types.js';
import { Ledger, LedgerFileStore } from '../src/relay/hub/ledger.js';
import { BotRegistry } from '../src/relay/registry.js';
import { installedArgs, servicePlan, type ServiceUnit } from '../src/relay/service.js';
import { RelayState, relayStatePath } from '../src/relay/state.js';
import { TelegramBot } from '../src/relay/telegram.js';
import { authorizeLikeTheBrowser } from './helpers/authorize.js';
import { memoryIo } from './helpers/io.js';

/**
 * The one background service (multi-bot design §1.5, phase 8): one unit per Yomi account and
 * environment that runs every registered bot (`relay --env …`, no channel, bot or character),
 * installed only when a bot can run in it (the others said, with what to run), replacing the
 * per-channel units of before it; `--service-status` and `--list` saying how it and each bot are;
 * `--uninstall-service` removing it and those of before; a change to the bots stopping it and
 * starting it again, not after the last bot went, and saying how to start one that is installed
 * but not running, with the cap it runs with; an older per-channel unit that holds the environment's
 * lock replaced, and one started again after a change said to run its own channel's bots only.
 * Against the mock gateway, the mock Bot API and the mock QQ API; no service manager is asked:
 * the service module's install, process, stop and start are the test's, and the units are written
 * under the test's HOME.
 */

/** The service manager as the test plays it: each unit's process, and what it was asked. */
const service = vi.hoisted(() => ({
  pids: new Map<string, number>(),
  paused: [] as string[],
  resumed: [] as string[],
  installed: [] as string[],
  onPause: null as (() => void) | null,
  onUninstall: null as ((path: string) => void) | null,
  /** Whether the environment's lock was held as each unit was loaded. */
  heldAtInstall: [] as boolean[],
  lockHeld: (): boolean => false,
}));

vi.mock('../src/relay/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/service.js')>();
  const fs = await import('node:fs');
  return {
    ...real,
    servicePid: (plan: { path: string }) => service.pids.get(plan.path) ?? 0,
    pauseService: (plan: { label: string }) => {
      service.paused.push(plan.label);
      service.onPause?.();
    },
    resumeService: (plan: { label: string }) => {
      service.resumed.push(plan.label);
      return true;
    },
    installService: (plan: Parameters<typeof real.installService>[0]) => {
      service.heldAtInstall.push(service.lockHeld());
      real.writeServiceUnit(plan);
      service.installed.push(plan.content);
    },
    uninstallService: (plan: { path: string }) => {
      const existed = fs.existsSync(plan.path);
      fs.rmSync(plan.path, { force: true });
      service.onUninstall?.(plan.path);
      return existed;
    },
  };
});

let mock: MockServer;
let tg: MockTelegram;
let second: MockTelegramBot;
let home: string;
const saved: Record<string, string | undefined> = {};

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

/** A unit of this account and environment, as the CLI names it, under the test's HOME. */
const unit = (kind: ServiceUnit, args: string[] = []) =>
  servicePlan({
    account: context().account,
    channel: kind,
    node: process.execPath,
    script: 'cli.js',
    args,
    environment: {},
    logDir: join(configDir(), 'logs'),
  });

/** A per-channel unit of before the hub, as an older yomi left it (running `args`). */
function installLegacy(kind: ChannelKind, args: string[] = []): string {
  const { path, content } = unit(kind, args);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const environmentLock = () =>
  join(configDir(), 'locks', `relay-env-${sha256(context().account).slice(0, 16)}.lock`);

/** Gives the bot `name` an owner, as a pairing would. */
function pair(name: string) {
  const { account } = context();
  const record = registry().find(name)!;
  new RelayState(relayStatePath(account, record.scope), record.scope, account, record.kind).update({
    owner: { userId: '5580201', chatId: '5580201', name: 'Ada', language: 'en', pairedAt: 1 },
  });
}

/**
 * The hub's service running in this process: it holds the environment's lock and lets go of it
 * when it is stopped.
 */
function runHubService() {
  const lock = acquireProcessLock(environmentLock(), { channel: 'telegram' });
  if (!('release' in lock)) throw new Error('the environment lock is taken');
  service.pids.set(unit('hub').path, process.pid);
  service.onPause = () => lock.release();
  return lock;
}

beforeAll(async () => {
  mock = await startMockServer();
  tg = await startMockTelegram({ username: 'Lin_Svc_Bot' });
  second = tg.addBot({ username: 'harbor_svc_bot', botId: 7_000_000_401 });
  home = mkdtempSync(join(tmpdir(), 'yomi-relay-service-home-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_TELEGRAM_API_ORIGIN: tg.origin,
    YOMI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'yomi-relay-service-')),
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
    // Never the real ~/Library/LaunchAgents or ~/.config/systemd/user.
    HOME: home,
  });
  expect(unit('hub').path.startsWith(home)).toBe(true);
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  await authorizeLikeTheBrowser(mock, url);
  expect(await pending).toBe(0);
});

afterEach(() => {
  service.pids.clear();
  service.paused.length = 0;
  service.resumed.length = 0;
  service.onPause = null;
  service.onUninstall = null;
  service.heldAtInstall.length = 0;
  service.lockHeld = () => false;
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

describe('the one background service', () => {
  it('is not installed without a bot that can run in it, saying what each needs', async () => {
    const empty = await run(['relay', '--install-service', '--allow-file-store']);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain('这台电脑上还没有 bot，后台服务没有可运行的：先添加一个');
    const english = await run(['--lang', 'en', 'relay', '--install-service', '--allow-file-store']);
    expect(english.err).toContain(
      'There are no bots on this computer yet, so a background service would have nothing to run',
    );
    const status = await run(['relay', '--service-status']);
    expect(status.code).toBe(0);
    expect(status.out).toContain('没有安装后台服务。');
    expect(status.out).toContain('这台电脑上还没有 bot：');

    const added = await run(
      [
        'relay',
        '--telegram',
        '--set-token',
        '--token-stdin',
        '--allow-file-store',
        '--character',
        MOCK_NPCS.single,
      ],
      { input: [tg.token] },
    );
    expect(added.code, added.err).toBe(0);
    // Nobody paired with it yet: a service has nobody to show a pairing code to.
    const unpaired = await run(['relay', '--install-service', '--allow-file-store']);
    expect(unpaired.code).toBe(1);
    expect(unpaired.err).toContain(
      'bot lin_svc_bot 还不能在后台服务里运行：需要配对：yomi relay --bot lin_svc_bot --pair',
    );
    expect(unpaired.err).toContain(
      '这些 bot 都还不能在后台服务里运行（见上面），所以没有安装后台服务。',
    );
    expect(service.installed).toEqual([]);
    expect(existsSync(unit('hub').path)).toBe(false);
  });

  it('runs every bot, replaces the per-channel units of before, and names the ones that cannot run', async () => {
    pair('lin_svc_bot');
    const added = await run(
      [
        'relay',
        '--telegram',
        '--set-token',
        '--token-stdin',
        '--allow-file-store',
        '--bot',
        'harbor',
      ],
      { input: [second.token] },
    );
    expect(added.code, added.err).toBe(0);
    const telegram = installLegacy('telegram');
    const qq = installLegacy('qq');
    const listed = await run(['relay', '--list']);
    // No hub beside them: removing them all is offered too.
    expect(listed.out).toContain(
      '还装着旧版按通道分开的后台服务（Telegram、QQ）：yomi relay --install-service 会换成一个运行所有 bot 的服务（yomi relay --uninstall-service 删除它们）',
    );

    const hub = unit('hub');
    // A channel named is no narrower service: it runs every bot all the same.
    const installed = await run([
      'relay',
      '--telegram',
      '--install-service',
      '--allow-file-store',
      '--max-spend',
      '50',
    ]);
    expect(installed.code, installed.err).toBe(0);
    expect(installed.err).toContain(
      'bot harbor 还不能在后台服务里运行：需要配对：yomi relay --bot harbor --pair',
    );
    expect(installed.err).toContain('bot harbor 还没有绑定角色');
    expect(installed.out).toContain(`已停止并删除后台服务（${telegram}）`);
    expect(installed.out).toContain(`已停止并删除后台服务（${qq}）`);
    expect(installed.out).toContain(`已安装并启动后台服务：${hub.path}`);
    expect(installed.out).toContain(
      '它在一个进程里运行这台电脑上的全部 bot（2 个）：lin_svc_bot、harbor。',
    );
    expect(installed.out).toContain('本机允许 relay 最多花 50 钻石（累计）。');
    expect(installed.out).toContain(`日志：${hub.log}；停止并删除：yomi relay --uninstall-service`);
    for (const path of [telegram, qq]) expect(existsSync(path), path).toBe(false);
    // The unit: a run of every bot, with the run's own arguments only.
    expect(service.installed).toHaveLength(1);
    const content = readFileSync(hub.path, 'utf8');
    expect(content).toBe(service.installed[0]);
    for (const word of ['--telegram', '--channel', '--bot', '--character', '--experimental'])
      expect(content, word).not.toContain(`>${word}<`);
    if (hub.platform === 'darwin')
      expect(content).toMatch(
        /<string>relay<\/string>\s*<string>--env<\/string>[\s\S]*<string>--allow-file-store<\/string>\s*<string>--max-spend<\/string>\s*<string>50<\/string>/,
      );
    else expect(content).toMatch(/"relay" "--env" "[^"]+" "--allow-file-store" "--max-spend" "50"/);
    // --bot is a run's, never the service's.
    const named = await run(['relay', '--bot', 'harbor', '--install-service']);
    expect(named.code).toBe(1);
    expect(named.err).toContain(
      '--bot 不能和 --install-service 一起用：后台服务运行这台电脑上的全部 bot（yomi relay --install-service）',
    );
  });

  it('says how it and each bot are in --service-status and --list', async () => {
    const hub = unit('hub');
    const stopped = await run(['relay', '--service-status']);
    expect(stopped.code).toBe(0);
    // Started again with what it was installed with: a bare --install-service would drop its cap.
    expect(stopped.out).toContain(
      `后台服务：已安装，没有在运行（${hub.label}）：用 yomi relay --allow-file-store --max-spend 50 --install-service 重新启动它`,
    );
    expect(stopped.out).toContain(`  单元文件：${hub.path}`);
    expect(stopped.out).toContain(`  日志：${hub.log}`);
    expect(stopped.out).toContain('lin_svc_bot  Telegram  @Lin_Svc_Bot');
    expect(stopped.out).toContain('  状态：需要配对：yomi relay --bot harbor --pair');
    service.pids.set(hub.path, 4321);
    const running = await run(['relay', '--service-status']);
    expect(running.out).toContain(`后台服务：运行中（进程 4321），运行所有 bot（${hub.label}）`);
    const english = await run(['--lang', 'en', 'relay', '--service-status']);
    expect(english.out).toContain(
      `Background service: running (process 4321), for every bot (${hub.label})`,
    );
    expect(english.out).toContain(`  Unit file: ${hub.path}`);
    expect(english.out).toContain('  Status: needs pairing: yomi relay --bot harbor --pair');
    // A unit of before it left beside it is said, with its own state.
    const wechat = installLegacy('wechat');
    try {
      const both = await run(['--lang', 'en', 'relay', '--service-status']);
      // Beside the hub, --uninstall-service is not offered: it would remove the hub too.
      expect(both.out).toContain(
        'Older per-channel background services are still installed (WeChat): yomi relay --allow-file-store --max-spend 50 --install-service replaces them with one for every bot\n',
      );
      expect(both.out).not.toContain('--uninstall-service removes them');
      expect(both.out).toContain(`  WeChat: not running (${wechat})`);
      const chinese = await run(['relay', '--service-status']);
      expect(chinese.out).toContain(`  微信：没有运行（${wechat}）`);
      const listed = await run(['relay', '--list']);
      expect(listed.out).toContain(`后台服务：运行中（进程 4321），运行所有 bot（${hub.label}）`);
      expect(listed.out).not.toContain('单元文件');
    } finally {
      rmSync(wechat, { force: true });
    }
  });

  it('is refused beside a relay running in a terminal, and started again when it was running', async () => {
    const hub = unit('hub');
    const terminal = acquireProcessLock(environmentLock(), {
      channel: 'telegram',
      bot: '@Lin_Svc_Bot',
    });
    if (!('release' in terminal)) throw new Error('the environment lock is taken');
    try {
      const refused = await run(['relay', '--install-service', '--allow-file-store']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        `relay 正在运行（Telegram bot @Lin_Svc_Bot，进程 ${process.pid}）：先停止它（Ctrl+C，或 yomi relay --uninstall-service），再 --install-service。`,
      );
      expect(service.installed).toHaveLength(1);
    } finally {
      terminal.release();
    }
    // The hub's own service: stopped, let go of, then loaded again with the new arguments.
    const lock = runHubService();
    try {
      const again = await run(['relay', '--install-service', '--allow-file-store']);
      expect(again.code, again.err).toBe(0);
      expect(service.paused).toEqual([hub.label]);
      expect(service.installed).toHaveLength(2);
      expect(service.installed[1]).not.toContain('--max-spend');
      expect(again.out).toContain('没有本机花费上限');
    } finally {
      lock.release();
    }
  });

  it('is stopped for a change and started again, says when it does not run, and stays stopped without bots', async () => {
    const hub = unit('hub');
    let lock = runHubService();
    try {
      const removed = await run(['relay', '--forget', '--bot', 'harbor']);
      expect(removed.code, removed.err).toBe(0);
      expect(removed.out).toContain(`正在停止后台服务（${hub.label}），改完后会重新启动它。`);
      expect(removed.out).toContain('已删除 bot harbor（Telegram @harbor_svc_bot）。');
      expect(removed.out).toContain(`已重新启动后台服务（${hub.label}）。`);
      expect(service.resumed).toEqual([hub.label]);
    } finally {
      lock.release();
    }
    // Installed, not running (it ended with nothing to run, or was stopped by hand): a change does
    // not start it, and says how.
    service.pids.clear();
    service.paused.length = 0;
    service.resumed.length = 0;
    const bound = await run(['relay', '--bot', 'lin_svc_bot', '--character', MOCK_NPCS.group]);
    expect(bound.code, bound.err).toBe(0);
    expect(bound.out).toContain(
      '后台服务已安装，但没有在运行，所以它不会运行这些 bot：用 yomi relay --allow-file-store --install-service 重新启动它。',
    );
    expect(service.paused).toEqual([]);
    const english = await run([
      '--lang',
      'en',
      'relay',
      '--bot',
      'lin_svc_bot',
      '--character',
      MOCK_NPCS.single,
    ]);
    expect(english.out).toContain(
      'The background service is installed but not running, so it does not run these bots: start it again with yomi relay --allow-file-store --install-service.',
    );
    // The last bot taken away: the service would have nothing to run, so it stays stopped.
    lock = runHubService();
    try {
      const last = await run(['relay', '--forget', '--bot', 'lin_svc_bot']);
      expect(last.code, last.err).toBe(0);
      expect(last.out).toContain(
        `没有 bot 了，所以没有重新启动后台服务（${hub.label}）。添加 bot 之后，用 yomi relay --allow-file-store --install-service 启动它。`,
      );
      expect(last.out).not.toContain('已重新启动后台服务');
      expect(service.resumed).toEqual([]);
      expect(existsSync(hub.path)).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('is removed with the units of before by --uninstall-service, and the bots stay', async () => {
    const hub = unit('hub');
    const wechat = installLegacy('wechat');
    const added = await run(
      [
        'relay',
        '--telegram',
        '--set-token',
        '--token-stdin',
        '--allow-file-store',
        '--bot',
        'harbor',
      ],
      { input: [second.token] },
    );
    expect(added.code, added.err).toBe(0);
    const removed = await run(['relay', '--uninstall-service']);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(`已停止并删除后台服务（${hub.path}）`);
    expect(removed.out).toContain(`已停止并删除后台服务（${wechat}）`);
    for (const path of [hub.path, wechat]) expect(existsSync(path), path).toBe(false);
    expect(registry().find('harbor')).toBeDefined();
    const none = await run(['--lang', 'pt', 'relay', '--uninstall-service']);
    expect(none.out).toContain('Nenhum serviço em segundo plano está instalado.');
  });

  it('is not installed for a --character meant for a channel that has no bot, saying how to add one', async () => {
    // Only the Telegram bot harbor is here.
    expect(registry().list('qq')).toEqual([]);
    const refused = await run([
      'relay',
      '--channel',
      'qq',
      '--install-service',
      '--allow-file-store',
      '--character',
      MOCK_NPCS.group,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      `这台电脑上还没有 QQ 的 bot，--character ${MOCK_NPCS.group} 没有可以绑定的 bot，所以没有安装后台服务。添加一个绑定这个角色的 bot：yomi relay --channel qq --set-app --character ${MOCK_NPCS.group}`,
    );
    expect(refused.err).not.toContain('这次运行了多个 bot');
    const english = await run([
      '--lang',
      'en',
      'relay',
      '--channel',
      'qq',
      '--install-service',
      '--allow-file-store',
      '--character',
      MOCK_NPCS.group,
    ]);
    expect(english.err).toContain(
      `There is no QQ bot on this computer, so --character ${MOCK_NPCS.group} has no bot to bind and the background service was not installed. To add one bound to this character: yomi relay --channel qq --set-app --character ${MOCK_NPCS.group}`,
    );
    expect(existsSync(unit('hub').path)).toBe(false);
  });

  it('replaces a per-channel unit of before that runs, once it let go of the environment', async () => {
    pair('harbor');
    const hub = unit('hub');
    const telegram = installLegacy('telegram', ['relay', '--telegram', '--max-spend', '0']);
    // An older relay's service: it holds the environment's lock and lets go of it a moment after
    // it is removed, as a process that is ending does.
    const lock = acquireProcessLock(environmentLock(), {
      channel: 'telegram',
      bot: '@Harbor_Svc_Bot',
    });
    if (!('release' in lock)) throw new Error('the environment lock is taken');
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      lock.release();
    };
    service.pids.set(telegram, process.pid);
    service.onUninstall = (path) => {
      if (path === telegram) setTimeout(release, 300);
    };
    service.lockHeld = () => lockHolder(environmentLock()) !== null;
    try {
      const status = await run(['relay', '--service-status']);
      expect(status.out).toContain(
        '还装着旧版按通道分开的后台服务（Telegram）：yomi relay --max-spend 0 --install-service 会换成一个运行所有 bot 的服务（yomi relay --uninstall-service 删除它们）',
      );
      expect(status.out).toContain(`  Telegram：运行中（进程 ${process.pid}）（${telegram}）`);
      const installed = await run([
        'relay',
        '--install-service',
        '--allow-file-store',
        '--max-spend',
        '50',
      ]);
      expect(installed.code, installed.err).toBe(0);
      expect(installed.out).toContain(`已停止并删除后台服务（${telegram}）`);
      expect(installed.out).toContain(`已安装并启动后台服务：${hub.path}`);
      expect(installed.err).not.toContain('relay 正在运行');
      expect(installed.err).not.toContain('另一个 relay');
      expect(existsSync(telegram)).toBe(false);
      expect(existsSync(hub.path)).toBe(true);
      // Booted out with its unit, not paused; the hub loaded only once it let go of the lock.
      expect(service.paused).toEqual([]);
      expect(service.heldAtInstall).toEqual([false]);
    } finally {
      release();
    }
  });

  it('names its cap in every command that starts it again, so following one keeps the cap and the total', async () => {
    const hub = unit('hub');
    const { account } = context();
    // The hub ran under the cap of 50 and spent 45 of it.
    LedgerFileStore.open(account).setAllowance({
      maxSpend: 50,
      spent: 45,
      since: 1,
      unmeasured: 0,
    });
    const lock = runHubService();
    try {
      const last = await run(['relay', '--forget', '--bot', 'harbor']);
      expect(last.code, last.err).toBe(0);
      expect(last.out).toContain(
        `没有 bot 了，所以没有重新启动后台服务（${hub.label}）。添加 bot 之后，用 yomi relay --allow-file-store --max-spend 50 --install-service 启动它。`,
      );
    } finally {
      lock.release();
    }
    service.pids.clear();
    const added = await run(
      [
        'relay',
        '--telegram',
        '--set-token',
        '--token-stdin',
        '--allow-file-store',
        '--character',
        MOCK_NPCS.single,
      ],
      { input: [tg.token] },
    );
    expect(added.code, added.err).toBe(0);
    const hint = /用 (yomi relay [^。]*--install-service) 重新启动它。/.exec(added.out);
    expect(hint?.[1]).toBe('yomi relay --allow-file-store --max-spend 50 --install-service');
    const listed = await run(['--lang', 'es', 'relay', '--list']);
    expect(listed.out).toContain(
      `Servicio en segundo plano: instalado, no está en ejecución (${hub.label}): vuelve a iniciarlo con yomi relay --allow-file-store --max-spend 50 --install-service`,
    );
    pair('lin_svc_bot');
    // Exactly what it said.
    const again = await run(hint![1].split(' ').slice(1));
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain('本机允许 relay 最多花 50 钻石（累计）。');
    const args = installedArgs(hub);
    expect(args.slice(args.indexOf('--max-spend'), args.indexOf('--max-spend') + 2)).toEqual([
      '--max-spend',
      '50',
    ]);
    // Started with the same cap, the hub keeps the running total: 5 gems are left, not 50.
    const ledger = new Ledger(LedgerFileStore.open(account), { shared: true });
    ledger.useAllowance(50, false);
    expect([ledger.maxSpend, ledger.spent]).toEqual([50, 45]);
  });

  it('says an older per-channel unit started again after a change runs only its own channel, also at a start', async () => {
    const removed = await run(['relay', '--uninstall-service']);
    expect(removed.code).toBe(0);
    const telegram = installLegacy('telegram', ['relay', '--telegram', '--max-spend', '0']);
    const label = unit('telegram').label;
    const qq: MockQq = await startMockQq({ botName: 'Harbor QQ bot', appId: '102000501' });
    setEnv({ YOMI_QQ_API_ORIGIN: qq.origin });
    const lock = acquireProcessLock(environmentLock(), {
      channel: 'telegram',
      bot: '@Lin_Svc_Bot',
    });
    if (!('release' in lock)) throw new Error('the environment lock is taken');
    service.pids.set(telegram, process.pid);
    service.onPause = () => lock.release();
    try {
      // A QQ bot added while the Telegram unit of before runs: it is stopped and started again,
      // and still runs the Telegram bots only.
      const added = await run(
        [
          'relay',
          '--channel',
          'qq',
          '--set-app',
          '--token-stdin',
          '--allow-file-store',
          '--character',
          MOCK_NPCS.group,
        ],
        { input: [qq.appId, qq.secret] },
      );
      expect(added.code, added.err).toBe(0);
      expect(added.out).toContain(`正在停止后台服务（${label}），改完后会重新启动它。`);
      const again = added.out.indexOf(`已重新启动后台服务（${label}）。`);
      const hint = added.out.indexOf(
        `这个后台服务（${label}）是旧版的，只运行 Telegram 的 bot：用 yomi relay --max-spend 0 --install-service 换成一个运行所有 bot 的服务。`,
      );
      expect(again).toBeGreaterThan(-1);
      expect(hint).toBeGreaterThan(again);
      expect(service.resumed).toEqual([label]);
    } finally {
      lock.release();
      await qq.shutdown();
    }
    service.pids.clear();
    // A run in a terminal says so as it starts.
    const polls = tg.calls.filter((call) => call.method === 'getUpdates').length;
    const terminal = memoryIo();
    const pending = main(
      ['--lang', 'en', 'relay', '--bot', 'lin_svc_bot', '--allow-file-store'],
      terminal.io,
    );
    await tg.waitFor(() => tg.calls.filter((call) => call.method === 'getUpdates').length > polls);
    await new TelegramBot(tg.token, { apiOrigin: tg.origin }).getUpdates(-1, 0).catch(() => {});
    expect(await pending).toBe(0);
    expect(terminal.out).toContain('Relay running: @Lin_Svc_Bot');
    expect(terminal.out).toContain(
      'Older per-channel background services are still installed (Telegram): yomi relay --max-spend 0 --install-service replaces them with one for every bot (yomi relay --uninstall-service removes them)',
    );
    rmSync(telegram, { force: true });
  });
});

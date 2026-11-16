import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { currentLanguage } from '../core/device.js';
import { describeEnvironment, isProduction, UsageError } from '../core/env.js';
import { configDir, ensurePrivateDir } from '../core/files.js';
import { acquireProcessLock } from '../core/lock.js';
import { readSecret } from '../core/prompt.js';
import { paint, say, warn } from '../core/ui.js';
import { PairingCode } from '../relay/pairing.js';
import { Relay, RelayStopped } from '../relay/relay.js';
import {
  installService,
  type ServicePlan,
  servicePlan,
  uninstallService,
  runCommand,
} from '../relay/service.js';
import { forgetRelayStates, RelayState, relayStatePath } from '../relay/state.js';
import { BOT_TOKEN, TelegramBot, TelegramError } from '../relay/telegram.js';
import { type Context, requireSignIn } from './context.js';
import { confirmProduction } from './declaration.js';

/**
 * `yomi relay --telegram`: the setup around `Relay` — the bot token (typed without echo or piped
 * on stdin, kept in the keychain, never an argument or variable), the pairing code in this
 * terminal, one relay per bot (a lock file, and Telegram's own 409), the background service.
 */

export type RelayCommandOptions = {
  telegram: boolean;
  setToken: boolean;
  tokenStdin: boolean;
  pair: boolean;
  forget: boolean;
  characterId: string;
  maxSpend: number;
  allowFileStore: boolean;
  installService: boolean;
  uninstallService: boolean;
  serviceStatus: boolean;
  replyTimeoutMs: number;
  drafts: boolean;
  confirmProd: boolean;
  /** Start the local ceiling's running total over. */
  resetSpend: boolean;
};

/** Settings a background relay needs (never tokens); YOMI_CONFIG_DIR is always set. */
const SERVICE_ENVIRONMENT = [
  'YOMI_TEST_API_ORIGIN',
  'YOMI_TEST_WEB_ORIGIN',
  'YOMI_LANG',
  'LANG',
  'YOMI_API_ORIGIN',
  'YOMI_WEB_ORIGIN',
  'YOMI_CREDENTIAL_STORE',
  'YOMI_TELEGRAM_API_ORIGIN',
];

const tokenName = (context: Context) => `telegram-bot:${context.account}`;

function planFor(context: Context, options: RelayCommandOptions): ServicePlan {
  const script = realpathSync(process.argv[1] ?? '');
  const args = ['relay', '--telegram', '--env', context.env.name];
  if (context.env.lane) args.push('--lane', context.env.lane);
  if (options.allowFileStore) args.push('--allow-file-store');
  args.push('--max-spend', String(options.maxSpend));
  if (options.characterId) args.push('--character', options.characterId);
  if (!options.drafts) args.push('--no-drafts');
  // Confirmed when the service was installed; a service has nobody to ask.
  if (isProduction(context.env)) args.push('--confirm-prod');
  // The resolved directory, so the service finds the same pairing, lock and file store even when
  // XDG_CONFIG_HOME or HOME differ under launchd/systemd.
  const environment: Record<string, string> = { YOMI_CONFIG_DIR: configDir() };
  for (const key of SERVICE_ENVIRONMENT) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return servicePlan({
    account: context.account,
    node: process.execPath,
    script,
    args,
    environment,
    logDir: join(configDir(), 'logs'),
  });
}

async function askToken(context: Context, fromStdin: boolean): Promise<string> {
  const { io } = context;
  if (!fromStdin)
    say(
      io,
      paint(
        io,
        'dim',
        '在 Telegram 的 @BotFather 里新建一个 bot（/newbot），把它给的 token 粘贴到这里（不会显示）。',
      ),
    );
  const token = await readSecret(io, 'Bot token: ', { fromStdin });
  if (!BOT_TOKEN.test(token))
    throw new UsageError('这不像是 bot token（应为 123456789:AA… 的形式）');
  return token;
}

async function verifiedBot(token: string) {
  const bot = new TelegramBot(token, { apiOrigin: process.env.YOMI_TELEGRAM_API_ORIGIN });
  try {
    const me = await bot.getMe();
    return { bot, me };
  } catch (error) {
    if (error instanceof TelegramError && error.unauthorized)
      throw new UsageError(
        'Telegram 不认这个 token：确认是 BotFather 给的、没有在 /revoke 后失效。',
      );
    throw error;
  }
}

function printPairing(context: Context, code: PairingCode, username: string) {
  const { io } = context;
  say(io);
  say(io, `在 Telegram 里打开 @${username}，发送：`);
  say(io, `  ${paint(io, 'bold', `/start ${code.code}`)}`);
  say(io, `或直接打开：${code.link(username)}`);
  say(io, paint(io, 'dim', '配对码 15 分钟内有效、只能用一次，只显示在这个终端里：不要发给别人。'));
  say(io);
}

export async function relay(context: Context, options: RelayCommandOptions) {
  const { io, store } = context;
  if (!options.telegram) throw new UsageError('目前只支持 Telegram：yomi relay --telegram');
  // Taking things away works without a keychain too.
  if (options.uninstallService) {
    const plan = planFor(context, options);
    const removed = uninstallService(plan);
    say(io, removed ? `已停止并删除后台服务（${plan.path}）` : '没有安装后台服务。');
    return;
  }
  if (options.serviceStatus) {
    const plan = planFor(context, options);
    if (!existsSync(plan.path)) return void say(io, '没有安装后台服务。');
    const [command, ...args] = plan.status;
    const result = runCommand(command, args);
    say(io, result.output || `${plan.label}：没有运行`);
    return;
  }
  if (options.forget) {
    const token = store.getSecret(tokenName(context));
    if (token && BOT_TOKEN.test(token)) {
      const lock = acquireProcessLock(
        join(configDir(), 'locks', `relay-${token.split(':')[0]}.lock`),
      );
      if ('heldBy' in lock)
        throw new UsageError(
          `relay 正在运行${lock.heldBy ? `（进程 ${lock.heldBy}）` : ''}：先停止它（Ctrl+C，或 --uninstall-service），再 --forget。`,
        );
      lock.release();
    }
    const plan = planFor(context, options);
    if (existsSync(plan.path)) {
      uninstallService(plan);
      say(io, `已停止并删除后台服务（${plan.path}）`);
    }
    const states = forgetRelayStates(context.account);
    const removed = store.deleteSecret(tokenName(context));
    say(
      io,
      removed || states
        ? `已删除本机保存的 bot token 和配对信息（${states} 份）。`
        : '本机没有保存 bot token 或配对信息。',
    );
    say(io, paint(io, 'dim', '如果 token 可能泄露，请在 @BotFather 里用 /revoke 让它失效。'));
    return;
  }

  if (store.kind === 'file' && !options.allowFileStore)
    throw new UsageError(
      '这台机器没有可用的系统钥匙串，relay 默认不启动（bot token 和会话会以明文文件保存）。确认接受时加 --allow-file-store。',
    );

  if (options.setToken) {
    const token = await askToken(context, options.tokenStdin);
    const { me } = await verifiedBot(token);
    store.setSecret(tokenName(context), token);
    say(
      io,
      `已保存 @${me.username ?? me.first_name} 的 token（${store.kind === 'file' ? '本地文件 0600' : '系统钥匙串'}）。`,
    );
    say(io, '接下来运行 yomi relay --telegram，在 Telegram 里完成配对。');
    return;
  }

  const credential = requireSignIn(context);
  if (
    !(await confirmProduction(
      context,
      '把 Telegram 私聊转给角色（会使用真实账号的免费额度和钻石）',
      options.confirmProd,
    ))
  )
    return;
  let token = store.getSecret(tokenName(context));
  if (!token) {
    if (!io.interactive && !options.tokenStdin) {
      // A service restarting would not fix this: say so and end without failing.
      warn(io, '还没有设置 bot token：先运行 yomi relay --telegram --set-token');
      return;
    }
    token = await askToken(context, options.tokenStdin);
    await verifiedBot(token);
    store.setSecret(tokenName(context), token);
  }
  let verified;
  try {
    verified = await verifiedBot(token);
  } catch (error) {
    if (!io.interactive && error instanceof UsageError) {
      warn(io, error.message);
      return;
    }
    throw error;
  }
  const { bot, me } = verified;
  const username = me.username ?? '';
  const state = new RelayState(relayStatePath(context.account, bot.id), bot.id, context.account);

  if (options.installService) {
    if (!state.data.owner)
      throw new UsageError(
        '还没有配对：先在终端里运行一次 yomi relay --telegram 完成配对，再安装后台服务。',
      );
    const plan = planFor(context, options);
    if (/[\\/](_npx|\.npm|tmp|temp)[\\/]/i.test(plan.content))
      warn(
        io,
        '当前 yomi 像是从临时目录运行的（npx 或缓存），后台服务可能在缓存清理后失效：建议全局安装后再装服务。',
      );
    ensurePrivateDir(join(configDir(), 'logs'));
    installService(plan);
    say(io, `已安装并启动后台服务：${plan.path}`);
    say(
      io,
      paint(
        io,
        'dim',
        `日志：${join(configDir(), 'logs')}；停止并删除：yomi relay --telegram --uninstall-service`,
      ),
    );
    if (plan.platform === 'linux')
      say(io, paint(io, 'dim', '退出登录后也要运行：loginctl enable-linger（需要时）。'));
    return;
  }

  const lock = acquireProcessLock(join(configDir(), 'locks', `relay-${bot.id}.lock`));
  if ('heldBy' in lock)
    throw new UsageError(
      `这个 bot 已经有一个 relay 在运行${lock.heldBy ? `（进程 ${lock.heldBy}）` : ''}。同一个 bot 只能运行一个。`,
    );
  try {
    // Another person may pair now: their consent to spend starts over.
    if (options.pair) state.resetOwner();
    let pairing: PairingCode | null = null;
    if (!state.data.owner) {
      // The code is shown only to someone at this terminal, never in a service log.
      if (!io.interactive && !options.pair) {
        warn(
          io,
          '还没有配对：请在终端里运行一次 yomi relay --telegram，按提示在 Telegram 里发送配对码。',
        );
        return;
      }
      pairing = new PairingCode();
      printPairing(context, pairing, username);
    }
    say(
      io,
      `relay 运行中：@${username} ⇄ Yomi ${credential.displayName || credential.userId}（${describeEnvironment(context.env)}）`,
    );
    say(
      io,
      paint(
        io,
        'dim',
        (options.maxSpend
          ? `本机允许 relay 最多花 ${options.maxSpend} 钻石（累计；--reset-spend 重新计算）。`
          : '本机不允许 relay 花钻石（要允许，用 --max-spend <数量> 启动）。服务端支持「只用免费额度」之前，这样不会发出任何消息。') +
          'Ctrl+C 停止。',
      ),
    );
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const engine = new Relay(context.gateway, bot, state, {
      maxSpend: options.maxSpend,
      resetSpend: options.resetSpend,
      characterId: options.characterId,
      pairing,
      onPairingCode: (code) => {
        say(io, paint(io, 'yellow', '配对码已过期，新的配对码：'));
        printPairing(context, code, username);
      },
      replyTimeoutMs: options.replyTimeoutMs,
      intervalMs: 1000,
      staleMs: 10 * 60 * 1000,
      pollTimeoutSeconds: 25,
      drafts: options.drafts,
      language: currentLanguage(),
      log: (line) => io.stderr.write(`${new Date().toISOString()} ${line}\n`),
    });
    try {
      await engine.run(controller.signal);
    } catch (error) {
      // Conditions a restart cannot fix: say why and end without failing, so a service stays down.
      if (error instanceof RelayStopped) {
        warn(io, error.message);
        return;
      }
      throw error;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    say(io, 'relay 已停止。');
  } finally {
    lock.release();
  }
}

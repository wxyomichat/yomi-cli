import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';

import { type CharacterProfile, ChatRefusal, characterProfile } from '../chat/api.js';
import { describeEnvironment, type Environment, isProduction, UsageError } from '../core/env.js';
import type { Credential } from '../core/credentials.js';
import { configDir, ensurePrivateDir, readJsonFile } from '../core/files.js';
import { tr, language } from '../core/i18n.js';
import { acquireProcessLock, type LockNote, lockHolder } from '../core/lock.js';
import { sha256 } from '../core/state.js';
import { paint, say, warn } from '../core/ui.js';
import {
  CHANNEL_KINDS,
  type ChannelKind,
  type ChannelSetup,
  channelSetup,
} from '../relay/channels/index.js';
import type { AcquiredBot, StoredBot } from '../relay/channels/setup.js';
import type { BotIdentity, RelayChannel } from '../relay/channels/types.js';
import { PairingCode } from '../relay/pairing.js';
import {
  addProblem,
  alreadyRegistered,
  anotherBot,
  type BotRecord,
  BotRegistry,
  DuplicateCharacter,
  migrateRegistry,
  sameBot,
} from '../relay/registry.js';
import { type HubBot, type HubStatusFile, hubStatusPath, RelayHub } from '../relay/hub/hub.js';
import { botRecords, LedgerFileStore, ledgerPath } from '../relay/hub/ledger.js';
import { Relay, RelayStopped } from '../relay/relay.js';
import {
  installedArgs,
  installService,
  pauseService,
  resumeService,
  servicePid,
  type ServicePlan,
  servicePlan,
  type ServiceUnit,
  uninstallService,
  writeServiceUnit,
} from '../relay/service.js';
import {
  forgetRelayStates,
  ownerKey,
  type RelayCharacter,
  RelayState,
  relayStatePath,
} from '../relay/state.js';
import { type Context, requireSignIn } from './context.js';
import { confirmProduction } from './declaration.js';

/**
 * `yomi relay [--channel telegram|qq|wechat] [--bot a,b]` (`--telegram` is `--channel telegram`):
 * the setup around `Relay`, the same for every channel — which flags the channel takes, the
 * bots and their credentials (typed without echo or piped on stdin, kept in the keychain, never an
 * argument or variable), the pairing in this terminal, one relay per bot and one per Yomi account
 * and environment (lock files), the background service, and `--forget`. What differs per channel
 * is asked of its `ChannelSetup` (relay/channels/setup.ts).
 *
 * A run takes every registered bot, or those of the channel or the names given, and runs them in
 * this one process (`RelayHub`): each opened and checked as a relay alone always was, each under
 * its own lock and all of them under the environment's (whose note names every bot), one sign-in,
 * one long connection, one ledger and one `--max-spend` for all, each bot supervised on its own.
 * The background service is one such run of every bot: one unit per Yomi account and environment
 * (`--install-service`, which takes away the per-channel units of before it), `--service-status`
 * says how it and each bot are, `--uninstall-service` removes it and those of before.
 *
 * The bots are the records of the bot registry (relay/registry.ts), taken over from the stored
 * credentials of before it before anything else (design §1.1, §1.2, §1.3):
 * - credentials with `--character ID` (or `--bot <a new name>`) add a bot; with `--bot NAME` they
 *   are set again for that bot, and must be its own; without either they renew the channel's one
 *   bot, add an unbound one when it has none, and ask which bot when it has several;
 * - `--forget --bot NAME`, `--channel K --forget` (K's one bot, or what K left of before the
 *   registry) and `--forget --all` take bots away;
 * - `--bot NAME --character ID` binds a bot to another character (`relayRebind`).
 * Every change runs under the setup lock, with no relay of the environment running: a running
 * background service is stopped for it and started again after (said; also when a signal ends
 * this process first, `serviceGuard`), a relay running in a terminal refuses it (`whileStopped`).
 * A new bot's name and the bot counts are checked before the platform is asked. `--pair` with the
 * service running pairs in this terminal under the service's cap and starts the service again
 * once paired; a run of a channel without a bot then only adds it (a run is not a change). A run
 * starts only when the stored credentials are still the bot's own, and `yomi relay --list` shows
 * the bots without changing them.
 *
 * A bot talks as the one character of its record. A run's `--character` binds a bot that has none,
 * and is ignored with a warning for one bound to another character (an older service's arguments
 * must not stop it). A character goes with one bot only.
 */

export type RelayCommandOptions = {
  /**
   * The chat platform: `--channel <kind>`, or `--telegram`. null: none named, a run takes every
   * registered bot (or those of `bots`).
   */
  channel: ChannelKind | null;
  /** The bots to run (`--bot a,b`, repeatable); empty: every bot of `channel`, or all of them. */
  bots: string[];
  /** WeChat runs only with it (`--experimental`); the others ignore it. */
  experimental: boolean;
  /** Telegram: set the bot token (`--set-token`). */
  setToken: boolean;
  /** QQ: set the AppID and AppSecret (`--set-app`). */
  setApp: boolean;
  /** WeChat: sign in with a QR code (`--login`). */
  login: boolean;
  /** WeChat, with --login: also print the QR code's link (`--qr-link`). */
  qrLink: boolean;
  /** The secret from stdin: Telegram the token; QQ the AppID, then the AppSecret. */
  tokenStdin: boolean;
  pair: boolean;
  forget: boolean;
  /** With --forget: every bot of this environment (`--all`). */
  all: boolean;
  characterId: string;
  /** The local spending cap (`--max-spend`); null: none, Yomi charges by its normal rules. */
  maxSpend: number | null;
  allowFileStore: boolean;
  installService: boolean;
  uninstallService: boolean;
  serviceStatus: boolean;
  replyTimeoutMs: number;
  /** Telegram drafts (`--no-drafts`: edits). */
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
  // Loopback-only test overrides of the chat platforms.
  'YOMI_TELEGRAM_API_ORIGIN',
  'YOMI_QQ_API_ORIGIN',
  'YOMI_WECHAT_API_ORIGIN',
];

/**
 * The flags each channel takes (design §6.2), checked before anything else: a flag meant for
 * another channel, and WeChat without `--experimental` (except to take things away: --forget,
 * --uninstall-service, --service-status). null when the options are fine.
 */
export function channelFlagProblem(options: RelayCommandOptions): string | null {
  const kind = options.channel;
  if (options.setToken && kind === 'qq')
    return tr(
      'QQ 用 --set-app 设置 AppID 和 AppSecret（不是 --set-token）：yomi relay --channel qq --set-app',
      'QQ uses --set-app for its AppID and AppSecret, not --set-token: yomi relay --channel qq --set-app',
      'QQ usa --set-app para su AppID y su AppSecret, no --set-token: yomi relay --channel qq --set-app',
      'O QQ usa --set-app para o AppID e o AppSecret, não --set-token: yomi relay --channel qq --set-app',
    );
  if (options.setToken && kind === 'wechat')
    return tr(
      '微信用 --login 扫码登录（不是 --set-token）：yomi relay --channel wechat --experimental --login',
      'WeChat signs in with --login and a QR code, not --set-token: yomi relay --channel wechat --experimental --login',
      'WeChat inicia sesión con --login y un código QR, no con --set-token: yomi relay --channel wechat --experimental --login',
      'O WeChat entra com --login e um código QR, não com --set-token: yomi relay --channel wechat --experimental --login',
    );
  if (options.setApp && kind !== 'qq')
    return tr(
      '--set-app 只用于 QQ：yomi relay --channel qq --set-app',
      '--set-app is only for QQ: yomi relay --channel qq --set-app',
      '--set-app es solo para QQ: yomi relay --channel qq --set-app',
      '--set-app é só para o QQ: yomi relay --channel qq --set-app',
    );
  if (options.login && kind !== 'wechat')
    return tr(
      '--login 只用于微信：yomi relay --channel wechat --experimental --login（登录 Yomi 用 yomi login）',
      '--login is only for WeChat: yomi relay --channel wechat --experimental --login (to sign in to Yomi, run yomi login)',
      '--login es solo para WeChat: yomi relay --channel wechat --experimental --login (para iniciar sesión en Yomi, ejecuta yomi login)',
      '--login é só para o WeChat: yomi relay --channel wechat --experimental --login (para entrar no Yomi, execute yomi login)',
    );
  if (options.qrLink && (kind !== 'wechat' || !options.login))
    return tr(
      '--qr-link 只和微信的 --login 一起用',
      '--qr-link only goes with --login on WeChat',
      '--qr-link solo se usa con --login en WeChat',
      '--qr-link só é usado com --login no WeChat',
    );
  if (options.tokenStdin && kind === 'wechat')
    return tr(
      '微信要用手机扫码登录，不能从标准输入读取：去掉 --token-stdin',
      'WeChat signs in by scanning a QR code with your phone, so there is nothing to read from standard input: drop --token-stdin',
      'WeChat inicia sesión escaneando un código QR con tu teléfono, así que no hay nada que leer de la entrada estándar: quita --token-stdin',
      'O WeChat entra escaneando um código QR com o celular, então não há nada para ler da entrada padrão: remova --token-stdin',
    );
  if (options.pair && kind === 'wechat') return wechatNoPairing();
  // Without a channel named, --no-drafts is for the Telegram bots among those that run.
  if (!options.drafts && kind && kind !== 'telegram')
    return tr(
      '--no-drafts 只用于 Telegram',
      '--no-drafts is only for Telegram',
      '--no-drafts es solo para Telegram',
      '--no-drafts é só para o Telegram',
    );
  if (
    kind === 'wechat' &&
    !options.experimental &&
    !(options.forget || options.uninstallService || options.serviceStatus)
  )
    return tr(
      '微信 ClawBot（iLink）通道是实验功能：它不是给第三方客户端的官方接口，对这类客户端的使用条款还不明确，仅限个人使用。了解这些之后，加 --experimental 启用：yomi relay --channel wechat --experimental',
      'The WeChat ClawBot (iLink) channel is experimental: it is not an official API for third-party clients, its terms for such clients are unclear, and it is for personal use only. If you accept that, add --experimental: yomi relay --channel wechat --experimental',
      'El canal WeChat ClawBot (iLink) es experimental: no es una API oficial para clientes de terceros, sus condiciones para esos clientes no están claras y es solo para uso personal. Si lo aceptas, agrega --experimental: yomi relay --channel wechat --experimental',
      'O canal WeChat ClawBot (iLink) é experimental: não é uma API oficial para clientes de terceiros, os termos para esses clientes não são claros e é somente para uso pessoal. Se você aceitar isso, adicione --experimental: yomi relay --channel wechat --experimental',
    );
  return null;
}

/** `--pair` for WeChat, whose owner is whoever signed in. */
function wechatNoPairing(): string {
  return tr(
    '微信没有配对码：用 --login 扫码的人就是主人。要换人，重新运行 --login。',
    'WeChat has no pairing code: whoever scans the QR code with --login is the owner. To change the owner, run --login again.',
    'WeChat no tiene código de vinculación: quien escanea el código QR con --login es el dueño. Para cambiar de dueño, vuelve a ejecutar --login.',
    'O WeChat não tem código de pareamento: quem escaneia o código QR com --login é o dono. Para trocar o dono, execute --login de novo.',
  );
}

/**
 * The background service's arguments after the script (design §1.5): a run of every registered
 * bot, `relay --env E [--lane L] [--allow-file-store] [--max-spend N] [--no-drafts]
 * [--confirm-prod]`. No channel, bot or character: those are the registry's, and a WeChat bot's
 * consent to the experimental channel is its record's.
 */
export function relayServiceArgs(env: Environment, options: RelayCommandOptions): string[] {
  const args = ['relay', '--env', env.name];
  if (env.lane) args.push('--lane', env.lane);
  if (options.allowFileStore) args.push('--allow-file-store');
  // Only a cap the owner chose: without one the service runs uncapped, as the foreground relay.
  if (options.maxSpend !== null) args.push('--max-spend', String(options.maxSpend));
  // For the Telegram bots among them.
  if (!options.drafts) args.push('--no-drafts');
  // Confirmed when the service was installed; a service has nobody to ask.
  if (isProduction(env)) args.push('--confirm-prod');
  return args;
}

/** A unit of this account and environment: the hub's (`args`), or a channel's of before it. */
function planFor(context: Context, unit: ServiceUnit, args: string[]): ServicePlan {
  const script = realpathSync(process.argv[1] ?? '');
  // The resolved directory, so the service finds the same pairing, lock and file store even when
  // XDG_CONFIG_HOME or HOME differ under launchd/systemd.
  const environment: Record<string, string> = { YOMI_CONFIG_DIR: configDir() };
  for (const key of SERVICE_ENVIRONMENT) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return servicePlan({
    account: context.account,
    channel: unit,
    node: process.execPath,
    script,
    args,
    environment,
    logDir: join(configDir(), 'logs'),
  });
}

/** The options of a plain run of every bot: the background service's when none are given. */
const PLAIN_OPTIONS: RelayCommandOptions = {
  channel: null,
  bots: [],
  experimental: false,
  setToken: false,
  setApp: false,
  login: false,
  qrLink: false,
  tokenStdin: false,
  pair: false,
  forget: false,
  all: false,
  characterId: '',
  maxSpend: null,
  allowFileStore: false,
  installService: false,
  uninstallService: false,
  serviceStatus: false,
  replyTimeoutMs: 120_000,
  drafts: true,
  confirmProd: false,
  resetSpend: false,
};

/** The background service that runs every bot, with `options`' arguments. */
const hubPlan = (context: Context, options: RelayCommandOptions = PLAIN_OPTIONS) =>
  planFor(context, 'hub', relayServiceArgs(context.env, options));

/** A channel's own unit of before the hub: only where it is and what it is called matter. */
const legacyPlan = (context: Context, kind: ChannelKind) => planFor(context, kind, []);

/**
 * The units of this account and environment installed now: the hub's first, then the channels'
 * of before it. None where no service can be installed (another system, no CLI entry to name).
 */
function installedPlans(context: Context): ServicePlan[] {
  try {
    return [hubPlan(context), ...CHANNEL_KINDS.map((kind) => legacyPlan(context, kind))].filter(
      (plan) => existsSync(plan.path),
    );
  } catch {
    return [];
  }
}

/** Whether `kind`'s own unit of before the hub is installed (design §4.3: its bot is preferred). */
function legacyInstalled(context: Context, kind: ChannelKind): boolean {
  try {
    return existsSync(legacyPlan(context, kind).path);
  } catch {
    return false;
  }
}

/** How a background service is stopped and removed, whichever unit it is. */
const UNINSTALL = 'yomi relay --uninstall-service';

/**
 * The command that installs the background service again (started with it) keeping what `plan`,
 * an installed unit (the hub's, or one of before it), runs with: its `--max-spend` above all, as
 * a bare --install-service would run with no cap and start the running total over, and its
 * `--no-drafts` and `--allow-file-store`.
 */
function reinstallCommand(plan: ServicePlan): string {
  const args = installedArgs(plan);
  const kept: string[] = [];
  if (args.includes('--allow-file-store')) kept.push('--allow-file-store');
  const cap = args.indexOf('--max-spend');
  if (cap >= 0 && /^\d+$/.test(args[cap + 1] ?? '')) kept.push('--max-spend', args[cap + 1]);
  if (args.includes('--no-drafts')) kept.push('--no-drafts');
  return ['yomi relay', ...kept, '--install-service'].join(' ');
}

/** Which channel's unit of before the hub `plan` is; null for the hub's. */
function legacyKind(context: Context, plan: ServicePlan): ChannelKind | null {
  return CHANNEL_KINDS.find((kind) => legacyPlan(context, kind).path === plan.path) ?? null;
}

/**
 * Who holds a relay lock: its process (0 when unknown) and, for the environment's lock, what it
 * wrote there: the channel (when it is one), the bots it runs (`hubNote`; an older relay: its one
 * bot's label) or the flag it runs (`--set-app`, `--login`).
 */
type Holder = {
  pid: number;
  setup: ChannelSetup | null;
  bot: string;
  /** The running relay's bots: channel, registry name, label (`hubNote`). */
  bots: { kind: ChannelKind; name: string; label: string }[];
  flag: string;
};

function holderOf(lock: { heldBy: number; note?: LockNote }): Holder {
  const note = lock.note ?? {};
  const kind = CHANNEL_KINDS.find((name) => name === note.channel);
  let listed: unknown = [];
  try {
    listed = JSON.parse(note.bots ?? '[]');
  } catch {
    listed = [];
  }
  const bots = (Array.isArray(listed) ? listed : []).flatMap((item) => {
    const kind = CHANNEL_KINDS.find((name) => name === item?.kind);
    const name = typeof item?.name === 'string' ? item.name : '';
    const label = typeof item?.label === 'string' ? item.label : '';
    return kind && (name || label) ? [{ kind, name, label }] : [];
  });
  return {
    pid: lock.heldBy,
    setup: kind ? channelSetup(kind) : null,
    bot: note.bot ?? '',
    bots,
    flag: note.flag ?? '',
  };
}

/**
 * "Telegram bot @lin_bot, QQ bot Lin, process 1234": what is known of a holder (the bots of a
 * relay of this version, the one bot of an older one), '' when nothing is.
 */
function holderDetails(holder: Holder): string {
  const parts: string[] = [];
  const name = holder.setup?.displayName ?? '';
  if (holder.bots.length)
    parts.push(
      holder.bots
        .map((bot) => {
          const its = channelSetup(bot.kind).displayName;
          const named = bot.label || bot.name;
          return tr(
            `${its} bot ${named}`,
            `${its} bot ${named}`,
            `bot de ${its} ${named}`,
            `bot do ${its} ${named}`,
          );
        })
        .join(tr('、', ', ', ', ', ', ')),
    );
  else if (name)
    parts.push(
      holder.bot
        ? tr(
            `${name} bot ${holder.bot}`,
            `${name} bot ${holder.bot}`,
            `bot de ${name} ${holder.bot}`,
            `bot do ${name} ${holder.bot}`,
          )
        : name,
    );
  if (holder.pid)
    parts.push(
      tr(
        `进程 ${holder.pid}`,
        `process ${holder.pid}`,
        `proceso ${holder.pid}`,
        `processo ${holder.pid}`,
      ),
    );
  return parts.join(tr('，', ', ', ', ', ', '));
}

/**
 * Refuses `flag` while a relay runs: this channel's (--forget, its own lock, known by pid only),
 * or any relay of this environment (--set-app, --login), named with its channel and bot.
 */
function runningRefusal(holder: Holder, flag: string): string {
  const details = holderDetails(holder);
  return tr(
    `relay 正在运行${details ? `（${details}）` : ''}：先停止它（Ctrl+C，或 ${UNINSTALL}），再 ${flag}。`,
    `Relay is running${details ? ` (${details})` : ''}: stop it first (Ctrl+C, or ${UNINSTALL}), then ${flag}.`,
    `El relay está en ejecución${details ? ` (${details})` : ''}: detenlo primero (Ctrl+C o ${UNINSTALL}) y luego usa ${flag}.`,
    `O relay está em execução${details ? ` (${details})` : ''}: pare-o primeiro (Ctrl+C ou ${UNINSTALL}) e depois use ${flag}.`,
  );
}

/** A relay start refused: another relay of this Yomi account and environment runs. */
function anotherRelayRunning(holder: Holder, env: Environment): string {
  const details = holderDetails(holder);
  const where = describeEnvironment(env);
  return tr(
    `这个 Yomi 账号（${where}）已经有另一个 relay 在运行${details ? `：${details}` : ''}。同一个账号和环境同时只能运行一个 relay：先停止它（Ctrl+C，或 ${UNINSTALL}）。`,
    `Another relay is already running for this Yomi account (${where})${details ? `: ${details}` : ''}. Only one relay per Yomi account and environment can run at a time: stop it first (Ctrl+C, or ${UNINSTALL}).`,
    `Ya hay otro relay en ejecución para esta cuenta de Yomi (${where})${details ? `: ${details}` : ''}. Solo puede ejecutarse un relay a la vez por cuenta de Yomi y entorno: detenlo primero (Ctrl+C o ${UNINSTALL}).`,
    `Já existe outro relay em execução para esta conta do Yomi (${where})${details ? `: ${details}` : ''}. Só é possível executar um relay por vez por conta do Yomi e ambiente: pare-o primeiro (Ctrl+C ou ${UNINSTALL}).`,
  );
}

/**
 * Refused while `--set-app` or `--login` of this environment runs: a relay start (`flag` '') or
 * another of those flags.
 */
function credentialsRunning(holder: Holder, flag: string): string {
  const command = `${holder.setup?.command ?? 'yomi relay'} ${holder.flag}`;
  const pid = holder.pid;
  return tr(
    `${command} 正在运行${pid ? `（进程 ${pid}）` : ''}：等它结束后再${flag ? ` ${flag}` : '启动 relay'}。`,
    `${command} is running${pid ? ` (process ${pid})` : ''}: wait for it to finish, then ${flag || 'start the relay'}.`,
    `${command} está en ejecución${pid ? ` (proceso ${pid})` : ''}: espera a que termine y luego ${flag ? `usa ${flag}` : 'inicia el relay'}.`,
    `${command} está em execução${pid ? ` (processo ${pid})` : ''}: espere terminar e depois ${flag ? `use ${flag}` : 'inicie o relay'}.`,
  );
}

/**
 * The local spending cap in words, for the terminal and the service's installation (nobody
 * watches a service: what it may spend is said when it is installed). `install`: the advice
 * names --install-service.
 */
function capLine(maxSpend: number | null, install: boolean): string {
  if (maxSpend === null)
    return install
      ? tr(
          '没有本机花费上限：按 Yomi 的正常规则扣费，钻石不足时会在聊天里提示（要设上限，加 --max-spend <数量> 重新安装，或在聊天里用 /budget <数量>）。',
          'No local spending cap: Yomi charges by its normal rules, and a low balance is reported in the chat (to set a cap, install again with --max-spend <amount>, or use /budget <amount> in the chat).',
          'Sin límite de gasto local: Yomi cobra según sus reglas habituales, y si el saldo no alcanza se avisa en el chat (para fijar un límite, vuelve a instalar con --max-spend <cantidad> o usa /budget <cantidad> en el chat).',
          'Sem limite de gastos local: o Yomi cobra pelas regras normais, e saldo baixo é avisado no chat (para definir um limite, instale de novo com --max-spend <quantidade> ou use /budget <quantidade> no chat).',
        )
      : tr(
          '没有本机花费上限：按 Yomi 的正常规则扣费，钻石不足时会在聊天里提示（要设上限：--max-spend <数量>，或在聊天里用 /budget <数量>）。',
          'No local spending cap: Yomi charges by its normal rules, and a low balance is reported in the chat (to set a cap: --max-spend <amount>, or /budget <amount> in the chat). ',
          'Sin límite de gasto local: Yomi cobra según sus reglas habituales, y si el saldo no alcanza se avisa en el chat (para fijar un límite: --max-spend <cantidad>, o /budget <cantidad> en el chat). ',
          'Sem limite de gastos local: o Yomi cobra pelas regras normais, e saldo baixo é avisado no chat (para definir um limite: --max-spend <quantidade>, ou /budget <quantidade> no chat). ',
        );
  if (maxSpend === 0)
    return install
      ? tr(
          '本机花费上限 0：relay 不花钻石，只用免费额度，服务端支持之前一条也不发。要按 Yomi 的正常规则扣费，去掉 --max-spend 重新安装。',
          'Local spending cap: 0, so relay spends no gems: free replies only, and nothing is sent until the server supports them. To let Yomi charge by its normal rules, install again without --max-spend.',
          'Límite de gasto local: 0, así que relay no gasta gemas: solo respuestas gratis, y no se envía nada hasta que el servidor las admita. Para que Yomi cobre según sus reglas habituales, vuelve a instalar sin --max-spend.',
          'Limite de gastos local: 0, então o relay não gasta gemas: só respostas grátis, e nada é enviado até o servidor oferecer suporte a elas. Para o Yomi cobrar pelas regras normais, instale de novo sem --max-spend.',
        )
      : tr(
          '本机花费上限 0：relay 不花钻石，只用免费额度，服务端支持之前一条也不发。要按 Yomi 的正常规则扣费，去掉 --max-spend 启动（后台服务：重新安装）。',
          'Local spending cap: 0, so relay spends no gems: free replies only, and nothing is sent until the server supports them. Start without --max-spend to let Yomi charge by its normal rules (a background service: install it again). ',
          'Límite de gasto local: 0, así que relay no gasta gemas: solo respuestas gratis, y no se envía nada hasta que el servidor las admita. Inicia sin --max-spend para que Yomi cobre según sus reglas habituales (un servicio en segundo plano: vuelve a instalarlo). ',
          'Limite de gastos local: 0, então o relay não gasta gemas: só respostas grátis, e nada é enviado até o servidor oferecer suporte a elas. Inicie sem --max-spend para o Yomi cobrar pelas regras normais (um serviço em segundo plano: instale-o de novo). ',
        );
  return install
    ? tr(
        `本机允许 relay 最多花 ${maxSpend} 钻石（累计）。`,
        `Local spending cap: relay may spend up to ${maxSpend} gems in total on this machine.`,
        `Límite de gasto local: relay puede gastar hasta ${maxSpend} gemas en total en este equipo.`,
        `Limite de gastos local: o relay pode gastar até ${maxSpend} gemas no total nesta máquina.`,
      )
    : tr(
        `本机允许 relay 最多花 ${maxSpend} 钻石（累计；--reset-spend 重新计算）。`,
        `Local spending cap: relay may spend up to ${maxSpend} gems in total on this machine (--reset-spend starts the count over). `,
        `Límite de gasto local: relay puede gastar hasta ${maxSpend} gemas en total en este equipo (--reset-spend reinicia el conteo). `,
        `Limite de gastos local: o relay pode gastar até ${maxSpend} gemas no total nesta máquina (--reset-spend zera a contagem). `,
      );
}

/** A channel's name inside Chinese text: set apart by spaces when it is in Latin letters. */
const inChinese = (name: string) => (/^[\x21-\x7e]/.test(name) ? ` ${name} ` : name);

const lockPath = (name: string) => join(configDir(), 'locks', `relay-${name}.lock`);

/**
 * One relay per Yomi account and environment, whatever the channel (design §5.2, §12.2): every
 * relay holds `relay-env-<sha256(account)[0:16]>.lock` while it runs, and so does every change to
 * the bots (`whileStopped`: adding or renewing one with --set-token, --set-app or --login,
 * rebinding, --forget, as well as --forget --all). Relays side by side would share the device id
 * on the Yomi long connection, take each other's offline messages, count each other's spending in
 * balance-measured charges and each spend a whole --max-spend.
 */
function lockEnvironment(
  context: Context,
  note: LockNote,
  refusal: (holder: Holder) => string,
): { release: () => void } {
  const name = `env-${sha256(context.account).slice(0, 16)}`;
  const lock = acquireProcessLock(lockPath(name), note);
  if ('heldBy' in lock) throw new UsageError(refusal(holderOf(lock)));
  return lock;
}

/** This environment's lock (`lockEnvironment`). */
const environmentLock = (context: Context) =>
  lockPath(`env-${sha256(context.account).slice(0, 16)}`);

/** Held while the bots change (design §2.6): one change at a time, a QR scan included. */
const setupLock = (context: Context) => lockPath(`setup-${sha256(context.account).slice(0, 16)}`);

/** How long a stopped background service may take to let go of the environment's lock. */
const SERVICE_STOP_MS = 30_000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This environment's background service that runs as `pid`, if one does: the hub's, or a unit of
 * before it still installed.
 */
function serviceRunningAs(context: Context, pid: number): ServicePlan | null {
  return installedPlans(context).find((plan) => servicePid(plan) === pid) ?? null;
}

/** The background service that holds the environment's lock now, if one does. */
function serviceHolding(context: Context): ServicePlan | null {
  const holder = lockHolder(environmentLock(context));
  return holder ? serviceRunningAs(context, holder.pid) : null;
}

/** The signals that would end this process while a background service is stopped for a change. */
const ENDING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Starts a background service stopped for a change again exactly once: when the change ends
 * (`restart`, unless it removed the service: `keep`), or when a signal ends this process first
 * (Ctrl+C at a prompt or during a check with the platform, the terminal closed during a QR scan),
 * which a signal's default would do without running any `finally`. Ctrl+C or SIGTERM while a step
 * listens for it itself (the QR scan, a pairing run) is left to that step, which ends the change
 * the usual way. `dispose` when it is over.
 */
function serviceGuard(context: Context) {
  let service: ServicePlan | null = null;
  let done = false;
  const restart = () => {
    if (!service || done) return;
    done = true;
    startServiceAgain(context, service);
  };
  const handlers = ENDING_SIGNALS.map((signal) => {
    const before = process.listenerCount(signal);
    const handler = () => {
      if (signal !== 'SIGHUP' && process.listenerCount(signal) > before + 1) return;
      restart();
      process.exit(128 + (constants.signals[signal] ?? 0));
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return {
    stopped(stopped: ServicePlan | null) {
      service = stopped;
    },
    /** The change removed the service: nothing to start again. */
    keep() {
      done = true;
    },
    restart,
    dispose() {
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
    },
  };
}

type ServiceGuard = ReturnType<typeof serviceGuard>;

/**
 * Runs `body` with the background service that holds the environment's lock stopped (`stopped`:
 * null when none does), started again after it whatever happens (`serviceGuard`), under no lock of
 * its own: the caller holds the setup lock.
 */
async function withServiceStopped<T>(
  context: Context,
  body: (stopped: ServicePlan | null, guard: ServiceGuard) => Promise<T>,
): Promise<T> {
  const guard = serviceGuard(context);
  try {
    const stopped = await stopRunningService(context, guard);
    return await body(stopped, guard);
  } finally {
    guard.restart();
    guard.dispose();
  }
}

/**
 * Stops the background service that holds the environment's lock, saying so, and waits until it
 * let go of it; null when no service holds it (a relay in a terminal is never stopped from here).
 * `guard` starts it again should this process end meanwhile.
 */
async function stopRunningService(
  context: Context,
  guard: ServiceGuard,
): Promise<ServicePlan | null> {
  const { io } = context;
  const holder = lockHolder(environmentLock(context));
  const service = holder ? serviceRunningAs(context, holder.pid) : null;
  if (!holder || !service) return null;
  say(
    io,
    tr(
      `正在停止后台服务（${service.label}），改完后会重新启动它。`,
      `Stopping the background service (${service.label}) for this change; it starts again afterwards.`,
      `Deteniendo el servicio en segundo plano (${service.label}) para este cambio; vuelve a iniciarse después.`,
      `Parando o serviço em segundo plano (${service.label}) para esta mudança; ele inicia de novo depois.`,
    ),
  );
  guard.stopped(service);
  pauseService(service);
  if (!(await environmentLetGo(context, holder.pid))) {
    guard.restart();
    throw new UsageError(
      tr(
        `后台服务（${service.label}）${SERVICE_STOP_MS / 1000} 秒内没有停下来，所以没有改动：稍后再试。`,
        `The background service (${service.label}) did not stop within ${SERVICE_STOP_MS / 1000} s, so nothing changed: try again later.`,
        `El servicio en segundo plano (${service.label}) no se detuvo en ${SERVICE_STOP_MS / 1000} s, así que no se cambió nada: vuelve a intentarlo más tarde.`,
        `O serviço em segundo plano (${service.label}) não parou em ${SERVICE_STOP_MS / 1000} s, então nada mudou: tente de novo mais tarde.`,
      ),
    );
  }
  return service;
}

/**
 * Waits until the process `pid` (a background service being stopped) let go of the environment's
 * lock; false when it still holds it after `SERVICE_STOP_MS`.
 */
async function environmentLetGo(context: Context, pid: number): Promise<boolean> {
  const deadline = Date.now() + SERVICE_STOP_MS;
  while (lockHolder(environmentLock(context))?.pid === pid) {
    if (Date.now() > deadline) return false;
    await pause(200);
  }
  return true;
}

/** Starts a background service stopped for a change again, saying so (or how to, if it failed). */
function startServiceAgain(context: Context, plan: ServicePlan) {
  const { io } = context;
  if (resumeService(plan))
    say(
      io,
      tr(
        `已重新启动后台服务（${plan.label}）。`,
        `Started the background service again (${plan.label}).`,
        `Se volvió a iniciar el servicio en segundo plano (${plan.label}).`,
        `O serviço em segundo plano foi iniciado de novo (${plan.label}).`,
      ),
    );
  else {
    const command = reinstallCommand(plan);
    warn(
      io,
      tr(
        `没能重新启动后台服务（${plan.label}）：运行 ${command} 重新安装它。`,
        `Couldn't start the background service again (${plan.label}): install it again with ${command}.`,
        `No se pudo volver a iniciar el servicio en segundo plano (${plan.label}): vuelve a instalarlo con ${command}.`,
        `Não foi possível iniciar de novo o serviço em segundo plano (${plan.label}): instale-o de novo com ${command}.`,
      ),
    );
  }
}

/** The note the setup and environment locks get while `flag` changes the bots. */
const changeNote = (flag: string, kind?: ChannelKind): LockNote =>
  kind ? { channel: kind, flag } : { flag };

/** Runs `change` under the setup lock (design §2.6): one change to the bots at a time. */
async function withSetupLock<T>(
  context: Context,
  note: LockNote,
  change: () => Promise<T>,
): Promise<T> {
  const lock = acquireProcessLock(setupLock(context), note);
  if ('heldBy' in lock) throw new UsageError(credentialsRunning(holderOf(lock), note.flag ?? ''));
  try {
    return await change();
  } finally {
    lock.release();
  }
}

/** What a change to the bots tells of the background service stopped for it. */
type ServiceAfter = {
  /** It removed `plan`: when that is the service stopped, it is not started again. */
  removed: (plan: ServicePlan) => void;
  /** It took the last bot away: the service stopped is not started again (said). */
  emptied: () => void;
};

/**
 * Runs a change to the bots (`flag`, of a bot of `kind` when it is one bot's) with no other change
 * and no relay of this environment running: under the setup lock, then the environment's lock. A
 * background service holding it is stopped first and started again after, said both times (the
 * other bots are offline meanwhile); a relay running in a terminal refuses the change, named.
 * `change` keeps a service from starting again when nothing is left for it (`ServiceAfter`).
 * With no service stopped, one installed but not running is said, with how to start it; a unit
 * of before the hub started again is said to run its own channel's bots only (`legacyRestarted`).
 */
async function whileStopped<T>(
  context: Context,
  flag: string,
  kind: ChannelKind | undefined,
  change: (service: ServiceAfter) => Promise<T>,
): Promise<T> {
  const note = changeNote(flag, kind);
  let restarted: ServicePlan | null = null;
  const result = await withSetupLock(context, note, () =>
    withServiceStopped(context, async (stopped, guard) => {
      const held = lockEnvironment(context, note, (holder) =>
        holder.flag ? credentialsRunning(holder, flag) : runningRefusal(holder, flag),
      );
      try {
        restarted = stopped;
        const result = await change({
          removed: (plan) => {
            if (stopped && plan.path === stopped.path) {
              guard.keep();
              restarted = null;
            }
          },
          emptied: () => {
            if (!stopped) return;
            guard.keep();
            restarted = null;
            say(context.io, paint(context.io, 'dim', serviceLeftStopped(stopped)));
          },
        });
        if (!stopped) idleServiceHint(context);
        return result;
      } finally {
        held.release();
      }
    }),
  );
  legacyRestarted(context, restarted);
  return result;
}

/** The last bot was taken away while the background service was stopped for it. */
function serviceLeftStopped(plan: ServicePlan): string {
  const command = reinstallCommand(plan);
  return tr(
    `没有 bot 了，所以没有重新启动后台服务（${plan.label}）。添加 bot 之后，用 ${command} 启动它。`,
    `No bots are left, so the background service (${plan.label}) was not started again. Once you add a bot, start it with ${command}.`,
    `No quedan bots, así que no se volvió a iniciar el servicio en segundo plano (${plan.label}). Cuando agregues un bot, inícialo con ${command}.`,
    `Não restam bots, então o serviço em segundo plano (${plan.label}) não foi iniciado de novo. Depois de adicionar um bot, inicie-o com ${command}.`,
  );
}

/**
 * After a change that stopped a background service and started it again: when that is a unit of
 * before the hub (design §4.3), it runs only its own channel's bots, as it was installed, whatever
 * the change was for; said, with the command that replaces it with one for every bot.
 */
function legacyRestarted(context: Context, plan: ServicePlan | null) {
  const kind = plan ? legacyKind(context, plan) : null;
  if (!plan || !kind || !existsSync(plan.path)) return;
  const { io } = context;
  const name = channelSetup(kind).displayName;
  const command = reinstallCommand(plan);
  say(
    io,
    paint(
      io,
      'dim',
      tr(
        `这个后台服务（${plan.label}）是旧版的，只运行${inChinese(name)}的 bot：用 ${command} 换成一个运行所有 bot 的服务。`,
        `This background service (${plan.label}) is an older one that runs only ${name} bots: replace it with one for every bot with ${command}.`,
        `Este servicio en segundo plano (${plan.label}) es uno antiguo que solo ejecuta los bots de ${name}: reemplázalo por uno para todos los bots con ${command}.`,
        `Este serviço em segundo plano (${plan.label}) é um antigo que só executa os bots do ${name}: substitua-o por um para todos os bots com ${command}.`,
      ),
    ),
  );
}

/**
 * After a change with no background service running: one that is installed (it ended, with no
 * bot that could run, or was stopped by hand) does not pick the change up by itself; said, with
 * how to start it, while there are bots for it to run.
 */
function idleServiceHint(context: Context) {
  const { io } = context;
  const installed = installedPlans(context);
  if (!installed.length || installed.some((plan) => servicePid(plan))) return;
  if (!BotRegistry.open(context.account).list().length) return;
  // The hub's when it is installed (`installedPlans` puts it first).
  const command = reinstallCommand(installed[0]);
  say(
    io,
    paint(
      io,
      'dim',
      tr(
        `后台服务已安装，但没有在运行，所以它不会运行这些 bot：用 ${command} 重新启动它。`,
        `The background service is installed but not running, so it does not run these bots: start it again with ${command}.`,
        `El servicio en segundo plano está instalado, pero no está en ejecución, así que no ejecuta estos bots: vuelve a iniciarlo con ${command}.`,
        `O serviço em segundo plano está instalado, mas não está em execução, então ele não executa estes bots: inicie-o de novo com ${command}.`,
      ),
    ),
  );
}

/** The command that sets a registered bot's credentials again. */
const renewCommand = (record: BotRecord) =>
  `yomi relay --bot ${record.name} ${channelSetup(record.kind).credentialsFlag}`;

/** Refused: a relay of an older yomi holds the bot's own lock while `flag` would change it. */
function botLocked(record: BotRecord, flag: string): { release: () => void } {
  const lock = acquireProcessLock(lockPath(record.lockName));
  if ('heldBy' in lock)
    throw new UsageError(
      runningRefusal({ pid: lock.heldBy, setup: null, bot: '', bots: [], flag: '' }, flag),
    );
  return lock;
}

/** Deletes a bot's state file and its local records; true when it had a state file. */
function forgetBotState(context: Context, record: BotRecord): boolean {
  const path = relayStatePath(context.account, record.scope);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  const userId = context.gateway.credential?.userId;
  if (userId) rmSync(botRecords(context.account, record.scope, userId).path, { force: true });
  return existed;
}

/** What --forget says it deleted: the channel's secret and pairing records, `states` of them. */
function forgotten(context: Context, setup: ChannelSetup, removed: boolean, states: number) {
  const { io } = context;
  const label = setup.secretLabel;
  // Telegram's Spanish and Portuguese say "token de bot" in this one line, as they always have.
  const none = setup.kind === 'telegram' ? 'token de bot' : label;
  say(
    io,
    removed || states
      ? tr(
          `已删除本机保存的 ${label} 和配对信息（${states} 份）。`,
          `Deleted the ${label} and pairing info saved on this machine (${states} record(s)).`,
          `Se eliminaron el ${label} y los datos de vinculación guardados en este equipo (${states} registro(s)).`,
          `O ${label} e os dados de pareamento salvos nesta máquina foram excluídos (${states} registro(s)).`,
        )
      : tr(
          `本机没有保存 ${label} 或配对信息。`,
          `No ${label} or pairing info is saved on this machine.`,
          `No hay ningún ${none} ni datos de vinculación guardados en este equipo.`,
          `Não há ${none} nem dados de pareamento salvos nesta máquina.`,
        ),
  );
}

/** Uninstalls `plan` (said). */
function removeService(context: Context, plan: ServicePlan) {
  uninstallService(plan);
  say(
    context.io,
    tr(
      `已停止并删除后台服务（${plan.path}）`,
      `Stopped and removed the background service (${plan.path})`,
      `Se detuvo y se eliminó el servicio en segundo plano (${plan.path})`,
      `O serviço em segundo plano foi parado e removido (${plan.path})`,
    ),
  );
}

/** Uninstalls `kind`'s own unit of before the hub when it is installed (said); its plan, else null. */
function removeLegacyService(context: Context, kind: ChannelKind): ServicePlan | null {
  if (!legacyInstalled(context, kind)) return null;
  const plan = legacyPlan(context, kind);
  removeService(context, plan);
  return plan;
}

/**
 * Takes one bot away (design §1.3): its secret, state, local records and record. `channelWide`
 * (`--channel K --forget`, K's one bot): K's own background service of before the hub and what K
 * left of before the registry (state files no bot has, the channel's old secret) go too, as
 * `--forget` always took the channel's. A secret of before the registry naming this bot goes with
 * it, or the next run would take it over again. The last bot taken away leaves a background
 * service stopped for it stopped: it would have nothing to run.
 */
async function removeBot(
  context: Context,
  registry: BotRegistry,
  record: BotRecord,
  channelWide: boolean,
) {
  const { io, store } = context;
  const setup = channelSetup(record.kind);
  await whileStopped(context, '--forget', record.kind, async (service) => {
    const lock = botLocked(record, '--forget');
    try {
      if (channelWide) {
        const plan = removeLegacyService(context, record.kind);
        if (plan) service.removed(plan);
      }
      let removed = store.deleteSecret(record.secretName);
      const legacyName = setup.secretName(context.account);
      const legacy = legacyName !== record.secretName ? store.getSecret(legacyName) : null;
      const legacyBot = legacy ? setup.storedBot(legacy) : null;
      if (legacy && (channelWide || legacyBot?.platformId === record.platformId))
        removed = store.deleteSecret(legacyName) || removed;
      let states = forgetBotState(context, record) ? 1 : 0;
      registry.remove(record.key);
      // No bot of the channel is left: its state files are nobody's now.
      if (channelWide) states += forgetRelayStates(context.account, undefined, record.kind);
      if (!channelWide)
        say(
          io,
          tr(
            `已删除 bot ${record.name}（${setup.displayName} ${record.label}）。`,
            `Removed the bot ${record.name} (${setup.displayName} ${record.label}).`,
            `Se eliminó el bot ${record.name} (${setup.displayName} ${record.label}).`,
            `O bot ${record.name} foi removido (${setup.displayName} ${record.label}).`,
          ),
        );
      forgotten(context, setup, removed, states);
      say(io, paint(io, 'dim', setup.forgetHint()));
      if (!registry.list().length) service.emptied();
    } finally {
      lock.release();
    }
  });
}

/**
 * `--channel K --forget` for a channel without a bot: what it left of before the registry (its
 * secret, unreadable or another account's state files, its background service of before the
 * hub), as `--forget` always did.
 */
async function forgetLeftovers(context: Context, setup: ChannelSetup) {
  const { io, store } = context;
  await whileStopped(context, '--forget', setup.kind, async (service) => {
    const plan = removeLegacyService(context, setup.kind);
    if (plan) service.removed(plan);
    const states = forgetRelayStates(context.account, undefined, setup.kind);
    const removed = store.deleteSecret(setup.secretName(context.account));
    forgotten(context, setup, removed, states);
    say(io, paint(io, 'dim', setup.forgetHint()));
  });
}

/**
 * `--forget --all` (design §1.3): every background service of this environment first (the hub's
 * and those of before it: nothing is left to start them again), then, with no relay running (one
 * in a terminal refuses it), every bot, the channels' secrets of before the registry, every state
 * file, the shared ledger and the registry itself.
 */
async function forgetAll(context: Context) {
  const { io, store, account } = context;
  const flag = '--forget --all';
  await withSetupLock(context, changeNote(flag), async () => {
    const holder = lockHolder(environmentLock(context));
    const service = holder ? serviceRunningAs(context, holder.pid) : null;
    for (const plan of installedPlans(context)) removeService(context, plan);
    // The service that ran lets go of the environment's lock as it ends.
    if (holder && service) await environmentLetGo(context, holder.pid);
    const held = lockEnvironment(context, changeNote(flag), (holder) =>
      holder.flag ? credentialsRunning(holder, flag) : runningRefusal(holder, flag),
    );
    try {
      const registry = openRegistry(context);
      const bots = registry.list();
      const locks = bots.map((record) => botLocked(record, flag));
      try {
        let states = 0;
        for (const record of bots) {
          store.deleteSecret(record.secretName);
          if (forgetBotState(context, record)) states += 1;
        }
        for (const kind of CHANNEL_KINDS)
          store.deleteSecret(channelSetup(kind).secretName(account));
        states += forgetRelayStates(account);
        for (const path of [ledgerPath(account), hubStatusPath(account), registry.path])
          rmSync(path, { force: true });
        say(
          io,
          bots.length || states
            ? tr(
                `已删除这台电脑上的 ${bots.length} 个 bot，以及它们的凭证、配对信息和花费记录（${states} 份）。`,
                `Removed the ${bots.length} bot(s) of this computer, with their credentials, pairing info and spending records (${states} record(s)).`,
                `Se eliminaron los ${bots.length} bot(s) de este equipo, con sus credenciales, sus datos de vinculación y sus registros de gasto (${states} registro(s)).`,
                `Os ${bots.length} bot(s) deste computador foram removidos, com as credenciais, os dados de pareamento e os registros de gastos (${states} registro(s)).`,
              )
            : tr(
                '这台电脑上没有 bot，也没有保存的凭证或配对信息。',
                'There are no bots on this computer, and no credentials or pairing info are saved.',
                'No hay bots en este equipo, ni credenciales ni datos de vinculación guardados.',
                'Não há bots neste computador, nem credenciais ou dados de pareamento salvos.',
              ),
        );
        for (const kind of CHANNEL_KINDS)
          if (bots.some((record) => record.kind === kind))
            say(io, paint(io, 'dim', channelSetup(kind).forgetHint()));
      } finally {
        for (const lock of locks) lock.release();
      }
    } finally {
      held.release();
    }
  });
}

/** `--forget` that says nothing of what. */
function forgetWhich(): string {
  return tr(
    '要删除什么？一个 bot：--forget --bot 名字（名字见 yomi relay --list）；一个通道唯一的 bot：--channel telegram|qq|wechat --forget；全部：--forget --all',
    'What should be removed? One bot: --forget --bot NAME (the names are in yomi relay --list); the one bot of a channel: --channel telegram|qq|wechat --forget; everything: --forget --all',
    '¿Qué se debe eliminar? Un bot: --forget --bot NOMBRE (los nombres están en yomi relay --list); el único bot de un canal: --channel telegram|qq|wechat --forget; todo: --forget --all',
    'O que deve ser removido? Um bot: --forget --bot NOME (os nomes estão em yomi relay --list); o único bot de um canal: --channel telegram|qq|wechat --forget; tudo: --forget --all',
  );
}

/**
 * `--forget` (design §1.3): `--bot NAME` takes that bot away; `--channel K` K's one bot (several
 * are refused, named), or what K left of before the registry when it has none; `--all` every bot.
 */
async function relayForget(context: Context, options: RelayCommandOptions) {
  if (options.all) {
    if (options.bots.length || options.channel)
      throw new UsageError(
        tr(
          '--forget --all 删除全部 bot，不能再加 --bot 或通道。',
          '--forget --all removes every bot and takes no --bot or channel.',
          '--forget --all elimina todos los bots y no lleva --bot ni canal.',
          '--forget --all remove todos os bots e não leva --bot nem canal.',
        ),
      );
    return forgetAll(context);
  }
  const registry = openRegistry(context);
  if (options.bots.length) {
    if (options.bots.length > 1)
      throw new UsageError(
        tr(
          '一次只能删除一个 bot：yomi relay --forget --bot 名字（全部：--forget --all）',
          'Remove one bot at a time: yomi relay --forget --bot NAME (all of them: --forget --all)',
          'Elimina un bot a la vez: yomi relay --forget --bot NOMBRE (todos: --forget --all)',
          'Remova um bot de cada vez: yomi relay --forget --bot NOME (todos: --forget --all)',
        ),
      );
    const record = registry.find(options.bots[0]);
    if (!record) throw new UsageError(unknownBot(options.bots[0], registry));
    if (options.channel && options.channel !== record.kind)
      throw new UsageError(otherChannel(record, options.channel));
    return removeBot(context, registry, record, false);
  }
  const kind = options.channel;
  if (!kind) throw new UsageError(forgetWhich());
  const bots = registry.list(kind);
  if (bots.length > 1) {
    const names = bots.map((record) => record.name);
    const name = channelSetup(kind).displayName;
    throw new UsageError(
      tr(
        `${inChinese(name)}有多个 bot（${names.join('、')}）：用 --forget --bot 名字删除其中一个（--forget --all 会删除这台电脑上所有通道的全部 bot）。`,
        `${name} has several bots (${names.join(', ')}): remove one with --forget --bot NAME (--forget --all removes every bot on this computer, in every channel).`,
        `${name} tiene varios bots (${names.join(', ')}): elimina uno con --forget --bot NOMBRE (--forget --all elimina todos los bots de este equipo, de todos los canales).`,
        `O ${name} tem vários bots (${names.join(', ')}): remova um com --forget --bot NOME (--forget --all remove todos os bots deste computador, de todos os canais).`,
      ).trim(),
    );
  }
  if (bots.length === 1) return removeBot(context, registry, bots[0], true);
  return forgetLeftovers(context, channelSetup(kind));
}

/**
 * This environment's bot registry, after taking over the bots the channels' credentials stored
 * before it (design §4.3); what the takeover found to warn about is said once, then.
 */
function openRegistry(context: Context): BotRegistry {
  const { registry, warnings } = migrateRegistry({
    account: context.account,
    store: context.store,
    installed: (kind) => legacyInstalled(context, kind),
  });
  for (const line of warnings) warn(context.io, line);
  return registry;
}

/**
 * The stored credentials are not the registered bot's (something that does not know the registry
 * replaced them): refused, so another bot never runs as this one.
 */
function otherBotCredentials(setup: ChannelSetup, record: BotRecord): string {
  const name = setup.displayName;
  const again = renewCommand(record);
  const forget = `yomi relay --forget --bot ${record.name}`;
  return tr(
    `保存的${inChinese(name)}凭证属于另一个 bot，不是登记的 ${record.name}，所以没有启动。要给 ${record.name} 重新设置它自己的凭证，运行 ${again}；要删掉它，运行 ${forget}。`,
    `The saved ${name} credentials belong to a bot other than the registered ${record.name}, so the relay was not started. To set ${record.name}'s own credentials again, run ${again}; to remove it, run ${forget}.`,
    `Las credenciales de ${name} guardadas son de otro bot, no del bot registrado ${record.name}, así que no se inició. Para volver a configurar las credenciales propias de ${record.name}, ejecuta ${again}; para eliminarlo, ejecuta ${forget}.`,
    `As credenciais do ${name} salvas são de outro bot, não do bot registrado ${record.name}, então ele não foi iniciado. Para configurar de novo as credenciais do próprio ${record.name}, execute ${again}; para removê-lo, execute ${forget}.`,
  );
}

/** The stored credentials changed while the relay started (another command set them): run again. */
function credentialsChanged(setup: ChannelSetup): string {
  const name = setup.displayName;
  return tr(
    `启动时保存的${inChinese(name)}凭证被换掉了，所以没有启动：再运行一次 ${setup.command}。`,
    `The saved ${name} credentials changed while the relay was starting, so it was not started: run ${setup.command} again.`,
    `Las credenciales de ${name} guardadas cambiaron mientras se iniciaba el relay, así que no se inició: vuelve a ejecutar ${setup.command}.`,
    `As credenciais do ${name} salvas mudaram enquanto o relay iniciava, então ele não foi iniciado: execute ${setup.command} de novo.`,
  );
}

/** The command that binds `name` to a character (`npcId` when it is known). */
const bindCommand = (name: string, npcId = 'ID') => `yomi relay --bot ${name} --character ${npcId}`;

/** The character id in `input` (a number or a link with one), '' when there is none. */
const characterIdOf = (input: string) => /([1-9][0-9]{5,19})/.exec(input)?.[1] ?? '';

/** `--character` names no character that can chat (not found, removed, or not for this account). */
function characterBad(input: string, detail: string): string {
  return tr(
    `没有找到角色 ${input}，或它暂时不能聊天${detail ? `（${detail}）` : ''}。`,
    `Character ${input} was not found or cannot chat right now${detail ? ` (${detail})` : ''}.`,
    `No se encontró el personaje ${input} o no puede chatear ahora${detail ? ` (${detail})` : ''}.`,
    `O personagem ${input} não foi encontrado ou não pode conversar agora${detail ? ` (${detail})` : ''}.`,
  );
}

/** The character `--character` names, read from Yomi; a UsageError when it cannot chat. */
async function characterFor(context: Context, input: string): Promise<RelayCharacter> {
  const npcId = characterIdOf(input);
  if (!npcId) throw new UsageError(characterBad(input, ''));
  let profile: CharacterProfile;
  try {
    profile = await characterProfile(context.gateway, npcId);
  } catch (error) {
    if (error instanceof ChatRefusal) throw new UsageError(characterBad(npcId, error.message));
    throw error;
  }
  return { npcId, name: profile.name, group: profile.group };
}

/** A character in the terminal: its name and id. */
const nameAndId = (character: RelayCharacter) =>
  tr(
    `${character.name}（${character.npcId}）`,
    `${character.name} (${character.npcId})`,
    `${character.name} (${character.npcId})`,
    `${character.name} (${character.npcId})`,
  );

/** A run's `--character` for a bot bound to another one: the registry's stays. */
function characterIgnored(record: BotRecord, character: RelayCharacter, input: string): string {
  return tr(
    `bot ${record.name} 固定和${nameAndId(character)}聊天：忽略这次的 --character ${input}。要换角色，先停止 relay，再运行 ${bindCommand(record.name)}。`,
    `The bot ${record.name} always chats with ${nameAndId(character)}: --character ${input} is ignored. To change its character, stop the relay, then run ${bindCommand(record.name)}.`,
    `El bot ${record.name} siempre chatea con ${nameAndId(character)}: se ignora --character ${input}. Para cambiar su personaje, detén el relay y luego ejecuta ${bindCommand(record.name)}.`,
    `O bot ${record.name} sempre conversa com ${nameAndId(character)}: --character ${input} foi ignorado. Para trocar o personagem, pare o relay e depois execute ${bindCommand(record.name)}.`,
  );
}

/** A bot without a character runs, but only says how to bind one. */
function needsCharacter(record: BotRecord): string {
  return tr(
    `bot ${record.name} 还没有绑定角色：消息不会转发，只会提示主人在电脑上绑定。绑定：${bindCommand(record.name)}`,
    `The bot ${record.name} has no character yet: messages are not forwarded, the owner is only told to bind one on the computer. To bind one: ${bindCommand(record.name)}`,
    `El bot ${record.name} todavía no tiene personaje: los mensajes no se reenvían, solo se le dice al dueño que vincule uno en el equipo. Para vincularlo: ${bindCommand(record.name)}`,
    `O bot ${record.name} ainda não tem personagem: as mensagens não são encaminhadas, o dono só é avisado para vincular um no computador. Para vincular: ${bindCommand(record.name)}`,
  );
}

/**
 * A run's `--character` (design §1.4): binds a bot that has none (unless another bot has it), and
 * changes nothing for one bound to it already. For one bound to another character it is ignored
 * with a warning, and so is anything that keeps it from binding: a background service started
 * with an older `--character` must not stop over it. Returns the bot's record.
 */
async function characterAtStart(
  context: Context,
  registry: BotRegistry,
  record: BotRecord,
  input: string,
): Promise<BotRecord> {
  const npcId = characterIdOf(input);
  const bound = record.character;
  if (bound && bound.npcId === npcId) return record;
  if (bound) {
    warn(context.io, characterIgnored(record, bound, input));
    return record;
  }
  try {
    return registry.rebind(record.key, await characterFor(context, input));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    warn(context.io, error.message);
    return record;
  }
}

/** A chat user id shown in part: its first and last two characters. */
function masked(id: string): string {
  return id.length > 6 ? `${id.slice(0, 2)}…${id.slice(-2)}` : '…';
}

/**
 * What the relay holding the environment's lock wrote of its bots (`RelayHub`), when that process
 * wrote it; null otherwise.
 */
function hubStatus(context: Context): HubStatusFile['bots'] | null {
  const holder = lockHolder(lockPath(`env-${sha256(context.account).slice(0, 16)}`));
  const status = readJsonFile<HubStatusFile>(hubStatusPath(context.account));
  return holder && status && status.pid === holder.pid ? (status.bots ?? null) : null;
}

/**
 * What `--list` says of a bot's state: what the running relay says of it when it stopped or is
 * starting again, else (offline) its lock, then `offlineStatus`.
 */
function botStatus(
  context: Context,
  record: BotRecord,
  state: RelayState | null,
  hub: HubStatusFile['bots'] | null,
): string {
  const running = hub?.[record.name];
  if (running?.status === 'stopped')
    return tr(
      `已停止${running.reason ? `：${running.reason}` : ''}`,
      `stopped${running.reason ? `: ${running.reason}` : ''}`,
      `detenido${running.reason ? `: ${running.reason}` : ''}`,
      `parado${running.reason ? `: ${running.reason}` : ''}`,
    );
  if (running?.status === 'restarting')
    return tr(
      `正在重新启动${running.reason ? `（${running.reason}）` : ''}`,
      `starting again${running.reason ? ` (${running.reason})` : ''}`,
      `reiniciándose${running.reason ? ` (${running.reason})` : ''}`,
      `reiniciando${running.reason ? ` (${running.reason})` : ''}`,
    );
  const holder = lockHolder(lockPath(record.lockName));
  if (holder)
    return tr(
      `运行中（进程 ${holder.pid}）`,
      `running (process ${holder.pid})`,
      `en ejecución (proceso ${holder.pid})`,
      `em execução (processo ${holder.pid})`,
    );
  return offlineStatus(context, record, state).text;
}

/**
 * What a bot that does not run needs, read on this computer alone (its credentials, its owner,
 * its character), and whether a run with nobody at the terminal (a background service) would
 * start it (`runs`): a bot without a character runs, answering only how to bind one.
 */
function offlineStatus(
  context: Context,
  record: BotRecord,
  state: RelayState | null,
): { text: string; runs: boolean } {
  const secret = context.store.getSecret(record.secretName);
  const stored = secret ? channelSetup(record.kind).storedBot(secret) : null;
  const renew = renewCommand(record);
  const login = () => ({
    text: tr(
      `需要登录：${renew}`,
      `needs login: ${renew}`,
      `necesita iniciar sesión: ${renew}`,
      `precisa entrar: ${renew}`,
    ),
    runs: false,
  });
  if (!stored && record.kind === 'wechat') return login();
  if (!stored)
    return {
      text: tr(
        `需要凭证：${renew}`,
        `needs credentials: ${renew}`,
        `necesita credenciales: ${renew}`,
        `precisa de credenciais: ${renew}`,
      ),
      runs: false,
    };
  if (!sameBot(record, stored)) {
    const forget = `yomi relay --forget --bot ${record.name}`;
    return {
      text: tr(
        `凭证属于另一个 bot：要重新设置它自己的凭证，运行 ${renew}；要删掉它，运行 ${forget}`,
        `credentials belong to another bot: set its own with ${renew}, or remove it with ${forget}`,
        `las credenciales son de otro bot: configura las suyas con ${renew}, o elimínalo con ${forget}`,
        `as credenciais são de outro bot: configure as dele com ${renew}, ou remova-o com ${forget}`,
      ),
      runs: false,
    };
  }
  if (!state?.data.owner && record.kind === 'wechat') return login();
  if (!state?.data.owner) {
    const pair = `yomi relay --bot ${record.name} --pair`;
    return {
      text: tr(
        `需要配对：${pair}`,
        `needs pairing: ${pair}`,
        `necesita vinculación: ${pair}`,
        `precisa de pareamento: ${pair}`,
      ),
      runs: false,
    };
  }
  if (!record.character)
    return {
      text: tr(
        `需要绑定角色：${bindCommand(record.name)}`,
        `needs a character: ${bindCommand(record.name)}`,
        `necesita un personaje: ${bindCommand(record.name)}`,
        `precisa de um personagem: ${bindCommand(record.name)}`,
      ),
      runs: true,
    };
  return {
    text: tr('没有运行', 'not running', 'no está en ejecución', 'não está em execução'),
    runs: true,
  };
}

/** A registered bot's state file, when it has one (read only). */
function stateOf(context: Context, record: BotRecord): RelayState | null {
  const path = relayStatePath(context.account, record.scope);
  return existsSync(path) ? new RelayState(path, record.scope, context.account, record.kind) : null;
}

/**
 * `yomi relay --list [--channel K]`: the registered bots, each with its channel, character, owner
 * and state, and the background service. Changes no bot (it takes over stored credentials first,
 * as every `yomi relay` does) and asks no server.
 */
export async function relayList(context: Context, kind: ChannelKind | null) {
  const { io } = context;
  const registry = openRegistry(context);
  listBots(context, registry, kind);
  for (const line of serviceLines(context, false)) say(io, paint(io, 'dim', line));
}

/** Says the bots of `kind` (all of them when null), as `--list` and `--service-status` show them. */
function listBots(context: Context, registry: BotRegistry, kind: ChannelKind | null) {
  const { io } = context;
  const bots = registry.list(kind ?? undefined);
  if (!bots.length && kind) {
    // Only this channel has none: the others' bots are listed without --channel.
    const setup = channelSetup(kind);
    const name = setup.displayName;
    const command = `${setup.command} ${setup.credentialsFlag}`;
    say(
      io,
      tr(
        `这台电脑上还没有${inChinese(name)}的 bot：用 ${command} 设置一个。`,
        `No ${name} bot on this computer yet: set one up with ${command}.`,
        `Todavía no hay ningún bot de ${name} en este equipo: configura uno con ${command}.`,
        `Ainda não há nenhum bot do ${name} neste computador: configure um com ${command}.`,
      ),
    );
    if (registry.list().length)
      say(
        io,
        paint(
          io,
          'dim',
          tr(
            '其他通道的 bot：yomi relay --list',
            "Other channels' bots: yomi relay --list",
            'Bots de los otros canales: yomi relay --list',
            'Bots dos outros canais: yomi relay --list',
          ),
        ),
      );
  } else if (!bots.length) say(io, noBotsYet());
  const none = tr('（还没有）', '(none yet)', '(todavía no)', '(ainda não)');
  const hub = hubStatus(context);
  for (const record of bots) {
    const setup = channelSetup(record.kind);
    const state = stateOf(context, record);
    const owner = state?.data.owner;
    const named = record.character;
    const character = named
      ? tr(
          `${named.name}（${named.npcId}）`,
          `${named.name} (${named.npcId})`,
          `${named.name} (${named.npcId})`,
          `${named.name} (${named.npcId})`,
        )
      : none;
    const ownerName = owner
      ? record.kind === 'telegram' && owner.name
        ? owner.name
        : masked(String(owner.userId))
      : none;
    say(io, `${paint(io, 'bold', record.name)}  ${setup.displayName}  ${record.label}`);
    say(
      io,
      tr(
        `  角色：${character}`,
        `  Character: ${character}`,
        `  Personaje: ${character}`,
        `  Personagem: ${character}`,
      ),
    );
    say(
      io,
      tr(
        `  主人：${ownerName}`,
        `  Owner: ${ownerName}`,
        `  Dueño: ${ownerName}`,
        `  Dono: ${ownerName}`,
      ),
    );
    const status = botStatus(context, record, state, hub);
    say(
      io,
      tr(`  状态：${status}`, `  Status: ${status}`, `  Estado: ${status}`, `  Status: ${status}`),
    );
  }
}

/**
 * What is installed of the background service (design §1.3, §1.5): the hub's unit, running (its
 * process) or not, and the per-channel units of before it still installed. `detailed`
 * (`--service-status`): the unit's file and its log too.
 */
function serviceLines(context: Context, detailed: boolean): string[] {
  const installed = installedPlans(context);
  if (!installed.length) return [noServiceInstalled()];
  const hub = hubPlan(context);
  const lines: string[] = [];
  if (installed.some((plan) => plan.path === hub.path)) {
    const pid = servicePid(hub);
    const command = reinstallCommand(hub);
    lines.push(
      pid
        ? tr(
            `后台服务：运行中（进程 ${pid}），运行所有 bot（${hub.label}）`,
            `Background service: running (process ${pid}), for every bot (${hub.label})`,
            `Servicio en segundo plano: en ejecución (proceso ${pid}), para todos los bots (${hub.label})`,
            `Serviço em segundo plano: em execução (processo ${pid}), para todos os bots (${hub.label})`,
          )
        : tr(
            `后台服务：已安装，没有在运行（${hub.label}）：用 ${command} 重新启动它`,
            `Background service: installed, not running (${hub.label}): start it again with ${command}`,
            `Servicio en segundo plano: instalado, no está en ejecución (${hub.label}): vuelve a iniciarlo con ${command}`,
            `Serviço em segundo plano: instalado, não está em execução (${hub.label}): inicie-o de novo com ${command}`,
          ),
    );
    if (detailed)
      lines.push(
        tr(
          `  单元文件：${hub.path}`,
          `  Unit file: ${hub.path}`,
          `  Archivo de la unidad: ${hub.path}`,
          `  Arquivo da unidade: ${hub.path}`,
        ),
        tr(
          `  日志：${hub.log}`,
          `  Log: ${hub.log}`,
          `  Registro: ${hub.log}`,
          `  Log: ${hub.log}`,
        ),
      );
  }
  const legacy = legacyLine(context, installed);
  if (legacy) {
    lines.push(legacy);
    if (detailed)
      for (const kind of CHANNEL_KINDS.filter((kind) => legacyInstalled(context, kind))) {
        const plan = legacyPlan(context, kind);
        const pid = servicePid(plan);
        const name = channelSetup(kind).displayName;
        const state = pid
          ? tr(
              `运行中（进程 ${pid}）`,
              `running (process ${pid})`,
              `en ejecución (proceso ${pid})`,
              `em execução (processo ${pid})`,
            )
          : tr('没有运行', 'not running', 'no está en ejecución', 'não está em execução');
        lines.push(
          tr(
            `  ${name}：${state}（${plan.path}）`,
            `  ${name}: ${state} (${plan.path})`,
            `  ${name}: ${state} (${plan.path})`,
            `  ${name}: ${state} (${plan.path})`,
          ),
        );
      }
  }
  return lines;
}

/**
 * The units of before the hub still installed among `installed` (design §4.3), said with the
 * command that replaces them with one for every bot (keeping the cap the service runs with:
 * `reinstallCommand`); null when there are none. --uninstall-service, which removes every unit,
 * is offered only while the hub's is not installed: beside it, it would take the hub away too.
 */
function legacyLine(context: Context, installed: ServicePlan[]): string | null {
  const legacy = installed.filter((plan) => legacyKind(context, plan));
  if (!legacy.length) return null;
  const names = legacy.map((plan) => channelSetup(legacyKind(context, plan)!).displayName);
  const hub = installed.find((plan) => !legacyKind(context, plan));
  const command = reinstallCommand(hub ?? legacy[0]);
  if (hub)
    return tr(
      `还装着旧版按通道分开的后台服务（${names.join('、')}）：${command} 会换成一个运行所有 bot 的服务`,
      `Older per-channel background services are still installed (${names.join(', ')}): ${command} replaces them with one for every bot`,
      `Todavía hay servicios en segundo plano antiguos, uno por canal (${names.join(', ')}): ${command} los reemplaza por uno para todos los bots`,
      `Ainda há serviços em segundo plano antigos, um por canal (${names.join(', ')}): ${command} os substitui por um para todos os bots`,
    );
  return tr(
    `还装着旧版按通道分开的后台服务（${names.join('、')}）：${command} 会换成一个运行所有 bot 的服务（${UNINSTALL} 删除它们）`,
    `Older per-channel background services are still installed (${names.join(', ')}): ${command} replaces them with one for every bot (${UNINSTALL} removes them)`,
    `Todavía hay servicios en segundo plano antiguos, uno por canal (${names.join(', ')}): ${command} los reemplaza por uno para todos los bots (${UNINSTALL} los elimina)`,
    `Ainda há serviços em segundo plano antigos, um por canal (${names.join(', ')}): ${command} os substitui por um para todos os bots (${UNINSTALL} os remove)`,
  );
}

/**
 * `yomi relay --service-status`: the background service (its unit, running or not, its log, and
 * the units of before it still installed), then every bot as `--list` shows it.
 */
async function relayServiceStatus(context: Context) {
  const { io } = context;
  const registry = openRegistry(context);
  for (const line of serviceLines(context, true)) say(io, line);
  say(io);
  listBots(context, registry, null);
}

/**
 * `yomi relay --uninstall-service`: stops and removes the background service, and the
 * per-channel units of before it, each said. The bots stay.
 */
async function relayUninstall(context: Context) {
  const { io } = context;
  // First, so a bot of before the registry whose unit is installed is the one taken over.
  openRegistry(context);
  await withSetupLock(context, changeNote('--uninstall-service'), async () => {
    const installed = installedPlans(context);
    for (const plan of installed) removeService(context, plan);
    if (!installed.length) say(io, noServiceInstalled());
  });
}

/** Neither the background service nor a unit of before it is installed. */
function noServiceInstalled(): string {
  return tr(
    '没有安装后台服务。',
    'No background service is installed.',
    'No hay ningún servicio en segundo plano instalado.',
    'Nenhum serviço em segundo plano está instalado.',
  );
}

/** `--bot NAME` names no registered bot. */
function unknownBot(name: string, registry: BotRegistry): string {
  const names = registry.list().map((record) => record.name);
  if (!names.length)
    return tr(
      `没有叫 "${name}" 的 bot：这台电脑上还没有 bot。`,
      `There is no bot named "${name}": there are no bots on this computer yet.`,
      `No hay ningún bot llamado "${name}": todavía no hay bots en este equipo.`,
      `Não há nenhum bot chamado "${name}": ainda não há bots neste computador.`,
    );
  return tr(
    `没有叫 "${name}" 的 bot。这台电脑上的 bot：${names.join('、')}（yomi relay --list）。`,
    `There is no bot named "${name}". The bots on this computer: ${names.join(', ')} (yomi relay --list).`,
    `No hay ningún bot llamado "${name}". Los bots de este equipo: ${names.join(', ')} (yomi relay --list).`,
    `Não há nenhum bot chamado "${name}". Os bots deste computador: ${names.join(', ')} (yomi relay --list).`,
  );
}

/** `--bot NAME` with a channel flag naming another channel than the bot's. */
function otherChannel(record: BotRecord, kind: ChannelKind): string {
  const its = channelSetup(record.kind).displayName;
  const given = channelSetup(kind).displayName;
  return tr(
    `"${record.name}" 是${inChinese(its)}的 bot，不是${inChinese(given)}的。`,
    `"${record.name}" is a ${its} bot, not ${given}.`,
    `"${record.name}" es un bot de ${its}, no de ${given}.`,
    `"${record.name}" é um bot do ${its}, não do ${given}.`,
  );
}

/**
 * `yomi relay --bot NAME --character ID`: binds the bot to another character, on this computer
 * only (design §1.3), with no relay running (`whileStopped`: a background service is stopped for
 * it and started again, a relay in a terminal refuses it), and never to a character another bot
 * has (`DuplicateCharacter`, checked again in the registry's commit). Its owner, budget, records
 * and cursor stay; its owner is welcomed with the new character before the answer to their next
 * message (the relay finds the change at its start).
 */
export async function relayRebind(
  context: Context,
  options: { bot: string; characterId: string; channel: ChannelKind | null },
) {
  const { io } = context;
  const registry = openRegistry(context);
  const record = registry.find(options.bot);
  if (!record) throw new UsageError(unknownBot(options.bot, registry));
  if (options.channel && options.channel !== record.kind)
    throw new UsageError(otherChannel(record, options.channel));
  const npcId = characterIdOf(options.characterId);
  if (!npcId) throw new UsageError(characterBad(options.characterId, ''));
  if (record.character?.npcId === npcId)
    return void say(
      io,
      tr(
        `bot ${record.name} 已经绑定${nameAndId(record.character)}，没有改动。`,
        `The bot ${record.name} is bound to ${nameAndId(record.character)} already: nothing changed.`,
        `El bot ${record.name} ya está vinculado a ${nameAndId(record.character)}: no se cambió nada.`,
        `O bot ${record.name} já está vinculado a ${nameAndId(record.character)}: nada mudou.`,
      ),
    );
  const holder = registry.byCharacter(npcId);
  if (holder) throw new DuplicateCharacter(npcId, holder.name);
  const flag = `--bot ${record.name} --character`;
  requireSignIn(context);
  const character = await characterFor(context, npcId);
  // Never under a running relay of this bot: it would go on as the old character.
  await whileStopped(context, flag, record.kind, async () => {
    const lock = botLocked(record, flag);
    try {
      const bound = registry.rebind(record.key, character);
      say(
        io,
        tr(
          `已把 bot ${bound.name} 换绑到${nameAndId(character)}，下次启动 relay 时生效。`,
          `Bound the bot ${bound.name} to ${nameAndId(character)}; it takes effect when the relay starts next.`,
          `Se vinculó el bot ${bound.name} a ${nameAndId(character)}; se aplica la próxima vez que se inicie el relay.`,
          `O bot ${bound.name} foi vinculado a ${nameAndId(character)}; vale a partir da próxima vez que o relay iniciar.`,
        ),
      );
      const path = relayStatePath(context.account, bound.scope);
      const state = existsSync(path)
        ? new RelayState(path, bound.scope, context.account, bound.kind)
        : null;
      const owner = state?.data.owner;
      const welcomed = state?.data.welcomed.some(
        (item) => owner && item.owner === ownerKey(owner.userId) && item.npcId === npcId,
      );
      if (owner && !welcomed)
        say(
          io,
          paint(
            io,
            'dim',
            tr(
              '主人发下一条消息时，会先收到这个角色的介绍。',
              "The owner gets this character's introduction before the answer to their next message.",
              'El dueño recibe la presentación de este personaje antes de la respuesta a su próximo mensaje.',
              'O dono recebe a apresentação deste personagem antes da resposta à próxima mensagem.',
            ),
          ),
        );
    } finally {
      lock.release();
    }
  });
}

/** Flags about one channel's credentials: they need the channel named (or a bot's). */
function needsChannel(options: RelayCommandOptions): boolean {
  return (
    options.setToken || options.setApp || options.login || options.qrLink || options.tokenStdin
  );
}

function chooseChannel(): string {
  return tr(
    '选择一个通道：--channel telegram|qq|wechat（或 --telegram）',
    'Choose a channel: --channel telegram|qq|wechat (or --telegram)',
    'Elige un canal: --channel telegram|qq|wechat (o --telegram)',
    'Escolha um canal: --channel telegram|qq|wechat (ou --telegram)',
  );
}

/** No bot is registered at all: how to set one up. */
function noBotsYet(): string {
  return tr(
    '这台电脑上还没有 bot：用 yomi relay --telegram --set-token、yomi relay --channel qq --set-app 或 yomi relay --channel wechat --experimental --login 设置一个。',
    'No bots on this computer yet: set one up with yomi relay --telegram --set-token, yomi relay --channel qq --set-app or yomi relay --channel wechat --experimental --login.',
    'Todavía no hay bots en este equipo: configura uno con yomi relay --telegram --set-token, yomi relay --channel qq --set-app o yomi relay --channel wechat --experimental --login.',
    'Ainda não há bots neste computador: configure um com yomi relay --telegram --set-token, yomi relay --channel qq --set-app ou yomi relay --channel wechat --experimental --login.',
  );
}

/** A bot a run takes: a registered one, or (null) the channel's first, set up as it starts. */
type Selected = { setup: ChannelSetup; record: BotRecord | null };

/**
 * The bots a run takes (design §1.4): those named with `--bot` (their channel is their record's:
 * a channel flag naming another is refused), else the named channel's, else every registered bot.
 * A named channel without a bot yet is one to set up as it starts (its credentials asked for, as
 * before the registry).
 */
function selectBots(registry: BotRegistry, options: RelayCommandOptions): Selected[] {
  if (options.bots.length) {
    const records: BotRecord[] = [];
    for (const name of options.bots) {
      const record = registry.find(name);
      if (!record) throw new UsageError(unknownBot(name, registry));
      if (options.channel && options.channel !== record.kind)
        throw new UsageError(otherChannel(record, options.channel));
      if (!records.includes(record)) records.push(record);
    }
    return records.map((record) => ({ setup: channelSetup(record.kind), record }));
  }
  const kind = options.channel;
  const records = registry.list(kind ?? undefined);
  if (!records.length && kind) return [{ setup: channelSetup(kind), record: null }];
  if (!records.length) throw new UsageError(noBotsYet());
  return records.map((record) => ({ setup: channelSetup(record.kind), record }));
}

/** No system keychain, and `--allow-file-store` not given: refused. */
function fileStoreRefusal(setup: ChannelSetup): string {
  return tr(
    `这台机器没有可用的系统钥匙串，relay 默认不启动（${setup.secretLabel} 和会话会以明文文件保存）。确认接受时加 --allow-file-store。`,
    `This machine has no system keychain available, so relay does not start by default (the ${setup.secretLabel} and session would be saved in plain-text files). To accept that, add --allow-file-store.`,
    `Este equipo no tiene un llavero del sistema disponible, así que relay no se inicia de forma predeterminada (el ${setup.secretLabel} y la sesión se guardarían en archivos de texto sin cifrar). Para aceptarlo, agrega --allow-file-store.`,
    `Esta máquina não tem um Keychain do sistema disponível, então o relay não inicia por padrão (o ${setup.secretLabel} e a sessão seriam salvos em arquivos de texto sem criptografia). Para aceitar isso, adicione --allow-file-store.`,
  );
}

export async function relay(context: Context, options: RelayCommandOptions) {
  const { io, store } = context;
  if (options.all && !options.forget)
    throw new UsageError(
      tr(
        '--all 只和 --forget 一起用：yomi relay --forget --all',
        '--all only goes with --forget: yomi relay --forget --all',
        '--all solo se usa con --forget: yomi relay --forget --all',
        '--all só é usado com --forget: yomi relay --forget --all',
      ),
    );
  // Taking things away works without a keychain too.
  if (options.forget) return relayForget(context, options);
  if (!options.channel && !options.bots.length && needsChannel(options))
    throw new UsageError(chooseChannel());
  if (options.setToken || options.setApp || options.login)
    return relayCredentials(context, options);
  const problem = channelFlagProblem(options);
  if (problem) throw new UsageError(problem);
  // The one background service runs every bot: a channel named takes nothing away from it.
  if (options.uninstallService) return relayUninstall(context);
  if (options.serviceStatus) return relayServiceStatus(context);
  if (options.installService) return installRelayService(context, options);
  const registry = openRegistry(context);
  // Nobody at the terminal (a background service whose last bot was taken away): nothing to run
  // is no failure, or the service would be started again and again.
  if (!options.channel && !options.bots.length && !registry.list().length && !io.interactive)
    return void warn(io, noBotsYet());
  let selected = selectBots(registry, options);
  const setup = selected[0].setup;
  // The channel is the bots' own when none is named: --pair needs one that pairs with a code.
  if (options.pair && selected.every((item) => item.setup.kind === 'wechat'))
    throw new UsageError(wechatNoPairing());
  if (store.kind === 'file' && !options.allowFileStore)
    throw new UsageError(fileStoreRefusal(setup));

  const credential = requireSignIn(context);
  const names = [...new Set(selected.map((item) => item.setup.displayName))];
  const name = names.join(tr('、', ', ', ', ', ', '));
  if (
    !(await confirmProduction(
      context,
      tr(
        `把${inChinese(name)}私聊转给角色（会使用真实账号的免费额度和钻石）`,
        `forward ${name} private chats to a character (uses the real account's free messages and gems)`,
        `reenviar los chats privados de ${name} a un personaje (usa los mensajes gratis y las gemas de la cuenta real)`,
        `encaminhar os chats privados do ${name} para um personagem (usa as mensagens grátis e as gemas da conta real)`,
      ),
      options.confirmProd,
    ))
  )
    return;
  // A channel named without a bot yet: its bot is set up first, as before the registry, when
  // someone can type its credentials (WeChat's owner is whoever signs in with --login).
  const first = selected[0];
  if (!first.record) {
    if (setup.kind === 'wechat' || !(io.interactive || options.tokenStdin))
      return void warn(io, setup.missingCredentials());
    // With the background service running, a run is not a change: the bot is added (the service
    // stopped meanwhile, said), and the command to pair it said (`--bot NAME --pair`).
    if (serviceHolding(context))
      return relayCredentials(context, {
        ...options,
        setToken: setup.kind === 'telegram',
        setApp: setup.kind === 'qq',
      });
    const refusal = addProblem(registry, setup.kind, '');
    if (refusal) throw refusal;
    const record = await whileStopped(context, setup.credentialsFlag, setup.kind, () =>
      credentialsFlow(
        context,
        registry,
        { setup, renew: null, name: '', character: null, atStart: true },
        options,
      ),
    );
    if (!record) return;
    selected = [{ setup, record }];
  }
  const records = selected.map((item) => ({ setup: item.setup, record: item.record! }));
  // --pair with the background service running: it is stopped while the owner pairs here, and
  // started again once they did (or this run ended). The run spends under the service's cap.
  if (options.pair && serviceHolding(context)) {
    const cap = pairingCap(context, options);
    let restarted: ServicePlan | null = null;
    await withSetupLock(context, changeNote('--pair'), () =>
      withServiceStopped(context, (stopped) => {
        restarted = stopped;
        return relayRun(
          context,
          registry,
          records,
          stopped ? { ...options, maxSpend: cap, resetSpend: false } : options,
          credential,
          Boolean(stopped),
        );
      }),
    );
    return legacyRestarted(context, restarted);
  }
  return relayRun(context, registry, records, options, credential, false);
}

/**
 * The cap a pairing run spends under while the background service is stopped for it: the one the
 * service runs with, as the shared ledger has it (a run with another would start the running
 * total over twice, once now and once when the service starts again, and the cap could be
 * spent twice). A different `--max-spend`, or `--reset-spend`, typed with `--pair` is refused: it
 * is the service's to change (`--install-service`).
 */
function pairingCap(context: Context, options: RelayCommandOptions): number | null {
  const cap = LedgerFileStore.open(context.account).allowance().maxSpend;
  const typed = options.maxSpend !== null && options.maxSpend !== cap;
  if (typed || options.resetSpend) {
    const flag = typed ? `--max-spend ${options.maxSpend}` : '--reset-spend';
    const now = cap === null ? tr('没有上限', 'no cap', 'sin límite', 'sem limite') : String(cap);
    throw new UsageError(
      tr(
        `后台服务在运行，配对时用它的花费上限（${now}）：去掉 ${flag} 再 --pair；要改上限，加上它重新 --install-service。`,
        `The background service is running, and a pairing spends under its cap (${now}): --pair without ${flag}; to change the cap, run --install-service again with it.`,
        `El servicio en segundo plano está en ejecución, y una vinculación gasta bajo su límite (${now}): usa --pair sin ${flag}; para cambiar el límite, vuelve a ejecutar --install-service con él.`,
        `O serviço em segundo plano está em execução, e um pareamento gasta sob o limite dele (${now}): use --pair sem ${flag}; para mudar o limite, execute --install-service de novo com ele.`,
      ),
    );
  }
  return cap;
}

/** What credentials flags with the bots named ask for (design §1.1): a bot to add or to renew. */
type CredentialsIntent = { setup: ChannelSetup; renew: BotRecord | null; name: string };

/**
 * `--set-token`, `--set-app` or `--login` (design §1.1): `--bot NAME` of a registered bot sets
 * that bot's again (its channel is its record's; it takes no --character); `--bot <a new name>` or
 * `--character` adds a bot of the channel named; with neither they renew the channel's one bot,
 * add an unbound one when it has none, and ask which when it has several.
 */
function credentialsIntent(registry: BotRegistry, options: RelayCommandOptions): CredentialsIntent {
  if (options.bots.length > 1)
    throw new UsageError(
      tr(
        '一次只能设置一个 bot 的凭证：--bot 名字',
        'Set the credentials of one bot at a time: --bot NAME',
        'Configura las credenciales de un bot a la vez: --bot NOMBRE',
        'Configure as credenciais de um bot de cada vez: --bot NOME',
      ),
    );
  const named = options.bots[0] ?? '';
  const record = named ? registry.find(named) : undefined;
  if (record) {
    if (options.channel && options.channel !== record.kind)
      throw new UsageError(otherChannel(record, options.channel));
    if (options.characterId)
      throw new UsageError(
        tr(
          `bot ${record.name} 已经登记了：重新设置凭证时不能加 --character。要换角色：${bindCommand(record.name)}`,
          `The bot ${record.name} is registered already: setting its credentials again takes no --character. To change its character: ${bindCommand(record.name)}`,
          `El bot ${record.name} ya está registrado: volver a configurar sus credenciales no lleva --character. Para cambiar su personaje: ${bindCommand(record.name)}`,
          `O bot ${record.name} já está registrado: configurar as credenciais de novo não leva --character. Para trocar o personagem: ${bindCommand(record.name)}`,
        ),
      );
    return { setup: channelSetup(record.kind), renew: record, name: '' };
  }
  if (!options.channel) throw new UsageError(chooseChannel());
  const setup = channelSetup(options.channel);
  if (named || options.characterId) return { setup, renew: null, name: named };
  const bots = registry.list(setup.kind);
  if (bots.length <= 1) return { setup, renew: bots[0] ?? null, name: '' };
  const names = bots.map((item) => item.name).join(tr('、', ', ', ', ', ', '));
  const again = `yomi relay --bot NAME ${setup.credentialsFlag}`;
  const add = `${setup.command} ${setup.credentialsFlag} --character ID`;
  throw new UsageError(
    tr(
      `${inChinese(setup.displayName)}有多个 bot（${names}）：重新设置其中一个的凭证用 ${again.replace('NAME', '名字')}，添加新的 bot 用 ${add}。`,
      `${setup.displayName} has several bots (${names}): to set one's credentials again, run ${again}; to add a bot, run ${add}.`,
      `${setup.displayName} tiene varios bots (${names}): para volver a configurar las credenciales de uno, ejecuta ${again.replace('NAME', 'NOMBRE')}; para agregar un bot, ejecuta ${add}.`,
      `O ${setup.displayName} tem vários bots (${names}): para configurar de novo as credenciais de um, execute ${again.replace('NAME', 'NOME')}; para adicionar um bot, execute ${add}.`,
    ).trim(),
  );
}

/**
 * Sets a bot's credentials (design §1.2): which bot (`credentialsIntent`), the flags of its
 * channel (a renewed WeChat bot's consent is its record's), the keychain, the name and the count
 * of a new bot and the character it talks as (checked before anything is asked: a QR code
 * scanned or a QQ session started for a bot that could not be kept is wasted), then the setup's
 * own flow with no relay running (`whileStopped`). Says the bot added.
 */
async function relayCredentials(context: Context, options: RelayCommandOptions) {
  const { io, store } = context;
  const registry = openRegistry(context);
  const intent = credentialsIntent(registry, options);
  const { setup, renew } = intent;
  const problem = channelFlagProblem({
    ...options,
    channel: setup.kind,
    experimental: options.experimental || Boolean(renew?.experimentalAcceptedAt),
  });
  if (problem) throw new UsageError(problem);
  if (store.kind === 'file' && !options.allowFileStore)
    throw new UsageError(fileStoreRefusal(setup));
  if (!renew) {
    const refusal = addProblem(registry, setup.kind, intent.name);
    if (refusal) throw refusal;
  }
  let character: RelayCharacter | null = null;
  if (options.characterId) {
    const npcId = characterIdOf(options.characterId);
    if (!npcId) throw new UsageError(characterBad(options.characterId, ''));
    const holder = registry.byCharacter(npcId);
    if (holder) throw new DuplicateCharacter(npcId, holder.name);
    requireSignIn(context);
    character = await characterFor(context, npcId);
  }
  // A WeChat ClawBot this computer has already is signed in again instead (`saveAdded`).
  const known = new Set(registry.list(setup.kind).map((item) => item.key));
  const record = await whileStopped(context, setup.credentialsFlag, setup.kind, () =>
    credentialsFlow(context, registry, { ...intent, character, atStart: false }, options),
  );
  if (!record || renew || known.has(record.key)) return;
  say(
    io,
    record.character
      ? tr(
          `已添加 bot ${record.name}，固定和${nameAndId(record.character)}聊天。`,
          `Added the bot ${record.name}; it always chats with ${nameAndId(record.character)}.`,
          `Se agregó el bot ${record.name}; siempre chatea con ${nameAndId(record.character)}.`,
          `O bot ${record.name} foi adicionado; ele sempre conversa com ${nameAndId(record.character)}.`,
        )
      : tr(
          `已添加 bot ${record.name}，还没有绑定角色：${bindCommand(record.name)}`,
          `Added the bot ${record.name}, with no character yet: ${bindCommand(record.name)}`,
          `Se agregó el bot ${record.name}, todavía sin personaje: ${bindCommand(record.name)}`,
          `O bot ${record.name} foi adicionado, ainda sem personagem: ${bindCommand(record.name)}`,
        ),
  );
}

/** A bot to add (`renew` null) or to set again, and what goes with it. */
type CredentialsPlan = CredentialsIntent & {
  character: RelayCharacter | null;
  atStart: boolean;
};

/**
 * The setup's credential flow for `plan`, under the renewed bot's own lock: the secrets it
 * concerns, the checks as soon as the credentials name their bot, and keeping them (`saveAdded`,
 * `saveRenewed`). The record kept, else null.
 */
async function credentialsFlow(
  context: Context,
  registry: BotRegistry,
  plan: CredentialsPlan,
  options: RelayCommandOptions,
): Promise<BotRecord | null> {
  const { store } = context;
  const { setup, renew } = plan;
  const lock = renew ? botLocked(renew, setup.credentialsFlag) : null;
  try {
    registry.commit(() => false);
    const concerned = renew ? [renew] : registry.list(setup.kind);
    return await setup.setCredentials(context, {
      options,
      renew,
      stored: concerned.flatMap((record) => store.getSecret(record.secretName) ?? []),
      bots: concerned.map((record) => record.name),
      character: plan.character,
      atStart: plan.atStart,
      check: (stored) => checkCredentials(registry, setup.kind, renew, stored),
      save: (bot, state) =>
        renew
          ? saveRenewed(context, registry, renew, bot, state)
          : saveAdded(context, registry, plan, bot, state),
    });
  } finally {
    lock?.release();
  }
}

/**
 * Credentials that may not be used here (design §1.2), refused as soon as they name their bot:
 * for a renewed bot, another bot (Telegram's bot id, QQ's AppID; a WeChat ClawBot another bot
 * has); for a new one, a bot registered already (WeChat: decided when it is kept, `saveAdded`).
 */
function checkCredentials(
  registry: BotRegistry,
  kind: ChannelKind,
  renew: BotRecord | null,
  stored: StoredBot,
) {
  registry.commit(() => false);
  const twin = registry.byPlatform(kind, stored.platformId);
  if (renew) {
    if (twin && twin.key !== renew.key) throw new UsageError(alreadyRegistered(twin));
    if (kind !== 'wechat' && !sameBot(renew, stored)) throw new UsageError(anotherBot(renew));
    return;
  }
  if (twin && kind !== 'wechat') throw new UsageError(alreadyRegistered(twin));
}

/**
 * Writes a bot's secret and state for a registry change (`BotRegistry.add`, `renew`), and puts
 * them back as they were when the change fails: nothing of it stays.
 */
function changeWrites(context: Context) {
  const { store, account } = context;
  const undo: (() => void)[] = [];
  return {
    secret(name: string, value: string) {
      const before = store.getSecret(name);
      undo.push(() => {
        if (before === null) store.deleteSecret(name);
        else store.setSecret(name, before);
      });
      store.setSecret(name, value);
    },
    state(record: BotRecord, write: (state: RelayState, record: BotRecord) => void) {
      const path = relayStatePath(account, record.scope);
      const before = existsSync(path) ? readFileSync(path) : null;
      undo.push(() => {
        if (before === null) rmSync(path, { force: true });
        else writeFileSync(path, before, { mode: 0o600 });
      });
      write(new RelayState(path, record.scope, account, record.kind), record);
    },
    undo() {
      for (const step of undo.splice(0).reverse()) step();
    },
  };
}

/**
 * The WeChat bot here that the scanner of `bot` owns (`AcquiredBot.owner`): one WeChat account has
 * one ClawBot, so a new login of theirs is that bot's even under another ClawBot id, whether its
 * saved login expired or is gone. Its state's owner is the scanner of its last login.
 */
function scannersBot(
  context: Context,
  registry: BotRegistry,
  bot: AcquiredBot,
): BotRecord | undefined {
  const { owner } = bot;
  if (!owner) return undefined;
  return registry
    .list('wechat')
    .find((record) => String(stateOf(context, record)?.data.owner?.userId ?? '') === owner);
}

/**
 * Keeps a new bot (design §1.2): its secret, its state (`state`) and its record, all or nothing
 * (`BotRegistry.add` checks names, characters and platform ids again under its lock). A WeChat
 * ClawBot this computer has already (WeChat confirmed it anew, by its id or its scanner's: one
 * WeChat account has one ClawBot) is signed in again instead, said, with how to change its
 * character.
 */
function saveAdded(
  context: Context,
  registry: BotRegistry,
  plan: CredentialsPlan,
  bot: AcquiredBot,
  state?: (state: RelayState, record: BotRecord) => void,
): BotRecord {
  const { setup } = plan;
  registry.commit(() => false);
  const twin =
    registry.byPlatform(setup.kind, bot.stored.platformId) ??
    (setup.kind === 'wechat' ? scannersBot(context, registry, bot) : undefined);
  if (twin && setup.kind === 'wechat') {
    const rebind = bindCommand(twin.name, plan.character?.npcId);
    if (plan.character || plan.name)
      warn(
        context.io,
        tr(
          `这个 ClawBot 已经是 bot ${twin.name}（一个微信号只有一个 ClawBot）：重新登录了它，没有添加新的 bot（--character 和 --bot 没有生效）。要和别的角色聊天，给它换绑角色：${rebind}`,
          `This ClawBot is the bot ${twin.name} already (one WeChat account has one ClawBot): it was signed in again, and no bot was added (--character and --bot did not apply). To chat with another character, rebind it: ${rebind}`,
          `Este ClawBot ya es el bot ${twin.name} (una cuenta de WeChat tiene un solo ClawBot): se volvió a iniciar su sesión y no se agregó ningún bot (--character y --bot no se aplicaron). Para chatear con otro personaje, cambia su personaje: ${rebind}`,
          `Este ClawBot já é o bot ${twin.name} (uma conta do WeChat tem um só ClawBot): o login dele foi feito de novo e nenhum bot foi adicionado (--character e --bot não foram aplicados). Para conversar com outro personagem, troque o personagem dele: ${rebind}`,
        ),
      );
    return saveRenewed(context, registry, twin, bot, state);
  }
  const writes = changeWrites(context);
  try {
    return registry.add(
      {
        kind: setup.kind,
        stored: bot.stored,
        ...(bot.identity ? { label: setup.label(bot.identity), handle: bot.identity.handle } : {}),
        ...(plan.name ? { name: plan.name } : {}),
        character: plan.character,
      },
      (record) => {
        writes.secret(record.secretName, bot.secret);
        if (state) writes.state(record, state);
      },
    );
  } catch (error) {
    writes.undo();
    throw error;
  }
}

/** Keeps a bot's new credentials (design §1.2, renew), all or nothing, as `saveAdded` does. */
function saveRenewed(
  context: Context,
  registry: BotRegistry,
  record: BotRecord,
  bot: AcquiredBot,
  state?: (state: RelayState, record: BotRecord) => void,
): BotRecord {
  const setup = channelSetup(record.kind);
  const writes = changeWrites(context);
  try {
    return registry.renew(
      record.key,
      {
        stored: bot.stored,
        ...(bot.identity ? { label: setup.label(bot.identity), handle: bot.identity.handle } : {}),
      },
      (current) => {
        writes.secret(current.secretName, bot.secret);
        if (state) writes.state(current, state);
      },
    );
  } catch (error) {
    writes.undo();
    throw error;
  }
}

/** A bot's channel opened and checked, with its record and state. */
type OpenedBot = {
  setup: ChannelSetup;
  channel: RelayChannel;
  identity: BotIdentity;
  record: BotRecord;
  /** The stored credentials are another bot's than the record's. */
  otherBot: boolean;
  state: RelayState;
};

/**
 * Opens the channel of a registered bot from its stored credentials (never asking for any) and
 * checks them with the platform. Credentials set by another command while this started are run
 * only when they are still this bot's; ones of another bot are marked (`otherBot`), never run as
 * this one. null after a warning: nothing to run (a service ends without failing). `several`: one
 * bot of several, whose failure is said and leaves the others running. A wait the platform asks
 * for (QQ's "too many requests") is not waited out here, before any lock, one bot after another:
 * the bot's own run does that under its locks and signal, while the others start.
 */
async function openBot(
  context: Context,
  setup: ChannelSetup,
  record: BotRecord,
  options: RelayCommandOptions,
  several: boolean,
): Promise<OpenedBot | null> {
  const { io, store } = context;
  try {
    const before = store.getSecret(record.secretName);
    const channel = await setup.open(context, record, options);
    if (!channel) return null;
    let identity: BotIdentity;
    try {
      identity = await setup.verify(channel);
    } catch (error) {
      if (!io.interactive && error instanceof UsageError) {
        warn(io, several ? `[${record.name}] ${error.message}` : error.message);
        return null;
      }
      throw error;
    }
    const saved = store.getSecret(record.secretName);
    const stored = saved ? setup.storedBot(saved) : null;
    const own = !stored || sameBot(record, stored);
    // Set by something else while this started, to another bot's: not the ones opened, run again.
    if (saved !== before && !own) throw new UsageError(credentialsChanged(setup));
    const state = new RelayState(
      relayStatePath(context.account, record.scope),
      record.scope,
      context.account,
      record.kind,
    );
    return { setup, channel, identity, record, otherBot: !own, state };
  } catch (error) {
    if (!several) throw error;
    warn(io, `[${record.name}] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** `--install-service --channel K --character X` with no bot of K: what adds one bound to X. */
function noBotToBind(setup: ChannelSetup, input: string): string {
  const add = `${setup.command} ${setup.credentialsFlag} --character ${input}`;
  return tr(
    `这台电脑上还没有${inChinese(setup.displayName)}的 bot，--character ${input} 没有可以绑定的 bot，所以没有安装后台服务。添加一个绑定这个角色的 bot：${add}`,
    `There is no ${setup.displayName} bot on this computer, so --character ${input} has no bot to bind and the background service was not installed. To add one bound to this character: ${add}`,
    `No hay ningún bot de ${setup.displayName} en este equipo, así que --character ${input} no tiene ningún bot que vincular y no se instaló el servicio en segundo plano. Para agregar uno vinculado a este personaje: ${add}`,
    `Não há nenhum bot do ${setup.displayName} neste computador, então --character ${input} não tem nenhum bot para vincular e o serviço em segundo plano não foi instalado. Para adicionar um vinculado a este personagem: ${add}`,
  );
}

/** `--install-service --character` among several bots: which one it is for is not said. */
function characterForSeveral(input: string): string {
  return tr(
    `这里有多个 bot：--character ${input} 不知道给哪一个，已忽略。给一个 bot 绑定角色：yomi relay --bot 名字 --character ID`,
    `There are several bots here, so --character ${input} is for none of them and is ignored. To bind a bot to a character: yomi relay --bot NAME --character ID`,
    `Aquí hay varios bots, así que --character ${input} no es para ninguno y se ignora. Para vincular un bot a un personaje: yomi relay --bot NOMBRE --character ID`,
    `Há vários bots aqui, então --character ${input} não é para nenhum deles e foi ignorado. Para vincular um bot a um personagem: yomi relay --bot NOME --character ID`,
  );
}

/** `--install-service` with no bot registered: nothing for a service to run. */
function nothingToServe(): string {
  return tr(
    '这台电脑上还没有 bot，后台服务没有可运行的：先添加一个（yomi relay --telegram --set-token、yomi relay --channel qq --set-app 或 yomi relay --channel wechat --experimental --login，加上 --character ID），再安装后台服务。',
    'There are no bots on this computer yet, so a background service would have nothing to run: add one first (yomi relay --telegram --set-token, yomi relay --channel qq --set-app or yomi relay --channel wechat --experimental --login, with --character ID), then install the service.',
    'Todavía no hay bots en este equipo, así que un servicio en segundo plano no tendría nada que ejecutar: agrega uno primero (yomi relay --telegram --set-token, yomi relay --channel qq --set-app o yomi relay --channel wechat --experimental --login, con --character ID) y luego instala el servicio.',
    'Ainda não há bots neste computador, então um serviço em segundo plano não teria nada para executar: adicione um primeiro (yomi relay --telegram --set-token, yomi relay --channel qq --set-app ou yomi relay --channel wechat --experimental --login, com --character ID) e depois instale o serviço.',
  );
}

/**
 * `--install-service`'s `--character` (design §1.4, as at a run's start): the bot it binds, the
 * one of the channel named (or of the computer) when that one has no character yet; null after a
 * warning when it is for no bot (several, or one bound to another character, which stays). A
 * character another bot has, or a channel named that has no bot, is refused before anything is
 * installed.
 */
function characterToBind(
  context: Context,
  registry: BotRegistry,
  options: RelayCommandOptions,
): BotRecord | null {
  const input = options.characterId;
  const npcId = characterIdOf(input);
  if (!npcId) throw new UsageError(characterBad(input, ''));
  const records = registry.list(options.channel ?? undefined);
  // None only of a channel named: a computer without bots was refused before.
  if (!records.length && options.channel)
    throw new UsageError(noBotToBind(channelSetup(options.channel), input));
  if (records.length !== 1) {
    warn(context.io, characterForSeveral(input));
    return null;
  }
  const [record] = records;
  if (record.character) {
    if (record.character.npcId !== npcId)
      warn(context.io, characterIgnored(record, record.character, input));
    return null;
  }
  const holder = registry.byCharacter(npcId);
  if (holder) throw new DuplicateCharacter(npcId, holder.name);
  return record;
}

/**
 * `yomi relay --install-service` (design §1.5): one background service for every registered bot
 * of this Yomi account and environment, with the run's own arguments only (`relayServiceArgs`).
 * Each bot is checked on this computer first: one that could not run in it (no credentials or
 * another bot's, nobody paired, a WeChat bot nobody signed in) is said with what to run, and so
 * is one without a character; with none that could run, nothing is installed. `--character`
 * binds the bot it is for now (`characterToBind`). Then, under the setup lock and with no relay
 * running in a terminal: the hub's unit is written, the per-channel units of before it are
 * removed (said), a service that still holds the environment's lock is waited for (one that does
 * not let go leaves the hub's unit written, not loaded: said), and the hub's unit is loaded (a
 * running one is started again: the arguments typed now apply, the cap too).
 */
async function installRelayService(context: Context, options: RelayCommandOptions) {
  const { io, store } = context;
  const registry = openRegistry(context);
  const bots = registry.list();
  if (!bots.length) throw new UsageError(nothingToServe());
  if (store.kind === 'file' && !options.allowFileStore)
    throw new UsageError(fileStoreRefusal(channelSetup(options.channel ?? bots[0].kind)));
  requireSignIn(context);
  const unbound = options.characterId ? characterToBind(context, registry, options) : null;
  const checked = bots.map((record) => ({
    record,
    ...offlineStatus(context, record, stateOf(context, record)),
  }));
  for (const { record, text, runs } of checked)
    if (!runs)
      warn(
        io,
        tr(
          `bot ${record.name} 还不能在后台服务里运行：${text}`,
          `The bot ${record.name} cannot run in the background service yet: ${text}`,
          `El bot ${record.name} todavía no puede ejecutarse en el servicio en segundo plano: ${text}`,
          `O bot ${record.name} ainda não pode ser executado no serviço em segundo plano: ${text}`,
        ),
      );
  if (!checked.some((item) => item.runs))
    throw new UsageError(
      tr(
        '这些 bot 都还不能在后台服务里运行（见上面），所以没有安装后台服务。',
        'None of these bots can run in a background service yet (see above), so it was not installed.',
        'Ninguno de estos bots puede ejecutarse todavía en un servicio en segundo plano (ver arriba), así que no se instaló.',
        'Nenhum destes bots pode ser executado ainda em um serviço em segundo plano (veja acima), então ele não foi instalado.',
      ),
    );
  const names = [...new Set(bots.map((record) => channelSetup(record.kind).displayName))];
  const name = names.join(tr('、', ', ', ', ', ', '));
  if (
    !(await confirmProduction(
      context,
      tr(
        `把${inChinese(name)}私聊转给角色（会使用真实账号的免费额度和钻石）`,
        `forward ${name} private chats to a character (uses the real account's free messages and gems)`,
        `reenviar los chats privados de ${name} a un personaje (usa los mensajes gratis y las gemas de la cuenta real)`,
        `encaminhar os chats privados do ${name} para um personagem (usa as mensagens grátis e as gemas da conta real)`,
      ),
      options.confirmProd,
    ))
  )
    return;
  const character = unbound ? await characterFor(context, options.characterId) : null;
  const plan = hubPlan(context, options);
  if (/[\\/](_npx|\.npm|tmp|temp)[\\/]/i.test(plan.content))
    warn(
      io,
      tr(
        '当前 yomi 像是从临时目录运行的（npx 或缓存），后台服务可能在缓存清理后失效：建议全局安装后再装服务。',
        'This yomi seems to run from a temporary directory (npx or a cache), so the background service may break when the cache is cleaned: install yomi globally before installing the service.',
        'Este yomi parece ejecutarse desde un directorio temporal (npx o una caché), así que el servicio en segundo plano podría dejar de funcionar cuando se limpie la caché: instala yomi de forma global antes de instalar el servicio.',
        'Este yomi parece estar sendo executado de um diretório temporário (npx ou um cache), então o serviço em segundo plano pode parar de funcionar quando o cache for limpo: instale o yomi globalmente antes de instalar o serviço.',
      ),
    );
  const flag = '--install-service';
  await withSetupLock(context, changeNote(flag), async () => {
    const holder = lockHolder(environmentLock(context));
    const running = holder ? serviceRunningAs(context, holder.pid) : null;
    if (holder && !running) {
      const held = holderOf({ heldBy: holder.pid, note: holder.note });
      throw new UsageError(held.flag ? credentialsRunning(held, flag) : runningRefusal(held, flag));
    }
    if (unbound && character) {
      const bound = registry.rebind(unbound.key, character);
      say(
        io,
        tr(
          `已把 bot ${bound.name} 绑定到${nameAndId(character)}。`,
          `Bound the bot ${bound.name} to ${nameAndId(character)}.`,
          `Se vinculó el bot ${bound.name} a ${nameAndId(character)}.`,
          `O bot ${bound.name} foi vinculado a ${nameAndId(character)}.`,
        ),
      );
    }
    for (const { record } of checked) {
      const current = registry.find(record.name);
      if (current && !current.character) warn(io, needsCharacter(current));
    }
    ensurePrivateDir(join(configDir(), 'logs'));
    // The new unit first: should anything fail after, the units of before are not all that is left.
    writeServiceUnit(plan);
    for (const kind of CHANNEL_KINDS) removeLegacyService(context, kind);
    // The service running lets go of the environment's lock as it ends (one of before, removed
    // above, or the hub's own, stopped here and loaded again below).
    if (holder && running) {
      if (running.path === plan.path) pauseService(plan);
      if (!(await environmentLetGo(context, holder.pid)))
        throw new UsageError(
          tr(
            `后台服务（${running.label}）${SERVICE_STOP_MS / 1000} 秒内没有停下来，所以新的后台服务写好了但没有启动：稍后再运行一次这个命令。`,
            `The background service (${running.label}) did not stop within ${SERVICE_STOP_MS / 1000} s, so the new one was written but not started: run this command again later.`,
            `El servicio en segundo plano (${running.label}) no se detuvo en ${SERVICE_STOP_MS / 1000} s, así que el nuevo quedó escrito pero no se inició: vuelve a ejecutar este comando más tarde.`,
            `O serviço em segundo plano (${running.label}) não parou em ${SERVICE_STOP_MS / 1000} s, então o novo foi escrito mas não iniciado: execute este comando de novo mais tarde.`,
          ),
        );
    }
    installService(plan);
  });
  say(
    io,
    tr(
      `已安装并启动后台服务：${plan.path}`,
      `Installed and started the background service: ${plan.path}`,
      `Se instaló e inició el servicio en segundo plano: ${plan.path}`,
      `Serviço em segundo plano instalado e iniciado: ${plan.path}`,
    ),
  );
  const all = registry.list().map((record) => record.name);
  say(
    io,
    tr(
      `它在一个进程里运行这台电脑上的全部 bot（${all.length} 个）：${all.join('、')}。`,
      `It runs every bot on this computer in one process (${all.length}): ${all.join(', ')}.`,
      `Ejecuta todos los bots de este equipo en un solo proceso (${all.length}): ${all.join(', ')}.`,
      `Ele executa todos os bots deste computador em um só processo (${all.length}): ${all.join(', ')}.`,
    ),
  );
  say(io, capLine(options.maxSpend, true));
  say(
    io,
    paint(
      io,
      'dim',
      tr(
        `日志：${plan.log}；停止并删除：${UNINSTALL}`,
        `Log: ${plan.log}; to stop and remove: ${UNINSTALL}`,
        `Registro: ${plan.log}; para detenerlo y eliminarlo: ${UNINSTALL}`,
        `Log: ${plan.log}; para parar e remover: ${UNINSTALL}`,
      ),
    ),
  );
  if (plan.platform === 'linux')
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '退出登录后也要运行：loginctl enable-linger（需要时）。',
          'To keep it running after you log out: loginctl enable-linger (if needed).',
          'Para que siga en ejecución después de cerrar sesión: loginctl enable-linger (si hace falta).',
          'Para mantê-lo em execução depois de sair da sessão: loginctl enable-linger (se necessário).',
        ),
      ),
    );
}

/** Another relay holds this bot's own lock. */
function botRunning(pid: number): string {
  return tr(
    `这个 bot 已经有一个 relay 在运行${pid ? `（进程 ${pid}）` : ''}。同一个 bot 只能运行一个。`,
    `A relay is already running for this bot${pid ? ` (process ${pid})` : ''}. Only one can run per bot.`,
    `Ya hay un relay en ejecución para este bot${pid ? ` (proceso ${pid})` : ''}. Solo puede ejecutarse uno por bot.`,
    `Já existe um relay em execução para este bot${pid ? ` (processo ${pid})` : ''}. Só é possível executar um por bot.`,
  );
}

/** `--pair` among several bots that pair with a code: which one is not said. */
function pairWhich(names: string[]): string {
  return tr(
    `有多个 bot 可以配对（${names.join('、')}）：用 --bot 名字 --pair 选一个。`,
    `Several bots can pair (${names.join(', ')}): choose one with --bot NAME --pair.`,
    `Hay varios bots que se pueden vincular (${names.join(', ')}): elige uno con --bot NOMBRE --pair.`,
    `Há vários bots que podem ser pareados (${names.join(', ')}): escolha um com --bot NOME --pair.`,
  );
}

/** A run's `--character` among several bots: which bot it is for is not said. */
function characterForWhich(input: string): string {
  return tr(
    `这次运行了多个 bot：忽略 --character ${input}。给一个 bot 绑定角色：yomi relay --bot 名字 --character ID`,
    `This run has several bots: --character ${input} is ignored. To bind a bot to a character: yomi relay --bot NAME --character ID`,
    `Esta ejecución tiene varios bots: se ignora --character ${input}. Para vincular un bot a un personaje: yomi relay --bot NOMBRE --character ID`,
    `Esta execução tem vários bots: --character ${input} foi ignorado. Para vincular um bot a um personagem: yomi relay --bot NOME --character ID`,
  );
}

/** A bot ready to run: opened, locked, its owner and character settled. */
type ReadyBot = OpenedBot & { pairing: PairingCode | null };

/**
 * Runs the selected bots in this one process (`RelayHub`, design §1.4, §2): each opened and
 * checked as a single relay always was, each under its own lock and all under the environment's,
 * then supervised side by side so one that stops leaves the others running. The terminal says
 * each bot's start (and the units of before the hub still installed: `legacyLine`) and stop; the
 * end is "Relay stopped." when it was stopped (Ctrl+C), and nothing more when every bot stopped on
 * its own (each said why). `untilPaired`: the run ends once an owner paired (the background
 * service stopped for it starts again).
 */
async function relayRun(
  context: Context,
  registry: BotRegistry,
  selected: { setup: ChannelSetup; record: BotRecord }[],
  options: RelayCommandOptions,
  credential: Credential,
  untilPaired: boolean,
) {
  const { io } = context;
  const several = selected.length > 1;
  // --pair: one bot that pairs with a code, named when several selected could (whichever open).
  const pairs = options.pair ? selected.filter(({ setup }) => setup.kind !== 'wechat') : [];
  if (pairs.length > 1) throw new UsageError(pairWhich(pairs.map(({ record }) => record.name)));
  const opened: OpenedBot[] = [];
  for (const { setup, record } of selected) {
    const bot = await openBot(context, setup, record, options, several);
    if (bot) opened.push(bot);
  }
  if (!opened.length) return;

  const locks: { release: () => void }[] = [];
  const releaseAll = () => {
    for (const lock of locks.splice(0).reverse()) lock.release();
  };
  const locked: OpenedBot[] = [];
  for (const bot of opened) {
    const lock = acquireProcessLock(lockPath(bot.record.lockName));
    if ('heldBy' in lock) {
      if (opened.length === 1) throw new UsageError(botRunning(lock.heldBy));
      warn(io, `${bot.record.name}: ${botRunning(lock.heldBy)}`);
      continue;
    }
    locks.push(lock);
    locked.push(bot);
  }
  if (!locked.length) return;
  try {
    locks.push(
      lockEnvironment(context, hubNote(locked), (holder) =>
        holder.flag ? credentialsRunning(holder, '') : anotherRelayRunning(holder, context.env),
      ),
    );
  } catch (error) {
    releaseAll();
    throw error;
  }
  try {
    const log = (line: string) => io.stderr.write(`${new Date().toISOString()} ${line}\n`);
    // A run's --character is for its one bot: counted among the bots selected, not those that
    // happened to open.
    if (options.characterId && several) warn(io, characterForWhich(options.characterId));
    const ready: ReadyBot[] = [];
    for (const bot of locked) {
      const prepared = await readyBot(context, registry, bot, options, several);
      if (prepared) ready.push(prepared);
    }
    const running = ready.filter((bot) => pairingFor(context, bot, options));
    if (!running.length) return;
    for (const bot of running)
      say(
        io,
        tr(
          `relay 运行中：${bot.setup.label(bot.identity)} ⇄ Yomi ${credential.displayName || credential.userId}（${describeEnvironment(context.env)}）`,
          `Relay running: ${bot.setup.label(bot.identity)} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
          `Relay en ejecución: ${bot.setup.label(bot.identity)} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
          `Relay em execução: ${bot.setup.label(bot.identity)} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
        ),
      );
    if (running.some((bot) => bot.setup.personalUseOnly))
      say(
        io,
        paint(
          io,
          'dim',
          tr(
            '仅限个人使用：relay 只转发你本人和你自己的 bot 之间的消息。',
            'Personal use only: this relays your own messages to your own bot.',
            'Solo para uso personal: esto reenvía tus propios mensajes a tu propio bot.',
            'Somente para uso pessoal: isto repassa as suas próprias mensagens para o seu próprio bot.',
          ),
        ),
      );
    if (running.some((bot) => bot.setup.experimental))
      say(
        io,
        paint(
          io,
          'dim',
          tr(
            '实验功能：微信 ClawBot（iLink）不是给第三方客户端的官方接口。',
            'Experimental: WeChat ClawBot (iLink) is not an official API for third-party clients.',
            'Experimental: WeChat ClawBot (iLink) no es una API oficial para clientes de terceros.',
            'Experimental: o WeChat ClawBot (iLink) não é uma API oficial para clientes de terceiros.',
          ),
        ),
      );
    say(
      io,
      paint(
        io,
        'dim',
        capLine(options.maxSpend, false) +
          tr(
            'Ctrl+C 停止。',
            'Press Ctrl+C to stop.',
            'Presiona Ctrl+C para detener.',
            'Pressione Ctrl+C para parar.',
          ),
      ),
    );
    // Units of before the hub (design §4.3): each runs its own channel's bots until replaced.
    const legacy = legacyLine(context, installedPlans(context));
    if (legacy) say(io, paint(io, 'dim', legacy));
    if (untilPaired)
      say(
        io,
        paint(
          io,
          'dim',
          tr(
            '配对完成（或按 Ctrl+C）后，这次运行结束，后台服务重新启动。',
            'Once the owner paired (or on Ctrl+C) this run ends and the background service starts again.',
            'Cuando el dueño se vincule (o con Ctrl+C), esta ejecución termina y el servicio en segundo plano vuelve a iniciarse.',
            'Quando o dono parear (ou com Ctrl+C), esta execução termina e o serviço em segundo plano inicia de novo.',
          ),
        ),
      );
    await runHub(context, registry, running, options, log, untilPaired);
  } finally {
    releaseAll();
  }
}

/**
 * What the environment's lock says of the relay holding it (design §2.6): `bots`, every bot it
 * runs (JSON: channel, registry name, label), and its channel when all of them are of one (else
 * 'hub'), with the bot's label when it is the only one, as an older relay wrote: an older yomi
 * names that relay as it always did, and only by its process when it runs several channels.
 */
function hubNote(bots: OpenedBot[]): LockNote {
  const kinds = [...new Set(bots.map((bot) => bot.channel.kind))];
  return {
    channel: kinds.length === 1 ? kinds[0] : 'hub',
    ...(bots.length === 1 ? { bot: bots[0].setup.label(bots[0].identity) } : {}),
    bots: JSON.stringify(
      bots.map((bot) => ({
        kind: bot.channel.kind,
        name: bot.record.name,
        label: bot.setup.label(bot.identity),
      })),
    ),
  };
}

/**
 * Under the locks, what a bot's run needs settled first: its credentials still its own, its
 * record up to date, a run's `--character`, `--pair`. null: it does not run (said why); alone in
 * an interactive run, credentials of another bot are an error, as they always were.
 */
async function readyBot(
  context: Context,
  registry: BotRegistry,
  bot: OpenedBot,
  options: RelayCommandOptions,
  several: boolean,
): Promise<ReadyBot | null> {
  const { io, store } = context;
  const { setup, identity, state } = bot;
  // Checked under the locks, as the run itself would: a relay already running says so first.
  if (bot.otherBot) {
    if (io.interactive && !several) throw new UsageError(otherBotCredentials(setup, bot.record));
    // A service restarting would not fix it: say so and end without failing.
    warn(io, otherBotCredentials(setup, bot.record));
    return null;
  }
  let record = registry.refresh(bot.record, {
    stored: setup.storedBot(store.getSecret(bot.record.secretName) ?? '') ?? {
      platformId: identity.id,
      scope: bot.record.scope,
      lockName: bot.record.lockName,
    },
    label: setup.label(identity),
    handle: identity.handle,
  });
  registry.bindAccount(context.gateway.requireCredential().userId);
  // Its owner then had their start before the registry: never welcomed again.
  if (record.welcomeBaseline) state.welcomedBefore(record.welcomeBaseline);
  // The registry's character is the one it talks as; --character binds one only when it has none,
  // and only when this run has one bot to bind it to.
  if (options.characterId && !several)
    record = await characterAtStart(context, registry, record, options.characterId);
  if (!record.character) warn(io, needsCharacter(record));
  return { ...bot, record, pairing: null };
}

/**
 * Whether the bot can run now, and its pairing code when it has no owner: `--pair` gives its
 * owner up first (another person may pair now: their consent to spend starts over). A code is
 * shown only to someone at this terminal, never in a service log; a channel whose owner is
 * whoever signed in (WeChat) has nobody to pair here.
 */
function pairingFor(context: Context, bot: ReadyBot, options: RelayCommandOptions): boolean {
  const { io } = context;
  const { setup, channel, state, identity } = bot;
  if (options.pair && channel.caps.pairing !== 'login') state.resetOwner();
  if (state.data.owner) return true;
  if (channel.caps.pairing === 'login' || (!io.interactive && !options.pair)) {
    warn(io, setup.unpairedHint(bot.record));
    return false;
  }
  bot.pairing = new PairingCode();
  setup.printPairing?.(context, bot.pairing, identity);
  return true;
}

/** Runs the ready bots in a `RelayHub` until they stop or Ctrl+C (or, `untilPaired`, a pairing). */
async function runHub(
  context: Context,
  registry: BotRegistry,
  bots: ReadyBot[],
  options: RelayCommandOptions,
  log: (line: string) => void,
  untilPaired: boolean,
) {
  const { io } = context;
  const kinds = [...new Set(bots.map((bot) => bot.channel.kind))];
  // The long connection says which relay it is: its one kind of channel, else several.
  const gateway = context.gateway.forClient(
    kinds.length === 1 ? `relay-${kinds[0]}` : 'relay-multi',
  );
  const several = bots.length > 1;
  const said = new Set<string>();
  const alone: { error: Error | null } = { error: null };
  const hub = new RelayHub(gateway, {
    account: context.account,
    log,
    maxSpend: options.maxSpend,
    resetSpend: options.resetSpend,
    ledgerBots: registry.list(),
    onStopped: (name, error) => {
      if (!error) return;
      // One bot alone keeps its old ending: a usage problem is the command's error.
      if (!several && error instanceof UsageError) {
        alone.error = error;
        return;
      }
      // Among several, each bot's own (what to run names that bot), said once per bot.
      const line = several ? `[${name}] ${error.message}` : error.message;
      if (said.has(line)) return;
      said.add(line);
      said.add(error.message);
      warn(io, line);
    },
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let ended: 'aborted' | 'ended';
  try {
    ended = await hub.run(
      bots.map((bot) =>
        hubBot(context, registry, bot, options, several, log, untilPaired ? stop : undefined),
      ),
      controller.signal,
    );
  } catch (error) {
    // Another Yomi account: every bot stopped, said once.
    if (error instanceof RelayStopped) {
      if (!said.has(error.message)) warn(io, error.message);
      return;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  if (alone.error) throw alone.error;
  if (ended === 'aborted')
    say(io, tr('relay 已停止。', 'Relay stopped.', 'El relay se detuvo.', 'O relay parou.'));
}

/**
 * One bot of the hub: its first run on the channel and state opened for it, every later one
 * (after a crash) on its channel opened again from the stored credentials (nobody is asked for
 * any), which must still be its own, and a new state (the one before is closed: what that run
 * still had in flight is not written over this one's). `onPaired`: told once an owner paired.
 */
function hubBot(
  context: Context,
  registry: BotRegistry,
  bot: ReadyBot,
  options: RelayCommandOptions,
  several: boolean,
  log: (line: string) => void,
  onPaired?: () => void,
): HubBot {
  const { io } = context;
  const { setup, record, identity } = bot;
  let first = true;
  /** Registry writes the relay asks for: it goes on when one fails (logged), as before. */
  const write = (change: () => void) => {
    try {
      change();
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  };
  const botLog = several ? (line: string) => log(`[${record.name}] ${line}`) : log;
  return {
    name: record.name,
    run: async (services, signal) => {
      let channel = bot.channel;
      let state = bot.state;
      if (!first) {
        // Nobody to ask after a crash, even for one bot: missing credentials stop it (said).
        const again = await setup.open({ ...context, io: { ...io, interactive: false } }, record, {
          ...options,
          tokenStdin: false,
        });
        if (!again) return 'unavailable';
        const secret = context.store.getSecret(record.secretName);
        const stored = secret ? setup.storedBot(secret) : null;
        if (stored && !sameBot(record, stored))
          throw new UsageError(otherBotCredentials(setup, record));
        channel = again;
        state = new RelayState(
          relayStatePath(context.account, record.scope),
          record.scope,
          context.account,
          record.kind,
        );
      }
      first = false;
      const engine = new Relay(context.gateway.forClient(`relay-${channel.kind}`), channel, state, {
        maxSpend: options.maxSpend,
        characterId: '',
        boundCharacter: record.character,
        botName: record.name,
        characterOwners: {
          get: (npcId) => registry.shownTo(npcId),
          set: (npcId, owner) => write(() => registry.showedCharacter(npcId, owner)),
        },
        hub: services,
        pairing: state.data.owner ? null : bot.pairing,
        onPaired,
        onPairingCode: (code) => {
          say(
            io,
            paint(
              io,
              'yellow',
              tr(
                '配对码已过期，新的配对码：',
                'The pairing code expired. New pairing code:',
                'El código de vinculación expiró. Nuevo código de vinculación:',
                'O código de pareamento expirou. Novo código de pareamento:',
              ),
            ),
          );
          setup.printPairing?.(context, code, identity);
        },
        replyTimeoutMs: options.replyTimeoutMs,
        intervalMs: 1000,
        staleMs: 10 * 60 * 1000,
        pollTimeoutSeconds: 25,
        drafts: options.drafts,
        // what the relay says in the chat: the CLI's own language (zh, en, es or pt)
        language: language(),
        log: botLog,
        rerunCommand: setup.command,
        // QQ and WeChat relay in production only on a policy the server sent for them.
        requireServerPolicy: channel.kind !== 'telegram' && isProduction(context.env),
        // The bound character's name as Yomi says it now.
        onCharacter: (character) =>
          write(() => character && registry.bindCharacter(record.key, character, '')),
      });
      try {
        await engine.run(signal);
      } finally {
        state.close(() =>
          botLog(
            tr(
              '这个 bot 已停止：之后的一次状态更新没有保存',
              'This bot has stopped: a later update of its state was not saved',
              'Este bot se detuvo: una actualización posterior de su estado no se guardó',
              'Este bot parou: uma atualização posterior do estado dele não foi salva',
            ),
          ),
        );
      }
    },
  };
}

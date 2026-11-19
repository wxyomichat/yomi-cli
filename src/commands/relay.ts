import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { type CharacterProfile, ChatRefusal, characterProfile } from '../chat/api.js';
import { describeEnvironment, type Environment, isProduction, UsageError } from '../core/env.js';
import { configDir, ensurePrivateDir } from '../core/files.js';
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
import type { BotIdentity, RelayChannel } from '../relay/channels/types.js';
import { PairingCode } from '../relay/pairing.js';
import {
  type BotRecord,
  type BotRegistry,
  DuplicateCharacter,
  migrateRegistry,
} from '../relay/registry.js';
import { Relay, RelayStopped } from '../relay/relay.js';
import {
  installService,
  type ServicePlan,
  servicePlan,
  uninstallService,
  runCommand,
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
 * `yomi relay --channel telegram|qq|wechat` (`--telegram` is `--channel telegram`): the setup
 * around `Relay`, the same for every channel — which flags the channel takes, the credentials
 * (typed without echo or piped on stdin, kept in the keychain, never an argument or variable),
 * the pairing in this terminal, one relay per bot and one per Yomi account and environment (lock
 * files), the background service, and `--forget`. What differs per channel is asked of its
 * `ChannelSetup` (relay/channels/setup.ts).
 *
 * Each channel's bot is a record of the bot registry (relay/registry.ts), taken over from the
 * stored credentials before anything else and made the bot new credentials belong to when they
 * are set: a run starts only when the stored credentials are still that bot's, and `yomi relay
 * --list` shows the bots without changing them.
 *
 * A bot talks as the one character of its record. `yomi relay --bot NAME --character ID` binds it
 * to another one while it is not running (`relayRebind`); a run's `--character` binds a bot that
 * has none, and is ignored with a warning for one bound to another character (an older service's
 * arguments must not stop it). A character goes with one bot only.
 */

export type RelayCommandOptions = {
  /** The chat platform: `--channel <kind>`, or `--telegram`. */
  channel: ChannelKind;
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
  if (options.pair && kind === 'wechat')
    return tr(
      '微信没有配对码：用 --login 扫码的人就是主人。要换人，重新运行 --login。',
      'WeChat has no pairing code: whoever scans the QR code with --login is the owner. To change the owner, run --login again.',
      'WeChat no tiene código de vinculación: quien escanea el código QR con --login es el dueño. Para cambiar de dueño, vuelve a ejecutar --login.',
      'O WeChat não tem código de pareamento: quem escaneia o código QR com --login é o dono. Para trocar o dono, execute --login de novo.',
    );
  if (!options.drafts && kind !== 'telegram')
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

/**
 * The background service's arguments after the script: `relay`, the channel's own words, then
 * the same options in the same places for every channel (Telegram's ExecStart is the one it
 * always had: `relay --telegram --env … [--no-drafts] [--confirm-prod]`).
 */
export function relayServiceArgs(
  env: Environment,
  setup: ChannelSetup,
  options: RelayCommandOptions,
): string[] {
  const { lead, trail } = setup.serviceArgs(options);
  const args = ['relay', ...lead, '--env', env.name];
  if (env.lane) args.push('--lane', env.lane);
  if (options.allowFileStore) args.push('--allow-file-store');
  // Only a cap the owner chose: without one the service runs uncapped, as the foreground relay.
  if (options.maxSpend !== null) args.push('--max-spend', String(options.maxSpend));
  if (options.characterId) args.push('--character', options.characterId);
  args.push(...trail);
  // Confirmed when the service was installed; a service has nobody to ask.
  if (isProduction(env)) args.push('--confirm-prod');
  return args;
}

function planFor(context: Context, setup: ChannelSetup, options: RelayCommandOptions): ServicePlan {
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
    channel: setup.kind,
    node: process.execPath,
    script,
    args: relayServiceArgs(context.env, setup, options),
    environment,
    logDir: join(configDir(), 'logs'),
  });
}

/**
 * Who holds a relay lock: its process (0 when unknown) and, for the environment's lock, what it
 * wrote there: the channel, and the bot it relays (a relay) or the flag it runs (`--set-app`,
 * `--login`).
 */
type Holder = { pid: number; setup: ChannelSetup | null; bot: string; flag: string };

function holderOf(lock: { heldBy: number; note?: LockNote }): Holder {
  const note = lock.note ?? {};
  const kind = CHANNEL_KINDS.find((name) => name === note.channel);
  return {
    pid: lock.heldBy,
    setup: kind ? channelSetup(kind) : null,
    bot: note.bot ?? '',
    flag: note.flag ?? '',
  };
}

/** "Telegram bot @lin_bot, process 1234": what is known of a holder, '' when nothing is. */
function holderDetails(holder: Holder): string {
  const parts: string[] = [];
  const name = holder.setup?.displayName ?? '';
  if (name)
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

/** How to stop a holder's background service: its channel's command when it is known. */
const uninstallCommand = (holder: Holder) =>
  holder.setup ? `${holder.setup.command} --uninstall-service` : '--uninstall-service';

/**
 * Refuses `flag` while a relay runs: this channel's (--forget, its own lock, known by pid only),
 * or any relay of this environment (--set-app, --login), named with its channel and bot.
 */
function runningRefusal(holder: Holder, flag: string): string {
  const details = holderDetails(holder);
  const stop = uninstallCommand(holder);
  return tr(
    `relay 正在运行${details ? `（${details}）` : ''}：先停止它（Ctrl+C，或 ${stop}），再 ${flag}。`,
    `Relay is running${details ? ` (${details})` : ''}: stop it first (Ctrl+C, or ${stop}), then ${flag}.`,
    `El relay está en ejecución${details ? ` (${details})` : ''}: detenlo primero (Ctrl+C o ${stop}) y luego usa ${flag}.`,
    `O relay está em execução${details ? ` (${details})` : ''}: pare-o primeiro (Ctrl+C ou ${stop}) e depois use ${flag}.`,
  );
}

/** A relay start refused: another relay of this Yomi account and environment runs. */
function anotherRelayRunning(holder: Holder, env: Environment): string {
  const details = holderDetails(holder);
  const stop = uninstallCommand(holder);
  const where = describeEnvironment(env);
  return tr(
    `这个 Yomi 账号（${where}）已经有另一个 relay 在运行${details ? `：${details}` : ''}。同一个账号和环境同时只能运行一个 relay：先停止它（Ctrl+C，或 ${stop}）。`,
    `Another relay is already running for this Yomi account (${where})${details ? `: ${details}` : ''}. Only one relay per Yomi account and environment can run at a time: stop it first (Ctrl+C, or ${stop}).`,
    `Ya hay otro relay en ejecución para esta cuenta de Yomi (${where})${details ? `: ${details}` : ''}. Solo puede ejecutarse un relay a la vez por cuenta de Yomi y entorno: detenlo primero (Ctrl+C o ${stop}).`,
    `Já existe outro relay em execução para esta conta do Yomi (${where})${details ? `: ${details}` : ''}. Só é possível executar um relay por vez por conta do Yomi e ambiente: pare-o primeiro (Ctrl+C ou ${stop}).`,
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
 * relay holds `relay-env-<sha256(account)[0:16]>.lock` while it runs, and so do --set-app and
 * --login. Relays side by side would share the device id on the Yomi long connection, take each
 * other's offline messages, count each other's spending in balance-measured charges and each
 * spend a whole --max-spend.
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

/**
 * `--install-service` beside another channel's installed service of this environment: only one
 * of them could run (the other would fail on the environment's lock and restart every 30 s).
 */
function otherServiceRefusal(
  context: Context,
  setup: ChannelSetup,
  options: RelayCommandOptions,
): string | null {
  for (const kind of CHANNEL_KINDS) {
    if (kind === setup.kind) continue;
    const other = channelSetup(kind);
    const plan = planFor(context, other, { ...options, channel: kind });
    if (!existsSync(plan.path)) continue;
    const name = other.displayName;
    const remove = `${other.command} --uninstall-service`;
    return tr(
      `这个环境已经安装了${inChinese(name)}的 relay 后台服务（${plan.path}）。同一个账号和环境同时只能运行一个 relay：先用 ${remove} 删除它，再安装这个。`,
      `A ${name} relay service is already installed for this environment (${plan.path}). Only one relay per Yomi account and environment can run at a time: remove it first with ${remove}, then install this one.`,
      `Ya hay un servicio de relay de ${name} instalado para este entorno (${plan.path}). Solo puede ejecutarse un relay a la vez por cuenta de Yomi y entorno: elimínalo primero con ${remove} y luego instala este.`,
      `Já existe um serviço de relay do ${name} instalado para este ambiente (${plan.path}). Só é possível executar um relay por vez por conta do Yomi e ambiente: remova-o primeiro com ${remove} e depois instale este.`,
    );
  }
  return null;
}

/** `--forget`: this channel's secret, pairing, bot and service; the other channels keep theirs. */
function forget(
  context: Context,
  setup: ChannelSetup,
  options: RelayCommandOptions,
  registry: BotRegistry,
) {
  const { io, store } = context;
  const secretName = setup.secretName(context.account);
  const secret = store.getSecret(secretName);
  const lockName =
    (secret ? setup.lockNameOf(secret) : null) ??
    registry.bySecret(setup.kind, secretName)?.lockName ??
    null;
  if (lockName) {
    const lock = acquireProcessLock(lockPath(lockName));
    if ('heldBy' in lock)
      throw new UsageError(
        runningRefusal({ pid: lock.heldBy, setup: null, bot: '', flag: '' }, '--forget'),
      );
    lock.release();
  }
  const plan = planFor(context, setup, options);
  if (existsSync(plan.path)) {
    uninstallService(plan);
    say(
      io,
      tr(
        `已停止并删除后台服务（${plan.path}）`,
        `Stopped and removed the background service (${plan.path})`,
        `Se detuvo y se eliminó el servicio en segundo plano (${plan.path})`,
        `O serviço em segundo plano foi parado e removido (${plan.path})`,
      ),
    );
  }
  const states = forgetRelayStates(context.account, undefined, setup.kind);
  const removed = store.deleteSecret(secretName);
  registry.forget(setup.kind, secretName);
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
  say(io, paint(io, 'dim', setup.forgetHint()));
}

/** The flag that sets each channel's credentials. */
const CREDENTIALS_FLAG: Record<ChannelKind, string> = {
  telegram: '--set-token',
  qq: '--set-app',
  wechat: '--login',
};

/** The options of a plain run of `kind`: for what does not depend on them (its service's file). */
const plainOptions = (kind: ChannelKind): RelayCommandOptions => ({
  channel: kind,
  experimental: kind === 'wechat',
  setToken: false,
  setApp: false,
  login: false,
  qrLink: false,
  tokenStdin: false,
  pair: false,
  forget: false,
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
});

/** Whether `kind`'s own background service is installed for this environment. */
function serviceInstalled(context: Context, kind: ChannelKind): string | null {
  try {
    const plan = planFor(context, channelSetup(kind), plainOptions(kind));
    return existsSync(plan.path) ? plan.path : null;
  } catch {
    return null;
  }
}

/**
 * This environment's bot registry, after taking over the bots the channels' credentials stored
 * before it (design §4.3); what the takeover found to warn about is said once, then.
 */
function openRegistry(context: Context): BotRegistry {
  const { registry, warnings } = migrateRegistry({
    account: context.account,
    store: context.store,
    installed: (kind) => serviceInstalled(context, kind) !== null,
  });
  for (const line of warnings) warn(context.io, line);
  return registry;
}

/**
 * The channel's bot is the one its stored credentials belong to, now that they were set: kept when
 * it is the registered one, else registered in its place. Nothing when none are stored.
 */
function adoptStored(
  context: Context,
  registry: BotRegistry,
  setup: ChannelSetup,
  identity: BotIdentity | null,
  channel?: RelayChannel,
): BotRecord | null {
  const secretName = setup.secretName(context.account);
  const secret = context.store.getSecret(secretName);
  const stored =
    (secret ? setup.storedBot(secret) : null) ??
    (channel && identity
      ? { platformId: identity.id, scope: channel.scope, lockName: channel.lockName }
      : null);
  if (!stored) return null;
  const { record, warnings } = registry.adopt({
    kind: setup.kind,
    secretName,
    stored,
    ...(identity ? { label: setup.label(identity), handle: identity.handle } : {}),
  });
  for (const line of warnings) warn(context.io, line);
  return record;
}

/**
 * The stored credentials are not the registered bot's (something that does not know the registry
 * replaced them): refused, so another bot never runs as this one.
 */
function otherBotCredentials(setup: ChannelSetup, record: BotRecord): string {
  const name = setup.displayName;
  const again = `${setup.command} ${CREDENTIALS_FLAG[setup.kind]}`;
  const forget = `${setup.command} --forget`;
  return tr(
    `保存的${inChinese(name)}凭证属于另一个 bot，不是登记的 ${record.name}，所以没有启动。要改用现在保存的这个 bot，运行 ${again} 重新设置；要从头开始，运行 ${forget}。`,
    `The saved ${name} credentials belong to a bot other than the registered ${record.name}, so the relay was not started. To use the bot saved now instead, set it again with ${again}; to start over, run ${forget}.`,
    `Las credenciales de ${name} guardadas son de otro bot, no del bot registrado ${record.name}, así que no se inició. Para usar el bot guardado ahora, vuelve a configurarlo con ${again}; para empezar de cero, ejecuta ${forget}.`,
    `As credenciais do ${name} salvas são de outro bot, não do bot registrado ${record.name}, então ele não foi iniciado. Para usar o bot salvo agora, configure-o de novo com ${again}; para começar do zero, execute ${forget}.`,
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

/** The command that binds `name` to a character. */
const bindCommand = (name: string) => `yomi relay --bot ${name} --character ID`;

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

/** What `--list` says of a bot's state, offline: its lock, its credentials, its owner. */
function botStatus(context: Context, record: BotRecord, state: RelayState | null): string {
  const holder = lockHolder(lockPath(record.lockName));
  if (holder)
    return tr(
      `运行中（进程 ${holder.pid}）`,
      `running (process ${holder.pid})`,
      `en ejecución (proceso ${holder.pid})`,
      `em execução (processo ${holder.pid})`,
    );
  const secret = context.store.getSecret(record.secretName);
  const stored = secret ? channelSetup(record.kind).storedBot(secret) : null;
  const command = channelSetup(record.kind).command;
  if (!stored && record.kind === 'wechat')
    return tr(
      `需要登录：${command} --login`,
      `needs login: ${command} --login`,
      `necesita iniciar sesión: ${command} --login`,
      `precisa entrar: ${command} --login`,
    );
  if (!stored)
    return tr(
      `需要凭证：${command} ${CREDENTIALS_FLAG[record.kind]}`,
      `needs credentials: ${command} ${CREDENTIALS_FLAG[record.kind]}`,
      `necesita credenciales: ${command} ${CREDENTIALS_FLAG[record.kind]}`,
      `precisa de credenciais: ${command} ${CREDENTIALS_FLAG[record.kind]}`,
    );
  if (stored.scope !== record.scope)
    return tr(
      '凭证属于另一个 bot',
      'credentials belong to another bot',
      'las credenciales son de otro bot',
      'as credenciais são de outro bot',
    );
  if (!state?.data.owner && record.kind === 'wechat')
    return tr(
      `需要登录：${command} --login`,
      `needs login: ${command} --login`,
      `necesita iniciar sesión: ${command} --login`,
      `precisa entrar: ${command} --login`,
    );
  if (!state?.data.owner)
    return tr(
      `需要配对：${command} --pair`,
      `needs pairing: ${command} --pair`,
      `necesita vinculación: ${command} --pair`,
      `precisa de pareamento: ${command} --pair`,
    );
  if (!record.character)
    return tr(
      `需要绑定角色：${bindCommand(record.name)}`,
      `needs a character: ${bindCommand(record.name)}`,
      `necesita un personaje: ${bindCommand(record.name)}`,
      `precisa de um personagem: ${bindCommand(record.name)}`,
    );
  return tr('没有运行', 'not running', 'no está en ejecución', 'não está em execução');
}

/**
 * `yomi relay --list [--channel K]`: the registered bots, each with its channel, character, owner
 * and state, and the background services installed. Changes no bot (it takes over stored
 * credentials first, as every `yomi relay` does) and asks no server.
 */
export async function relayList(context: Context, kind: ChannelKind | null) {
  const { io } = context;
  const registry = openRegistry(context);
  const bots = registry.list(kind ?? undefined);
  if (!bots.length && kind) {
    // Only this channel has none: the others' bots are listed without --channel.
    const setup = channelSetup(kind);
    const name = setup.displayName;
    const command = `${setup.command} ${CREDENTIALS_FLAG[kind]}`;
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
  } else if (!bots.length)
    say(
      io,
      tr(
        '这台电脑上还没有 bot：用 yomi relay --telegram --set-token、yomi relay --channel qq --set-app 或 yomi relay --channel wechat --experimental --login 设置一个。',
        'No bots on this computer yet: set one up with yomi relay --telegram --set-token, yomi relay --channel qq --set-app or yomi relay --channel wechat --experimental --login.',
        'Todavía no hay bots en este equipo: configura uno con yomi relay --telegram --set-token, yomi relay --channel qq --set-app o yomi relay --channel wechat --experimental --login.',
        'Ainda não há bots neste computador: configure um com yomi relay --telegram --set-token, yomi relay --channel qq --set-app ou yomi relay --channel wechat --experimental --login.',
      ),
    );
  const none = tr('（还没有）', '(none yet)', '(todavía no)', '(ainda não)');
  for (const record of bots) {
    const setup = channelSetup(record.kind);
    const path = relayStatePath(context.account, record.scope);
    const state = existsSync(path)
      ? new RelayState(path, record.scope, context.account, record.kind)
      : null;
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
    const status = botStatus(context, record, state);
    say(
      io,
      tr(`  状态：${status}`, `  Status: ${status}`, `  Estado: ${status}`, `  Status: ${status}`),
    );
  }
  const installed = CHANNEL_KINDS.filter(
    (item) => (!kind || item === kind) && serviceInstalled(context, item) !== null,
  ).map((item) => channelSetup(item).displayName);
  say(
    io,
    paint(
      io,
      'dim',
      installed.length
        ? tr(
            `已安装的后台服务：${installed.join('、')}`,
            `Background services installed: ${installed.join(', ')}`,
            `Servicios en segundo plano instalados: ${installed.join(', ')}`,
            `Serviços em segundo plano instalados: ${installed.join(', ')}`,
          )
        : tr(
            '没有安装后台服务。',
            'No background service is installed.',
            'No hay ningún servicio en segundo plano instalado.',
            'Nenhum serviço em segundo plano está instalado.',
          ),
    ),
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
 * only (design §1.3). Refused while the bot runs (its lock is held while this changes it), and
 * for a character another bot has (`DuplicateCharacter`, checked again in the registry's
 * commit). Its owner, budget, records and cursor stay; its owner is welcomed with the new
 * character before the answer to their next message (the relay finds the change at its start).
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
  const setup = channelSetup(record.kind);
  // Never under a running relay of this bot: it would go on as the old character.
  const lock = acquireProcessLock(lockPath(record.lockName));
  if ('heldBy' in lock)
    throw new UsageError(
      runningRefusal(
        { pid: lock.heldBy, setup, bot: record.label, flag: '' },
        `--bot ${record.name} --character`,
      ),
    );
  try {
    requireSignIn(context);
    const character = await characterFor(context, npcId);
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
}

export async function relay(context: Context, options: RelayCommandOptions) {
  const { io, store } = context;
  const setup = channelSetup(options.channel);
  const problem = channelFlagProblem(options);
  if (problem) throw new UsageError(problem);
  // Taking things away works without a keychain too.
  if (options.uninstallService) {
    const plan = planFor(context, setup, options);
    const removed = uninstallService(plan);
    say(
      io,
      removed
        ? tr(
            `已停止并删除后台服务（${plan.path}）`,
            `Stopped and removed the background service (${plan.path})`,
            `Se detuvo y se eliminó el servicio en segundo plano (${plan.path})`,
            `O serviço em segundo plano foi parado e removido (${plan.path})`,
          )
        : tr(
            '没有安装后台服务。',
            'No background service is installed.',
            'No hay ningún servicio en segundo plano instalado.',
            'Nenhum serviço em segundo plano está instalado.',
          ),
    );
    return;
  }
  if (options.serviceStatus) {
    const plan = planFor(context, setup, options);
    if (!existsSync(plan.path))
      return void say(
        io,
        tr(
          '没有安装后台服务。',
          'No background service is installed.',
          'No hay ningún servicio en segundo plano instalado.',
          'Nenhum serviço em segundo plano está instalado.',
        ),
      );
    const [command, ...args] = plan.status;
    const result = runCommand(command, args);
    say(
      io,
      result.output ||
        tr(
          `${plan.label}：没有运行`,
          `${plan.label}: not running`,
          `${plan.label}: no está en ejecución`,
          `${plan.label}: não está em execução`,
        ),
    );
    return;
  }
  const registry = openRegistry(context);
  if (options.forget) return forget(context, setup, options, registry);

  // Asked before the keychain check and sign-in: a channel may refuse here what it cannot do.
  const settingCredentials = setup.wantsCredentials(options);
  if (store.kind === 'file' && !options.allowFileStore)
    throw new UsageError(
      tr(
        `这台机器没有可用的系统钥匙串，relay 默认不启动（${setup.secretLabel} 和会话会以明文文件保存）。确认接受时加 --allow-file-store。`,
        `This machine has no system keychain available, so relay does not start by default (the ${setup.secretLabel} and session would be saved in plain-text files). To accept that, add --allow-file-store.`,
        `Este equipo no tiene un llavero del sistema disponible, así que relay no se inicia de forma predeterminada (el ${setup.secretLabel} y la sesión se guardarían en archivos de texto sin cifrar). Para aceptarlo, agrega --allow-file-store.`,
        `Esta máquina não tem um Keychain do sistema disponível, então o relay não inicia por padrão (o ${setup.secretLabel} e a sessão seriam salvos em arquivos de texto sem criptografia). Para aceitar isso, adicione --allow-file-store.`,
      ),
    );
  if (settingCredentials) {
    // Telegram's --set-token touches nothing a running relay uses (design Appendix A, 11).
    if (setup.kind === 'telegram') {
      adoptStored(context, registry, setup, await setup.setCredentials(context, options));
      return;
    }
    // --set-app and --login never run beside a relay of this environment, nor a relay beside
    // them (QQ's gateway probe could take a running relay's events; a login rewrites the owner a
    // running relay saves): they hold the environment's lock while they run.
    const flag = options.login ? '--login' : '--set-app';
    const held = lockEnvironment(context, { channel: setup.kind, flag }, (holder) =>
      holder.flag ? credentialsRunning(holder, flag) : runningRefusal(holder, flag),
    );
    try {
      adoptStored(context, registry, setup, await setup.setCredentials(context, options));
      return;
    } finally {
      held.release();
    }
  }
  if (options.installService) {
    const refusal = otherServiceRefusal(context, setup, options);
    if (refusal) throw new UsageError(refusal);
  }

  const credential = requireSignIn(context);
  const name = setup.displayName;
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
  const secretName = setup.secretName(context.account);
  const before = store.getSecret(secretName);
  const channel = await setup.open(context, options);
  if (!channel) return;
  let identity: BotIdentity;
  try {
    identity = await setup.verify(channel);
  } catch (error) {
    if (!io.interactive && error instanceof UsageError) {
      warn(io, error.message);
      return;
    }
    throw error;
  }
  // The registered bot, read again: --set-token may have set another one while this started.
  registry.commit(() => false);
  const registered = registry.bySecret(setup.kind, secretName);
  const saved = store.getSecret(secretName);
  let record: BotRecord | null = registered && saved === before ? registered : null;
  if (!record) {
    // Credentials set by something else while this started are not the ones opened: run again.
    const stored = saved ? setup.storedBot(saved) : null;
    if (stored && stored.scope !== channel.scope) throw new UsageError(credentialsChanged(setup));
    // Credentials typed in just now (`open` asked) make the bot theirs, as --set-token's do.
    record = adoptStored(context, registry, setup, identity, channel);
  }
  if (!record) return;
  // Stored credentials of another bot never run as this one.
  const otherBot = record.scope !== channel.scope;
  const state = new RelayState(
    relayStatePath(context.account, channel.scope),
    channel.scope,
    context.account,
    channel.kind,
  );

  if (options.installService) {
    if (otherBot) throw new UsageError(otherBotCredentials(setup, record));
    if (!state.data.owner)
      throw new UsageError(
        channel.caps.pairing === 'login'
          ? setup.unpairedHint()
          : tr(
              `还没有配对：先在终端里运行一次 ${setup.command} 完成配对，再安装后台服务。`,
              `Not paired yet: run ${setup.command} once in a terminal to pair, then install the background service.`,
              `Todavía no está vinculado: ejecuta ${setup.command} una vez en una terminal para vincularlo y luego instala el servicio en segundo plano.`,
              `Ainda não pareado: execute ${setup.command} uma vez em um terminal para parear e depois instale o serviço em segundo plano.`,
            ),
      );
    // --character binds a bot without one at the service's start; it never changes a bound one.
    let serviceOptions = options;
    if (record.character) {
      if (options.characterId && characterIdOf(options.characterId) !== record.character.npcId)
        warn(io, characterIgnored(record, record.character, options.characterId));
      // Left out, so the service's log never repeats that warning.
      serviceOptions = { ...options, characterId: '' };
    } else if (options.characterId) {
      const holder = registry.byCharacter(characterIdOf(options.characterId));
      if (holder && holder.key !== record.key)
        throw new DuplicateCharacter(holder.character!.npcId, holder.name);
    } else warn(io, needsCharacter(record));
    const plan = planFor(context, setup, serviceOptions);
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
    ensurePrivateDir(join(configDir(), 'logs'));
    installService(plan);
    say(
      io,
      tr(
        `已安装并启动后台服务：${plan.path}`,
        `Installed and started the background service: ${plan.path}`,
        `Se instaló e inició el servicio en segundo plano: ${plan.path}`,
        `Serviço em segundo plano instalado e iniciado: ${plan.path}`,
      ),
    );
    say(io, capLine(options.maxSpend, true));
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          `日志：${join(configDir(), 'logs')}；停止并删除：${setup.command} --uninstall-service`,
          `Logs: ${join(configDir(), 'logs')}; to stop and remove: ${setup.command} --uninstall-service`,
          `Registros: ${join(configDir(), 'logs')}; para detenerlo y eliminarlo: ${setup.command} --uninstall-service`,
          `Logs: ${join(configDir(), 'logs')}; para parar e remover: ${setup.command} --uninstall-service`,
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
    return;
  }

  const lock = acquireProcessLock(lockPath(channel.lockName));
  if ('heldBy' in lock)
    throw new UsageError(
      tr(
        `这个 bot 已经有一个 relay 在运行${lock.heldBy ? `（进程 ${lock.heldBy}）` : ''}。同一个 bot 只能运行一个。`,
        `A relay is already running for this bot${lock.heldBy ? ` (process ${lock.heldBy})` : ''}. Only one can run per bot.`,
        `Ya hay un relay en ejecución para este bot${lock.heldBy ? ` (proceso ${lock.heldBy})` : ''}. Solo puede ejecutarse uno por bot.`,
        `Já existe um relay em execução para este bot${lock.heldBy ? ` (processo ${lock.heldBy})` : ''}. Só é possível executar um por bot.`,
      ),
    );
  let environment: { release: () => void };
  try {
    environment = lockEnvironment(
      context,
      { channel: channel.kind, bot: setup.label(identity) },
      (holder) =>
        holder.flag ? credentialsRunning(holder, '') : anotherRelayRunning(holder, context.env),
    );
  } catch (error) {
    lock.release();
    throw error;
  }
  try {
    // Checked under the locks, as the run itself would: a relay already running says so first.
    if (otherBot) {
      if (io.interactive) throw new UsageError(otherBotCredentials(setup, record));
      // A service restarting would not fix it: say so and end without failing.
      warn(io, otherBotCredentials(setup, record));
      return;
    }
    let bot = registry.refresh(record, {
      stored: setup.storedBot(store.getSecret(secretName) ?? '') ?? {
        platformId: identity.id,
        scope: channel.scope,
        lockName: channel.lockName,
      },
      label: setup.label(identity),
      handle: identity.handle,
    });
    registry.bindAccount(credential.userId);
    // Its owner then had their start before the registry: never welcomed again.
    if (bot.welcomeBaseline) state.welcomedBefore(bot.welcomeBaseline);
    const log = (line: string) => io.stderr.write(`${new Date().toISOString()} ${line}\n`);
    // The registry's character is the one it talks as; --character binds one only when it has none.
    if (options.characterId)
      bot = await characterAtStart(context, registry, bot, options.characterId);
    if (!bot.character) warn(io, needsCharacter(bot));
    /** Registry writes the relay asks for: it goes on when one fails (logged), as before. */
    const write = (change: () => void) => {
      try {
        change();
      } catch (error) {
        log(error instanceof Error ? error.message : String(error));
      }
    };
    // Another person may pair now: their consent to spend starts over.
    if (options.pair) state.resetOwner();
    let pairing: PairingCode | null = null;
    if (!state.data.owner) {
      // A code is shown only to someone at this terminal, never in a service log; a channel whose
      // owner is whoever signed in (WeChat) has nobody to pair here.
      if (channel.caps.pairing === 'login' || (!io.interactive && !options.pair)) {
        warn(io, setup.unpairedHint());
        return;
      }
      pairing = new PairingCode();
      setup.printPairing?.(context, pairing, identity);
    }
    say(
      io,
      tr(
        `relay 运行中：${setup.label(identity)} ⇄ Yomi ${credential.displayName || credential.userId}（${describeEnvironment(context.env)}）`,
        `Relay running: ${setup.label(identity)} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
        `Relay en ejecución: ${setup.label(identity)} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
        `Relay em execução: ${setup.label(identity)} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
      ),
    );
    if (setup.personalUseOnly)
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
    if (setup.experimental)
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
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const engine = new Relay(context.gateway, channel, state, {
      maxSpend: options.maxSpend,
      resetSpend: options.resetSpend,
      characterId: '',
      boundCharacter: bot.character,
      botName: bot.name,
      characterOwners: {
        get: (npcId) => registry.shownTo(npcId),
        set: (npcId, owner) => write(() => registry.showedCharacter(npcId, owner)),
      },
      pairing,
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
      log,
      rerunCommand: setup.command,
      // QQ and WeChat relay in production only on a policy the server sent for them.
      requireServerPolicy: channel.kind !== 'telegram' && isProduction(context.env),
      // The bound character's name as Yomi says it now.
      onCharacter: (character) =>
        write(() => character && registry.bindCharacter(bot.key, character, '')),
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
    say(io, tr('relay 已停止。', 'Relay stopped.', 'El relay se detuvo.', 'O relay parou.'));
  } finally {
    environment.release();
    lock.release();
  }
}

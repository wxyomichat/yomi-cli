import { ChatRefusal, characterProfile } from '../chat/api.js';
import { ApiError } from '../core/api.js';
import { asciiJson, storeDescription } from '../core/credentials.js';
import { isProduction, UsageError } from '../core/env.js';
import { tr } from '../core/i18n.js';
import { paint, say } from '../core/ui.js';
import { VERSION } from '../core/version.js';
import { channelSetup } from '../relay/channels/index.js';
import type { QqApi } from '../relay/channels/qq-api.js';
import {
  acceptedText,
  askApp,
  checkingText,
  checkPrivateChat,
  createLines,
  credentialsLines,
  friendLines,
  type PrivateChatCheck,
  QQ_CONSOLE_ZH,
  QQ_LINKS,
  type QqApp,
  resetLines,
  scannedApp,
  spacingText,
  TOKEN_CHECKS_MAX,
  tokenProblem,
  tooManyChecks,
} from '../relay/channels/qq-guide.js';
import { qqIdentify, qqSetup } from '../relay/channels/qq.js';
import type { AcquiredBot } from '../relay/channels/setup.js';
import { type BotIdentity, ChannelError, type ChannelKind } from '../relay/channels/types.js';
import {
  againText,
  doneText,
  GUIDE_TIMINGS,
  GuideCancelled,
  type GuideStep,
  GuideUi,
  runGuide,
  type StepResult,
} from '../relay/guide/steps.js';
import { channelPolicy, compareVersions, relayPolicy } from '../relay/policy.js';
import { addProblem, type BotRecord, BotRegistry, DuplicateCharacter } from '../relay/registry.js';
import type { ServicePlan } from '../relay/service.js';
import type { RelayCharacter } from '../relay/state.js';
import { login } from './auth.js';
import { type Context, requireSignIn } from './context.js';
import { confirmProduction } from './declaration.js';
import {
  busyNow,
  characterIdOf,
  type CredentialsPlan,
  fileStoreRefusal,
  fromTemporaryDir,
  type GuideHooks,
  hubPlan,
  inChinese,
  installedOptions,
  installedPlans,
  installRelayService,
  legacyKind,
  masked,
  nameAndId,
  openRegistry,
  otherChannel,
  ownCredentials,
  type PairOutcome,
  pairingCap,
  pairUnderService,
  PLAIN_OPTIONS,
  type RelayCommandOptions,
  relayCommand,
  relayRebind,
  relayRun,
  reinstallCommand,
  saveAdded,
  saveRenewed,
  serviceHolding,
  stateOf,
  whileStopped,
} from './relay.js';

/**
 * `yomi relay --setup` (QQ, design "QQ guided setup"): the steps from nothing to a paired QQ bot
 * in this terminal, numbered, each said with what to do on q.qq.com and QQ's own link (`o` opens
 * it): choose the character, create the bot, type its AppID and AppSecret (checked with QQ), one
 * check of the gateway and the bot saved, how it runs from then on (this terminal, the background
 * service, later), adding it as a QQ friend, then connecting and pairing in this same process, the
 * guide saying what the answer to the pairing came to in QQ. Leaving at any step keeps what was
 * saved, and `--setup` again goes on from the registry alone (`decide`); a bot set up already has
 * its AppSecret set again in two steps.
 *
 * Nothing is checked or held for the whole guide: before step 1 only what would refuse it outright
 * (flags, a terminal, the keychain, a relay running in a terminal, another change, the service's
 * cap, production, the server's policy for QQ); the locks only around what changes something
 * (saving, binding, pairing, installing the service), each as `--set-app`, `--bot NAME --character`,
 * `--pair` and `--install-service` take them, so other commands run while the person is on
 * q.qq.com. Nothing typed is ever said back: the AppSecret has no echo, every other line only its
 * digits, and a secret pasted where it does not go is said and dropped.
 */

const FLAG = '--setup';
const Z = QQ_CONSOLE_ZH;

/** Where the guide is: what it has in memory, what is saved. */
type SetupState = {
  /** The bot being set up: an existing one, or a new one once saved (null until then). */
  record: BotRecord | null;
  /** A bot set up already: only its AppSecret is set again (two steps). */
  renewOnly: boolean;
  /** A new bot's name (`--bot` with a name not registered), '' for its default. */
  name: string;
  /** `--character`, answering step 1 once (its name is still confirmed). */
  prefill: string;
  /** A new bot's character, until it is saved with it. */
  character: RelayCharacter | null;
  /** The AppID and AppSecret QQ accepted, until saved (in memory only). */
  app: QqApp | null;
  api: QqApi | null;
  identity: BotIdentity | null;
  /** `app` is `record`'s own, set again: saved without checking the gateway. */
  renewing: boolean;
  /** Token checks of this run (`TOKEN_CHECKS_MAX`). */
  checks: number;
  /** What the check of the gateway found for `app` (null: not checked yet). */
  checked: PrivateChatCheck | null;
  /** When the check identified with QQ: the pairing connects 5 s after it at the earliest. */
  identifiedAt: number;
  /** How the bot runs once paired (step 5; null when the service ran as the guide started). */
  run: 'terminal' | 'service' | 'restart' | 'later' | null;
  /** The cap the pairing (and the service installed after it) run under. */
  cap: number | null;
  /** Waiting for `/pair`: what leaving now says. */
  waiting: boolean;
};

const emptyState = (): SetupState => ({
  record: null,
  renewOnly: false,
  name: '',
  prefill: '',
  character: null,
  app: null,
  api: null,
  identity: null,
  renewing: false,
  checks: 0,
  checked: null,
  identifiedAt: 0,
  run: null,
  cap: null,
  waiting: false,
});

export async function relaySetup(context: Context, options: RelayCommandOptions) {
  const { io } = context;
  const registry = preflight(context, options);
  if (
    !(await confirmProduction(
      context,
      tr(
        '设置一个 QQ bot，把它的私聊转给角色（会使用真实账号的免费额度和钻石）',
        "set up a QQ bot and forward its private chats to a character (uses the real account's free messages and gems)",
        'configurar un bot de QQ y reenviar sus chats privados a un personaje (usa los mensajes gratis y las gemas de la cuenta real)',
        'configurar um bot do QQ e encaminhar os chats privados dele para um personagem (usa as mensagens grátis e as gemas da conta real)',
      ),
      options.confirmProd,
    ))
  )
    return;
  say(
    io,
    tr(
      '按步骤把你自己的 QQ 机器人接到一个 Yomi 角色，大约 10 分钟。',
      'Connect your own QQ bot to a Yomi character, step by step (about 10 minutes).',
      'Conecta tu propio bot de QQ a un personaje de Yomi, paso a paso (unos 10 minutos).',
      'Conecte o seu próprio bot do QQ a um personagem do Yomi, passo a passo (uns 10 minutos).',
    ),
  );
  say(
    io,
    tr(
      '仅限个人使用：只转发你本人和你自己的机器人之间的私聊。随时按 Ctrl+C 退出，已经保存的不会丢。',
      'Personal use only: this relays private chats between you and your own bot. Press Ctrl+C at any time; what is saved stays saved.',
      'Solo para uso personal: esto reenvía los chats privados entre tú y tu propio bot. Presiona Ctrl+C cuando quieras; lo guardado sigue guardado.',
      'Somente para uso pessoal: isto repassa os chats privados entre você e o seu próprio bot. Pressione Ctrl+C quando quiser; o que foi salvo continua salvo.',
    ),
  );
  if (!options.channel)
    say(
      io,
      tr(
        '通道：QQ（Telegram 用 --set-token，微信用 --login 扫码；见 yomi relay --help）',
        'Channel: QQ (Telegram uses --set-token, WeChat uses --login with a QR code; see yomi relay --help)',
        'Canal: QQ (Telegram usa --set-token, WeChat usa --login con un código QR; consulta yomi relay --help)',
        'Canal: QQ (o Telegram usa --set-token, o WeChat usa --login com um código QR; veja yomi relay --help)',
      ),
    );
  const ui = new GuideUi(io);
  const state = emptyState();
  ui.guard();
  try {
    const signedIn = Boolean(context.gateway.credential);
    if (signedIn) await serverPolicy(context, ui);
    await decide(context, registry, options, ui, state);
    if (serviceHolding(context)) ui.say(paint(io, 'dim', serviceNote(state.renewOnly)));
    const steps = state.renewOnly
      ? renewSteps(context, signedIn)
      : setupSteps(context, options, signedIn, Boolean(qqServiceRunning(context)));
    await runGuide(steps, state, ui);
  } catch (error) {
    if (!(error instanceof GuideCancelled)) throw error;
    ui.say();
    ui.say(goodbye(state));
    process.exitCode = error.how === 'interrupt' ? 130 : 0;
  } finally {
    ui.unguard();
  }
}

// -------------------------------------------------------------------------------------------------
// Before the first step (design §4.1): what refuses the guide outright, with nothing asked yet.

function preflight(context: Context, options: RelayCommandOptions): BotRegistry {
  const { io } = context;
  if (options.channel === 'telegram')
    throw new UsageError(
      tr(
        '--setup 现在只用于 QQ。Telegram 用 yomi relay --telegram --set-token 添加 bot（见 yomi relay --help）。',
        '--setup is only for QQ for now. Telegram adds a bot with yomi relay --telegram --set-token (see yomi relay --help).',
        '--setup es solo para QQ por ahora. Telegram agrega un bot con yomi relay --telegram --set-token (consulta yomi relay --help).',
        '--setup é só para o QQ por enquanto. O Telegram adiciona um bot com yomi relay --telegram --set-token (veja yomi relay --help).',
      ),
    );
  if (options.channel === 'wechat')
    throw new UsageError(
      tr(
        '--setup 现在只用于 QQ。微信用 yomi relay --channel wechat --experimental --login 扫码添加（见 yomi relay --help）。',
        '--setup is only for QQ for now. WeChat adds its ClawBot with a QR code: yomi relay --channel wechat --experimental --login (see yomi relay --help).',
        '--setup es solo para QQ por ahora. WeChat agrega su ClawBot con un código QR: yomi relay --channel wechat --experimental --login (consulta yomi relay --help).',
        '--setup é só para o QQ por enquanto. O WeChat adiciona o ClawBot com um código QR: yomi relay --channel wechat --experimental --login (veja yomi relay --help).',
      ),
    );
  if (!io.interactive)
    throw new UsageError(
      tr(
        `--setup 要在终端里一步步回答，不能在脚本或管道里用。脚本里用：printf '%s\\n%s\\n' "$APPID" "$APPSECRET" | yomi relay --channel qq --set-app --token-stdin --character <ID>，再在终端里运行 yomi relay --bot <名字> --pair。`,
        `--setup asks its questions in a terminal, step by step: it does not run in a script or a pipe. In a script: printf '%s\\n%s\\n' "$APPID" "$APPSECRET" | yomi relay --channel qq --set-app --token-stdin --character <ID>, then in a terminal: yomi relay --bot <name> --pair.`,
        `--setup hace sus preguntas en una terminal, paso a paso: no funciona en un script ni en una tubería. En un script: printf '%s\\n%s\\n' "$APPID" "$APPSECRET" | yomi relay --channel qq --set-app --token-stdin --character <ID>, y luego en una terminal: yomi relay --bot <nombre> --pair.`,
        `--setup faz as perguntas em um terminal, passo a passo: não funciona em um script nem em um pipe. Em um script: printf '%s\\n%s\\n' "$APPID" "$APPSECRET" | yomi relay --channel qq --set-app --token-stdin --character <ID>, e depois em um terminal: yomi relay --bot <nome> --pair.`,
      ),
    );
  if (options.bots.length > 1)
    throw new UsageError(
      tr(
        '--setup 一次只设置一个 bot：--bot 名字',
        '--setup sets up one bot at a time: --bot NAME',
        '--setup configura un bot a la vez: --bot NOMBRE',
        '--setup configura um bot de cada vez: --bot NOME',
      ),
    );
  const registry = openRegistry(context);
  const named = options.bots[0] ? registry.find(options.bots[0]) : undefined;
  if (named && named.kind !== 'qq') throw new UsageError(otherChannel(named, 'qq'));
  if (context.store.kind === 'file' && !options.allowFileStore)
    throw new UsageError(fileStoreRefusal(qqSetup));
  const busy = busyNow(context, FLAG);
  if (busy) throw new UsageError(busy.refusal);
  // The service's cap is the service's to change (`--install-service`): another one is refused.
  if (installedPlans(context).length && options.maxSpend !== null) pairingCap(context, options);
  return registry;
}

/**
 * The server's policy for QQ (design §4.1 item 8): a version too old is refused; in production a
 * channel the server has not enabled is said, and set up only when asked to; elsewhere its warning.
 */
async function serverPolicy(context: Context, ui: GuideUi) {
  const policy = await relayPolicy(context.gateway, 'qq', ui.signal);
  ui.check();
  if (policy.minVersion && compareVersions(VERSION, policy.minVersion) < 0)
    throw new UsageError(
      tr(
        `服务端要求 yomi ${policy.minVersion} 或更新的版本（现在是 ${VERSION}）：先用 npm install -g @yomichat/cli 升级，再运行 yomi relay --setup。`,
        `The server requires yomi ${policy.minVersion} or newer (this is ${VERSION}): update with npm install -g @yomichat/cli, then run yomi relay --setup.`,
        `El servidor requiere yomi ${policy.minVersion} o más reciente (esta es ${VERSION}): actualiza con npm install -g @yomichat/cli y luego ejecuta yomi relay --setup.`,
        `O servidor exige o yomi ${policy.minVersion} ou mais recente (este é ${VERSION}): atualize com npm install -g @yomichat/cli e depois execute yomi relay --setup.`,
      ),
    );
  const read = channelPolicy(policy, 'qq', isProduction(context.env));
  if (!read.gated) {
    if (read.warning && !ui.notes.has(read.warning)) {
      ui.notes.add(read.warning);
      ui.say(paint(ui.io, 'dim', `· ${read.warning}`));
    }
    return;
  }
  // Said here in the guide's words: the run's own line saying so (step 7) is not said again.
  ui.notes.add(read.warning);
  ui.say(
    tr(
      '服务端还没有开放 QQ 通道（也可能是现在读不到服务端的设置）。现在设置的话，配对能完成，但开放之前每条消息都只会收到“服务端已关闭”的答复，不转发、不扣费；开放后自动恢复。',
      'The server has not enabled the QQ channel (or its settings cannot be read now). If you set it up now, pairing works, but until the channel is enabled every message gets the reply that the server switched it off, and nothing is relayed or charged; it resumes by itself once enabled.',
      'El servidor todavía no habilitó el canal de QQ (o ahora no se pueden leer sus ajustes). Si lo configuras ahora, la vinculación funciona, pero hasta que se habilite cada mensaje recibe la respuesta de que el servidor lo desactivó, y no se transmite ni se cobra nada; se reanuda solo cuando se habilite.',
      'O servidor ainda não habilitou o canal do QQ (ou agora não é possível ler os ajustes dele). Se você configurar agora, o pareamento funciona, mas até ele ser habilitado cada mensagem recebe a resposta de que o servidor o desativou, e nada é encaminhado nem cobrado; ele volta sozinho quando for habilitado.',
    ),
  );
  const key = await ui.key(
    tr(
      '1：照样设置 · q：退出 ',
      '1: set it up anyway · q: quit ',
      '1: configurarlo igual · q: salir ',
      '1: configurar mesmo assim · q: sair ',
    ),
    ['1', 'q'],
    true,
  );
  if (key === 'q') throw new GuideCancelled('quit');
}

/** What a QQ bot of this computer still needs, read on this computer alone, and how it is shown. */
function progressOf(context: Context, record: BotRecord): { done: boolean; text: string } {
  const credentials = ownCredentials(context, record);
  const owner = Boolean(stateOf(context, record)?.data.owner);
  const character = record.character?.name;
  const parts = [
    character ??
      tr('还没有角色', 'no character yet', 'todavía sin personaje', 'ainda sem personagem'),
    !credentials
      ? tr(
          'AppSecret 要重新输入',
          'its AppSecret to type again',
          'hay que escribir de nuevo su AppSecret',
          'é preciso digitar o AppSecret de novo',
        )
      : owner
        ? tr('已配对', 'paired', 'vinculado', 'pareado')
        : tr('还没有配对', 'not paired yet', 'todavía sin vincular', 'ainda não pareado'),
  ];
  return {
    done: credentials && Boolean(character) && owner,
    text: tr(
      `${record.name}（${parts.join('，')}）`,
      `${record.name} (${parts.join(', ')})`,
      `${record.name} (${parts.join(', ')})`,
      `${record.name} (${parts.join(', ')})`,
    ),
  };
}

/** The character of a bot (its name when it has one). */
const characterOf = (record: BotRecord) => record.character?.name ?? record.character?.npcId ?? '';

/**
 * The background service holding the environment's lock when it runs QQ bots: the hub's, or QQ's
 * own unit of before it. Null when none runs, and when it is another channel's unit of before the
 * hub, which runs only that channel's bots (the bot set up here would not run in it).
 */
function qqServiceRunning(context: Context): ServicePlan | null {
  const plan = serviceHolding(context);
  const kind = plan ? legacyKind(context, plan) : null;
  return plan && (kind === null || kind === 'qq') ? plan : null;
}

/** A character bound to another bot already (one set up, or of another channel). */
function boundElsewhere(holder: BotRecord): string {
  const named = characterOf(holder);
  const rebind = `yomi relay --bot ${holder.name} --character <ID>`;
  return tr(
    `${named}已经绑在 bot ${holder.name} 上（一个角色只能绑一个 bot）。换一个角色，或者先给 ${holder.name} 换绑：${rebind}`,
    `${named} is bound to the bot ${holder.name} already (one character, one bot). Choose another, or rebind ${holder.name} first: ${rebind}`,
    `${named} ya está vinculado al bot ${holder.name} (un personaje, un bot). Elige otro, o primero cambia el personaje de ${holder.name}: ${rebind}`,
    `${named} já está vinculado ao bot ${holder.name} (um personagem, um bot). Escolha outro, ou primeiro troque o personagem de ${holder.name}: ${rebind}`,
  );
}

/** A character bound to a QQ bot not set up yet: going on with that one is offered. */
function continueHolder(holder: BotRecord): string {
  const named = characterOf(holder);
  return tr(
    `${named}已经绑在 ${holder.name} 上，它还没设置完。接着设置 ${holder.name} 吗？`,
    `${named} is bound to ${holder.name}, which isn't set up yet. Continue setting up ${holder.name}?`,
    `${named} está vinculado a ${holder.name}, que todavía no está configurado. ¿Seguir configurando ${holder.name}?`,
    `${named} está vinculado a ${holder.name}, que ainda não foi configurado. Continuar configurando ${holder.name}?`,
  );
}

/**
 * New bot, a bot to go on with, or one whose AppSecret is set again (design §3.2, §4.3), from the
 * registry alone: `--bot NAME` names it (a new name: a new bot); `--character` a new bot's character,
 * or the QQ bot not set up yet that has it; else the QQ bots not set up yet are offered, then what
 * to do with those set up.
 */
async function decide(
  context: Context,
  registry: BotRegistry,
  options: RelayCommandOptions,
  ui: GuideUi,
  state: SetupState,
) {
  const name = options.bots[0] ?? '';
  const named = name ? registry.find(name) : undefined;
  const npcId = characterIdOf(options.characterId);
  if (options.characterId && !npcId)
    throw new UsageError(
      tr(
        '--character 不像角色链接或角色 ID。',
        "--character doesn't look like a character link or ID.",
        '--character no parece un enlace ni un ID de personaje.',
        '--character não parece um link nem um ID de personagem.',
      ),
    );
  if (named) {
    // A bot with a character keeps it: --setup never binds it to another (that is a rebind).
    if (npcId && named.character && named.character.npcId !== npcId)
      throw new UsageError(
        tr(
          `${named.name} 已经固定和${nameAndId(named.character)}聊天，--setup 不会给它换角色。要换角色：yomi relay --bot ${named.name} --character <ID>`,
          `${named.name} always chats with ${nameAndId(named.character)}, and --setup does not change its character. To change it: yomi relay --bot ${named.name} --character <ID>`,
          `${named.name} siempre chatea con ${nameAndId(named.character)}, y --setup no cambia su personaje. Para cambiarlo: yomi relay --bot ${named.name} --character <ID>`,
          `${named.name} sempre conversa com ${nameAndId(named.character)}, e o --setup não troca o personagem dele. Para trocar: yomi relay --bot ${named.name} --character <ID>`,
        ),
      );
    state.record = named;
    if (progressOf(context, named).done) state.renewOnly = true;
    else if (npcId && !named.character) state.prefill = options.characterId;
    return;
  }
  const qq = registry.list('qq').map((record) => ({ record, ...progressOf(context, record) }));
  if (options.characterId) {
    const holder = registry.byCharacter(npcId);
    if (holder && (holder.kind !== 'qq' || progressOf(context, holder).done))
      throw new UsageError(boundElsewhere(holder));
    if (holder && (await ui.yesNo(continueHolder(holder)))) {
      state.record = holder;
      return;
    }
    if (!holder) state.prefill = options.characterId;
  } else if (!name) {
    const open = qq.filter((item) => !item.done).slice(0, 9);
    if (open.length === 1) {
      const going = await ui.yesNo(
        tr(
          `${open[0].text}还没设置完。接着设置？`,
          `${open[0].text} isn't set up yet. Continue setting it up?`,
          `${open[0].text} todavía no está configurado. ¿Seguir configurándolo?`,
          `${open[0].text} ainda não foi configurado. Continuar configurando?`,
        ),
      );
      if (going) {
        state.record = open[0].record;
        return;
      }
    } else if (open.length > 1) {
      ui.say(
        tr(
          '这些 QQ bot 还没设置完：',
          "These QQ bots aren't set up yet:",
          'Estos bots de QQ todavía no están configurados:',
          'Estes bots do QQ ainda não foram configurados:',
        ),
      );
      ui.lines(...open.map((item, index) => `${index + 1}  ${item.text}`));
      const key = await ui.key(
        tr(
          '选一个接着设置 · n：新建一个 · q：退出 ',
          'Choose one to continue · n: a new one · q: quit ',
          'Elige uno para continuar · n: uno nuevo · q: salir ',
          'Escolha um para continuar · n: um novo · q: sair ',
        ),
        [...open.map((_, index) => String(index + 1)), 'n', 'q'],
        true,
      );
      if (key === 'q') throw new GuideCancelled('quit');
      if (key !== 'n') {
        state.record = open[Number(key) - 1].record;
        return;
      }
    }
    const done = qq.filter((item) => item.done).slice(0, 9);
    if (done.length) {
      ui.say(
        tr(
          `这台电脑上已有 QQ bot：${done.map((item) => item.text).join('、')}。`,
          `This computer has QQ bots already: ${done.map((item) => item.text).join(', ')}.`,
          `Este equipo ya tiene bots de QQ: ${done.map((item) => item.text).join(', ')}.`,
          `Este computador já tem bots do QQ: ${done.map((item) => item.text).join(', ')}.`,
        ),
      );
      const key = await ui.key(
        tr(
          '1：再添加一个 QQ bot（和另一个角色聊天） · 2：重新设置某个 bot 的 AppSecret · q：退出 ',
          '1: add another QQ bot (to chat with another character) · 2: set a bot’s AppSecret again · q: quit ',
          '1: agregar otro bot de QQ (para chatear con otro personaje) · 2: volver a configurar el AppSecret de un bot · q: salir ',
          '1: adicionar outro bot do QQ (para conversar com outro personagem) · 2: configurar de novo o AppSecret de um bot · q: sair ',
        ),
        ['1', '2', 'q'],
        true,
      );
      if (key === 'q') throw new GuideCancelled('quit');
      if (key === '2') {
        let chosen = done[0].record;
        if (done.length > 1) {
          ui.lines(...done.map((item, index) => `${index + 1}  ${item.text}`));
          const which = await ui.key(
            tr('哪一个？', 'Which one?', '¿Cuál?', 'Qual?') + ' ',
            [...done.map((_, index) => String(index + 1)), 'q'],
            true,
          );
          if (which === 'q') throw new GuideCancelled('quit');
          chosen = done[Number(which) - 1].record;
        }
        state.record = chosen;
        state.renewOnly = true;
        return;
      }
    }
  }
  state.name = name;
  const refusal = addProblem(registry, 'qq', name);
  if (refusal) throw refusal;
}

/** Said before the steps while the background service runs (design §4.1 item 10). */
function serviceNote(renewOnly: boolean): string {
  return renewOnly
    ? tr(
        '后台服务在运行：保存（几秒）时会先停止它，这期间所有 bot 离线，保存后自动重新启动。',
        "The background service is running: saving (a few seconds) stops it first, every bot is offline meanwhile, and it starts again by itself once it's saved.",
        'El servicio en segundo plano está en ejecución: guardar (unos segundos) lo detiene primero, todos los bots quedan sin conexión mientras tanto y vuelve a iniciarse solo después de guardar.',
        'O serviço em segundo plano está em execução: salvar (alguns segundos) o para primeiro, todos os bots ficam offline enquanto isso e ele inicia de novo sozinho depois de salvar.',
      )
    : tr(
        '后台服务在运行：保存（几秒）和配对（等你发 /pair）时会先停止它，这期间所有 bot 离线，完成后自动重新启动。',
        'The background service is running: saving (a few seconds) and pairing (until you send /pair) stop it first, every bot is offline meanwhile, and it starts again by itself afterwards.',
        'El servicio en segundo plano está en ejecución: guardar (unos segundos) y vincular (hasta que envíes /pair) lo detienen primero, todos los bots quedan sin conexión mientras tanto y vuelve a iniciarse solo después.',
        'O serviço em segundo plano está em execução: salvar (alguns segundos) e parear (até você enviar /pair) o param primeiro, todos os bots ficam offline enquanto isso e ele inicia de novo sozinho depois.',
      );
}

/** What leaving the guide says (Ctrl+C or q), from what is saved. */
function goodbye(state: SetupState): string {
  const record = state.record;
  if (record && state.renewOnly)
    return tr(
      `已退出：${record.name} 的 AppSecret 没有改动。`,
      `Quit: the AppSecret of ${record.name} did not change.`,
      `Saliste: el AppSecret de ${record.name} no cambió.`,
      `Você saiu: o AppSecret de ${record.name} não mudou.`,
    );
  if (!record)
    return tr(
      '已退出，什么都没有保存。',
      'Quit; nothing was saved.',
      'Saliste; no se guardó nada.',
      'Você saiu; nada foi salvo.',
    );
  if (state.waiting)
    return tr(
      `已退出：${record.name} 已保存，还没有配对。之后运行 yomi relay --setup 接着配对，或者运行 yomi relay --bot ${record.name} --pair。`,
      `Quit: ${record.name} is saved, not paired yet. Run yomi relay --setup later to pair it, or yomi relay --bot ${record.name} --pair.`,
      `Saliste: ${record.name} está guardado, todavía sin vincular. Ejecuta yomi relay --setup más tarde para vincularlo, o yomi relay --bot ${record.name} --pair.`,
      `Você saiu: ${record.name} está salvo, ainda não pareado. Execute yomi relay --setup depois para pareá-lo, ou yomi relay --bot ${record.name} --pair.`,
    );
  return tr(
    `已退出：${record.name} 已保存，运行 yomi relay --setup 接着设置。`,
    `Quit: ${record.name} is saved; run yomi relay --setup to go on.`,
    `Saliste: ${record.name} está guardado; ejecuta yomi relay --setup para continuar.`,
    `Você saiu: ${record.name} está salvo; execute yomi relay --setup para continuar.`,
  );
}

// -------------------------------------------------------------------------------------------------
// The steps.

/** "Sign in to Yomi" first, when nobody is signed in, then the server's policy for QQ. */
function loginStep(context: Context, signedIn: boolean): GuideStep<SetupState> {
  return {
    id: 'login',
    title: () => tr('登录 Yomi', 'Sign in to Yomi', 'Inicia sesión en Yomi', 'Entre no Yomi'),
    skip: () => signedIn,
    run: async (_state, ui) => {
      // Login's own Ctrl+C handling (a second one exits) while it runs; one is noted here.
      let interrupted = false;
      const noted = () => {
        interrupted = true;
      };
      await ui.outside(async () => {
        process.on('SIGINT', noted);
        try {
          await login(context, { browser: true, timeoutSeconds: 300 });
        } catch (error) {
          if (interrupted) throw new GuideCancelled('interrupt');
          throw error;
        } finally {
          process.removeListener('SIGINT', noted);
        }
      });
      await serverPolicy(context, ui);
    },
  };
}

function setupSteps(
  context: Context,
  options: RelayCommandOptions,
  signedIn: boolean,
  service: boolean,
): GuideStep<SetupState>[] {
  return [
    loginStep(context, signedIn),
    {
      id: 'character',
      title: () =>
        tr('选择角色', 'Choose the character', 'Elige el personaje', 'Escolha o personagem'),
      finished: (state) => Boolean(state.record?.character),
      run: (state, ui) => chooseCharacter(context, state, ui),
    },
    {
      id: 'create',
      title: () =>
        tr(
          '在 QQ 开放平台创建机器人',
          'Create the bot on the QQ Open Platform',
          'Crea el bot en la QQ Open Platform',
          'Crie o bot na QQ Open Platform',
        ),
      finished: (state) => Boolean(state.record || state.app),
      run: async (_state, ui) => {
        ui.lines(...createLines());
        await ui.checkpoint(QQ_LINKS.console);
      },
    },
    {
      id: 'credentials',
      title: () =>
        tr(
          '输入 AppID 和 AppSecret',
          'Enter the AppID and AppSecret',
          'Escribe el AppID y el AppSecret',
          'Digite o AppID e o AppSecret',
        ),
      finished: (state) =>
        Boolean(state.app) || (state.record !== null && ownCredentials(context, state.record)),
      run: (state, ui) => enterCredentials(context, state, ui),
    },
    {
      id: 'check',
      title: () =>
        tr(
          '检查私聊权限并保存',
          'Check the private chat permission and save',
          'Comprueba el permiso de chat privado y guarda',
          'Verifique a permissão de chat privado e salve',
        ),
      finished: (state) => state.record !== null && !state.app,
      run: (state, ui) => checkAndSave(context, state, ui, service),
    },
    {
      id: 'run',
      title: () =>
        tr(
          '之后怎样运行',
          'How it runs from now on',
          'Cómo se ejecuta desde ahora',
          'Como ele funciona daqui em diante',
        ),
      skip: () => service,
      run: (state, ui) => chooseRun(context, options, state, ui),
    },
    {
      id: 'friend',
      title: () =>
        tr(
          '加机器人为 QQ 好友',
          'Add the bot as a QQ friend',
          'Agrega el bot como amigo de QQ',
          'Adicione o bot como amigo do QQ',
        ),
      run: async (_state, ui) => {
        ui.lines(...friendLines());
        await ui.checkpoint(QQ_LINKS.console, tr('加好了', 'done', 'listo', 'pronto'));
      },
    },
    {
      id: 'pair',
      title: () => tr('连接并配对', 'Connect and pair', 'Conecta y vincula', 'Conecte e pareie'),
      run: (state, ui) => connectAndPair(context, options, state, ui),
    },
  ];
}

/** A bot set up already: its AppSecret, reset or viewed on q.qq.com, typed and saved (§4.3). */
function renewSteps(context: Context, signedIn: boolean): GuideStep<SetupState>[] {
  return [
    loginStep(context, signedIn),
    {
      id: 'reset',
      title: () =>
        tr(
          '在 q.qq.com 重置 AppSecret',
          'Reset the AppSecret on q.qq.com',
          'Restablece el AppSecret en q.qq.com',
          'Redefina o AppSecret em q.qq.com',
        ),
      run: async (state, ui) => {
        const record = state.record!;
        ui.lines(...resetLines(record.name, record.platformId, Boolean(qqServiceRunning(context))));
        await ui.checkpoint(QQ_LINKS.console, doneText());
      },
    },
    {
      id: 'secret',
      title: () =>
        tr(
          '输入新的 AppSecret',
          'Enter the new AppSecret',
          'Escribe el nuevo AppSecret',
          'Digite o novo AppSecret',
        ),
      run: async (state, ui) => {
        const record = state.record!;
        for (;;) {
          const app = await askApp(ui, record.platformId);
          if ((await checkToken(state, ui, app)) === 'ok') break;
        }
        state.renewing = true;
        return saveRenewedApp(context, state, ui);
      },
    },
  ];
}

// Step 1 ------------------------------------------------------------------------------------------

/**
 * The character a link or id names, as Yomi has it: 'missing' when Yomi refuses it (not there,
 * not published), 'unread' when it could not be asked (the network, the server, or `signal`).
 */
async function readCharacter(
  context: Context,
  npcId: string,
  signal: AbortSignal,
): Promise<RelayCharacter | 'missing' | 'unread'> {
  try {
    const profile = await characterProfile(context.gateway, npcId, signal);
    return { npcId, name: profile.name, group: profile.group };
  } catch (error) {
    if (signal.aborted) return 'unread';
    if (error instanceof ChatRefusal) return 'missing';
    if (error instanceof ApiError && !error.needsSignIn) return 'unread';
    throw error;
  }
}

async function chooseCharacter(
  context: Context,
  state: SetupState,
  ui: GuideUi,
): Promise<StepResult> {
  let prompt = tr(
    '这个机器人固定和一个已发布的 Yomi 角色聊天。在 Yomi App 或网页打开角色，粘贴链接或角色 ID（只显示其中的数字）：',
    'This bot always chats with one published Yomi character. Open the character in the Yomi app or on the web and paste its link or ID (only its digits are shown):',
    'Este bot siempre chatea con un personaje publicado de Yomi. Abre el personaje en la app de Yomi o en la web y pega su enlace o su ID (solo se muestran sus dígitos):',
    'Este bot sempre conversa com um personagem publicado do Yomi. Abra o personagem no app do Yomi ou na web e cole o link ou o ID dele (só os dígitos aparecem):',
  );
  let prefill = state.prefill;
  state.prefill = '';
  for (;;) {
    const input = prefill || (await ui.masked(prompt));
    prefill = '';
    const npcId = characterIdOf(input);
    if (!npcId) {
      prompt = tr(
        '这不像角色链接或角色 ID。再输一次：',
        "That doesn't look like a character link or ID. Try again:",
        'Eso no parece un enlace ni un ID de personaje. Inténtalo de nuevo:',
        'Isso não parece um link nem um ID de personagem. Tente de novo:',
      );
      continue;
    }
    const holder = BotRegistry.open(context.account).byCharacter(npcId);
    if (holder && holder.key !== state.record?.key) {
      const open = holder.kind === 'qq' && !progressOf(context, holder).done;
      if (open && !state.record && (await ui.yesNo(continueHolder(holder)))) {
        state.record = holder;
        state.character = null;
        return;
      }
      if (!open || state.record) ui.fail(boundElsewhere(holder));
      prompt = againText();
      continue;
    }
    const character = await readCharacter(context, npcId, ui.signal);
    ui.check();
    if (character === 'missing' || character === 'unread') {
      prompt =
        character === 'missing'
          ? tr(
              '找不到这个已发布的角色。再输一次：',
              'No published character with this ID. Try again:',
              'No hay ningún personaje publicado con este ID. Inténtalo de nuevo:',
              'Não há nenhum personagem publicado com este ID. Tente de novo:',
            )
          : tr(
              '没能从 Yomi 读到这个角色（网络或服务端出错）。再输一次：',
              "Couldn't read this character from Yomi (network or server error). Try again:",
              'No se pudo leer este personaje de Yomi (error de red o del servidor). Inténtalo de nuevo:',
              'Não foi possível ler este personagem do Yomi (erro de rede ou do servidor). Tente de novo:',
            );
      continue;
    }
    ui.lines(nameAndId(character));
    const right = await ui.yesNo(
      tr(
        '是这个角色吗？',
        'Is this the character?',
        '¿Es este el personaje?',
        'É este o personagem?',
      ),
    );
    if (!right) {
      prompt = againText();
      continue;
    }
    if (!state.record) {
      state.character = character;
      return;
    }
    await bindCharacter(context, state, ui, character);
    return;
  }
}

/** Binds the bot being set up (saved already) to `character` (`relayRebind`, said). */
async function bindCharacter(
  context: Context,
  state: SetupState,
  ui: GuideUi,
  character: RelayCharacter,
) {
  const record = state.record!;
  await changing(context, ui, 'save', () =>
    relayRebind(context, { bot: record.name, characterId: character.npcId, channel: 'qq' }),
  );
  state.record = BotRegistry.open(context.account).find(record.name) ?? record;
}

// Step 3 ------------------------------------------------------------------------------------------

/**
 * The AppID and AppSecret (the AppID of a bot saved already is its own), checked with QQ. An
 * AppID registered already is offered to be set again instead (its AppSecret checked as typed).
 */
async function enterCredentials(
  context: Context,
  state: SetupState,
  ui: GuideUi,
): Promise<StepResult> {
  const fixed = state.record?.platformId ?? '';
  ui.lines(...credentialsLines(fixed));
  let scanned = fixed ? 'manual' : await scannedApp();
  let previous = '';
  for (;;) {
    const app = scanned === 'manual' ? await askApp(ui, fixed, previous) : scanned;
    scanned = 'manual';
    let switched = false;
    if (!state.record) {
      const twin = BotRegistry.open(context.account).byPlatform('qq', app.appId);
      if (twin) {
        const again = await ui.yesNo(
          tr(
            `AppID ${app.appId} 已经是 bot ${twin.name}。要重新设置它的 AppSecret 吗？`,
            `AppID ${app.appId} is the bot ${twin.name} already. Set its AppSecret again?`,
            `El AppID ${app.appId} ya es el bot ${twin.name}. ¿Volver a configurar su AppSecret?`,
            `O AppID ${app.appId} já é o bot ${twin.name}. Configurar o AppSecret dele de novo?`,
          ),
        );
        if (!again) {
          previous = '';
          continue;
        }
        state.record = twin;
        switched = true;
      }
    }
    if ((await checkToken(state, ui, app)) === 'ok') {
      state.renewing = state.record !== null;
      return;
    }
    if (switched) state.record = null;
    previous = fixed ? '' : app.appId;
  }
}

/**
 * Asks QQ for a token with `app` (`TOKEN_CHECKS_MAX` per run): 'ok' (kept in `state`), or
 * 'reenter' when QQ refused the pair; a wait QQ asks for, or no answer, is tried again on Enter.
 */
async function checkToken(state: SetupState, ui: GuideUi, app: QqApp): Promise<'ok' | 'reenter'> {
  for (;;) {
    if (state.checks >= TOKEN_CHECKS_MAX) throw new UsageError(tooManyChecks());
    state.checks += 1;
    ui.lines(checkingText());
    try {
      const { api, identity } = await qqIdentify(app, ui.signal);
      ui.check();
      Object.assign(state, { app, api, identity, checked: null });
      ui.ok(acceptedText(identity.name, app.appId));
      return 'ok';
    } catch (error) {
      ui.check();
      if (!(error instanceof ChannelError)) throw error;
      const problem = tokenProblem(error);
      if (problem.failed) ui.fail(problem.text);
      else ui.lines(problem.text);
      if (problem.next === 'reenter') return 'reenter';
      await ui.enterOrQuit();
    }
  }
}

// Step 4 ------------------------------------------------------------------------------------------

/**
 * Runs `body` (it takes the locks it needs) once no relay in a terminal and no other change are
 * in the way (said, Enter tries again, q quits), with SIGINT left to it; one that got in the way
 * meanwhile is said the same way.
 */
async function changing<T>(
  context: Context,
  ui: GuideUi,
  what: 'save' | 'pair',
  body: () => Promise<T>,
): Promise<T> {
  for (;;) {
    for (let busy = busyNow(context, FLAG); busy; busy = busyNow(context, FLAG)) {
      ui.lines(
        busy.kind === 'relay'
          ? what === 'save'
            ? tr(
                `另一个终端里有 relay 在运行（进程 ${busy.pid}）：先在那边按 Ctrl+C 停止它，然后按回车重试保存。按 q 退出，这次输入的不会保存。`,
                `Another relay is running in a terminal (process ${busy.pid}): stop it with Ctrl+C there, then press Enter to save. q quits without saving.`,
                `Hay otro relay en ejecución en una terminal (proceso ${busy.pid}): detenlo allí con Ctrl+C y luego presiona Enter para guardar. q sale sin guardar.`,
                `Há outro relay em execução em um terminal (processo ${busy.pid}): pare-o lá com Ctrl+C e depois pressione Enter para salvar. q sai sem salvar.`,
              )
            : tr(
                `另一个终端里有 relay 在运行（进程 ${busy.pid}）：先在那边按 Ctrl+C 停止它，然后按回车接着配对。按 q 退出，bot 已保存。`,
                `Another relay is running in a terminal (process ${busy.pid}): stop it with Ctrl+C there, then press Enter to pair. q quits; the bot is saved.`,
                `Hay otro relay en ejecución en una terminal (proceso ${busy.pid}): detenlo allí con Ctrl+C y luego presiona Enter para vincular. q sale; el bot está guardado.`,
                `Há outro relay em execução em um terminal (processo ${busy.pid}): pare-o lá com Ctrl+C e depois pressione Enter para parear. q sai; o bot está salvo.`,
              )
          : tr(
              `另一个 yomi relay 命令正在修改 bot（进程 ${busy.pid}）。等它结束后按回车重试。`,
              `Another yomi relay command is changing bots (process ${busy.pid}). Press Enter when it's done.`,
              `Otro comando de yomi relay está cambiando los bots (proceso ${busy.pid}). Presiona Enter cuando termine.`,
              `Outro comando do yomi relay está mudando os bots (processo ${busy.pid}). Pressione Enter quando terminar.`,
            ),
      );
      await ui.enterOrQuit();
    }
    try {
      return await ui.outside(body);
    } catch (error) {
      // Started meanwhile, between the look and the lock: said as above.
      if (error instanceof UsageError && busyNow(context, FLAG)) continue;
      throw error;
    }
  }
}

/** The bot with the AppID and AppSecret QQ accepted: what QQ gave as its identity. */
function acquired(state: SetupState): AcquiredBot {
  const secret = asciiJson(state.app!);
  return { secret, stored: qqSetup.storedBot(secret)!, identity: state.identity };
}

async function checkAndSave(
  context: Context,
  state: SetupState,
  ui: GuideUi,
  service: boolean,
): Promise<StepResult> {
  if (state.renewing && state.record) return saveRenewedApp(context, state, ui);
  state.checked ??= await checkPrivateChat(ui, state.api!, state, service);
  const appId = state.app!.appId;
  const plan: CredentialsPlan = {
    setup: qqSetup,
    renew: null,
    name: state.name,
    character: state.character,
    atStart: false,
  };
  let record: BotRecord;
  try {
    record = await changing(context, ui, 'save', () =>
      whileStopped(context, FLAG, 'qq', async () =>
        saveAdded(context, BotRegistry.open(context.account), plan, acquired(state)),
      ),
    );
  } catch (error) {
    if (error instanceof DuplicateCharacter) {
      ui.fail(error.message);
      state.character = null;
      return { back: 'character' };
    }
    if (error instanceof UsageError && BotRegistry.open(context.account).byPlatform('qq', appId)) {
      ui.fail(error.message);
      state.app = null;
      state.checked = null;
      return { back: 'credentials' };
    }
    throw error;
  }
  const after = state.checked;
  Object.assign(state, { record, app: null, character: null });
  const character = record.character;
  const where = storeDescription(context.store.kind);
  ui.ok(
    character
      ? tr(
          `已添加 bot ${record.name}，固定和${nameAndId(character)}聊天；AppID 和 AppSecret 已保存（${where}）。`,
          `Added the bot ${record.name}; it always chats with ${nameAndId(character)}. The AppID and AppSecret are saved (${where}).`,
          `Se agregó el bot ${record.name}; siempre chatea con ${nameAndId(character)}. El AppID y el AppSecret están guardados (${where}).`,
          `O bot ${record.name} foi adicionado; ele sempre conversa com ${nameAndId(character)}. O AppID e o AppSecret estão salvos (${where}).`,
        )
      : tr(
          `已添加 bot ${record.name}；AppID 和 AppSecret 已保存（${where}）。`,
          `Added the bot ${record.name}. The AppID and AppSecret are saved (${where}).`,
          `Se agregó el bot ${record.name}. El AppID y el AppSecret están guardados (${where}).`,
          `O bot ${record.name} foi adicionado. O AppID e o AppSecret estão salvos (${where}).`,
        ),
  );
  if (after.after) ui.lines(after.after);
  if (after.end) return { end: true };
}

/** The AppID and AppSecret of a bot saved already, set again (no check of the gateway). */
async function saveRenewedApp(
  context: Context,
  state: SetupState,
  ui: GuideUi,
): Promise<StepResult> {
  const record = state.record!;
  const bot = acquired(state);
  const saved = await changing(context, ui, 'save', () =>
    whileStopped(context, FLAG, 'qq', async () =>
      saveRenewed(context, BotRegistry.open(context.account), record, bot),
    ),
  );
  Object.assign(state, { record: saved, app: null, renewing: false });
  ui.ok(
    tr(
      `已保存 ${saved.name} 的新 AppSecret（${storeDescription(context.store.kind)}）。`,
      `Saved the new AppSecret of ${saved.name} (${storeDescription(context.store.kind)}).`,
      `Se guardó el nuevo AppSecret de ${saved.name} (${storeDescription(context.store.kind)}).`,
      `O novo AppSecret de ${saved.name} foi salvo (${storeDescription(context.store.kind)}).`,
    ),
  );
  // A character chosen for a new bot whose AppID turned out to be this one's.
  const chosen = state.character;
  state.character = null;
  if (chosen && !saved.character) await bindCharacter(context, state, ui, chosen);
  else if (chosen && saved.character && saved.character.npcId !== chosen.npcId)
    ui.lines(
      tr(
        `${saved.name} 固定和${nameAndId(saved.character)}聊天，没有改成刚才选的${chosen.name}。要换角色：yomi relay --bot ${saved.name} --character <ID>`,
        `${saved.name} always chats with ${nameAndId(saved.character)}; it was not changed to ${chosen.name}. To change it: yomi relay --bot ${saved.name} --character <ID>`,
        `${saved.name} siempre chatea con ${nameAndId(saved.character)}; no se cambió a ${chosen.name}. Para cambiarlo: yomi relay --bot ${saved.name} --character <ID>`,
        `${saved.name} sempre conversa com ${nameAndId(saved.character)}; ele não foi trocado para ${chosen.name}. Para trocar: yomi relay --bot ${saved.name} --character <ID>`,
      ),
    );
  if (!progressOf(context, state.record!).done) return;
  ui.say();
  ui.say(finishedLine(false));
  return { end: true };
}

// Step 5 ------------------------------------------------------------------------------------------

async function chooseRun(
  context: Context,
  options: RelayCommandOptions,
  state: SetupState,
  ui: GuideUi,
): Promise<StepResult> {
  ui.lines(
    tr(
      '机器人只在 relay 运行时回复。relay 停着时发给它的消息，机器人收不到，QQ 也不会补发。',
      "The bot only answers while relay runs. Messages sent while relay is stopped never reach it, and QQ doesn't deliver them later.",
      'El bot solo responde mientras relay está en ejecución. Los mensajes enviados mientras relay está detenido nunca le llegan, y QQ no los entrega después.',
      'O bot só responde enquanto o relay está em execução. As mensagens enviadas enquanto o relay está parado nunca chegam a ele, e o QQ não as entrega depois.',
    ),
  );
  let plan: ServicePlan | null = null;
  try {
    plan = hubPlan(context, options);
  } catch {
    plan = null;
  }
  const installed = installedPlans(context)[0] ?? null;
  // Another channel's unit of before the hub, running: it would not run this bot, and no relay
  // runs in this terminal beside it (it holds the environment's lock). Replacing it is offered.
  const other = serviceHolding(context);
  const otherKind = other ? legacyKind(context, other) : null;
  const blocked = Boolean(otherKind && otherKind !== 'qq');
  if (other && otherKind && blocked)
    ui.lines(paint(ui.io, 'yellow', olderServiceText(other, otherKind)));
  const temporary = !installed && plan ? fromTemporaryDir(plan) : null;
  if (temporary) ui.lines(paint(ui.io, 'yellow', temporary));
  const again = installed ? reinstallCommand(installed) : '';
  const service = installed
    ? legacyKind(context, installed)
      ? tr(
          `换成运行所有 bot 的后台服务（沿用原来的参数）：${again}`,
          `Replace the background service with one for every bot (same arguments): ${again}`,
          `Reemplazar el servicio en segundo plano por uno para todos los bots (mismos argumentos): ${again}`,
          `Substituir o serviço em segundo plano por um para todos os bots (mesmos argumentos): ${again}`,
        )
      : tr(
          `用原来的参数启动后台服务：${again}`,
          `Start the background service with its own arguments: ${again}`,
          `Iniciar el servicio en segundo plano con sus propios argumentos: ${again}`,
          `Iniciar o serviço em segundo plano com os argumentos dele: ${again}`,
        )
    : temporary
      ? tr(
          '装成后台服务，登录这台电脑后一直运行',
          "Install the background service, running whenever you're signed in to this computer",
          'Instalar el servicio en segundo plano, en ejecución siempre que inicies sesión en este equipo',
          'Instalar o serviço em segundo plano, em execução sempre que você entrar neste computador',
        )
      : tr(
          '装成后台服务，登录这台电脑后一直运行（推荐）',
          "Install the background service, running whenever you're signed in to this computer (recommended)",
          'Instalar el servicio en segundo plano, en ejecución siempre que inicies sesión en este equipo (recomendado)',
          'Instalar o serviço em segundo plano, em execução sempre que você entrar neste computador (recomendado)',
        );
  const offered = Boolean(installed || plan);
  const choices: [string, string][] = [
    ...(blocked
      ? []
      : [
          [
            '1',
            tr(
              '在这个终端里运行（关掉终端就停）',
              'Run in this terminal (stops when the terminal closes)',
              'Ejecutar en esta terminal (se detiene al cerrar la terminal)',
              'Executar neste terminal (para quando o terminal fechar)',
            ),
          ] as [string, string],
        ]),
    ...(offered ? [['2', service] as [string, string]] : []),
    [
      '3',
      tr(
        '只配对，之后自己运行',
        'Only pair now; run it yourself later',
        'Solo vincular ahora; ejecutarlo tú más tarde',
        'Só parear agora; executar você mesmo depois',
      ),
    ],
  ];
  ui.lines(...choices.map(([key, text]) => `${key}  ${text}`));
  const key = await ui.key(
    tr('选一个（q：退出）：', 'Choose (q: quit):', 'Elige (q: salir):', 'Escolha (q: sair):') + ' ',
    [...choices.map(([key]) => key), 'q'],
    true,
  );
  if (key === 'q') throw new GuideCancelled('quit');
  // Under a service installed, a run here spends under its cap (the running total is shared).
  const shared = () => (installed ? pairingCap(context, options) : options.maxSpend);
  if (key === '1') Object.assign(state, { run: 'terminal', cap: shared() });
  else if (key === '3') Object.assign(state, { run: 'later', cap: shared() });
  else if (installed)
    Object.assign(state, { run: 'restart', cap: installedOptions(installed).maxSpend });
  else {
    state.run = 'service';
    state.cap = options.maxSpend !== null ? options.maxSpend : await askCap(ui);
    ui.lines(
      tr(
        '配对完成后马上安装并启动后台服务。',
        'The background service is installed and started right after pairing.',
        'El servicio en segundo plano se instala y se inicia justo después de la vinculación.',
        'O serviço em segundo plano é instalado e iniciado logo depois do pareamento.',
      ),
    );
  }
}

/** A unit of before the hub (another channel's) runs: it does not run the bot set up here. */
function olderServiceText(plan: ServicePlan, kind: ChannelKind): string {
  const name = channelSetup(kind).displayName;
  return tr(
    `正在运行的后台服务（${plan.label}）是旧版的，只运行${inChinese(name)}的 bot：它不会运行这个 QQ bot，它运行时这个终端里也不能再运行 relay。`,
    `The background service running (${plan.label}) is an older one that runs only ${name} bots: it won't run this QQ bot, and while it runs no relay can run in this terminal.`,
    `El servicio en segundo plano en ejecución (${plan.label}) es uno antiguo que solo ejecuta los bots de ${name}: no ejecutará este bot de QQ, y mientras se ejecute no puede ejecutarse ningún relay en esta terminal.`,
    `O serviço em segundo plano em execução (${plan.label}) é um antigo que só executa os bots do ${name}: ele não vai executar este bot do QQ, e enquanto ele estiver em execução nenhum relay pode ser executado neste terminal.`,
  );
}

/** The background service's cap, asked for (only its digits shown): Enter for none. */
async function askCap(ui: GuideUi): Promise<number | null> {
  let prompt = tr(
    '后台服务运行时没人看着。所有 bot 合计的花费上限（钻石，只显示数字）：直接回车表示不设上限，按 Yomi 的正常规则扣费；输入 0 表示只用免费额度，服务端支持只用免费额度之前，一条也不会发。',
    'Nobody watches a background service. Spending cap for all bots together (gems, digits only): press Enter for no cap, so Yomi charges by its normal rules; 0 means free replies only, and nothing is sent until the server supports them.',
    'Nadie vigila un servicio en segundo plano. Límite de gasto para todos los bots juntos (gemas, solo dígitos): presiona Enter para no poner límite, así Yomi cobra según sus reglas habituales; 0 significa solo respuestas gratis, y no se envía nada hasta que el servidor las admita.',
    'Ninguém acompanha um serviço em segundo plano. Limite de gastos para todos os bots juntos (gemas, só dígitos): pressione Enter para não ter limite, e o Yomi cobra pelas regras normais; 0 significa só respostas grátis, e nada é enviado até o servidor oferecer suporte a elas.',
  );
  for (;;) {
    const typed = await ui.masked(prompt);
    if (!typed) return null;
    if (/^[0-9]{1,7}$/.test(typed) && Number(typed) <= 1_000_000) return Number(typed);
    prompt = tr(
      '这不像钻石数量（0 到 1000000 的整数）。再输一次：',
      "That doesn't look like a number of gems (a whole number from 0 to 1000000). Try again:",
      'Eso no parece una cantidad de gemas (un número entero de 0 a 1000000). Inténtalo de nuevo:',
      'Isso não parece uma quantidade de gemas (um número inteiro de 0 a 1000000). Tente de novo:',
    );
  }
}

// Step 7 ------------------------------------------------------------------------------------------

/** The last line: how to look at the bots (and at the service when one runs them). */
function finishedLine(service: boolean): string {
  return service
    ? tr(
        '完成 · 查看状态：yomi relay --service-status · 列出 bot：yomi relay --list',
        'Done · Status: yomi relay --service-status · Bots: yomi relay --list',
        'Listo · Estado: yomi relay --service-status · Bots: yomi relay --list',
        'Pronto · Status: yomi relay --service-status · Bots: yomi relay --list',
      )
    : tr(
        '完成 · 列出 bot：yomi relay --list',
        'Done · Bots: yomi relay --list',
        'Listo · Bots: yomi relay --list',
        'Pronto · Bots: yomi relay --list',
      );
}

/** The few seconds between the pairing and the service reaching QQ. */
const fewSeconds = () =>
  tr(
    '  配对结束到服务连上 QQ 之间有几秒，这几秒里发的消息可能收不到；没收到回复的话，再发一次。',
    '  For a few seconds between pairing and the service reaching QQ, messages may not arrive; if you get no answer, send it again.',
    '  Durante unos segundos entre la vinculación y la conexión del servicio con QQ, puede que los mensajes no lleguen; si no recibes respuesta, envíalo otra vez.',
    '  Por alguns segundos entre o pareamento e a conexão do serviço com o QQ, as mensagens podem não chegar; se não receber resposta, envie de novo.',
  );

/** What the answer to the pairing came to in QQ (design §2.1, the table after it). */
export function pairedLines(ui: GuideUi, outcome: PairOutcome) {
  ui.ok(
    tr(
      `已配对：QQ 用户 ${masked(outcome.owner)}`,
      `Paired: QQ user ${masked(outcome.owner)}`,
      `Vinculado: usuario de QQ ${masked(outcome.owner)}`,
      `Pareado: usuário do QQ ${masked(outcome.owner)}`,
    ),
  );
  const report = outcome.report;
  if (outcome.gated)
    ui.lines(
      tr(
        '已配对。服务端还没有开放 QQ 通道：开放之前，每条消息都只会收到“服务端已关闭”的答复，不转发、不扣费；开放后自动恢复，介绍会在你发下一条消息时发出。',
        "Paired. The server hasn't enabled the QQ channel yet: until it does, every message is answered that the server switched it off, nothing is relayed or charged; it resumes by itself once enabled, and the introduction goes with your next message.",
        'Vinculado. El servidor todavía no habilitó el canal de QQ: hasta entonces, cada mensaje recibe la respuesta de que el servidor lo desactivó, y no se transmite ni se cobra nada; se reanuda solo cuando se habilite, y la presentación llega con tu próximo mensaje.',
        'Pareado. O servidor ainda não habilitou o canal do QQ: até lá, cada mensagem recebe a resposta de que o servidor o desativou, e nada é encaminhado nem cobrado; ele volta sozinho quando for habilitado, e a apresentação vai com a sua próxima mensagem.',
      ),
    );
  else if (report?.notFriend)
    ui.fail(
      tr(
        '配对成功了，但 QQ 不让机器人回复你：你还不是它的好友（40054004）。加好友后随便发一条消息，排队的介绍会跟着发出。',
        "Paired, but QQ doesn't let the bot answer you: you aren't its friend yet (40054004). Add it as a friend, then send any message: the introduction waiting in the queue goes with it.",
        'Vinculado, pero QQ no deja que el bot te responda: todavía no eres su amigo (40054004). Agrégalo como amigo y envía cualquier mensaje: la presentación en espera va con él.',
        'Pareado, mas o QQ não deixa o bot responder: você ainda não é amigo dele (40054004). Adicione-o como amigo e envie qualquer mensagem: a apresentação na fila vai junto.',
      ),
    );
  else if (report && report.sent > 0 && !report.failed)
    ui.ok(
      tr(
        '机器人已在 QQ 里回复：配对结果、封面、简介和开场白。',
        'The bot answered in QQ: the pairing result, cover, introduction and opening.',
        'El bot respondió en QQ: el resultado de la vinculación, la portada, la presentación y el saludo inicial.',
        'O bot respondeu no QQ: o resultado do pareamento, a capa, a apresentação e a mensagem de abertura.',
      ),
    );
  else
    ui.lines(
      tr(
        '已在 QQ 里回复配对结果。没看到的话，确认已经加了好友，再发一条消息。',
        "The pairing was answered in QQ. If you don't see it, make sure you added the bot as a friend, then send another message.",
        'La vinculación se respondió en QQ. Si no la ves, confirma que agregaste el bot como amigo y envía otro mensaje.',
        'O pareamento foi respondido no QQ. Se você não vê a resposta, confira se adicionou o bot como amigo e envie outra mensagem.',
      ),
    );
}

/** A line of a run of several bots names its bot first: `[name] …`. */
const BOT_PREFIX = /^\[[^\]]*\] /;

/**
 * What the run of the pairing tells the guide (`GuideHooks`), said here: connected (and the code),
 * a new code, paired (what the answer came to), the run's log in grey (the line naming the owner
 * said masked instead, and the bot's lines between it and what the answer came to, about the
 * welcome and its sends, left to `pairedLines`); not connected after `GUIDE_TIMINGS.notConnectedMs`
 * of the run (`during`), why (the last line of the log naming QQ). The guide's bot stopping for good
 * before it paired ends the run. `terminal`: the run goes on once paired, logging as `yomi relay`
 * does.
 */
function pairingWatch(ui: GuideUi, record: BotRecord, terminal: boolean) {
  const { io } = ui;
  const result: { outcome: PairOutcome | null; ended: 'aborted' | 'ended' | null } = {
    outcome: null,
    ended: null,
  };
  let code = '';
  let ready = false;
  let handedOff = false;
  let pairing = false;
  let last = '';
  let told = '';
  const ownLine = (line: string) => !BOT_PREFIX.test(line) || line.startsWith(`[${record.name}] `);
  const showCode = () => {
    ui.say();
    ui.say(`      ${paint(io, 'bold', `/pair ${code}`)}`);
    ui.say();
    ui.lines(
      tr(
        '配对码 15 分钟内有效，只能用一次，只显示在这个终端里：不要发给别人。',
        "The pairing code is valid for 15 minutes, works once and is shown only in this terminal: don't send it to anyone.",
        'El código de vinculación es válido durante 15 minutos, funciona una sola vez y solo se muestra en esta terminal: no se lo envíes a nadie.',
        'O código de pareamento vale por 15 minutos, funciona uma única vez e só aparece neste terminal: não o envie para ninguém.',
      ),
      tr(
        '等你发送……（Ctrl+C 退出：bot 已保存，之后运行 yomi relay --setup 接着配对）',
        'Waiting… (Ctrl+C quits: the bot is saved; run yomi relay --setup later to pair)',
        'Esperando… (Ctrl+C sale: el bot está guardado; ejecuta yomi relay --setup más tarde para vincularlo)',
        'Aguardando… (Ctrl+C sai: o bot está salvo; execute yomi relay --setup depois para pareá-lo)',
      ),
    );
  };
  const notConnected = () => {
    if (ready || result.outcome) return;
    const reason =
      last || tr('还在连接', 'still connecting', 'todavía conectando', 'ainda conectando');
    if (reason === told) return;
    told = reason;
    ui.lines(
      tr(
        `还没连上 QQ：${reason}。可以继续等；按 Ctrl+C 退出，bot 已保存。`,
        `Not connected to QQ yet: ${reason}. Keep waiting, or Ctrl+C to quit; the bot is saved.`,
        `Todavía no hay conexión con QQ: ${reason}. Sigue esperando, o Ctrl+C para salir; el bot está guardado.`,
        `Ainda sem conexão com o QQ: ${reason}. Continue esperando, ou Ctrl+C para sair; o bot está salvo.`,
      ),
    );
  };
  const hooks: GuideHooks = {
    bot: record.name,
    onCode(display) {
      code = display;
      if (!ready || result.outcome) return;
      ui.lines(
        paint(
          io,
          'yellow',
          tr(
            '配对码过期了，新的配对码：',
            'The pairing code expired. New pairing code:',
            'El código de vinculación expiró. Nuevo código de vinculación:',
            'O código de pareamento expirou. Novo código de pareamento:',
          ),
        ),
      );
      showCode();
    },
    onReady() {
      if (ready) return;
      ready = true;
      ui.ok(
        tr(
          `已连上（q.qq.com 上这个机器人应该显示${Z.online}）。在手机 QQ 里打开和「${record.label}」的私聊，发送：`,
          `Connected (q.qq.com should now show the bot as ${Z.online} (online)). In QQ on your phone, open the private chat with "${record.label}" and send:`,
          `Conectado (q.qq.com debería mostrar el bot como ${Z.online} (en línea)). En QQ en tu teléfono, abre el chat privado con "${record.label}" y envía:`,
          `Conectado (q.qq.com deve mostrar o bot como ${Z.online} (online)). No QQ do celular, abra o chat privado com "${record.label}" e envie:`,
        ),
      );
      showCode();
    },
    onPaired(outcome) {
      pairing = false;
      result.outcome = outcome;
      pairedLines(ui, outcome);
      if (!terminal) return;
      const character = record.character?.name ?? '';
      ui.ok(
        tr(
          `relay 接着在这个终端里运行：直接回复，就是在和${character}聊天。关掉终端或按 Ctrl+C 就停。`,
          `Relay goes on running in this terminal: just reply to chat with ${character}. Closing the terminal or Ctrl+C stops it.`,
          `Relay sigue en ejecución en esta terminal: solo responde para chatear con ${character}. Cerrar la terminal o Ctrl+C lo detiene.`,
          `O relay continua em execução neste terminal: é só responder para conversar com ${character}. Fechar o terminal ou Ctrl+C o para.`,
        ),
      );
      handedOff = true;
    },
    onLog(line, kind) {
      if (handedOff) return void io.stderr.write(`${new Date().toISOString()} ${line}\n`);
      if (kind === 'paired') {
        pairing = true;
        return;
      }
      // The welcome and its sends, said by `pairedLines` once they are known (a grey line here
      // could say "sent" for what QQ only queued, or name the wrong cause).
      if (pairing && ownLine(line)) return;
      // Said already (the server's policy before step 1), by any bot of the run.
      if (ui.notes.has(line) || ui.notes.has(line.replace(BOT_PREFIX, ''))) return;
      // Why it is not connected: the channel's own lines (they name QQ), not the relay's start.
      if (line.includes('QQ')) last = line;
      ui.notes.add(line);
      ui.note(line);
    },
    onStopped: () => !result.outcome,
    onEnd(how) {
      result.ended = how;
    },
  };
  /** Runs `body` (the run), "not connected yet" said while it goes on, not while it waits. */
  const during = async <T>(body: () => Promise<T>): Promise<T> => {
    const timer = setInterval(notConnected, GUIDE_TIMINGS.notConnectedMs);
    timer.unref?.();
    try {
      return await body();
    } finally {
      clearInterval(timer);
    }
  };
  return { hooks, result, during };
}

/**
 * The options a background service runs with after the guide, to install it (or say how): an
 * installed one's own (its cap above all, as `reinstallCommand` keeps them; `own`), else the cap
 * step 5 chose with this run's `--allow-file-store` and `--no-drafts`.
 */
function serviceOptions(
  options: RelayCommandOptions,
  state: SetupState,
  own: ServicePlan | null,
): RelayCommandOptions {
  if (own) {
    const kept = installedOptions(own);
    return { ...kept, allowFileStore: kept.allowFileStore || options.allowFileStore };
  }
  return {
    ...PLAIN_OPTIONS,
    allowFileStore: options.allowFileStore,
    maxSpend: state.cap,
    drafts: options.drafts,
  };
}

/**
 * Step 7: the bot connected and paired in this process (design §4.2): with the background service
 * running, under it stopped (`pairUnderService`); else a run of this bot until it is paired, or of
 * every bot going on in this terminal (step 5's 1). Then the service installed or started (2), or
 * how to run it (3). Another channel's unit of before the hub, running, is stopped for the pairing
 * too, but does not run this bot after it: step 5's choice still says how it runs.
 */
async function connectAndPair(
  context: Context,
  options: RelayCommandOptions,
  state: SetupState,
  ui: GuideUi,
): Promise<StepResult> {
  const record = BotRegistry.open(context.account).find(state.record!.name) ?? state.record!;
  state.record = record;
  ui.lines(tr('正在连接 QQ……', 'Connecting to QQ…', 'Conectando con QQ…', 'Conectando ao QQ…'));
  const wait = state.identifiedAt + GUIDE_TIMINGS.identifyIntervalMs - Date.now();
  if (state.identifiedAt && wait > 0) {
    ui.note(spacingText());
    await ui.sleep(wait);
  }
  const credential = requireSignIn(context);
  const registry = openRegistry(context);
  const service = serviceHolding(context);
  const older = service && !qqServiceRunning(context) ? service : null;
  // No run in this terminal beside a service (one of before the hub that started meanwhile).
  const chosen = state.run === 'terminal' && service ? 'later' : (state.run ?? 'later');
  const run = service && !older ? 'running' : chosen;
  const terminal = run === 'terminal';
  const runOptions: RelayCommandOptions = {
    ...options,
    characterId: '',
    pair: false,
    resetSpend: false,
    maxSpend: state.cap,
  };
  const watch = pairingWatch(ui, record, terminal);
  state.waiting = true;
  let restarted: ServicePlan | null = null;
  if (service)
    restarted = await changing(context, ui, 'pair', () =>
      watch.during(() =>
        pairUnderService(
          context,
          registry,
          [{ setup: qqSetup, record }],
          runOptions,
          credential,
          FLAG,
          watch.hooks,
        ),
      ),
    );
  else {
    const selected = terminal
      ? registry.list().map((item) => ({ setup: channelSetup(item.kind), record: item }))
      : [{ setup: qqSetup, record }];
    await changing(context, ui, 'pair', () =>
      watch.during(() =>
        relayRun(context, registry, selected, runOptions, credential, !terminal, watch.hooks),
      ),
    );
  }
  const { outcome, ended } = watch.result;
  if (!outcome) {
    if (ended === 'aborted') throw new GuideCancelled('interrupt');
    throw new UsageError(
      tr(
        `${record.name} 已保存，还没有配对。修好后运行 yomi relay --setup 接着配对。`,
        `${record.name} is saved, not paired yet. Once that is fixed, run yomi relay --setup to pair it.`,
        `${record.name} está guardado, todavía sin vincular. Cuando se solucione, ejecuta yomi relay --setup para vincularlo.`,
        `${record.name} está salvo, ainda não pareado. Quando isso estiver resolvido, execute yomi relay --setup para pareá-lo.`,
      ),
    );
  }
  state.waiting = false;
  if (terminal) {
    if (ended === 'aborted') {
      ui.say(tr('relay 已停止。', 'Relay stopped.', 'El relay se detuvo.', 'O relay parou.'));
      process.exitCode = 130;
    }
    return;
  }
  const character = record.character?.name ?? '';
  if (run === 'running' && restarted) {
    ui.ok(
      tr(
        `后台服务已重新启动，${record.name} 在里面运行：直接回复，就是在和${character}聊天。`,
        `The background service started again with ${record.name} in it: just reply to chat with ${character}.`,
        `El servicio en segundo plano volvió a iniciarse con ${record.name}: solo responde para chatear con ${character}.`,
        `O serviço em segundo plano iniciou de novo com ${record.name}: é só responder para conversar com ${character}.`,
      ),
    );
    ui.say(fewSeconds());
    ui.say();
    ui.say(finishedLine(true));
    return;
  }
  const installed = installedPlans(context)[0] ?? null;
  if (run === 'service' || run === 'restart') {
    const install = serviceOptions(options, state, run === 'restart' ? installed : null);
    ui.lines(
      tr(
        '正在安装后台服务……',
        'Installing the background service…',
        'Instalando el servicio en segundo plano…',
        'Instalando o serviço em segundo plano…',
      ),
    );
    try {
      await ui.outside(() =>
        installRelayService(context, { ...install, installService: true, confirmProd: true }),
      );
    } catch (error) {
      // What to run once it is fixed keeps the cap (and the rest) this install had.
      const again = relayCommand(install, '--install-service');
      throw new UsageError(
        `${error instanceof Error ? error.message : String(error)}\n${tr(
          `${record.name} 已配对；修好后运行 ${again}。`,
          `${record.name} is paired; once that is fixed, run ${again}.`,
          `${record.name} está vinculado; cuando se solucione, ejecuta ${again}.`,
          `${record.name} está pareado; quando isso estiver resolvido, execute ${again}.`,
        )}`,
      );
    }
    ui.ok(
      tr(
        `后台服务已启动，${record.name} 在里面运行：直接回复，就是在和${character}聊天。`,
        `The background service is running ${record.name}: just reply to chat with ${character}.`,
        `El servicio en segundo plano está ejecutando ${record.name}: solo responde para chatear con ${character}.`,
        `O serviço em segundo plano está executando ${record.name}: é só responder para conversar com ${character}.`,
      ),
    );
    ui.say(fewSeconds());
    ui.say();
    ui.say(finishedLine(true));
    return;
  }
  if (older && restarted) {
    const again = reinstallCommand(older);
    ui.lines(
      tr(
        `${record.name} 已配对，但正在运行的旧版后台服务不运行它：现在发给机器人的消息它收不到。运行 ${again} 换成运行所有 bot 的后台服务以后，直接回复就能聊。`,
        `${record.name} is paired, but the older background service running does not run it: messages to the bot now never reach it. Once you run ${again} to replace it with one for every bot, just reply to chat.`,
        `${record.name} está vinculado, pero el servicio en segundo plano antiguo en ejecución no lo ejecuta: los mensajes que le envíes al bot ahora no le llegan. Cuando ejecutes ${again} para reemplazarlo por uno para todos los bots, solo responde para chatear.`,
        `${record.name} está pareado, mas o serviço em segundo plano antigo em execução não o executa: as mensagens enviadas ao bot agora não chegam a ele. Depois de executar ${again} para substituí-lo por um para todos os bots, é só responder para conversar.`,
      ),
    );
    ui.say();
    ui.say(finishedLine(false));
    return;
  }
  // How to run it later, with the cap (and the rest) it would run with.
  const later = serviceOptions(options, state, null);
  const inTerminal = relayCommand(later);
  const asService = installed
    ? relayCommand(serviceOptions(options, state, installed), '--install-service')
    : relayCommand(later, '--install-service');
  ui.lines(
    tr(
      `relay 已停止：现在发给机器人的消息它收不到。运行 ${inTerminal}（终端）或 ${asService}（后台服务）以后，直接回复就能聊。`,
      `Relay has stopped: messages to the bot now never reach it. Once you run ${inTerminal} (in a terminal) or ${asService} (a background service), just reply to chat.`,
      `Relay se detuvo: los mensajes que le envíes al bot ahora no le llegan. Cuando ejecutes ${inTerminal} (en una terminal) o ${asService} (un servicio en segundo plano), solo responde para chatear.`,
      `O relay parou: as mensagens enviadas ao bot agora não chegam a ele. Depois de executar ${inTerminal} (em um terminal) ou ${asService} (um serviço em segundo plano), é só responder para conversar.`,
    ),
  );
  ui.say();
  ui.say(finishedLine(false));
}

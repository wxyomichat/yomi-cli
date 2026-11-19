import { randomBytes, randomUUID } from 'node:crypto';

import {
  CHARACTER_REMOVED,
  ChatRefusal,
  characterProfile,
  characterReportReasons,
  ConsumptionMode,
  conversationId,
  type FeedbackReason,
  feedbackReasons,
  INSUFFICIENT_GEMS,
  listMessages,
  openingOf,
  pollMessages,
  replyCost,
  type SendAnswer,
  sendMessage,
  submitCharacterReport,
  submitFeedback,
} from '../chat/api.js';
import { ApiError, type Gateway, NotSignedIn } from '../core/api.js';
import { tr } from '../core/i18n.js';
import { LocalState } from '../core/state.js';
import { VERSION } from '../core/version.js';
import {
  CHAT_IMAGE_POLL_MS,
  CHAT_IMAGE_TIMEOUT_MS,
  type ChatImageTask,
  chatImageAspectRatio,
  chatImageBillingSettled,
  chatImageDone,
  chatImageRefusal,
  chatImageRequest,
  chatImageRequestId,
  contentRejected,
  createChatImageTask,
  getChatImageConfig,
  getChatImageTask,
  ImageBilling,
  ImageDelivery,
  ImageGeneration,
} from '../gen/chatImage.js';
import { download, extensionOf, type GenRefusal } from '../gen/common.js';
import { sniffMime } from '../gen/raster.js';
import { ImConnection, type SocketFactory } from '../im/connection.js';
import {
  asidePlainText,
  type ImMessage,
  type ImParagraph,
  Semantic,
  SenderType,
} from '../im/models.js';
import { BusinessType, Command } from '../im/packet.js';
import {
  type AsideEvent,
  ConversationPurpose,
  type StreamEvent,
  StreamEventType,
} from '../im/thrift.js';
import { walletBalance } from '../ugc/api.js';
import { TelegramChannel } from './channels/telegram.js';
import {
  type AskRef,
  type BotIdentity,
  ChannelError,
  type ChannelHost,
  type InboundAnswer,
  type InboundCommand,
  type InboundEvent,
  type InboundMessage,
  type OutgoingFile,
  type OutgoingText,
  type PauseReason,
  type Question,
  type RelayChannel,
  RelayStopped,
  type ReplyContext,
  type ReplyPresenter,
} from './channels/types.js';
import { PairingCode } from './pairing.js';
import {
  channelPolicy,
  compareVersions,
  DEFAULT_POLICY,
  POLICY_REFETCH_MS,
  type RelayPolicy,
  relayPolicy,
} from './policy.js';
import { renderReply } from './render.js';
import { type BillingMode, type RelayCharacter, type RelayState } from './state.js';
import { TelegramBot } from './telegram.js';
import {
  type ImageBillingNote,
  relayCommands,
  relayTexts,
  type RelayTexts,
  spaced,
} from './texts.js';

/**
 * `yomi relay`: the owner's private chat with their own bot (Telegram, QQ, WeChat: a
 * `RelayChannel`) ⇄ a published Yomi character, through the same chat APIs as the app.
 *
 * - Only the paired owner is served (private chat, their user id, not a bot); anyone else is
 *   ignored before anything reaches Yomi, so strangers cost nothing. Groups are left.
 * - A reply is ours only if its `stream_id` came back from our own `send_message`: the account's
 *   other devices get the same pushes, and none of them is ever relayed.
 * - Only reviewed `paragraphs` are shown; a chunk's `text` and `thinking_content` never are.
 * - Money: by default there is no cap and Yomi charges by its normal rules, as in the app; when
 *   the balance is too low the server refuses the send and the owner is told so in the chat, and
 *   the relay keeps running. Two caps are optional: `/budget <amount>` in the chat (confirmed with
 *   a button or a typed code; `/budget none` goes back to no cap, confirmed the same way when it
 *   lifts one) and `--max-spend` on this computer, whose running total nothing from the chat
 *   resets; `/budget off` and `--max-spend 0` mean free replies only. Every send is measured (the
 *   server's `charged_diamonds`, else the balance before and after) and booked, so the total is
 *   known. Under a cap measuring is strict: a charge that could not be measured yet stays pending
 *   (across restarts) and is settled before the next send, and when the balance cannot be read
 *   nothing is sent. Without one it is bookkeeping only: a pending charge is settled when a reading
 *   comes (a send never replaces a pending charge before it is settled: the reading measures both),
 *   and an unreadable balance blocks nothing; what could not be measured is counted. A spent cap
 *   pauses the relay, and so does a "free" reply that was charged under free-only or a budget. A
 *   send is never repeated.
 * - The channel only translates: its inbound events in, the core's sends out under its own reply
 *   rules. Every rule about money, consent, policy and Yomi is here, the same on every channel.
 * - `/image` asks for a picture of a reply (one at a time, like a reply): a priced one goes as a
 *   reply does (refused under free-only, within a cap when one is set) and is measured like a
 *   reply. The request is kept before it is sent and resent only as the same request (`/image
 *   resume`); only a request whose outcome is unknown may be dropped (`/image forget`). Its charge
 *   lands on delivery, so it is measured once the task has ended (or its 180 s window has passed),
 *   never earlier. Under a cap nothing else is sent until then; without one a reply goes anyway
 *   once the picture is delivered (following its charge stops first) and its cost lands in the
 *   image's measurement (the image is booked by its task, the rest is the replies'). The picture is forwarded only when it is the result of this relay's own task,
 *   never another device's.
 * - The long connection never gives up, reconnects after sleep, and reads `poll_message` on every
 *   connect; a reply that still did not arrive is read back from history.
 * - What the server promises lives in `relay/get_policy`; without it no server feature is assumed
 *   (FreeOnly, the spend cap, the notices): free-only sends nothing, a cap (a budget or
 *   `--max-spend`) needs a known price, and the relay shows its own notices. Without a cap none
 *   of that is needed.
 */

export type RelayOptions = {
  /**
   * Gems the relay may spend at most, set on this computer (`--max-spend`): null, no local cap
   * (Yomi charges by its normal rules); 0, free replies only.
   */
  maxSpend: number | null;
  /** Start the local ceiling's running total over (`--reset-spend`). */
  resetSpend?: boolean;
  /** Character to start with (`--character`), '' to keep the saved one. */
  characterId: string;
  /** Pairing code while unpaired (foreground runs only), else null. */
  pairing: PairingCode | null;
  /** Called when a spent or expired code is replaced (the terminal shows the new one). */
  onPairingCode?: (code: PairingCode) => void;
  replyTimeoutMs: number;
  /** Minimum time between two Telegram calls in the chat (when a `TelegramBot` is given). */
  intervalMs: number;
  /** Messages older than this (sent while the relay was off) are not relayed. */
  staleMs: number;
  /** Telegram's long poll (when a `TelegramBot` is given). */
  pollTimeoutSeconds: number;
  /** Telegram drafts, else edits (when a `TelegramBot` is given). */
  drafts: boolean;
  language: string;
  log: (line: string) => void;
  createSocket?: SocketFactory;
  /** How often a paused (signed out) relay looks for a new sign-in. */
  resumeCheckMs?: number;
  /** How often a requested image's task is read (2 s, as the app does) and for how long (180 s). */
  imagePollMs?: number;
  imageTimeoutMs?: number;
  /** Where a requested image is kept until its cost is settled; this account's state by default. */
  records?: LocalState;
  /** The command that starts this relay again, for the owner (`yomi relay --telegram`). */
  rerunCommand?: string;
  /**
   * QQ and WeChat relay only on a policy the server sent for them (production); without one
   * every message is answered that the server switched them off (policy.ts `channelPolicy`).
   */
  requireServerPolicy?: boolean;
  /** How long such a gated channel waits before an owner message asks the server again (60 s). */
  policyRefetchMs?: number;
};

// Moved to channels/types.ts with the reasons other channels add; imports from here keep working.
export { RelayStopped };

type Turn = {
  character: RelayCharacter;
  chatId: string;
  /** The owner message it answers. */
  context: ReplyContext;
  streamId: string;
  assistantMid: string;
  cid: string;
  presenter: ReplyPresenter;
  lastSeq: number;
  settled: boolean;
  mode: BillingMode;
  /** The server reported this turn's charge and it is booked. */
  booked: boolean;
  /** The pending charge was stored for this send alone: a sure refusal clears it. */
  ownPending: boolean;
  /** Its end settles the pending charge; not while it rides along an image's measurement. */
  settles: boolean;
  /** Nothing measures it: unless the server says what it cost, it is counted as unmeasured. */
  unmeasured: boolean;
  /** Once settled: shown and booked (`finishTurn`). */
  finished: Promise<void> | null;
  watchdog: ReturnType<typeof setTimeout> | null;
};

/**
 * A requested image until its gems are settled, kept across restarts (one per bot: per channel
 * scope). The request is frozen before it is sent: a resend is the same `client_request_id` and
 * the same body.
 */
type ImageRecord = {
  requestId: string;
  /** The `create_task` body as sent. */
  body: string;
  npcId: string;
  name: string;
  /** The reply it is drawn from; '' for the opening. */
  anchorMid: string;
  cid: string;
  /** '' while the server's answer is unknown. */
  taskId: string;
  /** The billing mode then and the price shown (0: free). */
  mode: BillingMode;
  price: number;
  /**
   * The pending charge is this image's own measurement (absent in older records: it was). False
   * (only without a cap): another measurement was open, or the balance unreadable; it is booked
   * by its task alone.
   */
  measured?: boolean;
  /** What it costs if charged (the full price; a free one is charged this once the quota is gone). */
  worst: number;
  /** The owner's chat it goes to (as the channel persists ids: a number for Telegram). */
  chatId: number | string;
  /** The owner was told how it ended (the picture, or why there is none). */
  told: boolean;
  /** A refund was under way when the owner was told. */
  refunding: boolean;
  /**
   * When the request was made, then when its task became known, then when the owner was told how
   * it ended: the 180 s window runs from here (within it, a delivered picture's charge is waited
   * for, so a picture delivered late still gets its full window).
   */
  at: number;
};

/** Following one image's task until it is delivered (or not) and settled. */
type ImageJob = {
  record: ImageRecord;
  /** `MessagePersisted` pushes that may be its picture, by mid. */
  pushes: Map<string, ImMessage>;
  /** Reads the task now instead of after the pause. */
  wake: () => void;
  stop: AbortController;
  done: Promise<void>;
};

const IMAGE_RECORDS = 'relay-chat-image';

/** Pauses that come from the session or the server; worked out again on every start. */
type Gate = '' | 'signedOut' | 'disabled' | 'tooOld';

/** An open question (buttons, or a typed code), by its nonce. */
type Button =
  /** `amount` null: no budget (`/budget none`). */
  | { kind: 'budget'; amount: number | null; ref: AskRef }
  | { kind: 'report'; npcId: string; mid: string; reasons: FeedbackReason[]; ref: AskRef }
  | { kind: 'reportCharacter'; npcId: string; reasons: FeedbackReason[]; ref: AskRef };

/** Server notices the relay passes on whatever reply they follow (contract §5). */
const NOTICE_SCENES = new Set([
  'ai_disclosure',
  'break_reminder',
  'minor_notice',
  'crisis_support',
]);
const THREE_HOURS = 3 * 60 * 60 * 1000;
const PRICE_TTL = 5 * 60 * 1000;
/** How long a stop waits for the open reply's presenter at shutdown before giving up on it. */
const SHUTDOWN_STOP_MS = 3000;

/**
 * Whether a failed send may still have been accepted (and charged): no answer at all, a timeout,
 * or a server error. A 4xx (other than a timeout) or a named refusal means it was not.
 */
export function unknownOutcome(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== ApiError.transport) return false;
  const status = error.httpStatus;
  return status === 0 || status === 408 || status >= 500;
}

/** A picture's download gives up after a minute: a stalled one must not hold the relay. */
const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(60_000) });

/** What happened to an image's gems (`ImageBillingStatus`), for the owner. */
function billingNote(status: number): ImageBillingNote {
  switch (status) {
    case ImageBilling.chargePending:
      return 'pending';
    case ImageBilling.charged:
      return 'charged';
    case ImageBilling.refundPending:
      return 'refunding';
    case ImageBilling.refunded:
      return 'refunded';
    case ImageBilling.manualReview:
      return 'review';
    default:
      return 'none';
  }
}

export class Relay {
  private turn: Turn | null = null;
  private early = new Map<string, StreamEvent[]>();
  private connection: ImConnection | null = null;
  private policy: RelayPolicy = DEFAULT_POLICY;
  private readonly texts: RelayTexts;
  private price: { npcId: string; value: number | null; at: number } | null = null;
  private buttons = new Map<string, Button>();
  private asides = new Set<string>();
  private noticed = new Set<string>();
  /** Assistant mids of replies this relay asked for (asides anchored on them are ours). */
  private ownMids = new Set<string>();
  /** Characters whose price the owner saw under the current budget. */
  private priceShown = new Set<string>();
  /** Characters whose image price the owner saw under the current budget. */
  private imagePriceShown = new Set<string>();
  /** The image being followed, at most one (and never beside a reply). */
  private job: ImageJob | null = null;
  /** `(cid, mid)` of the `MessagePersisted` pushes seen. */
  private persisted = new Set<string>();
  private readonly records: LocalState;
  private gate: Gate = '';
  private strangers = 0;
  private resumeTimer: ReturnType<typeof setInterval> | null = null;
  private stopReason: RelayStopped | null = null;
  private readonly abort = new AbortController();
  private readonly userId: string;
  private readonly channel: RelayChannel;
  /** What the channel may use of the relay, for the whole run. */
  private readonly host: ChannelHost;
  private identity: BotIdentity = { id: '', name: '', handle: '' };
  /** The context of the latest owner message: every send to the owner names it. */
  private replyTo: ReplyContext | null = null;
  /** The channel asked for a pause (`host.pause`); null while it relays. */
  private channelPause: { reason: PauseReason; until: number | null } | null = null;
  /** The server has not confirmed this channel (production): asked again now and then. */
  private policyGated = false;
  private policyAt = 0;

  /** `channel`: a `RelayChannel`, or a `TelegramBot` (made Telegram's channel with `options`). */
  constructor(
    private readonly gateway: Gateway,
    channel: RelayChannel | TelegramBot,
    private readonly state: RelayState,
    private readonly options: RelayOptions,
  ) {
    this.channel =
      channel instanceof TelegramBot
        ? new TelegramChannel(channel, {
            drafts: options.drafts,
            intervalMs: options.intervalMs,
            pollTimeoutSeconds: options.pollTimeoutSeconds,
          })
        : channel;
    this.texts = relayTexts(options.language);
    this.userId = gateway.requireCredential().userId;
    // One file per bot: a relay of another bot of this account saves its own copy whole.
    this.records =
      options.records ??
      new LocalState(`relay|${state.data.account}|${this.channel.scope}`, this.userId);
    this.host = {
      state,
      store: state.channelStore(),
      texts: this.texts,
      language: options.language,
      log: (line) => this.log(line),
      // The relay's own: a change of Yomi account aborts this one, not the caller's.
      signal: this.abort.signal,
      staleMs: options.staleMs,
      owner: () => this.ownerIds(),
      pause: (reason, until) => this.pauseChannel(reason, until),
      resume: () => this.resumeChannel(),
    };
  }

  private log(line: string) {
    this.options.log(line);
  }

  /** Runs until `signal` aborts or the relay has to stop (`RelayStopped`). */
  async run(signal: AbortSignal): Promise<void> {
    const onAbort = () => this.abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.prepare();
      await this.poll();
    } finally {
      signal.removeEventListener('abort', onAbort);
      const job = this.job;
      // The open reply is stopped first, so what its presenter still sends reaches the channel
      // before the channel lets go of what it holds.
      await this.shutdown();
      // Nothing reaches the chat after the relay stopped.
      await job?.done;
      await this.channel.close().catch(() => undefined);
    }
    if (this.stopReason) throw this.stopReason;
  }

  private async prepare() {
    this.identity = await this.channel.verify();
    this.state.update({ botUsername: this.identity.handle });
    await this.channel.connect(this.host);
    await this.channel.setCommands(relayCommands(this.options.language)).catch(() => undefined);
    if (this.state.bindAccount(this.userId))
      this.log(
        tr(
          '这台电脑上登录的 Yomi 账号和上次不同：预算、角色和记录已重置',
          'A different Yomi account is signed in on this machine than last time: budget, character and records have been reset',
          'En este equipo inició sesión una cuenta de Yomi distinta de la última vez: se restablecieron el presupuesto, el personaje y los registros',
          'Uma conta do Yomi diferente da última vez está conectada nesta máquina: orçamento, personagem e registros foram redefinidos',
        ),
      );
    this.state.useAllowance(this.options.maxSpend, Boolean(this.options.resetSpend));
    this.liftStalePause();
    await this.readPolicy(true);
    if (this.options.characterId) await this.chooseCharacter(this.options.characterId, false);
    const kept = this.keptImage();
    // A kept image's charge lands on delivery, maybe after this start: its own conclusion (or the
    // next send) settles it, never a reading taken now.
    if (this.state.data.pending && !kept && !(await this.settlePending()))
      this.log(
        tr(
          '上次有一条消息的花费还没核对：读不到余额，下一条发送前再核对',
          "The cost of a message from last time is not checked yet: can't read the balance, will check before the next send",
          'El costo de un mensaje de la vez anterior aún no se verificó: no se puede leer el saldo, se verificará antes del próximo envío',
          'O custo de uma mensagem da última vez ainda não foi conferido: não foi possível ler o saldo, será conferido antes do próximo envio',
        ),
      );
    // A picture asked for before the restart is still followed (and forwarded when it is ours).
    if (kept?.taskId) {
      this.log(
        tr(
          '上次请求的图片还没有结算，继续跟进',
          'The image requested last time is not settled yet, still following it',
          'La imagen solicitada la vez anterior aún no se liquidó, se sigue su estado',
          'A imagem solicitada da última vez ainda não foi finalizada, continuando a acompanhá-la',
        ),
      );
      this.startImageJob(kept);
    } else if (kept)
      this.log(
        tr(
          '上次的生图请求结果未知：主人发送 /image resume 用同一个请求重发',
          'The outcome of the last image request is unknown: the owner can send /image resume to resend the same request',
          'El resultado de la última solicitud de imagen es desconocido: el dueño puede enviar /image resume para reenviar la misma solicitud',
          'O resultado da última solicitação de imagem é desconhecido: o dono pode enviar /image resume para reenviar a mesma solicitação',
        ),
      );
    this.logMoney();
    this.connect();
  }

  /**
   * Without a budget, a pause this run's limits no longer hold is lifted: a cap spent under an
   * earlier `--max-spend` (also under `--max-spend 0`: free-only spends nothing, as `/budget off`
   * lifts it), or a charged "free" reply once free-only is no longer asked for. Under a budget
   * only the owner lifts it (`/budget`), as always.
   */
  private liftStalePause() {
    const { billing, billingPause } = this.state.data;
    if (billing.mode !== 'open') return;
    if (
      (billingPause === 'budget' && (this.left() > 0 || this.freeOnly())) ||
      (billingPause === 'freeCharged' && !this.freeOnly())
    )
      this.state.update({ billingPause: '' });
  }

  /** The money rules of this run, once at the start. */
  private logMoney() {
    const { billing, allowance } = this.state.data;
    const ceiling = this.options.maxSpend;
    const left = Math.max(0, this.ceilingLeft());
    if (this.uncapped())
      this.log(
        tr(
          `没有设花费上限：按 Yomi 的正常规则扣费，钻石不足时会在聊天里提示；通过 relay 已花 ${allowance.spent} 钻石`,
          `No spending cap: Yomi charges by its normal rules, and a low balance is reported in the chat; ${allowance.spent} gems spent through the relay so far`,
          `Sin límite de gasto: Yomi cobra según sus reglas habituales, y si el saldo no alcanza se avisa en el chat; hasta ahora se gastaron ${allowance.spent} gemas a través del relay`,
          `Sem limite de gastos: o Yomi cobra pelas regras normais, e saldo baixo é avisado no chat; até agora, ${allowance.spent} gemas foram gastas pelo relay`,
        ),
      );
    else if (this.freeOnly())
      this.log(
        tr(
          '只用免费额度（不花钻石）',
          'Free replies only (no gems spent)',
          'Solo respuestas gratis (sin gastar gemas)',
          'Só respostas grátis (sem gastar gemas)',
        ),
      );
    else if (billing.mode === 'paid')
      this.log(
        ceiling === null
          ? tr(
              `预算 ${billing.budget} 钻石（已用 ${billing.spent}）；本机没有设上限`,
              `Budget ${billing.budget} gems (used ${billing.spent}); no local spending cap`,
              `Presupuesto ${billing.budget} gemas (usadas ${billing.spent}); sin límite de gasto local`,
              `Orçamento ${billing.budget} gemas (usadas ${billing.spent}); sem limite de gastos local`,
            )
          : tr(
              `预算 ${billing.budget} 钻石（已用 ${billing.spent}）；本机上限 ${ceiling}，还可花 ${Math.max(0, this.left())}`,
              `Budget ${billing.budget} gems (used ${billing.spent}); local spending cap ${ceiling}, ${Math.max(0, this.left())} left to spend`,
              `Presupuesto ${billing.budget} gemas (usadas ${billing.spent}); límite de gasto local ${ceiling}, quedan ${Math.max(0, this.left())} por gastar`,
              `Orçamento ${billing.budget} gemas (usadas ${billing.spent}); limite de gastos local ${ceiling}, restam ${Math.max(0, this.left())} para gastar`,
            ),
      );
    else
      this.log(
        tr(
          `聊天里没有设预算：按 Yomi 的正常规则扣费，不超过本机上限 ${ceiling} 钻石（还可花 ${left}）`,
          `No budget in the chat: Yomi charges by its normal rules, up to the local spending cap of ${ceiling} gems (${left} left)`,
          `Sin presupuesto en el chat: Yomi cobra según sus reglas habituales, hasta el límite de gasto local de ${ceiling} gemas (quedan ${left})`,
          `Sem orçamento no chat: o Yomi cobra pelas regras normais, até o limite de gastos local de ${ceiling} gemas (restam ${left})`,
        ),
      );
  }

  /** The server's switches: off, too old, or back on. */
  private applyPolicy() {
    if (!this.policy.enabled) this.gate = 'disabled';
    else if (this.policy.minVersion && compareVersions(VERSION, this.policy.minVersion) < 0)
      this.gate = 'tooOld';
    else this.gate = '';
    if (this.gate === 'tooOld')
      this.log(
        tr(
          `yomi ${VERSION} 低于服务端要求的 ${this.policy.minVersion}，relay 暂停`,
          `yomi ${VERSION} is older than the ${this.policy.minVersion} the server requires, relay paused`,
          `yomi ${VERSION} es anterior a la versión ${this.policy.minVersion} que requiere el servidor, relay en pausa`,
          `yomi ${VERSION} é anterior à versão ${this.policy.minVersion} exigida pelo servidor, relay pausado`,
        ),
      );
    this.log(
      tr(
        `服务端策略：${this.policy.source === 'server' ? '已读取' : '未提供（按最严格的默认值）'}` +
          `；只用免费额度${this.policy.freeOnly ? '已支持' : '未确认'}` +
          `；合规提示${this.policy.complianceNotices ? '由服务端注入' : '由 relay 显示'}`,
        `Server policy: ${this.policy.source === 'server' ? 'loaded' : 'not provided (using the strictest defaults)'}` +
          `; free messages only: ${this.policy.freeOnly ? 'supported' : 'not confirmed'}` +
          `; compliance notices: ${this.policy.complianceNotices ? 'added by the server' : 'shown by relay'}`,
        `Política del servidor: ${this.policy.source === 'server' ? 'cargada' : 'no proporcionada (se usan los valores predeterminados más estrictos)'}` +
          `; solo mensajes gratis: ${this.policy.freeOnly ? 'admitido' : 'sin confirmar'}` +
          `; avisos de cumplimiento: ${this.policy.complianceNotices ? 'los agrega el servidor' : 'los muestra relay'}`,
        `Política do servidor: ${this.policy.source === 'server' ? 'carregada' : 'não fornecida (usando os padrões mais restritivos)'}` +
          `; só mensagens grátis: ${this.policy.freeOnly ? 'suportado' : 'não confirmado'}` +
          `; avisos de conformidade: ${this.policy.complianceNotices ? 'adicionados pelo servidor' : 'exibidos pelo relay'}`,
      ),
    );
  }

  /**
   * `relay/get_policy` for this channel. QQ and WeChat run only on a policy the server sent for
   * them in production (`channelPolicy`); without one they are gated with the server-off text and
   * the server is asked again later. Telegram runs on whatever was read, as it always has.
   */
  private async readPolicy(starting: boolean) {
    this.policyAt = Date.now();
    const kind = this.channel.kind;
    const read = channelPolicy(
      await relayPolicy(this.gateway, kind),
      kind,
      Boolean(this.options.requireServerPolicy),
    );
    // Still gated on a later read: nothing changed, nothing to say again.
    if (!starting && read.gated) return;
    this.policy = read.policy;
    this.policyGated = read.gated;
    if (read.warning) this.log(read.warning);
    this.applyPolicy();
  }

  /** While the server has not confirmed this channel, an owner message asks again (60 s apart). */
  private async refreshPolicy() {
    if (!this.policyGated || this.gate !== 'disabled') return;
    if (Date.now() - this.policyAt < (this.options.policyRefetchMs ?? POLICY_REFETCH_MS)) return;
    await this.readPolicy(false);
  }

  /** The channel's events, one at a time; the channel releases what it held after each. */
  private async poll() {
    for await (const event of this.channel.events()) {
      try {
        await this.handle(event);
      } catch (error) {
        await this.unexpected(error);
      }
      await this.channel.flush().catch(() => undefined);
      if (this.stopReason || this.abort.signal.aborted) break;
    }
  }

  private async shutdown() {
    this.connection?.stop();
    // The image's record stays: the next run follows it again.
    this.job?.stop.abort();
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.resumeTimer = null;
    const turn = this.turn;
    if (turn) {
      if (turn.watchdog) clearTimeout(turn.watchdog);
      // Its charge, if any, stays pending in the state and is settled on the next run. A stop
      // that hangs is given up on: the relay must end.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        turn.presenter.stop().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_STOP_MS);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The channel's events

  /** The paired owner's ids as strings, null while unpaired. */
  private ownerIds(): { userId: string; chatId: string } | null {
    const owner = this.state.data.owner;
    return owner ? { userId: String(owner.userId), chatId: String(owner.chatId) } : null;
  }

  private owns(userId: string, chatId: string): boolean {
    const owner = this.ownerIds();
    return Boolean(owner && userId === owner.userId && chatId === owner.chatId);
  }

  private async handle(event: InboundEvent) {
    if (event.kind === 'stop') {
      const turn = this.turn;
      if (
        turn &&
        event.streamRef &&
        event.chatId === turn.chatId &&
        event.streamRef === turn.presenter.streamRef
      )
        await this.stopTurn();
      return;
    }
    if (event.kind === 'answer') return this.answer(event);
    if (!this.state.data.owner) return this.pair(event);
    if (!this.owns(event.from.id, event.chatId)) {
      this.strangers += 1;
      if (this.strangers === 1 || this.strangers % 20 === 0)
        this.log(
          tr(
            `已忽略非主人的消息（共 ${this.strangers} 条，没有转发、没有扣费）`,
            `Ignored messages from someone other than the owner (${this.strangers} in total, not forwarded, not charged)`,
            `Se ignoraron mensajes de alguien que no es el dueño (${this.strangers} en total, sin reenviar, sin cobro)`,
            `Mensagens de alguém que não é o dono foram ignoradas (${this.strangers} no total, não encaminhadas, sem cobrança)`,
          ),
        );
      return;
    }
    this.replyTo = event.context;
    await this.refreshPolicy();
    if (Date.now() - event.sentAt > this.options.staleMs)
      return void (await this.say(this.texts.stale));
    if (!event.text) return void (await this.say(this.texts.textOnly));
    if (event.kind === 'command') return this.command(event);
    return this.chat(event, event.text);
  }

  private async pair(event: InboundMessage | InboundCommand) {
    // A channel whose owner is whoever logged in (WeChat) pairs on the computer, not in the chat.
    if (this.channel.caps.pairing !== 'code') return;
    const code = this.options.pairing;
    const match = /^\/(?:start|pair)(?:@\w+)?\s+(\S+)/.exec(event.rawText);
    if (!code || !match) return;
    const result = code.check(match[1], event.from.id);
    if (result === 'ignored') return;
    if (result !== 'ok') {
      await this.channel
        .send(event.chatId, { text: this.texts.badCode }, event.context)
        .catch(() => undefined);
      // Only time replaces the code: wrong guesses by others never use up the owner's.
      if (result === 'expired') {
        const next = new PairingCode();
        this.options.pairing = next;
        this.options.onPairingCode?.(next);
      }
      return;
    }
    this.options.pairing = null;
    this.state.update({
      owner: {
        userId: this.channel.persistId(event.from.id),
        chatId: this.channel.persistId(event.chatId),
        name: event.from.name.slice(0, 64),
        language: event.from.language,
        pairedAt: Date.now(),
      },
    });
    const name = this.channel.displayName;
    const who = event.from.name;
    const id = event.from.id;
    this.log(
      tr(
        `已配对：${spaced(name, 'after')}用户 ${who ? `${who}（${id}）` : id}`,
        `Paired: ${name} user ${who ? `${who} (${id})` : id}`,
        `Vinculado: usuario de ${name} ${who ? `${who} (${id})` : id}`,
        `Pareado: usuário do ${name} ${who ? `${who} (${id})` : id}`,
      ),
    );
    this.replyTo = event.context;
    // The bot by its handle (Telegram), else its name, else the channel's: never an empty "()".
    const handle = this.identity.handle;
    await this.say(this.texts.paired(handle ? `@${handle}` : this.identity.name || name));
    const character = this.state.data.character;
    if (character) await this.say(this.texts.characterIs(character.name, character.npcId));
    else await this.say(this.texts.noCharacter);
  }

  private async command(event: InboundCommand) {
    const { target, argument } = event;
    if (target && target.toLowerCase() !== this.state.data.botUsername.toLowerCase()) return;
    switch (event.name.toLowerCase()) {
      case 'start':
      case 'help':
        return void (await this.say(this.texts.help(this.channel.caps.quotes)));
      case 'character':
        if (!argument) {
          const character = this.state.data.character;
          return void (await this.say(
            character
              ? this.texts.characterIs(character.name, character.npcId)
              : this.texts.noCharacter,
          ));
        }
        await this.afterBooking();
        if (this.turn || this.job) return void (await this.say(this.texts.busy));
        return this.chooseCharacter(argument, true);
      case 'price':
        return this.showPrice();
      case 'budget':
        return this.budget(argument);
      case 'image':
        return this.imageCommand(event, argument);
      case 'report':
        return this.report(event);
      case 'stop':
        return this.stopTurn();
      default:
        return void (await this.say(this.texts.unknownCommand));
    }
  }

  // -------------------------------------------------------------------------------------------
  // The channel's pauses

  /** The channel must not relay for now: chat and new images are answered, commands still work. */
  private pauseChannel(reason: PauseReason, until: number | null) {
    const known = this.channelPause?.reason === reason;
    this.channelPause = { reason, until };
    if (known) return;
    const name = this.channel.displayName;
    this.log(
      reason === 'contentRefused'
        ? tr(
            `${spaced(name, 'after')}多次按内容规则拒绝了回复，转发已暂停（重新启动 relay 后恢复）`,
            `${name} refused several replies under its content rules: relaying is paused until the relay is restarted`,
            `${name} rechazó varias respuestas por sus reglas de contenido: la transmisión queda en pausa hasta reiniciar el relay`,
            `O ${name} recusou várias respostas pelas regras de conteúdo: o encaminhamento fica pausado até o relay ser reiniciado`,
          )
        : tr(
            `${spaced(name, 'after')}暂时不可用，转发已暂停`,
            `${name} is unavailable for now: relaying is paused`,
            `${name} no está disponible por ahora: la transmisión queda en pausa`,
            `O ${name} está indisponível por enquanto: o encaminhamento está pausado`,
          ),
    );
  }

  private resumeChannel() {
    if (!this.channelPause) return;
    this.channelPause = null;
    const name = this.channel.displayName;
    this.log(
      tr(
        `${spaced(name, 'after')}恢复转发`,
        `Relaying through ${name} resumed`,
        `Se reanudó la transmisión por ${name}`,
        `O encaminhamento pelo ${name} foi retomado`,
      ),
    );
  }

  /** Why the channel is paused now; null when it relays (a pause whose time is up ends here). */
  private channelPaused(): PauseReason | null {
    const pause = this.channelPause;
    if (!pause) return null;
    if (pause.until !== null && Date.now() >= pause.until) {
      this.resumeChannel();
      return null;
    }
    return pause.reason;
  }

  // -------------------------------------------------------------------------------------------
  // Characters, notices, price

  private async chooseCharacter(input: string, announce: boolean) {
    const npcId = /([1-9][0-9]{5,19})/.exec(input)?.[1] ?? '';
    if (!npcId) return void (await this.say(this.texts.characterBad));
    let profile;
    try {
      profile = await characterProfile(this.gateway, npcId);
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
      this.log(
        tr(
          '角色读取失败',
          "Couldn't load the character",
          'No se pudo cargar el personaje',
          'Não foi possível carregar o personagem',
        ),
      );
      if (announce) await this.say(this.texts.characterBad);
      return;
    }
    const character: RelayCharacter = { npcId, name: profile.name, group: profile.group };
    this.state.update({ character });
    this.price = null;
    this.log(
      tr(
        `当前角色：${character.name}（${npcId}${character.group ? '，群聊' : ''}）`,
        `Current character: ${character.name} (${npcId}${character.group ? ', group chat' : ''})`,
        `Personaje actual: ${character.name} (${npcId}${character.group ? ', chat grupal' : ''})`,
        `Personagem atual: ${character.name} (${npcId}${character.group ? ', chat em grupo' : ''})`,
      ),
    );
    if (!announce) return;
    await this.say(this.texts.characterSet(character.name));
    await this.notice(character, true);
    // A first chat shows the opening, as the app does; the server keeps no message for it.
    const greeted = this.state.data.greeted;
    if (greeted.includes(npcId)) return;
    const cid = await conversationId(this.gateway, npcId).catch(() => 'unknown');
    if (cid !== '') return;
    const opening = openingOf(profile);
    const { maxText, format } = this.channel.caps;
    for (const text of renderReply(
      opening,
      { characterName: character.name, group: character.group },
      maxText,
      format,
    ))
      await this.sayFormatted(text);
    this.state.update({ greeted: [...greeted, npcId].slice(-200) });
  }

  /** The relay's own AI notice: at the start of a run and every 3 hours, unless the server does it. */
  private async notice(character: RelayCharacter, force: boolean) {
    if (this.policy.complianceNotices) return;
    const last = this.state.data.noticeAt[character.npcId] ?? 0;
    if (!force && this.noticed.has(character.npcId) && Date.now() - last < THREE_HOURS) return;
    await this.say(this.texts.aiNotice(character.name));
    this.noticed.add(character.npcId);
    this.state.update({ noticeAt: { ...this.state.data.noticeAt, [character.npcId]: Date.now() } });
  }

  private async replyPrice(npcId: string): Promise<number | null> {
    if (this.price && this.price.npcId === npcId && Date.now() - this.price.at < PRICE_TTL)
      return this.price.value;
    let value: number | null = null;
    try {
      value = await replyCost(this.gateway, npcId);
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
    }
    // An unknown price is asked again next time: it must not stand in for a real one.
    if (value !== null) this.price = { npcId, value, at: Date.now() };
    return value;
  }

  /** The gem balance; one retry; null when it cannot be read. */
  private async balance(): Promise<number | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await walletBalance(this.gateway);
      } catch (error) {
        if (error instanceof NotSignedIn) throw error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    return null;
  }

  /** No cap at all: no budget in the chat and no `--max-spend`. Measuring is bookkeeping then. */
  private uncapped(): boolean {
    return this.state.data.billing.mode === 'open' && this.options.maxSpend === null;
  }

  /** Free replies only: `/budget off`, or no budget under `--max-spend 0`. */
  private freeOnly(): boolean {
    const mode = this.state.data.billing.mode;
    return mode === 'free' || (mode === 'open' && this.options.maxSpend === 0);
  }

  /**
   * Gems the relay may still spend: the budget's rest (none under free-only, no limit without
   * one), never past the local ceiling. Finite exactly when some cap is set (or free-only).
   */
  private left(): number {
    const billing = this.state.data.billing;
    const budget =
      billing.mode === 'paid'
        ? billing.budget - billing.spent
        : billing.mode === 'open'
          ? Infinity
          : 0;
    return Math.min(budget, this.ceilingLeft());
  }

  /** What is left under `--max-spend`; Infinity without one (never printed). */
  private ceilingLeft(): number {
    const ceiling = this.options.maxSpend;
    return ceiling === null ? Infinity : ceiling - this.state.data.allowance.spent;
  }

  /** The local ceiling, not the budget, is what limits now: a budget cannot lift it. */
  private ceilingLimits(): boolean {
    if (this.options.maxSpend === null) return false;
    const billing = this.state.data.billing;
    return billing.mode !== 'paid' || this.ceilingLeft() < billing.budget - billing.spent;
  }

  private rerunCommand(): string {
    return this.options.rerunCommand ?? 'yomi relay --telegram';
  }

  /** How to leave free-only (or its pause): under `--max-spend 0` only the computer can. */
  private leaveHint(): string {
    return this.options.maxSpend === 0
      ? this.texts.restartHint(this.rerunCommand())
      : this.texts.budgetNoneHint;
  }

  /**
   * Why spending stopped: the local ceiling (which no `/budget` lifts), else the budget. A
   * budget's pause that a lower ceiling caused before a restart stays the owner's to lift, but
   * says so: the budget itself still has room.
   */
  private exhaustedText(): string {
    const ceiling = this.options.maxSpend;
    if (ceiling === 0)
      return this.texts.budgetTooHigh(0, 0, this.texts.restartHint(this.rerunCommand()));
    if (ceiling !== null && this.ceilingLeft() <= 0)
      return this.texts.ceilingExhausted(
        this.state.data.allowance.spent,
        ceiling,
        this.rerunCommand(),
      );
    const billing = this.state.data.billing;
    if (billing.mode === 'paid' && billing.spent < billing.budget)
      return this.texts.budgetPausedByCeiling(billing.budget - billing.spent);
    return this.texts.budgetExhausted(billing.spent);
  }

  /** Not enough left for the next reply, naming the limit that is short. */
  private shortText(price: number, left: number): string {
    return this.ceilingLimits()
      ? this.texts.ceilingShort(price, left)
      : this.texts.budgetShort(price, left);
  }

  /** A send whose cost nothing could measure: the total shown is a lower bound from now on. */
  private countUnmeasured() {
    const allowance = this.state.data.allowance;
    this.state.update({ allowance: { ...allowance, unmeasured: allowance.unmeasured + 1 } });
  }

  private async priceAndBalance(): Promise<string> {
    const character = this.state.data.character;
    const price = character ? await this.replyPrice(character.npcId) : null;
    if (character) this.priceShown.add(character.npcId);
    return this.texts.priceLine(price) + this.texts.balanceLine(await this.balance());
  }

  private budgetLine(): string {
    const { billing, allowance } = this.state.data;
    return this.texts.budgetLine({
      mode: billing.mode,
      freeOnly: this.freeOnly(),
      budget: billing.budget,
      spent: billing.spent,
      total: allowance.spent,
      ceiling: this.options.maxSpend,
      ceilingLeft: this.ceilingLeft(),
      unmeasured: allowance.unmeasured,
    });
  }

  private async showPrice() {
    const prices = (await this.priceAndBalance()) + (await this.imagePriceText());
    await this.say(prices + '\n' + this.budgetLine());
  }

  /** The current character's image price for `/price`; '' when images are off or unknown. */
  private async imagePriceText(): Promise<string> {
    const character = this.state.data.character;
    if (!character) return '';
    try {
      const config = await getChatImageConfig(this.gateway, character.npcId);
      return config.enabled ? this.texts.imagePriceLine(config.cost) : '';
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
      return '';
    }
  }

  private async budget(argument: string) {
    if (!argument) return void (await this.say(this.budgetLine() + '\n' + this.texts.budgetUsage));
    if (
      /^(off|free|0|关|免费)$/i.test(argument) // i18n-ignore
    ) {
      // A charged "free" reply stays paused: free-only is what failed. The owner's only "spend
      // nothing" switch in the chat: it is kept even before the server supports free-only (then
      // nothing is sent, and the answer says how to go on).
      this.state.update({
        billing: { mode: 'free', budget: 0, spent: 0, setAt: Date.now() },
        billingPause: this.state.data.billingPause === 'budget' ? '' : this.state.data.billingPause,
      });
      return void (await this.say(this.texts.budgetOff(this.policy.freeOnly, this.leaveHint())));
    }
    if (
      /^(none|unlimited|不限)$/i.test(argument) // i18n-ignore
    )
      return this.budgetNone();
    const amount = Number(argument);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000)
      return void (await this.say(this.texts.budgetUsage));
    if (amount > this.ceilingLeft()) return void (await this.say(this.tooHigh()));
    const nonce = randomBytes(4).toString('hex');
    const ref = await this.ask({
      id: nonce,
      prompt: this.texts.budgetAsk(amount) + '\n' + (await this.priceAndBalance()),
      options: [
        { id: 'y', label: this.texts.budgetConfirm(amount) },
        { id: 'n', label: this.texts.cancel },
      ],
      layout: 'row',
    });
    if (ref) this.buttons.set(nonce, { kind: 'budget', amount, ref });
  }

  private tooHigh(): string {
    return this.texts.budgetTooHigh(
      this.ceilingLeft(),
      this.options.maxSpend ?? 0,
      this.texts.restartHint(this.rerunCommand()),
    );
  }

  /**
   * `/budget none`: no budget, Yomi charges by its normal rules (within `--max-spend` when set).
   * Lifting a budget or free-only widens spending, so it is confirmed like `/budget <amount>`;
   * already without one, nothing widens. Under a spent (or 0) local ceiling it changes nothing.
   */
  private async budgetNone() {
    const ceiling = this.options.maxSpend;
    if (ceiling === 0) return void (await this.say(this.tooHigh()));
    if (ceiling !== null && this.ceilingLeft() <= 0)
      return void (await this.say(this.exhaustedText()));
    if (this.state.data.billing.mode === 'open') return this.noBudget();
    const nonce = randomBytes(4).toString('hex');
    const ref = await this.ask({
      id: nonce,
      prompt:
        this.texts.budgetNoneAsk(ceiling === null ? null : this.ceilingLeft()) +
        '\n' +
        (await this.priceAndBalance()),
      options: [
        { id: 'y', label: this.texts.budgetNoneConfirm },
        { id: 'n', label: this.texts.cancel },
      ],
      layout: 'row',
    });
    if (ref) this.buttons.set(nonce, { kind: 'budget', amount: null, ref });
  }

  private async noBudget() {
    this.state.update({
      billing: { mode: 'open', budget: 0, spent: 0, setAt: Date.now() },
      billingPause: '',
    });
    this.log(
      tr(
        '主人选择不设预算：按 Yomi 的正常规则扣费',
        'The owner chose no budget: Yomi charges by its normal rules',
        'El dueño eligió no tener presupuesto: Yomi cobra según sus reglas habituales',
        'O dono escolheu não ter orçamento: o Yomi cobra pelas regras normais',
      ),
    );
    const ceiling = this.options.maxSpend;
    await this.say(this.texts.budgetNone(ceiling === null ? null : this.ceilingLeft()));
  }

  // -------------------------------------------------------------------------------------------
  // Reports

  private async report(event: InboundCommand) {
    const character = this.state.data.character;
    if (!character) return void (await this.say(this.texts.noCharacter));
    const mid = event.replyTo ? this.state.replyMid(event.replyTo) : this.state.lastReplyMid;
    let reasons: FeedbackReason[] = [];
    if (mid) {
      try {
        const all = await feedbackReasons(this.gateway);
        reasons = all.filter((reason) => reason.isReport);
        if (reasons.length === 0) reasons = all;
      } catch (error) {
        if (error instanceof NotSignedIn) throw error;
      }
    }
    const nonce = randomBytes(4).toString('hex');
    const ref = await this.ask({
      id: nonce,
      prompt: mid ? this.texts.reportPick : this.texts.reportNothing(this.channel.caps.quotes),
      options: [
        ...reasons.slice(0, 8).map((reason, index) => ({ id: String(index), label: reason.label })),
        { id: 'c', label: this.texts.reportCharacter },
      ],
      layout: 'column',
    });
    if (ref) this.buttons.set(nonce, { kind: 'report', npcId: character.npcId, mid, reasons, ref });
  }

  /**
   * A button pressed (Telegram) or a code typed (QQ, WeChat). A question this run did not ask (one
   * from before a restart included) has expired: answering it does nothing.
   */
  private async answer(event: InboundAnswer) {
    if (!event.chatId || !this.owns(event.from.id, event.chatId)) {
      await event.ack().catch(() => undefined);
      return;
    }
    this.replyTo = event.context;
    const button = this.buttons.get(event.questionId);
    if (!button) {
      await event.ack('expired').catch(() => undefined);
      return;
    }
    this.buttons.delete(event.questionId);
    const choice = event.optionId;
    await event.ack().catch(() => undefined);
    await this.channel.closeQuestion(button.ref).catch(() => undefined);
    if (button.kind === 'budget') {
      if (choice !== 'y') return void (await this.say(this.texts.budgetCancelled));
      // Spending may have gone on since the prompt: the ceiling is checked again.
      if (button.amount === null && this.options.maxSpend !== null && this.ceilingLeft() <= 0)
        return void (await this.say(this.exhaustedText()));
      if (button.amount !== null && button.amount > this.ceilingLeft())
        return void (await this.say(this.tooHigh()));
      const character = this.state.data.character;
      const seen = character ? this.priceShown.has(character.npcId) : false;
      this.priceShown.clear();
      this.imagePriceShown.clear();
      if (character && seen) this.priceShown.add(character.npcId);
      if (button.amount === null) return this.noBudget();
      this.state.update({
        billing: { mode: 'paid', budget: button.amount, spent: 0, setAt: Date.now() },
        billingPause: '',
      });
      this.log(
        tr(
          `主人确认了预算 ${button.amount} 钻石`,
          `The owner confirmed a budget of ${button.amount} gems`,
          `El dueño confirmó un presupuesto de ${button.amount} gemas`,
          `O dono confirmou um orçamento de ${button.amount} gemas`,
        ),
      );
      return void (await this.say(this.texts.budgetSet(button.amount)));
    }
    if (choice === 'c') {
      let reasons: FeedbackReason[] = [];
      try {
        reasons = await characterReportReasons(this.gateway);
      } catch (error) {
        if (error instanceof NotSignedIn) throw error;
        return void (await this.say(this.texts.reportFailed));
      }
      const next = randomBytes(4).toString('hex');
      const ref = await this.ask({
        id: next,
        prompt: this.texts.reportPick,
        options: reasons
          .slice(0, 8)
          .map((reason, index) => ({ id: String(index), label: reason.label })),
        layout: 'column',
      });
      if (ref)
        this.buttons.set(next, { kind: 'reportCharacter', npcId: button.npcId, reasons, ref });
      return;
    }
    // No option named (a button without one) chooses nothing.
    const reason = choice ? button.reasons[Number(choice)] : undefined;
    if (!reason) return;
    try {
      if (button.kind === 'report')
        await submitFeedback(this.gateway, button.npcId, button.mid, [reason.key]);
      else await submitCharacterReport(this.gateway, button.npcId, [reason.key]);
      await this.say(this.texts.reportDone);
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
      await this.say(this.texts.reportFailed);
    }
  }

  // -------------------------------------------------------------------------------------------
  // A turn

  /** Why nothing can be sent now, '' when it can. */
  private pausedText(): string {
    switch (this.gate) {
      case 'signedOut':
        return this.texts.signedOut;
      case 'tooOld':
        return this.texts.tooOld;
      case 'disabled':
        return this.texts.disabled(this.policy.message);
    }
    switch (this.state.data.billingPause) {
      case 'budget':
        return this.exhaustedText();
      case 'freeCharged':
        return this.texts.paused(this.leaveHint());
    }
    return '';
  }

  /** A reply that is done and only being booked is waited for, not answered with "busy". */
  private async afterBooking() {
    const finished = this.turn?.settled ? this.turn.finished : null;
    if (finished) await finished.catch(() => undefined);
  }

  private async chat(event: InboundMessage, text: string) {
    // A paused channel starts nothing: no price, balance or pending charge is touched.
    const pause = this.channelPaused();
    if (pause)
      return void (await this.say(this.texts.channelPaused(this.channel.displayName, pause)));
    await this.afterBooking();
    if (this.turn) return void (await this.say(this.texts.busy));
    // Without a cap only a picture still being made holds a reply back, not its landing charge.
    const job = this.job;
    if (job && !(job.record.told && this.uncapped()))
      return void (await this.say(this.imageWaitText(job.record)));
    const blocked = this.pausedText();
    if (blocked) return void (await this.say(blocked));
    const character = this.state.data.character;
    if (!character) return void (await this.say(this.texts.noCharacter));
    if (job) {
      // Its follower stops before the reply goes, not beside it: concluding meanwhile, it could
      // read the balance before the reply's charge lands and lose that cost. The reply rides along
      // the image's measurement; a later send (or the next start) settles the picture.
      job.stop.abort();
      await job.done;
    }
    // An image whose cost is still open is settled first: it is charged on delivery. Without a cap
    // a reply goes anyway and rides along the image's measurement.
    const open = await this.settleImage(true);
    if (open) return void (await this.say(open));
    const riding = this.keptImage() !== null;
    const uncapped = this.uncapped();
    // What earlier sends cost is booked before anything more is spent; without a cap that is
    // bookkeeping, and an unreadable balance blocks nothing (the reading comes later).
    if (!riding && !(await this.settlePending())) {
      if (!uncapped) return void (await this.say(this.texts.walletUnavailable));
      this.log(
        tr(
          '读不到余额：之前的花费稍后再核对；没有设花费上限，这条照常发送',
          "Can't read the balance: the earlier cost is checked later; there is no spending cap, so this message goes anyway",
          'No se puede leer el saldo: el costo anterior se verificará más tarde; no hay límite de gasto, así que este mensaje se envía igual',
          'Não foi possível ler o saldo: o custo anterior será conferido depois; não há limite de gastos, então esta mensagem é enviada mesmo assim',
        ),
      );
    }
    const afterSettling = this.pausedText();
    if (afterSettling) return void (await this.say(afterSettling));
    const billing = this.state.data.billing;
    const freeOnly = this.freeOnly();
    let consumptionMode: number;
    let maxCost: number | undefined;
    let price: number | null = null;
    if (freeOnly) {
      // Without the server's word that FreeOnly is honoured, any message may be charged.
      if (!this.policy.freeOnly)
        return void (await this.say(this.texts.freeOnlyUnsupported(this.leaveHint())));
      consumptionMode = ConsumptionMode.freeOnly;
    } else if (uncapped) {
      // Yomi charges by its normal rules, whatever the policy offers; too few gems is the
      // server's refusal, said in the chat (`refused`).
      consumptionMode = ConsumptionMode.allowPaid;
    } else {
      const left = this.left();
      if (left <= 0) {
        this.state.update({ billingPause: 'budget' });
        return void (await this.say(this.exhaustedText()));
      }
      price = await this.replyPrice(character.npcId);
      // An unknown price is "not free": without the server's cap it could overrun the cap.
      if (price === null && !this.policy.spendCap)
        return void (await this.say(this.texts.priceUnknown));
      if (price !== null && price > left) return void (await this.say(this.shortText(price, left)));
      consumptionMode = ConsumptionMode.allowPaid;
      if (this.policy.spendCap) maxCost = left;
    }
    await this.notice(character, false);
    // Riding along an image's measurement, this reply takes no reading of its own.
    const before = riding ? null : await this.balance();
    // A paid send under a cap needs something to measure its cost against.
    if (before === null && !riding && !uncapped && !freeOnly)
      return void (await this.say(this.texts.walletUnavailable));
    if (billing.mode === 'paid' && !this.priceShown.has(character.npcId)) {
      await this.say(this.texts.priceLine(price) + this.texts.balanceLine(before));
      this.priceShown.add(character.npcId);
    }
    const mode: BillingMode = freeOnly ? 'free' : billing.mode;
    const pending = this.state.data.pending;
    let ownPending = false;
    if (riding) {
      // The image's measurement (taken before it) holds this reply's cost too.
      if (pending) this.state.update({ pending: { ...pending, extra: true, capped: false } });
      this.log(
        tr(
          '上一张图片的花费还没结算：没有设花费上限，这条照常发送，花费和图片的一起核对',
          "The last image's cost is not settled yet: there is no spending cap, so this message goes anyway and its cost is checked with the image's",
          'El costo de la última imagen aún no se liquidó: no hay límite de gasto, así que este mensaje se envía igual y su costo se verifica junto con el de la imagen',
          'O custo da última imagem ainda não foi finalizado: não há limite de gastos, então esta mensagem é enviada mesmo assim e o custo dela é conferido com o da imagem',
        ),
      );
    } else if (before === null) {
      if (pending) {
        // Without a cap: the earlier send's reading is still to come and measures this one too.
        this.state.update({ pending: { ...pending, mode: 'open', price: null, capped: false } });
        this.log(
          tr(
            '读不到余额：这条的花费和之前的一起核对',
            "Can't read the balance: this message's cost is checked together with the earlier one",
            'No se puede leer el saldo: el costo de este mensaje se verifica junto con el anterior',
            'Não foi possível ler o saldo: o custo desta mensagem é conferido junto com o anterior',
          ),
        );
      } else
        this.log(
          freeOnly
            ? tr(
                '读不到余额：这条只用免费额度的回复无法核对是否扣费',
                "Can't read the balance: can't check whether this free-messages-only reply was charged",
                'No se puede leer el saldo: no se puede verificar si se cobró esta respuesta en modo solo mensajes gratis',
                'Não foi possível ler o saldo: não é possível conferir se esta resposta no modo só mensagens grátis foi cobrada',
              )
            : tr(
                '读不到余额：这条的花费量不出来；没有设花费上限，照常发送',
                "Can't read the balance: this message's cost can't be measured; there is no spending cap, so it goes anyway",
                'No se puede leer el saldo: no se puede medir el costo de este mensaje; no hay límite de gasto, así que se envía igual',
                'Não foi possível ler o saldo: o custo desta mensagem não pode ser medido; não há limite de gastos, então ela é enviada mesmo assim',
              ),
        );
    } else {
      // A pending charge is replaced only once settled: this reading settles it first.
      if (pending) await this.settlePending(before);
      this.state.update({ pending: { before, mode, price, at: Date.now(), capped: !uncapped } });
      ownPending = true;
    }
    const presenter = this.channel.presenter({
      to: event.chatId,
      context: event.context,
      render: { characterName: character.name, group: character.group },
      log: (line) => this.log(line),
    });
    const turn: Turn = {
      character,
      chatId: event.chatId,
      context: event.context,
      streamId: '',
      assistantMid: '',
      cid: '',
      presenter,
      lastSeq: 0,
      settled: false,
      mode,
      booked: false,
      ownPending,
      settles: !riding,
      unmeasured: !ownPending && !this.state.data.pending,
      finished: null,
      watchdog: null,
    };
    this.turn = turn;
    this.early.clear();
    presenter.start();
    let answer: SendAnswer;
    try {
      answer = await sendMessage(this.gateway, {
        npcId: character.npcId,
        text,
        clientRequestId: randomUUID(),
        consumptionMode,
        maxCostDiamonds: maxCost,
      });
    } catch (error) {
      // Refused for sure: nothing was charged. Unknown: the pending charge is settled later. A
      // measurement this send only joined still holds earlier costs: it stays.
      if (!unknownOutcome(error) && ownPending) this.state.update({ pending: null });
      this.turn = null;
      this.early.clear();
      await presenter.stop().catch(() => undefined);
      await this.refused(error);
      return;
    }
    this.log(
      tr(
        `已转发一条消息给「${character.name}」`,
        `Forwarded a message to "${character.name}"`,
        `Se reenvió un mensaje a "${character.name}"`,
        `Uma mensagem foi encaminhada para "${character.name}"`,
      ),
    );
    turn.streamId = answer.streamId;
    turn.assistantMid = answer.assistantMid;
    turn.cid = answer.cid;
    if (answer.assistantMid) this.ownMids.add(answer.assistantMid);
    if (this.ownMids.size > 1000) this.ownMids = new Set([...this.ownMids].slice(-500));
    if (answer.chargedDiamonds !== null) {
      // The server says what it took: booked now, so a stop or restart cannot lose it. A
      // measurement this send only joined keeps the earlier costs: this charge leaves its drop.
      const joined = this.state.data.pending;
      if (ownPending) this.state.update({ pending: null });
      else if (joined)
        this.state.update({
          pending: { ...joined, before: joined.before - answer.chargedDiamonds },
        });
      turn.booked = true;
      await this.book(answer.chargedDiamonds, turn.mode);
    } else if (turn.unmeasured) this.countUnmeasured();
    for (const notice of answer.notices) await this.say(notice);
    this.armWatchdog(turn);
    const early = this.early.get(answer.streamId) ?? [];
    this.early.clear();
    for (const event of early) this.onStream(event);
  }

  private async refused(error: unknown) {
    if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn))
      return this.signedOut();
    if (error instanceof ChatRefusal) {
      this.log(
        tr(
          `发送被拒绝：${error.kind}（${error.code}）`,
          `Send refused: ${error.kind} (${error.code})`,
          `Envío rechazado: ${error.kind} (${error.code})`,
          `Envio recusado: ${error.kind} (${error.code})`,
        ),
      );
      switch (error.kind) {
        case 'gems':
          return void (await this.say(this.texts.insufficientGems));
        case 'membership':
          return void (await this.say(this.texts.membership));
        case 'freeExhausted':
          return void (await this.say(
            this.texts.freeExhausted(...(await this.priceParts()), this.leaveHint()),
          ));
        case 'spendCap': {
          // Only a capped send names a cap; one without a cap is told what the server said.
          if (this.uncapped())
            return void (await this.say(
              this.texts.refused(error.dialog?.content || error.message),
            ));
          const character = this.state.data.character;
          const price = character ? await this.replyPrice(character.npcId) : null;
          return void (await this.say(this.shortText(price ?? 0, Math.max(0, this.left()))));
        }
        case 'rateLimited':
          return void (await this.say(
            this.texts.rateLimited(Math.ceil(error.retryAfterMs / 1000)),
          ));
        case 'busy':
          return void (await this.say(this.texts.busy));
        case 'ageGate':
          return void (await this.say(this.texts.ageGate));
        case 'unavailable':
          return void (await this.say(this.texts.unavailable));
        case 'disabled':
          this.gate = 'disabled';
          return void (await this.say(this.texts.disabled(error.message)));
        case 'tooOld':
          this.gate = 'tooOld';
          return void (await this.say(this.texts.tooOld));
        default:
          return void (await this.say(this.texts.refused(error.dialog?.content || error.message)));
      }
    }
    if (unknownOutcome(error)) return void (await this.say(this.texts.sendUnknown));
    this.log(
      tr(
        `发送失败：${error instanceof Error ? error.name : 'error'}`,
        `Send failed: ${error instanceof Error ? error.name : 'error'}`,
        `Falló el envío: ${error instanceof Error ? error.name : 'error'}`,
        `Falha no envio: ${error instanceof Error ? error.name : 'error'}`,
      ),
    );
    await this.say(this.texts.refused(''));
  }

  private async priceParts(): Promise<[string, string]> {
    const character = this.state.data.character;
    const price = character ? await this.replyPrice(character.npcId) : null;
    return [this.texts.priceLine(price), this.texts.balanceLine(await this.balance())];
  }

  private onStream(event: StreamEvent) {
    if (event.type === StreamEventType.messagePersisted) return this.onPersisted(event);
    const turn = this.turn;
    // Nothing in flight, or another character: not ours.
    if (!turn || event.entityId !== turn.character.npcId) return;
    if (!turn.streamId) {
      // The send's answer is still on its way: keep the events until it says which stream is ours.
      const list = this.early.get(event.streamId) ?? [];
      if (list.length < 200 && this.early.size < 20) list.push(event);
      this.early.set(event.streamId, list);
      return;
    }
    // Another device of this account chatting with the same character.
    if (event.streamId !== turn.streamId) return;
    if (turn.settled || event.seq <= turn.lastSeq) return;
    turn.lastSeq = event.seq;
    if (event.type === StreamEventType.messageChunk && event.chunk) {
      if (turn.assistantMid && event.chunk.mid !== turn.assistantMid) return;
      // Reviewed paragraphs only; `chunk.text` and `thinking_content` are never shown.
      if (event.chunk.paragraphs) turn.presenter.update(event.chunk.paragraphs);
      this.armWatchdog(turn);
    } else if (event.type === StreamEventType.messageCompleted && event.message) {
      if (turn.assistantMid && event.message.mid !== turn.assistantMid) return;
      this.complete(turn, event.message.content.paragraphs, event.message.mid).catch((error) =>
        this.unexpected(error),
      );
    } else if (event.type === StreamEventType.error) {
      // Too few gems found while replying is said in the relay's words, not the server's.
      const code = event.error?.code ?? '';
      const gems = code === 'INSUFFICIENT_GEMS' || INSUFFICIENT_GEMS.has(Number(code));
      this.failTurn(
        turn,
        gems ? this.texts.insufficientGems : this.texts.replyFailed(event.error?.message ?? ''),
        event.message?.content.paragraphs ?? [],
      ).catch((error) => this.unexpected(error));
    }
  }

  private onAside(event: AsideEvent) {
    const character = this.state.data.character;
    if (!character || event.entityId !== character.npcId || this.asides.has(event.asideId)) return;
    const anchor = event.anchorMid;
    const ours =
      Boolean(anchor) &&
      (this.ownMids.has(anchor) || this.state.data.replies.some(([, mid]) => mid === anchor));
    if (!NOTICE_SCENES.has(event.aside.scene) && !(ours && event.aside.scene !== 'memory_updated'))
      return;
    this.asides.add(event.asideId);
    if (this.asides.size > 500) this.asides = new Set([...this.asides].slice(-200));
    const text = asidePlainText(event.aside).trim() || event.aside.title.trim();
    if (text) void this.say(text);
  }

  private armWatchdog(turn: Turn) {
    if (turn.watchdog) clearTimeout(turn.watchdog);
    turn.watchdog = setTimeout(
      () => this.catchUp(turn, true).catch((error) => this.unexpected(error)),
      this.options.replyTimeoutMs,
    );
    turn.watchdog.unref?.();
  }

  /** Reads the reply back from history; `final`: give up when it is not there. */
  private async catchUp(turn: Turn, final: boolean) {
    if (turn.settled) return;
    let reply = null;
    if (turn.cid && turn.assistantMid) {
      try {
        const messages = await listMessages(this.gateway, turn.cid, 20);
        reply = messages.find(
          (message) =>
            message.mid === turn.assistantMid && message.senderType === SenderType.assistant,
        );
      } catch (error) {
        if (error instanceof NotSignedIn) return this.signedOut();
      }
    }
    // The stream (or another catch-up) may have finished it while history was read.
    if (turn.settled) return;
    if (reply) return this.complete(turn, reply.content.paragraphs, reply.mid);
    if (!final) return;
    turn.settled = true;
    await this.finishTurn(turn, () =>
      turn.presenter.stop(turn.presenter.isClosed ? '' : this.texts.replyMissing),
    );
  }

  private async complete(turn: Turn, paragraphs: readonly ImParagraph[], mid: string) {
    if (turn.settled) return;
    turn.settled = true;
    await this.finishTurn(turn, async () => {
      if (turn.presenter.isClosed) return;
      const refs = await turn.presenter.finish(paragraphs, this.texts.emptyReply);
      for (const ref of refs)
        this.state.rememberReply(this.channel.persistId(ref), mid || turn.assistantMid);
    });
  }

  /** `told`: why it failed, in the relay's words. */
  private async failTurn(turn: Turn, told: string, paragraphs: readonly ImParagraph[]) {
    if (turn.settled) return;
    turn.settled = true;
    await this.finishTurn(turn, async () => {
      if (turn.presenter.isClosed) return;
      if (paragraphs.length) {
        const refs = await turn.presenter.finish(paragraphs, this.texts.emptyReply);
        for (const ref of refs)
          this.state.rememberReply(this.channel.persistId(ref), turn.assistantMid);
        await this.say(told);
      } else await turn.presenter.stop(told);
    });
  }

  /**
   * The end of a turn, whatever the channel does: show it (a failure is logged), book what it cost,
   * and only then accept the next message, so a send never overtakes the previous charge.
   */
  private finishTurn(turn: Turn, show: () => Promise<void>): Promise<void> {
    turn.finished = this.showAndBook(turn, show);
    return turn.finished;
  }

  private async showAndBook(turn: Turn, show: () => Promise<void>) {
    if (turn.watchdog) clearTimeout(turn.watchdog);
    try {
      await show();
    } catch (error) {
      const name = this.channel.displayName;
      const detail = error instanceof ChannelError ? `${error.operation} ${error.code}` : '';
      this.log(
        tr(
          `回复发到${spaced(name, 'both')}失败${detail ? `（${detail}）` : ''}`,
          `Couldn't send the reply to ${name}${detail ? ` (${detail})` : ''}`,
          `No se pudo enviar la respuesta a ${name}${detail ? ` (${detail})` : ''}`,
          `Não foi possível enviar a resposta ao ${name}${detail ? ` (${detail})` : ''}`,
        ),
      );
    }
    try {
      if (!turn.booked && turn.settles && !(await this.settlePending()))
        this.log(
          tr(
            '暂时读不到余额：这条回复的花费会在下一条发送前核对',
            "Can't read the balance right now: this reply's cost will be checked before the next send",
            'No se puede leer el saldo en este momento: el costo de esta respuesta se verificará antes del próximo envío',
            'Não foi possível ler o saldo agora: o custo desta resposta será conferido antes do próximo envio',
          ),
        );
    } catch (error) {
      if (error instanceof NotSignedIn) await this.signedOut();
      else throw error;
    } finally {
      this.endTurn(turn);
    }
  }

  private endTurn(turn: Turn) {
    if (this.turn === turn) this.turn = null;
  }

  /** `/stop` or the channel's Stop control: stop showing it; the server finishes (and charges). */
  private async stopTurn() {
    const turn = this.turn;
    if (!turn && this.job) return this.stopImage();
    if (!turn || turn.settled || turn.presenter.isClosed)
      return void (await this.say(this.texts.nothingToStop));
    this.log(
      tr(
        '主人停止了这条回复的转发',
        'The owner stopped forwarding this reply',
        'El dueño detuvo el reenvío de esta respuesta',
        'O dono parou o encaminhamento desta resposta',
      ),
    );
    await turn.presenter.stop(this.texts.stopped);
  }

  /**
   * Books the pending send's cost from the balance now (`reading`, else read here): the drop, if
   * any. A balance that rose meanwhile (a top-up) hides the cost: for a send made under a cap the
   * quoted price is booked instead (or, unknown, the rest of what may be spent, its bound then);
   * for one made without a cap (`capped` false), even if a budget was set since, it is counted as
   * unmeasured. False when the balance cannot be read: it stays pending.
   */
  private async settlePending(reading?: number): Promise<boolean> {
    const pending = this.state.data.pending;
    if (!pending) return true;
    const now = reading ?? (await this.balance());
    if (now === null) return false;
    this.state.update({ pending: null });
    const drop = pending.before - now;
    if (drop >= 0) await this.book(drop, pending.mode);
    else if (pending.mode !== 'free' && !this.uncapped() && pending.capped !== false) {
      const estimate = pending.price ?? Math.max(0, this.left());
      this.log(
        tr(
          `余额在这条回复期间增加了，无法量出花费：按 ${estimate} 钻石计入`,
          `The balance went up during this reply, so the cost can't be measured: counting ${estimate} gems as spent`,
          `El saldo aumentó durante esta respuesta, así que no se puede medir el costo: se cuentan ${estimate} gemas como gastadas`,
          `O saldo aumentou durante esta resposta, então o custo não pode ser medido: ${estimate} gemas serão contadas como gastas`,
        ),
      );
      await this.book(estimate, pending.mode);
    } else if (pending.mode !== 'free') {
      this.log(
        tr(
          '余额在这期间增加了（充值？），这次的花费量不出来',
          'The balance went up meanwhile (a top-up?), so this cost cannot be measured',
          'El saldo aumentó mientras tanto (¿una recarga?), así que este costo no se puede medir',
          'O saldo aumentou nesse meio-tempo (uma recarga?), então este custo não pode ser medido',
        ),
      );
      this.countUnmeasured();
      await this.book(pending.price ?? 0, pending.mode);
    }
    return true;
  }

  /**
   * Counts `amount` gems in the running total, against the budget and the local ceiling when they
   * are set; pauses when one is spent. A "free" send that was charged pauses under free-only and
   * under a budget (which it was never meant to touch); without a budget it is counted like any.
   */
  private async book(amount: number, mode: BillingMode) {
    if (amount <= 0) return;
    const allowance = this.state.data.allowance;
    const total = allowance.spent + amount;
    this.state.update({ allowance: { ...allowance, spent: total } });
    if (mode === 'free' && (this.freeOnly() || this.state.data.billing.mode === 'paid')) {
      this.log(
        tr(
          `只用免费额度时被扣了 ${amount} 钻石，relay 暂停`,
          `Charged ${amount} gems while on free messages only, relay paused`,
          `Se cobraron ${amount} gemas en modo solo mensajes gratis, relay en pausa`,
          `Foram cobradas ${amount} gemas no modo só mensagens grátis, relay pausado`,
        ),
      );
      this.state.update({ billingPause: 'freeCharged' });
      await this.say(this.texts.freeCharged(amount, this.leaveHint()));
      return;
    }
    const billing = this.state.data.billing;
    const ceiling = this.options.maxSpend;
    const ceilingLeft = Math.max(0, this.ceilingLeft());
    if (billing.mode === 'paid') {
      const spent = billing.spent + amount;
      this.state.update({ billing: { ...billing, spent } });
      this.log(
        ceiling === null
          ? tr(
              `这条回复花了 ${amount} 钻石（预算 ${billing.budget}，已用 ${spent}；本机没有设上限）`,
              `This reply cost ${amount} gems (budget ${billing.budget}, used ${spent}; no local spending cap)`,
              `Esta respuesta costó ${amount} gemas (presupuesto ${billing.budget}, usadas ${spent}; sin límite de gasto local)`,
              `Esta resposta custou ${amount} gemas (orçamento ${billing.budget}, usadas ${spent}; sem limite de gastos local)`,
            )
          : tr(
              `这条回复花了 ${amount} 钻石（预算 ${billing.budget}，已用 ${spent}；本机还可花 ${ceilingLeft}）`,
              `This reply cost ${amount} gems (budget ${billing.budget}, used ${spent}; ${ceilingLeft} left under the local spending cap)`,
              `Esta respuesta costó ${amount} gemas (presupuesto ${billing.budget}, usadas ${spent}; quedan ${ceilingLeft} dentro del límite de gasto local)`,
              `Esta resposta custou ${amount} gemas (orçamento ${billing.budget}, usadas ${spent}; restam ${ceilingLeft} dentro do limite de gastos local)`,
            ),
      );
      if (this.left() <= 0) {
        this.state.update({ billingPause: 'budget' });
        await this.say(this.exhaustedText());
      }
      return;
    }
    // No budget: the running total, and the local ceiling when one is set. Nothing in the chat:
    // a cost line after every reply would only be noise.
    this.log(
      ceiling === null
        ? tr(
            `扣了 ${amount} 钻石（通过 relay 累计 ${total}；没有设花费上限）`,
            `Charged ${amount} gems (${total} spent through the relay in total; no spending cap)`,
            `Se cobraron ${amount} gemas (${total} gastadas a través del relay en total; sin límite de gasto)`,
            `Foram cobradas ${amount} gemas (${total} gastas pelo relay no total; sem limite de gastos)`,
          )
        : tr(
            `扣了 ${amount} 钻石（通过 relay 累计 ${total}；本机上限还可花 ${ceilingLeft}）`,
            `Charged ${amount} gems (${total} spent through the relay in total; ${ceilingLeft} left under the local spending cap)`,
            `Se cobraron ${amount} gemas (${total} gastadas a través del relay en total; quedan ${ceilingLeft} dentro del límite de gasto local)`,
            `Foram cobradas ${amount} gemas (${total} gastas pelo relay no total; restam ${ceilingLeft} dentro do limite de gastos local)`,
          ),
    );
    if (ceiling !== null && this.ceilingLeft() <= 0) {
      this.state.update({ billingPause: 'budget' });
      await this.say(this.exhaustedText());
    }
  }

  // -------------------------------------------------------------------------------------------
  // Images

  private keptImage(): ImageRecord | null {
    return this.records.record<ImageRecord>(IMAGE_RECORDS, this.channel.scope);
  }

  private keepImage(record: ImageRecord | null) {
    this.records.setRecord(IMAGE_RECORDS, this.channel.scope, record);
  }

  /** `/image`, `/image resume`, `/image forget`. */
  private async imageCommand(event: InboundCommand, argument: string) {
    const action = argument.toLowerCase();
    if (action && action !== 'resume' && action !== 'forget')
      return void (await this.say(this.texts.imageUsage(this.channel.caps.quotes)));
    await this.afterBooking();
    if (this.turn) return void (await this.say(this.texts.busy));
    const kept = this.keptImage();
    if (action === 'forget') {
      if (!kept) return void (await this.say(this.texts.imageNothingToResume));
      // An accepted task is charged when it is delivered: only its own end may settle it.
      if (kept.taskId)
        return void (await this.say(this.texts.imageForgetAccepted(!this.uncapped())));
      // Only an unknown outcome goes; its pending charge is still settled before the next send.
      this.keepImage(null);
      this.log(
        tr(
          '主人放弃追踪上一次结果未知的生图请求',
          'The owner stopped tracking the last image request with an unknown outcome',
          'El dueño dejó de seguir la última solicitud de imagen con resultado desconocido',
          'O dono parou de acompanhar a última solicitação de imagem com resultado desconhecido',
        ),
      );
      return void (await this.say(this.texts.imageForgotten(!this.uncapped())));
    }
    if (this.job) return void (await this.say(this.imageWaitText(this.job.record)));
    const blocked = this.pausedText();
    if (blocked) return void (await this.say(blocked));
    if (action === 'resume') {
      if (!kept) return void (await this.say(this.texts.imageNothingToResume));
      if (kept.taskId) {
        await this.say(this.texts.imageResumed);
        this.startImageJob(kept);
        return;
      }
      // The answer never came: the same request again. If it was never accepted it is priced
      // now, so the higher of then and now must fit today's budget.
      let cost = kept.price;
      let worst: number | null = kept.worst ?? kept.price;
      try {
        const config = await getChatImageConfig(this.gateway, kept.npcId);
        cost = Math.max(cost, config.cost);
        worst = config.worstCost === null ? null : Math.max(worst, config.worstCost);
      } catch (error) {
        if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn))
          return this.signedOut();
        return void (await this.say(this.texts.imageConfigUnavailable(!this.uncapped())));
      }
      const money = await this.imageMoney(kept.npcId, cost, worst, true);
      if (money.refusal) return void (await this.say(money.refusal));
      return this.requestImage(
        { ...kept, mode: this.state.data.billing.mode, price: cost, worst: worst ?? cost },
        money.before,
        true,
      );
    }
    // A paused channel starts no new picture (one asked for before still resumes or is forgotten).
    const pause = this.channelPaused();
    if (pause)
      return void (await this.say(this.texts.channelPaused(this.channel.displayName, pause)));
    if (kept) {
      const open = await this.settleImage();
      if (open) return void (await this.say(open));
    }
    return this.newImage(event);
  }

  private async newImage(event: InboundCommand) {
    const character = this.state.data.character;
    if (!character) return void (await this.say(this.texts.noCharacter));
    let config;
    try {
      config = await getChatImageConfig(this.gateway, character.npcId);
    } catch (error) {
      if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn))
        return this.signedOut();
      if (error instanceof ApiError && error.code === CHARACTER_REMOVED)
        return void (await this.say(this.texts.unavailable));
      // An unknown price is "not free": nothing is asked for.
      this.log(
        tr(
          '读不到生图配置',
          "Can't read the image generation settings",
          'No se puede leer la configuración de generación de imágenes',
          'Não foi possível ler as configurações de geração de imagem',
        ),
      );
      return void (await this.say(this.texts.imageConfigUnavailable(!this.uncapped())));
    }
    if (!config.enabled) return void (await this.say(this.texts.imageDisabled));
    const anchor = await this.imageAnchor(event, character.npcId);
    if (!anchor) return;
    const money = await this.imageMoney(character.npcId, config.cost, config.worstCost);
    if (money.refusal) return void (await this.say(money.refusal));
    const requestId = chatImageRequestId(character.npcId, anchor.mid);
    const record: ImageRecord = {
      requestId,
      body: chatImageRequest({
        npcId: character.npcId,
        anchorMid: anchor.mid,
        requestId,
        aspectRatio: chatImageAspectRatio(config.aspectRatios),
      }),
      npcId: character.npcId,
      name: character.name,
      anchorMid: anchor.mid,
      cid: anchor.cid,
      taskId: '',
      mode: this.state.data.billing.mode,
      price: config.cost,
      worst: config.worstCost ?? config.cost,
      chatId: this.channel.persistId(event.chatId),
      told: false,
      refunding: false,
      at: Date.now(),
    };
    await this.requestImage(record, money.before);
  }

  /**
   * The reply a picture is drawn from: the one the owner answered with `/image`, else the latest
   * reply in this character's chat, else the opening ('' with `is_prologue`). Null when it cannot
   * be (said why).
   */
  private async imageAnchor(
    event: InboundCommand,
    npcId: string,
  ): Promise<{ mid: string; cid: string } | null> {
    let cid = '';
    let recent: ImMessage[] = [];
    try {
      cid = await conversationId(this.gateway, npcId);
      if (cid) recent = await listMessages(this.gateway, cid, 30);
    } catch (error) {
      if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn)) {
        await this.signedOut();
        return null;
      }
      const removed = error instanceof ChatRefusal && error.kind === 'unavailable';
      await this.say(removed ? this.texts.unavailable : this.texts.imageHistoryUnavailable);
      return null;
    }
    const isReply = (item: ImMessage) =>
      item.senderType === SenderType.assistant && item.semantic === Semantic.dialogueTurn;
    if (event.replyTo) {
      const mid = this.state.replyMid(event.replyTo);
      const known = recent.find((item) => item.mid === mid);
      if (!mid || (known && !isReply(known))) {
        await this.say(this.texts.imageNotReply);
        return null;
      }
      return { mid, cid };
    }
    return { mid: recent.find(isReply)?.mid ?? '', cid };
  }

  /**
   * The money checks before an image is asked for, as for a reply: earlier costs booked first, a
   * priced image never under free-only and, under a cap, only when it covers it, and only with a
   * balance that pays for it. One shown as free may still be charged its full price (`worst`: the
   * free images are a snapshot), so under a cap that must fit what this relay may still spend; an
   * unknown worst case refuses. Without a cap Yomi charges by its normal rules: an unreadable
   * balance blocks nothing (the image is then booked by its task). `refusal` says why not ('' when
   * it may go); `before` is the balance to measure from.
   */
  private async imageMoney(
    npcId: string,
    cost: number,
    worst: number | null,
    replay = false,
  ): Promise<{ refusal: string; before: number | null }> {
    const no = (refusal: string) => ({ refusal, before: null });
    const uncapped = this.uncapped();
    if (worst === null && !uncapped) return no(this.texts.imageConfigUnavailable(true));
    // A resend keeps the first send's pending charge: it is the same image, booked once at its end.
    if (!replay && !(await this.settlePending())) {
      if (!uncapped) return no(this.texts.walletUnavailable);
      this.log(
        tr(
          '读不到余额：之前的花费稍后再核对；没有设花费上限，照常生图',
          "Can't read the balance: the earlier cost is checked later; there is no spending cap, so the image is requested anyway",
          'No se puede leer el saldo: el costo anterior se verificará más tarde; no hay límite de gasto, así que la imagen se pide igual',
          'Não foi possível ler o saldo: o custo anterior será conferido depois; não há limite de gastos, então a imagem é solicitada mesmo assim',
        ),
      );
    }
    const paused = this.pausedText();
    if (paused) return no(paused);
    if (cost <= 0 && worst !== null && worst > this.ceilingLeft())
      return no(this.texts.imageFreeOverCeiling(worst, this.ceilingLeft()));
    if (cost > 0) {
      if (this.freeOnly()) return no(this.texts.imageNeedsBudget(cost, this.leaveHint()));
      if (!uncapped) {
        const left = this.left();
        if (left <= 0) {
          this.state.update({ billingPause: 'budget' });
          return no(this.exhaustedText());
        }
        if (cost > left)
          return no(
            this.ceilingLimits()
              ? this.texts.imageCeilingShort(cost, left)
              : this.texts.imageBudgetShort(cost, left),
          );
      }
    }
    const before = await this.balance();
    // Nothing on the server keeps an image free (no free-only mode as for replies): under a cap
    // every image, free or not, needs a balance to measure its cost against.
    if (before === null) {
      if (!uncapped) return no(this.texts.walletUnavailable);
      this.log(
        tr(
          '读不到余额：这张图片的花费按它的任务记录核对',
          "Can't read the balance: this image's cost is checked from its task",
          'No se puede leer el saldo: el costo de esta imagen se verifica a partir de su tarea',
          'Não foi possível ler o saldo: o custo desta imagem é conferido pela tarefa dela',
        ),
      );
    }
    if (cost > 0) {
      // A resend that was accepted the first time costs nothing more; one that was not is refused.
      if (before !== null && before < cost && !replay)
        return no(this.texts.imageGemsShort(cost, before));
      if (!this.imagePriceShown.has(npcId)) {
        await this.say(this.texts.imagePriceLine(cost) + this.texts.balanceLine(before));
        this.imagePriceShown.add(npcId);
      }
    }
    return { refusal: '', before };
  }

  /**
   * Sends the frozen request (kept first, so an answer that never comes leaves it to resend as
   * is). Only a known refusal (`chatImageRefusal`) of the first send charged nothing and forgets
   * it; anything else, an unrecognised code included, is an unknown outcome and keeps it with its
   * pending charge. A refused resend (`replay`) covers that resend only: the first send may have
   * been accepted, so the request and its pending charge stay.
   */
  private async requestImage(record: ImageRecord, before: number | null, replay = false) {
    // A resend keeps the first send's pending charge (measured from before that send). A new
    // measurement starts only when none is open: one that is (only without a cap) began before
    // this image and would take its charge too, so the image is then booked by its task alone.
    const pending = this.state.data.pending;
    const kept = replay && record.measured !== false ? pending : null;
    const fresh = !kept && !pending && before !== null && !(replay && record.measured === false);
    record.measured = Boolean(kept) || fresh;
    this.keepImage(record);
    // An image shown as free that is charged anyway pauses the relay under free-only and under a
    // budget (`book`).
    if (kept && record.price > 0 && kept.mode === 'free')
      this.state.update({ pending: { ...kept, mode: record.mode, price: record.price } });
    else if (fresh && before !== null)
      this.state.update({
        pending: {
          before,
          mode: record.price > 0 ? record.mode : 'free',
          price: record.price,
          at: Date.now(),
          capped: !this.uncapped(),
        },
      });
    let answer;
    try {
      answer = await createChatImageTask(this.gateway, record.body);
    } catch (error) {
      const refusal = chatImageRefusal(error);
      const signedOut =
        error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn);
      if (replay && (refusal || signedOut)) {
        this.keepImage({ ...record, taskId: '' });
        if (signedOut) return this.signedOut();
        this.log(
          tr(
            `重发的生图请求被拒绝：${refusal?.kind}（${refusal?.code}），保留请求`,
            `The resent image request was refused: ${refusal?.kind} (${refusal?.code}), keeping the request`,
            `Se rechazó la solicitud de imagen reenviada: ${refusal?.kind} (${refusal?.code}), se conserva la solicitud`,
            `A solicitação de imagem reenviada foi recusada: ${refusal?.kind} (${refusal?.code}), mantendo a solicitação`,
          ),
        );
        return void (await this.say(
          this.texts.imageReplayRefused(
            refusal && refusal.message !== refusal.code ? refusal.message : (refusal?.code ?? ''),
            !this.uncapped(),
          ),
        ));
      }
      if (refusal || signedOut) {
        this.keepImage(null);
        // Only its own measurement goes: one it did not start still holds earlier costs.
        if (record.measured) this.state.update({ pending: null });
        if (refusal) return this.imageRefused(refusal);
        return this.signedOut();
      }
      const code = error instanceof ApiError ? `${error.code}/HTTP ${error.httpStatus}` : 'error';
      this.log(
        tr(
          `生图请求结果未知（${code}）：保留请求，等主人用 /image resume 重发同一个请求`,
          `Image request outcome unknown (${code}): keeping the request until the owner resends it with /image resume`,
          `Resultado desconocido de la solicitud de imagen (${code}): se conserva la solicitud hasta que el dueño la reenvíe con /image resume`,
          `Resultado desconhecido da solicitação de imagem (${code}): mantendo a solicitação até o dono reenviá-la com /image resume`,
        ),
      );
      return void (await this.say(this.texts.imageUnknown));
    }
    record.taskId = answer.task.taskId;
    record.cid ||= answer.task.cid;
    record.at = Date.now();
    this.keepImage(record);
    this.log(
      answer.replay
        ? tr(
            '同一个生图请求已被受理过：继续跟进，不会重复扣费',
            'This image request was already accepted: still following it, no second charge',
            'Esta solicitud de imagen ya se aceptó: se sigue su estado, sin un segundo cobro',
            'Esta solicitação de imagem já foi aceita: continuando a acompanhá-la, sem uma segunda cobrança',
          )
        : tr(
            `已为「${record.name}」请求一张图片（${record.price > 0 ? `${record.price} 钻石` : '免费'}）`,
            `Requested an image for "${record.name}" (${record.price > 0 ? `${record.price} gems` : 'free'})`,
            `Se solicitó una imagen para "${record.name}" (${record.price > 0 ? `${record.price} gemas` : 'gratis'})`,
            `Uma imagem foi solicitada para "${record.name}" (${record.price > 0 ? `${record.price} gemas` : 'grátis'})`,
          ),
    );
    await this.say(this.texts.imageStarted(record.price));
    this.startImageJob(record);
  }

  private async imageRefused(refusal: GenRefusal) {
    this.log(
      tr(
        `生图被拒绝：${refusal.kind}（${refusal.code}）`,
        `Image generation refused: ${refusal.kind} (${refusal.code})`,
        `Generación de imagen rechazada: ${refusal.kind} (${refusal.code})`,
        `Geração de imagem recusada: ${refusal.kind} (${refusal.code})`,
      ),
    );
    switch (refusal.kind) {
      case 'gems':
        return void (await this.say(this.texts.imageGems));
      case 'rateLimited':
        return void (await this.say(this.texts.rateLimited(0)));
      default:
        return void (await this.say(
          this.texts.imageRefused(refusal.message === refusal.code ? '' : refusal.message),
        ));
    }
  }

  /**
   * A kept image is settled before anything else is sent: '' when nothing is open (any more),
   * else why nothing is sent now. Its pending charge is booked only once the task has ended and,
   * within its 180 s window, once a delivered priced picture's charge has landed (after /stop or
   * a timeout too): until then the task is followed again and nothing is sent. Without a cap a
   * reply (`forReply`) does not wait for the measurement: an unknown outcome, an unreadable task
   * or a charge still landing let it go, riding along the image's measurement (`chat`); a
   * picture still being made is waited for all the same, one at a time.
   */
  private async settleImage(forReply = false): Promise<string> {
    const record = this.keptImage();
    if (!record) return '';
    if (this.job) return this.imageWaitText(this.job.record);
    const along = forReply && this.uncapped();
    if (!record.taskId) return along ? '' : this.texts.imageKeptUnknown(!this.uncapped());
    let task: ChatImageTask;
    try {
      task = await getChatImageTask(this.gateway, record.taskId);
    } catch (error) {
      if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn))
        throw error;
      return along ? '' : this.texts.imageUnchecked;
    }
    const window = this.options.imageTimeoutMs ?? CHAT_IMAGE_TIMEOUT_MS;
    const patient = Date.now() < record.at + window;
    if (await this.concludeImage(record, task, new Map(), patient)) return '';
    // Delivered, its charge still landing: a later send (or the next start) settles it.
    if (along && record.told) return '';
    this.startImageJob(record);
    return this.imageWaitText(record);
  }

  /** Why nothing new goes while an image is followed: still being made, or its charge landing. */
  private imageWaitText(record: ImageRecord): string {
    return record.told ? this.texts.imageSettling(!this.uncapped()) : this.texts.imageBusy;
  }

  private startImageJob(record: ImageRecord): ImageJob {
    const stop = new AbortController();
    let wakeUp: (() => void) | null = null;
    const job: ImageJob = {
      record,
      pushes: new Map(),
      wake: () => wakeUp?.(),
      stop,
      done: Promise.resolve(),
    };
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const end = () => {
          clearTimeout(timer);
          wakeUp = null;
          stop.signal.removeEventListener('abort', end);
          resolve();
        };
        const timer = setTimeout(end, ms);
        wakeUp = end;
        stop.signal.addEventListener('abort', end, { once: true });
      });
    this.job = job;
    job.done = this.followImage(job, pause)
      .catch((error) => this.unexpected(error))
      .finally(() => {
        if (this.job === job) this.job = null;
      });
    return job;
  }

  /**
   * Reads the task every 2 s (sooner when a push may be its picture) for at most 180 s, as the
   * app does. Stopping or running out of time cancels nothing: the server goes on and the record
   * stays for `/image resume`.
   */
  private async followImage(job: ImageJob, pause: (ms: number) => Promise<void>) {
    const { record } = job;
    const window = this.options.imageTimeoutMs ?? CHAT_IMAGE_TIMEOUT_MS;
    const deadline = Date.now() + window;
    const every = this.options.imagePollMs ?? CHAT_IMAGE_POLL_MS;
    let reported = false;
    while (!job.stop.signal.aborted && !this.abort.signal.aborted) {
      let task: ChatImageTask | null = null;
      try {
        task = await getChatImageTask(this.gateway, record.taskId);
      } catch (error) {
        if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn))
          return this.signedOut();
        if (!reported)
          this.log(
            tr(
              '读取生图进度失败，继续重试',
              "Couldn't read the image progress, still retrying",
              'No se pudo leer el progreso de la imagen, se sigue reintentando',
              'Não foi possível ler o progresso da imagem, continuando a tentar',
            ),
          );
        reported = true;
      }
      if (job.stop.signal.aborted) return;
      // A picture delivered late still gets its full window for the charge to land.
      const patient = Date.now() < Math.max(deadline, record.told ? record.at + window : 0);
      if (task && (await this.concludeImage(record, task, job.pushes, patient))) return;
      if (!patient) {
        if (record.told)
          this.log(
            tr(
              '图片的扣费还没结算完：下一次发送前再核对',
              "The image's charge is not settled yet: will check before the next send",
              'El cobro de la imagen aún no se liquidó: se verificará antes del próximo envío',
              'A cobrança da imagem ainda não foi finalizada: será conferida antes do próximo envio',
            ),
          );
        else {
          this.log(
            tr(
              '图片还没生成好：服务端会继续，主人可用 /image resume 继续等待',
              'The image is not ready yet: the server keeps going, the owner can wait again with /image resume',
              'La imagen aún no está lista: el servidor sigue trabajando, el dueño puede volver a esperar con /image resume',
              'A imagem ainda não está pronta: o servidor continua trabalhando, o dono pode esperar de novo com /image resume',
            ),
          );
          await this.say(this.texts.imageTimeout);
        }
        return;
      }
      await pause(every);
    }
  }

  /**
   * Acts on what the task says once nothing more will change: the picture to the owner when it
   * was delivered, or why there is none; then, once its gems are where they stay, books them like
   * a reply's and forgets the request. True when it is settled. `patient`: a delivered priced
   * picture that reads "not charged" is given time for its charge to land.
   */
  private async concludeImage(
    record: ImageRecord,
    task: ChatImageTask,
    pushes: Map<string, ImMessage>,
    patient: boolean,
  ): Promise<boolean> {
    if (!chatImageDone(task)) return false;
    let waiting = patient;
    if (!record.told) {
      if (task.generation === ImageGeneration.failed) {
        const note = this.texts.imageBilling(billingNote(task.billing));
        const detail = task.failure?.message ?? '';
        await this.say(
          contentRejected(task.failure)
            ? this.texts.imageRejected(detail, note)
            : this.texts.imageFailed(detail, note),
        );
        this.log(
          tr(
            `图片没有生成成功（${task.failure?.code || '未知原因'}）`,
            `The image was not generated (${task.failure?.code || 'unknown reason'})`,
            `No se generó la imagen (${task.failure?.code || 'motivo desconocido'})`,
            `A imagem não foi gerada (${task.failure?.code || 'motivo desconhecido'})`,
          ),
        );
      } else if (task.delivery === ImageDelivery.skippedConversationDeleted)
        await this.say(this.texts.imageSkipped);
      else await this.forwardImage(record, task, pushes);
      record.told = true;
      record.refunding = task.billing === ImageBilling.refundPending;
      // Its charge may still be on the way: the window starts again from now.
      record.at = Date.now();
      this.keepImage(record);
      waiting = true;
    }
    if (!chatImageBillingSettled(task, waiting && record.price > 0)) return false;
    if (record.refunding && task.billing === ImageBilling.refunded)
      await this.say(this.texts.imageRefunded);
    await this.settleImageCharge(record, task);
    this.keepImage(null);
    return true;
  }

  /**
   * Books a settled image by what its task says, not by the balance: another `yomi` process
   * spending or a top-up meanwhile would distort a drop. Charged: its price (a free one charged
   * anyway: the full price, which pauses the relay under free-only or a budget). Not charged,
   * refunded or failed: nothing. Any other state is measured from the balance as before. A drop
   * that disagrees is logged. Without a cap two things differ: an image that had no measurement of
   * its own (`measured` false) is booked by its task alone and taken out of the measurement that
   * was open (which began before it); and replies that rode along its measurement (`extra`) get
   * the rest of the drop.
   */
  private async settleImageCharge(record: ImageRecord, task: ChatImageTask) {
    const pending = this.state.data.pending;
    const mode: BillingMode = record.price > 0 ? record.mode : 'free';
    const billing = task.billing;
    const known =
      billing === ImageBilling.charged
        ? record.price > 0
          ? record.price
          : (record.worst ?? null)
        : billing === ImageBilling.notCharged ||
            billing === ImageBilling.refunded ||
            billing === ImageBilling.chargeFailed
          ? 0
          : null;
    if (record.measured === false) {
      if (known === null) {
        // Inside the open measurement's drop, it is booked with it; without one it is lost.
        if (!pending) {
          this.countUnmeasured();
          this.log(
            tr(
              '这张图片的花费量不出来（读不到余额，任务也没有记录）',
              "This image's cost can't be measured (the balance was unreadable and the task does not say)",
              'No se puede medir el costo de esta imagen (el saldo no se pudo leer y la tarea no lo indica)',
              'O custo desta imagem não pode ser medido (não foi possível ler o saldo e a tarefa não informa)',
            ),
          );
        }
        return;
      }
      if (pending) this.state.update({ pending: { ...pending, before: pending.before - known } });
      await this.book(known, mode);
      return;
    }
    if (!pending) return;
    if (known === null) {
      if (!(await this.settlePending()))
        this.log(
          tr(
            '暂时读不到余额：这张图片的花费会在下一条发送前核对',
            "Can't read the balance right now: this image's cost will be checked before the next send",
            'No se puede leer el saldo en este momento: el costo de esta imagen se verificará antes del próximo envío',
            'Não foi possível ler o saldo agora: o custo desta imagem será conferido antes do próximo envio',
          ),
        );
      return;
    }
    if (pending.extra) {
      // Replies rode along: the image is booked by its task, the rest of the drop is theirs.
      this.state.update({
        pending: {
          before: pending.before - known,
          mode: 'open',
          price: null,
          at: pending.at,
          capped: false,
        },
      });
      await this.book(known, mode);
      if (!(await this.settlePending()))
        this.log(
          tr(
            '暂时读不到余额：图片期间发出的消息的花费会在下一条发送前核对',
            "Can't read the balance right now: the cost of the messages sent during the image will be checked before the next send",
            'No se puede leer el saldo en este momento: el costo de los mensajes enviados durante la imagen se verificará antes del próximo envío',
            'Não foi possível ler o saldo agora: o custo das mensagens enviadas durante a imagem será conferido antes do próximo envio',
          ),
        );
      return;
    }
    const now = await this.balance();
    this.state.update({ pending: null });
    if (now !== null && pending.before - now !== known)
      this.log(
        tr(
          `这张图片按任务记为 ${known} 钻石；同期余额变化 ${pending.before - now}（其他扣费或充值），按任务计入预算`,
          `The task records this image at ${known} gems; the balance changed by ${pending.before - now} meanwhile (other charges or top-ups), counting the task's amount against the budget`,
          `La tarea registra esta imagen en ${known} gemas; mientras tanto el saldo cambió en ${pending.before - now} (otros cobros o recargas), se descuenta del presupuesto el monto de la tarea`,
          `A tarefa registra esta imagem em ${known} gemas; enquanto isso o saldo mudou em ${pending.before - now} (outras cobranças ou recargas), descontando do orçamento o valor da tarefa`,
        ),
      );
    await this.book(known, pending.mode);
  }

  /**
   * The delivered picture to the owner: downloaded here (fresh links from the task, else the
   * message's) and uploaded to the channel, never as a link. Only this task's own message counts.
   */
  private async forwardImage(
    record: ImageRecord,
    task: ChatImageTask,
    pushes: Map<string, ImMessage>,
  ) {
    const assetIds = new Set(task.assets.map((asset) => asset.assetId).filter(Boolean));
    const ours = (item: ImMessage) =>
      task.resultMid
        ? item.mid === task.resultMid
        : item.content.images.some((image) => assetIds.has(image.assetId));
    let message = [...pushes.values()].find(ours) ?? null;
    if (!message) {
      // The push may never come: the result is read back from history.
      const cid = record.cid || task.cid;
      try {
        if (cid) message = (await listMessages(this.gateway, cid, 20)).find(ours) ?? null;
      } catch (error) {
        if (error instanceof NotSignedIn) throw error;
      }
    }
    const owner = this.state.data.owner;
    if (!owner || String(owner.chatId) !== String(record.chatId)) {
      this.log(
        tr(
          '配对的主人变了：这张图片没有转发',
          'The paired owner changed: this image was not forwarded',
          'Cambió el dueño vinculado: esta imagen no se reenvió',
          'O dono pareado mudou: esta imagem não foi encaminhada',
        ),
      );
      return;
    }
    const picture = await this.downloadImage(task, message);
    if (!picture) {
      this.log(
        tr(
          '图片下载失败',
          "Couldn't download the image",
          'No se pudo descargar la imagen',
          'Não foi possível baixar a imagem',
        ),
      );
      return void (await this.say(this.texts.imageForwardFailed(this.channel.displayName)));
    }
    const chat = String(owner.chatId);
    await this.channel.typing(chat, 'photo', this.replyTo).catch(() => undefined);
    try {
      const sent = await this.channel.sendPhoto(
        chat,
        picture,
        this.texts.imageCaption(record.name),
        this.replyTo,
      );
      const mid = task.resultMid || message?.mid || '';
      if (mid && sent.status === 'sent' && sent.refs.length)
        this.state.rememberReply(this.channel.persistId(sent.refs[0]), mid);
      this.log(
        tr(
          `已转发一张「${record.name}」的图片`,
          `Forwarded an image from "${record.name}"`,
          `Se reenvió una imagen de "${record.name}"`,
          `Uma imagem de "${record.name}" foi encaminhada`,
        ),
      );
    } catch (error) {
      const name = this.channel.displayName;
      const detail = error instanceof ChannelError ? `${error.operation} ${error.code}` : '';
      this.log(
        tr(
          `图片发到${spaced(name, 'both')}失败${detail ? `（${detail}）` : ''}`,
          `Couldn't send the image to ${name}${detail ? ` (${detail})` : ''}`,
          `No se pudo enviar la imagen a ${name}${detail ? ` (${detail})` : ''}`,
          `Não foi possível enviar a imagem ao ${name}${detail ? ` (${detail})` : ''}`,
        ),
      );
      await this.say(this.texts.imageForwardFailed(name));
    }
  }

  /** The first link with a picture the channel takes (Telegram: 10 MB); expired ones skipped. */
  private async downloadImage(
    task: ChatImageTask,
    message: ImMessage | null,
  ): Promise<OutgoingFile | null> {
    const maxBytes = this.channel.caps.maxPhotoBytes;
    const now = Date.now();
    const fresh = (expires: number) => !expires || expires > now + 5000;
    const links: string[] = [];
    for (const asset of task.assets)
      if (fresh(asset.accessExpiresAtMs) && asset.sizeBytes <= maxBytes) links.push(asset.url);
    for (const image of message?.content.images ?? [])
      if (fresh(image.accessExpiresAtMs)) links.push(image.url);
    for (const asset of task.assets)
      if (fresh(asset.accessExpiresAtMs)) links.push(asset.thumbnailUrl);
    for (const image of message?.content.images ?? [])
      if (fresh(image.accessExpiresAtMs)) links.push(image.thumbnailUrl);
    for (const link of new Set(links.filter(Boolean))) {
      try {
        const { bytes } = await download(link, { maxBytes, fetcher: timedFetch });
        const mime = sniffMime(bytes);
        if (mime) return { bytes, mime, name: `yomi-${task.taskId}.${extensionOf(mime)}` };
      } catch {
        // The next link.
      }
    }
    return null;
  }

  /** `/stop` while a picture is awaited: stop waiting; the server still makes (and charges) it. */
  private async stopImage() {
    const job = this.job;
    if (!job) return void (await this.say(this.texts.nothingToStop));
    job.stop.abort();
    await job.done;
    this.log(
      tr(
        '主人停止了等待图片',
        'The owner stopped waiting for the image',
        'El dueño dejó de esperar la imagen',
        'O dono parou de esperar a imagem',
      ),
    );
    await this.say(this.texts.imageStopped);
  }

  /**
   * A message committed on its own (a generated picture). It is only a hint for the image this
   * relay asked for: the task's own `result_mid` decides, so another device's picture is never
   * forwarded. Deduplicated by `(cid, mid)`.
   */
  private onPersisted(event: StreamEvent) {
    const message = event.message;
    if (!message || !event.cid) return;
    const key = `${event.cid}:${message.mid}`;
    if (this.persisted.has(key)) return;
    this.persisted.add(key);
    if (this.persisted.size > 500) this.persisted = new Set([...this.persisted].slice(-200));
    const job = this.job;
    if (!job || event.entityId !== job.record.npcId) return;
    if (job.record.cid && event.cid !== job.record.cid) return;
    if (job.record.anchorMid && message.sourceMid && message.sourceMid !== job.record.anchorMid)
      return;
    if (job.pushes.size < 20) job.pushes.set(message.mid, message);
    job.wake();
  }

  // -------------------------------------------------------------------------------------------
  // The long connection and the session

  private connect() {
    const credential = this.gateway.credential;
    if (!credential) return;
    this.connection?.stop();
    const connection = new ImConnection({
      url: () => {
        if (this.gateway.reloadCredential() === 'otherAccount') this.otherAccount();
        return this.gateway.connectionURL();
      },
      headers: () => this.gateway.connectionHeaders(),
      userId: credential.userId,
      deviceId: credential.deviceId,
      businessTypes: [BusinessType.conversationStream, BusinessType.conversationAside],
      purpose: ConversationPurpose.normal,
      maxBackoffMs: 30_000,
      watchWake: true,
      createSocket: this.options.createSocket,
      onConnected: () => {
        this.drain(connection).catch((error) => this.unexpected(error));
      },
      onState: (state) => {
        if (state === 'retrying' && connection.reconnects % 10 === 1)
          this.log(
            tr(
              'Yomi 长连接断开，正在重连',
              'Yomi connection dropped, reconnecting',
              'Se cortó la conexión con Yomi, reconectando',
              'A conexão com o Yomi caiu, reconectando',
            ),
          );
      },
    });
    connection.on((event) => {
      if (event.kind === 'stream') this.onStream(event.event);
      else if (event.kind === 'aside') this.onAside(event.event);
    });
    this.connection = connection;
    connection.start();
  }

  /** What arrived while no socket was open (`poll_message`), then a missed reply from history. */
  private async drain(connection: ImConnection) {
    for (let page = 0; page < 10; page++) {
      let result;
      try {
        result = await pollMessages(this.gateway, 50);
      } catch (error) {
        if (error instanceof NotSignedIn) await this.signedOut();
        break;
      }
      result.packets
        .filter(
          (packet) =>
            packet.command === Command.business || packet.command === Command.businessStreaming,
        )
        .sort((a, b) => a.sid - b.sid)
        .forEach((packet) => connection.ingest(packet));
      if (!result.hasMore) break;
    }
    const turn = this.turn;
    if (turn && !turn.settled && connection.reconnects > 0) await this.catchUp(turn, false);
  }

  private async signedOut() {
    if (this.gate === 'signedOut') return;
    this.log(
      tr(
        'Yomi 登录已失效，relay 暂停；在这台电脑上运行 yomi login 后自动恢复',
        'Yomi sign-in expired, relay paused; it resumes on its own after you run yomi login on this machine',
        'La sesión de Yomi expiró, relay en pausa; se reanuda solo cuando ejecutes yomi login en este equipo',
        'O login do Yomi expirou, relay pausado; ele volta sozinho depois que você executar yomi login nesta máquina',
      ),
    );
    this.gate = 'signedOut';
    this.connection?.stop();
    const turn = this.turn;
    if (turn && !turn.settled) {
      // Its charge, if any, stays pending and is settled before the next send.
      turn.settled = true;
      if (turn.watchdog) clearTimeout(turn.watchdog);
      await turn.presenter.stop().catch(() => undefined);
      this.endTurn(turn);
    }
    await this.say(this.texts.signedOut);
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.resumeTimer = setInterval(
      () => this.tryResume().catch((error) => this.unexpected(error)),
      this.options.resumeCheckMs ?? 15_000,
    );
    this.resumeTimer.unref?.();
  }

  private async tryResume() {
    this.gateway.reloadCredential();
    const credential = this.gateway.credential;
    if (!credential) return;
    if (credential.userId !== this.userId) return this.otherAccount();
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.resumeTimer = null;
    // Only the sign-in came back: a channel the server has not confirmed stays off.
    if (this.gate === 'signedOut') this.gate = this.policyGated ? 'disabled' : '';
    this.log(
      tr(
        'Yomi 登录已恢复',
        'Yomi sign-in restored',
        'Sesión de Yomi restablecida',
        'Login do Yomi restabelecido',
      ),
    );
    this.connect();
    await this.say(this.texts.resumed);
    const kept = this.keptImage();
    if (kept?.taskId && !this.job) this.startImageJob(kept);
  }

  private otherAccount() {
    if (this.stopReason) return;
    this.stopReason = new RelayStopped(
      'otherAccount',
      tr(
        '这台电脑上登录的 Yomi 账号变了，relay 已停止。',
        'The Yomi account signed in on this machine changed, relay stopped.',
        'Cambió la cuenta de Yomi con sesión iniciada en este equipo, relay detenido.',
        'A conta do Yomi conectada nesta máquina mudou, relay parado.',
      ),
    );
    void this.say(this.texts.otherAccount(this.options.rerunCommand ?? 'yomi relay --telegram'));
    this.abort.abort();
  }

  private async unexpected(error: unknown) {
    if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn))
      return this.signedOut();
    this.log(
      tr(
        `处理消息出错：${error instanceof Error ? `${error.name} ${error.message}`.slice(0, 200) : 'error'}`,
        `Error handling a message: ${error instanceof Error ? `${error.name} ${error.message}`.slice(0, 200) : 'error'}`,
        `Error al procesar un mensaje: ${error instanceof Error ? `${error.name} ${error.message}`.slice(0, 200) : 'error'}`,
        `Erro ao processar uma mensagem: ${error instanceof Error ? `${error.name} ${error.message}`.slice(0, 200) : 'error'}`,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Talking to the owner

  /** Plain text to the owner (the channel escapes it); a failure is logged. */
  private say(text: string) {
    return this.deliver({ text });
  }

  /** Text already in the channel's format (a rendered opening). */
  private sayFormatted(text: string) {
    return this.deliver({ text, formatted: true });
  }

  private async deliver(message: OutgoingText): Promise<void> {
    const owner = this.state.data.owner;
    if (!owner || !message.text) return;
    try {
      await this.channel.send(String(owner.chatId), message, this.replyTo);
    } catch (error) {
      this.sendFailed(error);
    }
  }

  /** A question to the owner (buttons or a typed code); null when it could not be shown. */
  private async ask(question: Question): Promise<AskRef | null> {
    const owner = this.state.data.owner;
    if (!owner || !question.prompt) return null;
    try {
      return await this.channel.ask(String(owner.chatId), question, this.replyTo);
    } catch (error) {
      this.sendFailed(error);
      return null;
    }
  }

  private sendFailed(error: unknown) {
    const name = this.channel.displayName;
    if (error instanceof ChannelError && error.reason === 'blocked')
      this.log(
        tr(
          '主人屏蔽了 bot，消息发不出去',
          "The owner blocked the bot, messages can't be sent",
          'El dueño bloqueó el bot, no se pueden enviar mensajes',
          'O dono bloqueou o bot, não é possível enviar mensagens',
        ),
      );
    // The channel tells the owner itself (once a run), and pauses after repeated refusals.
    else if (error instanceof ChannelError && error.reason === 'contentRefused')
      this.log(
        tr(
          `${spaced(name, 'after')}按内容规则拒绝了一条消息`,
          `${name} refused a message under its content rules`,
          `${name} rechazó un mensaje por sus reglas de contenido`,
          `O ${name} recusou uma mensagem pelas regras de conteúdo`,
        ),
      );
    else
      this.log(
        tr(
          `发给${spaced(name, 'both')}失败${error instanceof ChannelError ? `（${error.code}）` : ''}`,
          `Couldn't send to ${name}${error instanceof ChannelError ? ` (${error.code})` : ''}`,
          `No se pudo enviar a ${name}${error instanceof ChannelError ? ` (${error.code})` : ''}`,
          `Não foi possível enviar ao ${name}${error instanceof ChannelError ? ` (${error.code})` : ''}`,
        ),
      );
  }
}

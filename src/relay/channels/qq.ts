import type { Context } from '../../commands/context.js';
import type { RelayCommandOptions } from '../../commands/relay.js';
import { asciiJson, storeDescription } from '../../core/credentials.js';
import { UsageError } from '../../core/env.js';
import { tr } from '../../core/i18n.js';
import { readLine, readLines, readSecret } from '../../core/prompt.js';
import { paint, say, warn } from '../../core/ui.js';
import type { PairingCode } from '../pairing.js';
import { type Formatter, PLAIN } from '../render.js';
import { OutOfContextQueue } from './queue.js';
import {
  ACTIVE_OFF_CODES,
  codeOf,
  MARKDOWN_CODES,
  QQ_CODE,
  QqApi,
  qqApiOrigin,
  QqError,
  type QqSent,
  type QqStreamSent,
  QqTokens,
  TOO_LONG_CODES,
} from './qq-api.js';
import {
  probeGateway,
  QqGateway,
  type QqDispatch,
  type QqGatewayTimings,
  tokenStopped,
} from './qq-gateway.js';
import {
  type Held,
  heldText,
  isQqContext,
  type QqContext,
  type QqOutlet,
  QqPresenter,
} from './qq-presenter.js';
import { QQ_MARKDOWN, QQ_MARKDOWN_ENABLED } from './qq-render.js';
import type { ChannelSetup } from './setup.js';
import { TextQuestions } from './text-ask.js';
import { TextInbound } from './text-inbound.js';
import {
  type AskRef,
  type BotIdentity,
  type ChannelCaps,
  ChannelError,
  type ChannelHost,
  channelName,
  type InboundEvent,
  type OutgoingFile,
  type OutgoingText,
  type PresenterRequest,
  type Question,
  type RelayChannel,
  type ReplyContext,
  type ReplyPresenter,
  type Sent,
} from './types.js';

/**
 * QQ as a relay channel (design §9): the person's own official bot (q.qq.com), its AppID and
 * AppSecret in the keychain, the official WebSocket gateway for private-chat (C2C) events, and
 * REST sends under QQ's reply rules. A message to the owner answers one of their messages while
 * that is allowed (a passive reply: a few per message, for a few minutes, each with its own
 * `msg_seq`), else goes as an active message (which the owner can switch off, and QQ rations),
 * else waits in a queue for the owner's next message. Sends made while the core handles a
 * message, or while a reply streams, are held and released merged, so notices share messages
 * instead of using up the replies. Inbound messages go through the shared pipeline for text
 * channels (text-inbound.ts); the ids of handled messages and the gateway's position are kept in
 * the state file, so a Resume after a restart never relays (and charges) a message twice.
 * Personal use only.
 */

/** Constants of design §9.8 (constructor options, so tests can shrink them). */
export const QQ_DEFAULTS = {
  /** Passive replies: 5 minutes per QQ's msg_id page (the overview says 60), minus a margin. */
  passiveWindowMs: 270_000,
  passiveMax: 4,
  /** Held notices up to this long ride in a reply's first message. */
  prefixMax: 600,
  /** 40034100 (active message rate limit): no active messages for this long. */
  activeHoldMs: 600_000,
  /** This many content refusals in one run pause relaying. */
  contentRefusalsMax: 3,
  /** A stored session younger than this is resumed after a restart. */
  resumeMaxAgeMs: 300_000,
  /** Sends outside the handling of an event are released this long after the last one. */
  backgroundFlushMs: 500,
  streamIntervalMs: 1000,
  maxText: 2000,
  /** `file_data` uploads are 5 MB at most. */
  maxPhotoBytes: 5 * 1024 * 1024,
  /** A transient failure is retried once after this. */
  retryDelayMs: 1000,
  /** close() waits this long for held sends before queueing them. */
  closeWaitMs: 3000,
  /** Events waiting to be handled at most (the oldest go). */
  eventsMax: 100,
  /** Ids of handled messages kept in the state file. */
  seenMax: 200,
  /** The gateway's position is written at least this often while connected. */
  gatewaySaveMs: 60_000,
  /** A new session after this long without QQ: messages sent meanwhile were not received. */
  offlineGapMs: 60_000,
};

/** Typing (`msg_type: 6`) may use one of the 4 replies (Q-4): off until checked. */
export const QQ_TYPING = false;
/** `C2C_MSG_RECEIVE` / `FRIEND_ADD` answered with their `event_id` (Q-12): off until checked. */
export const QQ_EVENT_REPLIES = false;
/** Inbound quotes (`ref_msg_idx`) matched to the replies' `ref_idx` (Q-6): off until checked. */
export const QQ_QUOTES = false;

export type QqChannelOptions = Partial<typeof QQ_DEFAULTS> & {
  appId: string;
  secret: string;
  /** `YOMI_QQ_API_ORIGIN` (loopback only). */
  apiOrigin?: string;
  markdown?: boolean;
  typing?: boolean;
  eventReplies?: boolean;
  quotes?: boolean;
  gateway?: Partial<QqGatewayTimings>;
  fetch?: typeof fetch;
};

/** The gateway's position in the state file (`gateway`). */
type StoredGateway = { sessionId: string; seq: number; at: number };

/**
 * A dispatch waiting for the core: the session it came in, and when it arrived (QQ's reply window
 * runs from then, not from when the core got to it).
 */
type Queued = QqDispatch & { session: string; at: number };

/** C2C_MESSAGE_CREATE's `d` (the fields the relay reads). */
type C2CMessage = {
  id?: string;
  content?: string;
  timestamp?: string;
  author?: { id?: string; user_openid?: string; bot?: boolean };
  message_scene?: { ext?: string[] };
};

/** The quoted message's index (`ref_msg_idx=…` in `message_scene.ext`). */
function quoteOf(message: C2CMessage): string {
  for (const entry of message.message_scene?.ext ?? []) {
    const match = /^ref_msg_idx=(.+)$/.exec(String(entry));
    if (match) return match[1];
  }
  return '';
}

/** Cuts formatted text into messages of at most `limit`, at a line break or space when it can. */
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    let at = cut > limit / 2 ? cut + 1 : limit;
    if (/[\uD800-\uDBFF]/.test(rest[at - 1] ?? '')) at -= 1;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class QqChannel implements RelayChannel, QqOutlet {
  readonly kind = 'qq' as const;
  readonly displayName = channelName('qq');
  readonly caps: ChannelCaps;
  readonly api: QqApi;
  readonly appId: string;
  streamingDisabled = false;
  private readonly settings: typeof QQ_DEFAULTS;
  private host: ChannelHost | null = null;
  private questions: TextQuestions | null = null;
  private queue: OutOfContextQueue | null = null;
  private inbound: TextInbound | null = null;
  private gateway: QqGateway | null = null;
  private gatewayDone: Promise<void> | null = null;
  /** The gateway's run() has returned (stopped, or a reason to end the relay in `fatal`). */
  private gatewayEnded = false;
  private fatal: unknown = null;
  /** Dispatches waiting to be handled, each with the session it came in and when it arrived. */
  private events_: Queued[] = [];
  private waiter: (() => void) | null = null;
  /** The owner's recent messages, oldest first: any of them may still take a passive reply. */
  private ownerContexts: QqContext[] = [];
  /** Every recent context (close() releases what they hold). */
  private recent: QqContext[] = [];
  private current: QqContext | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private refusals = 0;
  private offlineNotice = false;
  private groupsLogged = false;
  private overflowLogged = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private seen: string[] = [];
  private handledSeq = 0;
  private storedAt = 0;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: QqChannelOptions) {
    this.settings = { ...QQ_DEFAULTS };
    for (const key of Object.keys(QQ_DEFAULTS) as (keyof typeof QQ_DEFAULTS)[])
      if (typeof options[key] === 'number') this.settings[key] = options[key]!;
    this.appId = options.appId;
    const origin = qqApiOrigin(options.apiOrigin);
    const tokens = new QqTokens({
      appId: options.appId,
      secret: options.secret,
      origin,
      fetch: options.fetch,
    });
    this.api = new QqApi(tokens, origin, options.fetch);
    this.caps = {
      maxText: this.settings.maxText,
      format: (options.markdown ?? QQ_MARKDOWN_ENABLED) ? QQ_MARKDOWN : PLAIN,
      maxPhotoBytes: this.settings.maxPhotoBytes,
      quotes: options.quotes ?? QQ_QUOTES,
      pairing: 'code',
    };
  }

  /** `qq:<AppID>`: the state file, the image record. */
  get scope(): string {
    return `qq:${this.appId}`;
  }

  get lockName(): string {
    return `qq-${this.appId}`;
  }

  // QqOutlet --------------------------------------------------------------------------------

  get maxText(): number {
    return this.caps.maxText;
  }

  get format(): Formatter {
    return this.caps.format;
  }

  get prefixMax(): number {
    return this.settings.prefixMax;
  }

  get streamIntervalMs(): number {
    return this.settings.streamIntervalMs;
  }

  get retryDelayMs(): number {
    return this.settings.retryDelayMs;
  }

  usable(context: QqContext): boolean {
    return (
      !context.usedUp &&
      context.replies < this.settings.passiveMax &&
      Date.now() - context.receivedAt < this.settings.passiveWindowMs
    );
  }

  take(context: QqContext): number {
    context.replies += 1;
    return context.nextSeq++;
  }

  stream(openid: string, body: Record<string, unknown>): Promise<QqStreamSent> {
    return this.api.stream(openid, body).catch((error: unknown) => {
      this.refusedToken(error);
      throw error;
    });
  }

  recall(openid: string, messageId: string): Promise<void> {
    return this.api.recall(openid, messageId).catch((error: unknown) => {
      this.refusedToken(error);
      throw error;
    });
  }

  deliver(context: QqContext, items: Held[]): Promise<string[]> {
    return this.serial(() => this.deliverNow(context, items));
  }

  release(context: QqContext, now = false): Promise<string[]> {
    if (context.timer) clearTimeout(context.timer);
    context.timer = null;
    if (context.presenterOpen || (context.handling && !now)) return Promise.resolve([]);
    return this.serial(() => this.deliverNow(context, context.pending.splice(0)));
  }

  contentRefused(context: QqContext | null): void {
    const host = this.requireHost();
    this.refusals += 1;
    host.log(
      tr(
        `QQ 按内容规则拒绝了一条消息（本次运行第 ${this.refusals} 次）`,
        `QQ refused a message under its content rules (${this.refusals} in this run)`,
        `QQ rechazó un mensaje por sus reglas de contenido (${this.refusals} en esta ejecución)`,
        `O QQ recusou uma mensagem pelas regras de conteúdo (${this.refusals} nesta execução)`,
      ),
    );
    if (this.refusals === 1) {
      const target = context && this.usable(context) ? context : this.newestUsable();
      const text = host.texts.contentRefused(this.displayName);
      if (target) this.hold(target, { text, formatted: false });
      else this.queue?.push({ text, at: Date.now() });
    }
    if (this.refusals === this.settings.contentRefusalsMax) host.pause('contentRefused', null);
  }

  markdownRefused(): void {
    if (this.caps.format === PLAIN) return;
    this.caps.format = PLAIN;
    this.host?.log(
      tr(
        'QQ 不接受 markdown，本次运行改发纯文本',
        'QQ refused markdown: sending plain text for the rest of this run',
        'QQ rechazó el markdown: se enviará texto sin formato durante el resto de esta ejecución',
        'O QQ recusou o markdown: será enviado texto simples no resto desta execução',
      ),
    );
  }

  disableStreaming(error: unknown): void {
    if (this.streamingDisabled) return;
    this.streamingDisabled = true;
    this.host?.log(
      tr(
        `QQ 流式消息不可用（${codeOf(error) || 'error'}），本次运行改为整条发送回复`,
        `QQ streaming is unavailable (${codeOf(error) || 'error'}): replies are sent whole for the rest of this run`,
        `El streaming de QQ no está disponible (${codeOf(error) || 'error'}): las respuestas se enviarán completas durante el resto de esta ejecución`,
        `O streaming do QQ não está disponível (${codeOf(error) || 'error'}): as respostas serão enviadas inteiras no resto desta execução`,
      ),
    );
  }

  // RelayChannel ----------------------------------------------------------------------------

  /** The token (refused: `ChannelError` 'unauthorized'), then the bot's name if QQ gives it. */
  async verify(): Promise<BotIdentity> {
    await this.api.tokens.get();
    try {
      const me = await this.api.me();
      return { id: String(me.id || this.appId), name: String(me.username ?? ''), handle: '' };
    } catch {
      return { id: this.appId, name: '', handle: '' };
    }
  }

  async connect(host: ChannelHost): Promise<void> {
    this.host = host;
    const store = host.store;
    this.questions = new TextQuestions(store, host.texts);
    this.queue = new OutOfContextQueue(store, host.log);
    this.inbound = new TextInbound(host, this.questions, {
      deliverQueue: (context) => this.deliverQueue(context as QqContext),
      reply: async (context, text) => {
        if (isQqContext(context)) this.hold(context, { text, formatted: false });
      },
    });
    try {
      await this.api.tokens.get();
    } catch (error) {
      if (error instanceof ChannelError && error.reason === 'unauthorized') throw tokenStopped();
      throw error;
    }
    const saved = store.get<string[]>('seen');
    this.seen = Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
    const stored = store.get<StoredGateway>('gateway');
    this.storedAt = typeof stored?.at === 'number' ? stored.at : 0;
    const resumable =
      stored &&
      typeof stored.sessionId === 'string' &&
      stored.sessionId &&
      typeof stored.seq === 'number' &&
      Date.now() - this.storedAt < this.settings.resumeMaxAgeMs;
    if (resumable) this.handledSeq = stored.seq;
    this.gateway = new QqGateway({
      api: this.api,
      signal: host.signal,
      log: host.log,
      dispatch: (event) => this.enqueue(event),
      ready: (info) => this.ready(info),
      session: resumable ? { sessionId: stored.sessionId, seq: stored.seq } : null,
      timings: this.options.gateway,
    });
    host.signal.addEventListener('abort', () => this.wakeUp(), { once: true });
    this.gatewayDone = this.gateway
      .run()
      .catch((error: unknown) => {
        this.fatal = error;
      })
      .finally(() => {
        this.gatewayEnded = true;
        this.wakeUp();
      });
    this.saveTimer = setInterval(() => this.saveGateway(), this.settings.gatewaySaveMs);
    this.saveTimer.unref?.();
  }

  async *events(): AsyncIterable<InboundEvent> {
    const host = this.requireHost();
    while (!host.signal.aborted && !this.closed) {
      if (this.fatal) throw this.fatal;
      const dispatch = this.events_.shift();
      if (!dispatch) {
        // The gateway's end wakes this wait too (no handler piles up per wait on a long run).
        if (!this.gatewayDone || this.gatewayEnded) return;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
        this.waiter = null;
        continue;
      }
      const event = await this.translate(dispatch);
      this.handled(dispatch);
      if (event) yield event;
    }
  }

  async flush(): Promise<void> {
    const context = this.current;
    this.current = null;
    if (!context) return;
    context.handling = false;
    // The pairing message: its sender is the owner now, and it can still take replies.
    if (this.isOwner(context.openid) && !this.ownerContexts.includes(context))
      this.ownerContexts.push(context);
    if (!context.presenterOpen) await this.release(context);
  }

  /** Sends what is held (≤ 3 s); the rest waits in the queue for the owner's next message. */
  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  persistId(id: string): string {
    return id;
  }

  async send(to: string, message: OutgoingText, context: ReplyContext | null): Promise<Sent> {
    const item: Held = { text: message.text, formatted: Boolean(message.formatted) };
    const target = this.holder(to, context);
    if (target) {
      this.hold(target, item);
      return { status: 'queued' };
    }
    const refs = await this.serial(() =>
      this.sendText(null, to, heldText([item], this.caps.format)),
    );
    return refs.length ? { status: 'sent', refs } : { status: 'queued' };
  }

  async sendPhoto(
    to: string,
    file: OutgoingFile,
    caption: string,
    context: ReplyContext | null,
  ): Promise<Sent> {
    const given = isQqContext(context) && context.openid === to ? context : null;
    return this.serial(async () => {
      // What was said before the picture goes first, also while the core is still handling the
      // message (a welcome's notice before its cover). An open reply keeps its notices as its
      // first lines.
      if (given && given.pending.length && !given.presenterOpen)
        await this.deliverNow(given, given.pending.splice(0));
      return this.photoNow(to, file, caption, this.passiveTarget(to, given));
    });
  }

  /** `input_notify` uses a reply slot (Q-4): sent only with the typing option. */
  async typing(to: string, _action: 'text' | 'photo', context: ReplyContext | null): Promise<void> {
    if (!(this.options.typing ?? QQ_TYPING)) return;
    const target = this.passiveTarget(to, isQqContext(context) ? context : null);
    if (!target) return;
    await this.api.send(to, {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
      ...this.replyFields(target),
    });
  }

  /** QQ's command menu is set in its console. */
  async setCommands(): Promise<void> {}

  /** Numbered options and a one-time code (text-ask.ts), held like any send. */
  async ask(to: string, question: Question, context: ReplyContext | null): Promise<AskRef> {
    const questions = this.requireQuestions();
    const { code, text } = questions.open(question);
    await this.send(to, { text }, context);
    return { questionId: question.id, ref: code };
  }

  async closeQuestion(ref: AskRef): Promise<void> {
    this.requireQuestions().close(ref.questionId);
  }

  presenter(request: PresenterRequest): ReplyPresenter {
    return new QqPresenter(this, request);
  }

  // Inbound ---------------------------------------------------------------------------------

  private enqueue(event: QqDispatch) {
    this.events_.push({ ...event, session: this.gateway?.sessionId ?? '', at: Date.now() });
    if (this.events_.length > this.settings.eventsMax) {
      this.events_.shift();
      if (!this.overflowLogged) {
        this.overflowLogged = true;
        this.host?.log(
          tr(
            '待处理的 QQ 事件太多，丢掉了最早的',
            'Too many QQ events waiting: dropped the oldest',
            'Demasiados eventos de QQ en espera: se descartaron los más antiguos',
            'Eventos do QQ demais esperando: os mais antigos foram descartados',
          ),
        );
      }
    }
    this.wakeUp();
  }

  private wakeUp() {
    this.waiter?.();
  }

  /**
   * QQ refused the token twice in a row (the AppSecret was reset): the relay stops with the
   * command to set it again, instead of failing every send.
   */
  private refusedToken(error: unknown) {
    if (!(error instanceof ChannelError) || error.reason !== 'unauthorized' || this.fatal) return;
    this.fatal = tokenStopped();
    this.gateway?.close();
    this.wakeUp();
  }

  /** READY after a gap: what was sent to the bot meanwhile never reached it. */
  private ready(info: { resumed: boolean; lastAliveAt: number }) {
    if (!info.resumed) {
      this.handledSeq = 0;
      const last = info.lastAliveAt || this.storedAt;
      if (last && Date.now() - last >= this.settings.offlineGapMs) this.offlineNotice = true;
    }
    this.saveGateway();
  }

  private async translate(dispatch: Queued): Promise<InboundEvent | null> {
    const host = this.requireHost();
    const owner = host.owner();
    const data = (dispatch.d ?? {}) as Record<string, unknown>;
    const openid = String(data.openid ?? data.user_openid ?? '');
    const fromOwner = Boolean(owner && openid && openid === owner.userId);
    switch (dispatch.t) {
      case 'C2C_MESSAGE_CREATE':
        return this.message(dispatch);
      case 'C2C_MSG_REJECT':
        if (fromOwner) {
          host.store.set('activeOff', true);
          host.log(
            tr(
              '主人在 QQ 里关闭了主动消息：回复时限外的消息会等主人下次发消息时再发',
              'The owner switched off active messages in QQ: messages outside the reply window wait for their next message',
              'El dueño desactivó los mensajes activos en QQ: los mensajes fuera del plazo de respuesta esperarán a su próximo mensaje',
              'O dono desativou as mensagens ativas no QQ: as mensagens fora do prazo de resposta vão esperar a próxima mensagem dele',
            ),
          );
        }
        return null;
      case 'C2C_MSG_RECEIVE':
        if (fromOwner) {
          host.store.set('activeOff', false);
          host.log(
            tr(
              '主人在 QQ 里打开了主动消息',
              'The owner switched active messages back on in QQ',
              'El dueño volvió a activar los mensajes activos en QQ',
              'O dono reativou as mensagens ativas no QQ',
            ),
          );
          if ((this.options.eventReplies ?? QQ_EVENT_REPLIES) && this.queue?.size) {
            const context = this.context(openid, '', dispatch.id, dispatch.at);
            context.handling = false;
            await this.deliverQueue(context);
            await this.release(context);
          }
        }
        return null;
      case 'FRIEND_ADD':
        host.log(
          tr(
            '有人在 QQ 里加了 bot 为好友',
            'Someone added the bot as a QQ friend',
            'Alguien agregó el bot como amigo en QQ',
            'Alguém adicionou o bot como amigo no QQ',
          ),
        );
        if ((this.options.eventReplies ?? QQ_EVENT_REPLIES) && !owner && openid) {
          const context = this.context(openid, '', dispatch.id, dispatch.at);
          context.handling = false;
          this.hold(context, { text: host.texts.pairHint, formatted: false });
        }
        return null;
      case 'FRIEND_DEL':
        if (fromOwner)
          host.log(
            tr(
              '主人在 QQ 里删除了 bot 好友：要再加为好友，relay 才能回复',
              'The owner removed the bot from their QQ friends: the relay can reply again once it is a friend again',
              'El dueño quitó el bot de sus amigos de QQ: el relay podrá responder cuando vuelva a ser su amigo',
              'O dono removeu o bot dos amigos do QQ: o relay poderá responder quando ele for amigo de novo',
            ),
          );
        return null;
      default:
        if (dispatch.t.startsWith('GROUP_') && !this.groupsLogged) {
          this.groupsLogged = true;
          host.log(
            tr(
              'QQ 群里的消息会被忽略：relay 只转发和主人的私聊',
              'QQ group messages are ignored: the relay only relays the private chat with the owner',
              'Los mensajes de grupos de QQ se ignoran: el relay solo transmite el chat privado con el dueño',
              'As mensagens de grupos do QQ são ignoradas: o relay só repassa o chat privado com o dono',
            ),
          );
        }
        return null;
    }
  }

  private async message(dispatch: Queued): Promise<InboundEvent | null> {
    const host = this.requireHost();
    const inbound = this.inbound!;
    const data = (dispatch.d ?? {}) as C2CMessage;
    const id = String(data.id ?? '');
    const openid = String(data.author?.user_openid ?? data.author?.id ?? '');
    if (!id || !openid || data.author?.bot) return null;
    // Handled before (a Resume after a restart replays, and QQ may push a message twice).
    if (this.seen.includes(id)) return null;
    this.remember(id, dispatch);
    const context = this.context(openid, id, dispatch.id, dispatch.at);
    const owner = host.owner();
    if (owner && owner.userId === openid) {
      this.ownerContexts.push(context);
      if (this.ownerContexts.length > 20) this.ownerContexts.shift();
      if (this.offlineNotice) {
        this.offlineNotice = false;
        this.hold(context, {
          text: host.texts.offlineNotReceived(this.displayName),
          formatted: false,
        });
      }
    }
    const sentAt = Date.parse(String(data.timestamp ?? ''));
    const event = await inbound.accept({
      key: id,
      from: { id: openid, name: '', language: '' },
      chatId: openid,
      context,
      text: String(data.content ?? '').trim(),
      sentAt: Number.isFinite(sentAt) ? sentAt : Date.now(),
      replyTo: (this.options.quotes ?? QQ_QUOTES) ? quoteOf(data) : '',
    });
    if (!event) {
      context.handling = false;
      await this.release(context);
      return null;
    }
    this.current = context;
    return event;
  }

  /** A context for one inbound message or event; the core is handling it until flush(). */
  private context(openid: string, msgId: string, eventId: string, at: number): QqContext {
    const context: QqContext = {
      channel: 'qq',
      receivedAt: at,
      openid,
      msgId,
      eventId,
      nextSeq: 1,
      replies: 0,
      usedUp: false,
      pending: [],
      presenterOpen: false,
      handling: true,
      timer: null,
    };
    this.recent.push(context);
    if (this.recent.length > 50) this.recent.shift();
    return context;
  }

  /** Written before the message is handled, with the gateway's position: never handled twice. */
  private remember(id: string, dispatch: Queued) {
    this.seen.push(id);
    if (this.seen.length > this.settings.seenMax)
      this.seen.splice(0, this.seen.length - this.settings.seenMax);
    this.handled(dispatch);
    this.requireHost().store.set('seen', this.seen);
    this.saveGateway();
  }

  /** The position a Resume after a restart starts from (in the current session only). */
  private handled(dispatch: Queued) {
    if (dispatch.session === this.gateway?.sessionId && dispatch.s > this.handledSeq)
      this.handledSeq = dispatch.s;
  }

  private saveGateway() {
    const gateway = this.gateway;
    const host = this.host;
    if (!gateway || !host || !gateway.sessionId) return;
    const stored: StoredGateway = {
      sessionId: gateway.sessionId,
      seq: this.handledSeq,
      at: gateway.aliveAt || Date.now(),
    };
    host.store.set('gateway', stored);
  }

  /** What was queued for the owner, in their new message's context (design §3.3). */
  private async deliverQueue(context: QqContext) {
    const queue = this.queue;
    const host = this.requireHost();
    if (!queue?.size) return;
    const items = queue.drain();
    const texts: string[] = [];
    let photoSent = false;
    for (const item of items) {
      // One picture per message, so the owner's own reply keeps a passive slot.
      if (item.photo && !photoSent) {
        const photo = item.photo;
        try {
          const sent = await this.serial(() =>
            this.photoNow(context.openid, photo, photo.caption, context),
          );
          if (sent.status === 'sent') {
            photoSent = true;
            continue;
          }
        } catch {
          // Its text says where it is.
        }
      }
      texts.push(item.text);
    }
    if (texts.length)
      this.hold(context, {
        text: `${host.texts.queuedHeader(texts.length)}\n\n${texts.join('\n\n')}`,
        formatted: false,
      });
  }

  // Outbound --------------------------------------------------------------------------------

  /** The context a send to `to` is held in: the one given while it can still answer, else the owner's newest. */
  private holder(to: string, context: ReplyContext | null): QqContext | null {
    if (isQqContext(context) && context.openid === to) {
      if (context.handling || context.presenterOpen || this.usable(context)) return context;
    }
    return this.isOwner(to) ? this.newestUsable() : null;
  }

  /** A context for a passive reply to `to` now: the one given, else the owner's newest usable. */
  private passiveTarget(to: string, context: QqContext | null): QqContext | null {
    if (context && context.openid === to && this.usable(context)) return context;
    return this.isOwner(to) ? this.newestUsable() : null;
  }

  private newestUsable(): QqContext | null {
    for (let index = this.ownerContexts.length - 1; index >= 0; index--) {
      const context = this.ownerContexts[index];
      if (this.usable(context)) return context;
    }
    return null;
  }

  private isOwner(openid: string): boolean {
    const owner = this.host?.owner();
    return Boolean(owner && owner.chatId === openid);
  }

  private hold(context: QqContext, item: Held) {
    if (this.closed) {
      this.toQueue(context.openid, heldText([item], this.caps.format));
      return;
    }
    context.pending.push(item);
    if (context.handling || context.presenterOpen) return;
    if (context.timer) clearTimeout(context.timer);
    context.timer = setTimeout(() => {
      context.timer = null;
      void this.release(context);
    }, this.settings.backgroundFlushMs);
    context.timer.unref?.();
  }

  /** One send at a time, in order. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async deliverNow(context: QqContext, items: Held[]): Promise<string[]> {
    if (!items.length) return [];
    const refs: string[] = [];
    for (const message of splitText(heldText(items, this.caps.format), this.caps.maxText))
      refs.push(...(await this.sendText(context, context.openid, message)));
    return refs;
  }

  private replyFields(context: QqContext): Record<string, unknown> {
    return {
      ...(context.msgId ? { msg_id: context.msgId } : { event_id: context.eventId }),
      msg_seq: this.take(context),
    };
  }

  private textBody(text: string): Record<string, unknown> {
    return this.caps.format === QQ_MARKDOWN
      ? { msg_type: 2, markdown: { content: text } }
      : { msg_type: 0, content: text };
  }

  /** One formatted message: passive while a context allows, else active, else the queue. */
  private async sendText(
    context: QqContext | null,
    to: string,
    text: string,
    split = true,
  ): Promise<string[]> {
    if (this.closed) return this.toQueue(to, text);
    let target = this.passiveTarget(to, context);
    while (target) {
      const fields = this.replyFields(target);
      try {
        const body = { ...this.textBody(text), ...fields };
        const sent = await this.retried(() => this.api.send(to, body), { id: '' });
        return [this.refOf(sent)];
      } catch (error) {
        const code = codeOf(error);
        const reason = error instanceof ChannelError ? error.reason : 'other';
        if (reason === 'expired') {
          target.usedUp = true;
          target = this.passiveTarget(to, null);
          continue;
        }
        return this.failed(error, code, to, text, split, target);
      }
    }
    return this.active(to, text, split);
  }

  /** An active message, while the owner allows them and QQ has not rationed them. */
  private async active(to: string, text: string, split: boolean): Promise<string[]> {
    if (!this.isOwner(to)) return [];
    const store = this.requireHost().store;
    const allowed =
      !store.get<boolean>('activeOff') && (store.get<number>('activeHoldUntil') ?? 0) <= Date.now();
    if (!allowed || this.closed) return this.toQueue(to, text);
    try {
      const body = this.textBody(text);
      return [this.refOf(await this.retried(() => this.api.send(to, body)))];
    } catch (error) {
      return this.failed(error, codeOf(error), to, text, split, null);
    }
  }

  /** What a refused send means (design §9.3); the text is queued for the owner when it may go later. */
  private async failed(
    error: unknown,
    code: number,
    to: string,
    text: string,
    split: boolean,
    context: QqContext | null,
  ): Promise<string[]> {
    const host = this.requireHost();
    const reason = error instanceof ChannelError ? error.reason : 'other';
    if (reason === 'contentRefused') {
      this.contentRefused(context);
      return [];
    }
    this.refusedToken(error);
    if (TOO_LONG_CODES.has(code) && split) {
      const refs: string[] = [];
      for (const part of splitText(text, Math.floor(this.caps.maxText / 2)))
        refs.push(...(await this.sendText(context, to, part, false)));
      return refs;
    }
    if (MARKDOWN_CODES.has(code) && this.caps.format === QQ_MARKDOWN) {
      this.markdownRefused();
      return this.sendText(context, to, text, split);
    }
    if (ACTIVE_OFF_CODES.has(code)) {
      host.store.set('activeOff', true);
      host.log(
        tr(
          '主人关闭了 QQ 主动消息：消息会等主人下次发消息时再发',
          'The owner has active messages switched off in QQ: messages wait for their next message',
          'El dueño tiene desactivados los mensajes activos en QQ: los mensajes esperarán a su próximo mensaje',
          'O dono está com as mensagens ativas desativadas no QQ: as mensagens vão esperar a próxima mensagem dele',
        ),
      );
    } else if (code === QQ_CODE.activeLimit) {
      host.store.set('activeHoldUntil', Date.now() + this.settings.activeHoldMs);
      host.log(
        tr(
          'QQ 主动消息达到频率上限：10 分钟内消息会等主人下次发消息时再发',
          'QQ active message limit reached: for 10 minutes, messages wait for the owner’s next message',
          'Se alcanzó el límite de mensajes activos de QQ: durante 10 minutos, los mensajes esperarán al próximo mensaje del dueño',
          'O limite de mensagens ativas do QQ foi atingido: por 10 minutos, as mensagens vão esperar a próxima mensagem do dono',
        ),
      );
    } else if (reason === 'blocked')
      host.log(
        tr(
          '主人还不是 bot 的 QQ 好友（40054004）：请先在 QQ 里加 bot 为好友',
          'The owner is not a QQ friend of the bot (40054004): add the bot as a friend in QQ first',
          'El dueño no es amigo del bot en QQ (40054004): primero agrega el bot como amigo en QQ',
          'O dono não é amigo do bot no QQ (40054004): primeiro adicione o bot como amigo no QQ',
        ),
      );
    else
      host.log(
        tr(
          `发给 QQ 失败（${error instanceof ChannelError ? `${error.operation} ${error.code}` : 'error'}）`,
          `Couldn't send to QQ (${error instanceof ChannelError ? `${error.operation} ${error.code}` : 'error'})`,
          `No se pudo enviar a QQ (${error instanceof ChannelError ? `${error.operation} ${error.code}` : 'error'})`,
          `Não foi possível enviar ao QQ (${error instanceof ChannelError ? `${error.operation} ${error.code}` : 'error'})`,
        ),
      );
    return this.toQueue(to, text);
  }

  private toQueue(to: string, text: string): string[] {
    if (this.isOwner(to)) this.queue?.push({ text, at: Date.now() });
    return [];
  }

  /**
   * A transient failure (network, 5xx, friend check, bot offline) is retried once after a second,
   * as the same request (the same `msg_seq`); a "duplicate" answer to the retry means the first
   * one arrived.
   */
  private async retried<T>(call: () => Promise<T>, duplicate?: T): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ChannelError) || error.reason !== 'transient') throw error;
      await sleep(this.settings.retryDelayMs);
      try {
        return await call();
      } catch (again) {
        if (duplicate !== undefined && codeOf(again) === QQ_CODE.duplicate) return duplicate;
        throw again;
      }
    }
  }

  private refOf(sent: QqSent): string {
    return String(sent.ext_info?.ref_idx || sent.id || '');
  }

  /** A picture: uploaded (not sent), then a media message in context, else active, else queued. */
  private async photoNow(
    to: string,
    file: OutgoingFile,
    caption: string,
    target: QqContext | null,
  ): Promise<Sent> {
    const host = this.requireHost();
    if (file.bytes.length > this.caps.maxPhotoBytes)
      throw new QqError('POST /v2/users/{openid}/files', 0, 'file too large', 0, 'rejected');
    const store = host.store;
    const activeAllowed =
      !store.get<boolean>('activeOff') && (store.get<number>('activeHoldUntil') ?? 0) <= Date.now();
    const queued = (): Sent => {
      if (this.isOwner(to))
        this.queue?.push({
          text: host.texts.imageForwardFailed(this.displayName),
          at: Date.now(),
          photo: { ...file, caption },
        });
      return { status: 'queued' };
    };
    if (this.closed || (!target && !activeAllowed)) return queued();
    const uploaded = await this.retried(() => this.api.upload(to, file.bytes, file.name)).catch(
      (error: unknown) => {
        this.refusedToken(error);
        throw error;
      },
    );
    const fileInfo = String(uploaded.file_info ?? '');
    const media = (withCaption: boolean) => ({
      msg_type: 7,
      media: { file_info: fileInfo },
      content: withCaption ? caption : '',
    });
    let context = target;
    for (let withCaption = true; ; ) {
      const body = { ...media(withCaption), ...(context ? this.replyFields(context) : {}) };
      try {
        const sent = await this.retried(() => this.api.send(to, body), { id: '' });
        return { status: 'sent', refs: [this.refOf(sent)] };
      } catch (error) {
        const code = codeOf(error);
        const reason = error instanceof ChannelError ? error.reason : 'other';
        if (code === QQ_CODE.typeMismatch && withCaption) {
          withCaption = false;
          continue;
        }
        if (context && reason === 'expired') {
          context.usedUp = true;
          context = this.passiveTarget(to, null);
          if (context || activeAllowed) continue;
          return queued();
        }
        if (!context && ACTIVE_OFF_CODES.has(code)) {
          store.set('activeOff', true);
          return queued();
        }
        if (!context && code === QQ_CODE.activeLimit) {
          store.set('activeHoldUntil', Date.now() + this.settings.activeHoldMs);
          return queued();
        }
        if (reason === 'blocked') return queued();
        if (reason === 'contentRefused') this.contentRefused(context);
        this.refusedToken(error);
        throw error;
      }
    }
  }

  private async shutDown(): Promise<void> {
    const releasing = Promise.all(
      this.recent
        .filter((context) => context.pending.length)
        .map((context) => {
          context.presenterOpen = false;
          return this.release(context, true).catch(() => []);
        }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      releasing,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.settings.closeWaitMs);
      }),
    ]);
    clearTimeout(timer);
    this.closed = true;
    for (const context of this.recent) {
      if (context.timer) clearTimeout(context.timer);
      context.timer = null;
      const items = context.pending.splice(0);
      if (items.length) this.toQueue(context.openid, heldText(items, this.caps.format));
    }
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
    this.saveGateway();
    this.gateway?.close();
    this.wakeUp();
  }

  private requireHost(): ChannelHost {
    if (!this.host) throw new Error('QqChannel.connect() was not called');
    return this.host;
  }

  private requireQuestions(): TextQuestions {
    if (!this.questions) throw new Error('QqChannel.connect() was not called');
    return this.questions;
  }
}

// -------------------------------------------------------------------------------------------------
// `yomi relay --channel qq`: the AppID and AppSecret of the person's own bot (q.qq.com), typed
// (the AppSecret without echo) or piped on stdin (two lines), kept in the keychain as
// `{"appId","secret"}`; `/pair <code>` in the private chat.

/** The stored secret is `{"appId":"<digits>","secret":"<AppSecret>"}` (design §5.3). */
function appOf(secret: string): { appId: string; secret: string } | null {
  try {
    const parsed = JSON.parse(secret) as { appId?: unknown; secret?: unknown };
    return typeof parsed.appId === 'string' &&
      /^[0-9]{5,20}$/.test(parsed.appId) &&
      typeof parsed.secret === 'string' &&
      parsed.secret
      ? { appId: parsed.appId, secret: parsed.secret }
      : null;
  } catch {
    return null;
  }
}

const secretName = (account: string) => `qq-bot:${account}`;

function apiFor(app: { appId: string; secret: string }): QqApi {
  const origin = qqApiOrigin(process.env.YOMI_QQ_API_ORIGIN);
  return new QqApi(new QqTokens({ ...app, origin }), origin);
}

/** QQ's refusal of the AppID/AppSecret, as the command words it. */
function refusedApp(): UsageError {
  return new UsageError(
    tr(
      'QQ 不接受这个 AppID/AppSecret：请在 QQ 开放平台（q.qq.com）的机器人「开发管理」里核对，AppSecret 重置过就要用新的。',
      "QQ does not accept this AppID/AppSecret: check them in the bot's development settings on the QQ Open Platform (q.qq.com); if the AppSecret was reset, use the new one.",
      'QQ no acepta este AppID/AppSecret: revísalos en la configuración de desarrollo del bot en la QQ Open Platform (q.qq.com); si el AppSecret se restableció, usa el nuevo.',
      'O QQ não aceita este AppID/AppSecret: confira-os nas configurações de desenvolvimento do bot na QQ Open Platform (q.qq.com); se o AppSecret foi redefinido, use o novo.',
    ),
  );
}

async function askApp(
  context: Context,
  fromStdin: boolean,
): Promise<{ appId: string; secret: string }> {
  const { io } = context;
  if (!fromStdin)
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '在 QQ 开放平台（q.qq.com）用自己的 QQ 创建机器人，在它的「开发管理」里找到 AppID 和 AppSecret（AppSecret 输入时不会显示）。仅限个人使用。',
          "Create a bot with your own QQ on the QQ Open Platform (q.qq.com) and find its AppID and AppSecret in the bot's development settings (the AppSecret will not be shown as you type). Personal use only.",
          'Crea un bot con tu propia cuenta de QQ en la QQ Open Platform (q.qq.com) y busca su AppID y su AppSecret en la configuración de desarrollo del bot (el AppSecret no se mostrará al escribirlo). Solo para uso personal.',
          'Crie um bot com a sua própria conta do QQ na QQ Open Platform (q.qq.com) e encontre o AppID e o AppSecret nas configurações de desenvolvimento do bot (o AppSecret não aparece enquanto você digita). Somente para uso pessoal.',
        ),
      ),
    );
  let appId: string;
  let secret: string;
  if (fromStdin) [appId, secret] = await readLines(io, 2);
  else {
    appId = await readLine(io, 'AppID: ');
    secret = await readSecret(io, 'AppSecret: ', { fromStdin: false });
  }
  if (!/^[0-9]{5,20}$/.test(appId))
    throw new UsageError(
      tr(
        '这不像是 QQ 机器人的 AppID（应为 5 到 20 位数字）',
        'This does not look like a QQ bot AppID (it should be 5 to 20 digits)',
        'Esto no parece el AppID de un bot de QQ (debería tener de 5 a 20 dígitos)',
        'Isto não parece o AppID de um bot do QQ (deveria ter de 5 a 20 dígitos)',
      ),
    );
  if (!/^[\x21-\x7e]{8,128}$/.test(secret))
    throw new UsageError(
      tr(
        '这不像是 QQ 机器人的 AppSecret（应为 8 到 128 个字母、数字或符号，没有空格）',
        'This does not look like a QQ bot AppSecret (it should be 8 to 128 letters, digits or symbols, without spaces)',
        'Esto no parece el AppSecret de un bot de QQ (debería tener de 8 a 128 letras, dígitos o símbolos, sin espacios)',
        'Isto não parece o AppSecret de um bot do QQ (deveria ter de 8 a 128 letras, dígitos ou símbolos, sem espaços)',
      ),
    );
  return { appId, secret };
}

/** Fetches a token: refused → the command's refusal. */
async function checkApp(api: QqApi): Promise<void> {
  try {
    await api.tokens.get();
  } catch (error) {
    if (error instanceof ChannelError && error.reason === 'unauthorized') throw refusedApp();
    throw error;
  }
}

export const qqSetup: ChannelSetup = {
  kind: 'qq',
  command: 'yomi relay --channel qq',
  displayName: channelName('qq'),
  experimental: false,
  personalUseOnly: true,
  secretLabel: 'AppSecret',
  secretName,

  wantsCredentials: (options: RelayCommandOptions) => options.setApp,

  async setCredentials(context: Context, options: RelayCommandOptions) {
    const { io, store } = context;
    const app = await askApp(context, options.tokenStdin);
    const api = apiFor(app);
    await checkApp(api);
    const me = await api.me().catch(() => null);
    const name = String(me?.username || app.appId);
    // One Identify with the private-chat intent: QQ refuses it (4013/4014) when the bot may not
    // receive private chats. It uses one of the day's session starts.
    const probe = await probeGateway(api);
    if (probe === 'intents')
      warn(
        io,
        tr(
          '这个 bot 还没有私聊（单聊）消息事件的权限：在 q.qq.com 为它开启后 relay 才能收到消息。AppID 和 AppSecret 已照常保存。',
          'This bot has no permission for private chat (C2C) message events yet: enable them on q.qq.com, or the relay will receive nothing. The AppID and AppSecret are saved anyway.',
          'Este bot todavía no tiene permiso para los eventos de chat privado (C2C): actívalos en q.qq.com o el relay no recibirá nada. El AppID y el AppSecret se guardan de todos modos.',
          'Este bot ainda não tem permissão para os eventos de chat privado (C2C): ative-os em q.qq.com, senão o relay não vai receber nada. O AppID e o AppSecret são salvos mesmo assim.',
        ),
      );
    else if (probe === 'failed')
      warn(
        io,
        tr(
          '没能连上 QQ 网关检查私聊权限；AppID 和 AppSecret 已照常保存。',
          "Couldn't reach QQ's gateway to check the private chat permission; the AppID and AppSecret are saved anyway.",
          'No se pudo conectar con el gateway de QQ para comprobar el permiso de chat privado; el AppID y el AppSecret se guardan de todos modos.',
          'Não foi possível conectar ao gateway do QQ para verificar a permissão de chat privado; o AppID e o AppSecret são salvos mesmo assim.',
        ),
      );
    store.setSecret(secretName(context.account), asciiJson(app));
    say(
      io,
      tr(
        `已保存 QQ bot ${name} 的 AppID 和 AppSecret（${storeDescription(store.kind)}）。`,
        `Saved the AppID and AppSecret for QQ bot ${name} (${storeDescription(store.kind)}).`,
        `Se guardaron el AppID y el AppSecret del bot de QQ ${name} (${storeDescription(store.kind)}).`,
        `AppID e AppSecret do bot do QQ ${name} salvos (${storeDescription(store.kind)}).`,
      ),
    );
    say(
      io,
      tr(
        '接下来在 QQ 里加这个 bot 为好友，再运行 yomi relay --channel qq，在私聊里完成配对。',
        'Next, add the bot as a QQ friend, then run yomi relay --channel qq and finish pairing in the private chat.',
        'A continuación, agrega el bot como amigo en QQ, ejecuta yomi relay --channel qq y completa la vinculación en el chat privado.',
        'Em seguida, adicione o bot como amigo no QQ, execute yomi relay --channel qq e conclua o pareamento no chat privado.',
      ),
    );
  },

  async open(context: Context, options: RelayCommandOptions) {
    const { io, store } = context;
    let app = appOf(store.getSecret(secretName(context.account)) ?? '');
    if (!app) {
      if (!io.interactive && !options.tokenStdin) {
        // A service restarting would not fix this: say so and end without failing.
        warn(
          io,
          tr(
            '还没有设置 QQ bot 的 AppID 和 AppSecret：先运行 yomi relay --channel qq --set-app',
            'No QQ bot AppID and AppSecret set yet: run yomi relay --channel qq --set-app first',
            'Todavía no hay un AppID y un AppSecret de bot de QQ configurados: ejecuta primero yomi relay --channel qq --set-app',
            'Ainda não há AppID e AppSecret de bot do QQ configurados: execute primeiro yomi relay --channel qq --set-app',
          ),
        );
        return null;
      }
      app = await askApp(context, options.tokenStdin);
      await checkApp(apiFor(app));
      store.setSecret(secretName(context.account), asciiJson(app));
    }
    return new QqChannel({ ...app, apiOrigin: process.env.YOMI_QQ_API_ORIGIN });
  },

  async verify(channel) {
    try {
      return await channel.verify();
    } catch (error) {
      if (error instanceof ChannelError && error.reason === 'unauthorized') throw refusedApp();
      throw error;
    }
  },

  /** `qq-<AppID>`: the lock of `QqChannel.lockName` (scope `qq:<AppID>`). */
  lockNameOf(secret: string) {
    const app = appOf(secret);
    return app ? `qq-${app.appId}` : null;
  },

  printPairing(context: Context, code: PairingCode, identity: BotIdentity) {
    const { io } = context;
    const name = identity.name || identity.id;
    say(io);
    say(
      io,
      tr(
        `先在 QQ 里加 bot（${name}）为好友，再在和它的私聊里发送：`,
        `Add the bot (${name}) as a QQ friend, then send it in your private chat:`,
        `Agrega el bot (${name}) como amigo en QQ y luego envíale en el chat privado:`,
        `Adicione o bot (${name}) como amigo no QQ e depois envie para ele no chat privado:`,
      ),
    );
    say(io, `  ${paint(io, 'bold', `/pair ${code.display}`)}`);
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '配对码 15 分钟内有效、只能用一次，只显示在这个终端里：不要发给别人。',
          'The pairing code is valid for 15 minutes, works once and is shown only in this terminal: do not send it to anyone.',
          'El código de vinculación es válido durante 15 minutos, funciona una sola vez y solo se muestra en esta terminal: no se lo envíes a nadie.',
          'O código de pareamento vale por 15 minutos, funciona uma única vez e só aparece neste terminal: não o envie para ninguém.',
        ),
      ),
    );
    say(io);
  },

  unpairedHint: () =>
    tr(
      '还没有配对：请在终端里运行一次 yomi relay --channel qq，按提示在 QQ 里给 bot 发送 /pair 配对码。',
      'Not paired yet: run yomi relay --channel qq once in a terminal and send /pair with the pairing code to the bot in QQ as prompted.',
      'Todavía no está vinculado: ejecuta yomi relay --channel qq una vez en una terminal y envía /pair con el código de vinculación al bot en QQ según las indicaciones.',
      'Ainda não pareado: execute yomi relay --channel qq uma vez em um terminal e envie /pair com o código de pareamento para o bot no QQ conforme indicado.',
    ),

  serviceArgs: () => ({ lead: ['--channel', 'qq'], trail: [] }),

  forgetHint: () =>
    tr(
      '如果 AppSecret 可能泄露，请在 QQ 开放平台（q.qq.com）的机器人设置里重置它。',
      "If the AppSecret may have leaked, reset it in the bot's settings on the QQ Open Platform (q.qq.com).",
      'Si el AppSecret pudo haberse filtrado, restablécelo en la configuración del bot en la QQ Open Platform (q.qq.com).',
      'Se o AppSecret pode ter vazado, redefina-o nas configurações do bot na QQ Open Platform (q.qq.com).',
    ),

  label: (identity: BotIdentity) => identity.name || identity.id,
};

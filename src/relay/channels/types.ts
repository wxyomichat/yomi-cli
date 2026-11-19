import { tr } from '../../core/i18n.js';
import type { ImParagraph } from '../../im/models.js';
import type { Formatter, RenderOptions } from '../render.js';
import type { RelayState } from '../state.js';
import type { RelayTexts } from '../texts.js';

/**
 * What a chat platform has to offer the relay. The core (relay.ts) keeps every rule about money,
 * consent, policy and Yomi; a channel only translates: the platform's inbound events into
 * `InboundEvent`s, and the core's sends into platform calls under that platform's reply rules.
 */

export type ChannelKind = 'telegram' | 'qq' | 'wechat';
export const CHANNEL_KINDS: readonly ChannelKind[] = ['telegram', 'qq', 'wechat'];

/** A channel's name as the CLI writes it in its own lines and errors ('Telegram', 'QQ', 微信). */
export function channelName(kind: ChannelKind): string {
  if (kind === 'telegram') return 'Telegram';
  if (kind === 'qq') return 'QQ';
  return tr('微信', 'WeChat', 'WeChat', 'WeChat');
}

/**
 * Everything the core reads about a channel, and nothing more. How a channel streams, edits, shows
 * typing, asks a question or reaches the owner out of context is its own business: the core never
 * branches on it, so there is no field for it.
 */
export type ChannelCaps = {
  /** Longest message, as `format.measure` counts it: renderReply's limit. */
  maxText: number;
  /** How text is written for this channel (render.ts: TELEGRAM_HTML, PLAIN; channels/qq-render.ts: QQ_MARKDOWN). */
  format: Formatter;
  /** Largest picture sendPhoto accepts (bytes, before any encoding). */
  maxPhotoBytes: number;
  /** Inbound messages carry the bot message they quote (`replyTo`): /report and /image can target it. */
  quotes: boolean;
  /** 'code': the owner sends /pair <code> (or /start <code>) in the chat; 'login': the QR scanner is the owner. */
  pairing: 'code' | 'login';
};

/** The bot as the platform reports it. */
export type BotIdentity = {
  /** Telegram: numeric bot id; QQ: the bot's id from /users/@me (else the AppID); WeChat: ilink_bot_id. */
  id: string;
  /** Display name ('' when unknown). */
  name: string;
  /** Telegram username without '@' ('' elsewhere). The core stores it as `state.botUsername`. */
  handle: string;
};

/**
 * What a channel needs to answer one inbound message. Opaque to the core: the core only keeps it,
 * passes it back, and reads `receivedAt` for logs. Concrete types live in each channel:
 *   TelegramContext { channel:'telegram'; receivedAt }                      (nothing else needed)
 *   QqContext       { channel:'qq'; receivedAt; openid; msgId | eventId; nextSeq; replies; pending; ... }
 *   WechatContext   { channel:'wechat'; receivedAt; toUserId; contextToken; sent }
 */
export interface ReplyContext {
  readonly channel: ChannelKind;
  /** Date.now() when the relay received the inbound message. */
  readonly receivedAt: number;
}

export type InboundUser = {
  /** Platform user id as a string (Telegram user id, QQ user_openid, WeChat from_user_id). */
  id: string;
  /** Display name ('' when the platform gives none: QQ, WeChat). */
  name: string;
  /** IETF-ish language code ('' when unknown). */
  language: string;
};

type InboundBase = {
  from: InboundUser;
  /** The chat to answer in (Telegram chat id; QQ/WeChat: the user id again). */
  chatId: string;
  context: ReplyContext;
};

/**
 * A message from a private chat. Replays (a QQ Resume, a WeChat batch read twice) never reach the
 * core: a channel drops them before anything else, so the core has no dedupe of its own.
 */
export type InboundMessage = InboundBase & {
  kind: 'message';
  /** Trimmed text; '' for anything that is not text (photo, sticker, voice, file). */
  text: string;
  /**
   * The text pairing matches on (`^/(?:start|pair)…`): Telegram `message.text` exactly, as before
   * channels; QQ and WeChat the trimmed content (QQ may lead with a space or a mention).
   */
  rawText: string;
  /** When the person sent it, ms since epoch (stale messages are not relayed). */
  sentAt: number;
  /** Ref of the bot message this one quotes ('' when none or the channel has no quotes). */
  replyTo: string;
};

/** A message whose trimmed text starts with '/', split exactly as the core splits commands. */
export type InboundCommand = Omit<InboundMessage, 'kind'> & {
  kind: 'command';
  /** Without '/', original case (the core lower-cases it). */
  name: string;
  /** The part after '@' in '/name@target', '' when none. */
  target: string;
  /** The rest, words joined by single spaces, trimmed. */
  argument: string;
};

/** A button press (Telegram) or a typed "<code> <n>" answer (QQ, WeChat). */
export type InboundAnswer = InboundBase & {
  kind: 'answer';
  /** The Question.id it answers; '' when the code is known to have expired. */
  questionId: string;
  /** The QuestionOption.id chosen ('' when unknown). */
  optionId: string;
  /**
   * Acknowledges the answer. Telegram: answerCallbackQuery (with texts.expired when 'expired').
   * Text channels: no-op, or texts.askExpired as a message when 'expired'.
   */
  ack(result?: 'expired'): Promise<void>;
};

/** The person pressed a platform "stop generating" control (Telegram draft Stop). */
export type InboundStop = { kind: 'stop'; chatId: string; streamRef: string };

export type InboundEvent = InboundMessage | InboundCommand | InboundAnswer | InboundStop;

/** Splits a command exactly as the core always has: `/name@target the rest`. */
export function parseCommand(
  text: string,
): { name: string; target: string; argument: string } | null {
  if (!text.startsWith('/')) return null;
  const [head, ...rest] = text.split(/\s+/);
  const [name, target = ''] = head.slice(1).split('@');
  return { name, target, argument: rest.join(' ').trim() };
}

export type OutgoingText = {
  text: string;
  /** true: `text` is already in the channel's format (the opening from renderReply); false: plain, the channel escapes. */
  formatted?: boolean;
};

/** A file to upload: its bytes, media type and file name (`TelegramFile` is an alias of this). */
export type OutgoingFile = { bytes: Buffer; mime: string; name: string };

/** 'sent' with the refs of the messages holding it; 'queued': it will go out later. */
export type Sent = { status: 'sent'; refs: string[] } | { status: 'queued' };

export type QuestionOption = { id: string; label: string };
export type Question = {
  /** The core's nonce (8 hex); Telegram callback_data is `${id}:${option.id}` (unchanged). */
  id: string;
  /** Plain text; the channel escapes it. */
  prompt: string;
  options: QuestionOption[];
  /** Telegram keyboard shape: 'row' = one row of buttons (budget), 'column' = one button per row (report). */
  layout: 'row' | 'column';
};
/** Where a question was shown, to remove its buttons or its code after the answer. */
export type AskRef = { questionId: string; ref: string };

export type BotCommand = { command: string; description: string };

export interface ReplyPresenter {
  /** What a stop event names for this reply (Telegram: String(draft_id)); '' when the channel has no stop control. */
  readonly streamRef: string;
  readonly isClosed: boolean;
  /** Shows that a reply is coming (draft "Thinking…", typing, or nothing). */
  start(): void;
  /** The reviewed paragraphs so far (cumulative). Never raw text or thinking content. */
  update(paragraphs: readonly ImParagraph[]): void;
  /**
   * Sends the finished reply; resolves with the refs of the messages holding it, stored for /report
   * and /image: Telegram message ids, QQ `ext_info.ref_idx` (else `id`), WeChat `client_id`s.
   */
  finish(paragraphs: readonly ImParagraph[], emptyText: string): Promise<string[]>;
  /**
   * Stops showing this reply (what was shown stays). Anything the presenter took over and has not
   * shown (QQ: the notices it held as the reply's prefix) is sent first, then `note`.
   */
  stop(note?: string): Promise<void>;
}

export type PresenterRequest = {
  to: string;
  /** The turn's inbound message (QQ: its msg_id answers the stream; WeChat: its context_token). */
  context: ReplyContext;
  render: RenderOptions;
  log: (line: string) => void;
};

/** Channel data kept in the relay's state file (`data.channel`, QQ/WeChat only). */
export interface ChannelStore {
  get<T>(key: string): T | undefined;
  /** Writes the state file at once; `undefined` deletes the key. */
  set(key: string, value: unknown): void;
}

export type PauseReason = 'contentRefused' | 'unavailable';

export type ChannelHost = {
  state: RelayState;
  store: ChannelStore;
  texts: RelayTexts;
  language: string;
  log: (line: string) => void;
  /**
   * The relay's own abort signal, never the signal run() was given: a change of Yomi account aborts
   * only the internal one, and every loop, socket and wait in a channel (Telegram long poll, QQ
   * gateway, WeChat long poll, timers) ends with it.
   */
  signal: AbortSignal;
  /** RelayOptions.staleMs: owner messages older than this get texts.stale instead of being relayed. */
  staleMs: number;
  /** The paired owner as strings, null while unpaired. */
  owner(): { userId: string; chatId: string } | null;
  /**
   * The channel must not relay for now ('contentRefused': QQ refused replies under its content
   * rules) or cannot deliver for a while ('unavailable': WeChat -14). Until `until` (ms since epoch;
   * null: until resume() or the end of the run) the core starts nothing new: a chat message or
   * /image gets texts.channelPaused(displayName, reason) and is neither forwarded nor charged;
   * commands keep working. The core logs the pause and its end once each.
   */
  pause(reason: PauseReason, until: number | null): void;
  resume(): void;
};

export interface RelayChannel {
  readonly kind: ChannelKind;
  /**
   * Relay state scope: `relay/<sha256(account|scope)[0:16]>.json`, LocalState `relay|<account>|<scope>`,
   * image record key. Telegram: the bot id (unchanged); QQ: `qq:<AppID>`; WeChat:
   * `wx:<sha256(ilink_user_id)[0:16]>` — the owner, not the bot, because a re-login may change
   * ilink_bot_id.
   */
  readonly scope: string;
  /** `locks/relay-<lockName>.lock`. Telegram: bot id (unchanged); QQ: `qq-<AppID>`; WeChat: `wx-<same 16 hex>`. */
  readonly lockName: string;
  /** 'Telegram', 'QQ', tr('微信', 'WeChat', 'WeChat', 'WeChat'). Used in logs and texts. */
  readonly displayName: string;
  readonly caps: ChannelCaps;

  /** Checks the credentials (network); no side effects. Throws ChannelError reason 'unauthorized' when refused. */
  verify(): Promise<BotIdentity>;
  /** Starts receiving. Telegram: webhook check (RelayStopped 'webhook'); QQ: token + gateway; WeChat: notifystart. */
  connect(host: ChannelHost): Promise<void>;
  /**
   * Inbound events in order, one at a time: the next is not pulled before the core finished handling the
   * previous one. Ends when host.signal aborts. Throws RelayStopped for conditions a restart cannot fix.
   * A channel never yields events of non-private chats or of bots. QQ and WeChat run every inbound
   * message through the shared pipeline (dedupe → owner's queue → answers to open questions).
   */
  events(): AsyncIterable<InboundEvent>;
  /**
   * Waits ≤ 3 s for held sends; whatever still cannot go out is moved to the persistent queue, so
   * nothing taken over from the core is lost at shutdown. Then stops timers and sockets. Idempotent.
   */
  close(): Promise<void>;

  /** How ids are written to the state file: Telegram Number(id) (files stay byte-identical), others the string. */
  persistId(id: string): number | string;

  /** Text to `to`. `context`: the inbound message this answers (null: none known). Throws ChannelError when it fails. */
  send(to: string, message: OutgoingText, context: ReplyContext | null): Promise<Sent>;
  /** A picture with a plain-text caption (the channel escapes it). Telegram: one retry after 429. */
  sendPhoto(
    to: string,
    file: OutgoingFile,
    caption: string,
    context: ReplyContext | null,
  ): Promise<Sent>;
  /** Typing / "uploading a photo" indicator; no-op where none. Errors are swallowed by the caller. */
  typing(to: string, action: 'text' | 'photo', context: ReplyContext | null): Promise<void>;
  /** The bot command menu: Telegram setMyCommands; no-op elsewhere (QQ menus are set in its console). */
  setCommands(commands: readonly BotCommand[]): Promise<void>;
  /** Shows a question. Telegram: inline buttons (unchanged); QQ, WeChat: numbered options + a one-time code (text-ask.ts). */
  ask(to: string, question: Question, context: ReplyContext | null): Promise<AskRef>;
  /** After an answer: removes the buttons (Telegram editMessageReplyMarkup) or forgets the code. */
  closeQuestion(ref: AskRef): Promise<void>;
  /** A presenter for one reply. */
  presenter(request: PresenterRequest): ReplyPresenter;
  /** Called by the core after it finished handling each event (QQ releases held sends; others no-op). */
  flush(): Promise<void>;
}

export type ChannelErrorReason =
  | 'conflict' // another poller/connection owns the bot (Telegram 409)
  | 'unauthorized' // token/secret refused or revoked
  | 'blocked' // the person blocked the bot or is not its friend (QQ 40054004)
  | 'rateLimited' // wait `retryAfterMs`
  | 'expired' // the reply context can no longer be used (QQ msg_id expired or 4 replies used; WeChat token stale)
  | 'contentRefused' // the platform's content rules refused this text (QQ 40034006): never retried
  | 'rejected' // format or length refused (QQ markdown codes, too long)
  | 'transient' // network, timeout, 5xx, QQ 40054006 / 40054016
  | 'other';

/**
 * A platform call that failed. It never carries a token or a URL with one: the operation is a
 * method name, a REST path template or an endpoint, and the description is cut to 200 characters.
 */
export class ChannelError extends Error {
  constructor(
    readonly channel: ChannelKind,
    /** Bot API method / REST path template / iLink endpoint, never a URL with a token. */
    readonly operation: string,
    /** Platform error code (Telegram error_code, QQ code, iLink ret/errcode), 0 for network. */
    readonly code: number | string,
    /** Platform description, ≤ 200 characters, never containing a token. */
    readonly description: string,
    readonly reason: ChannelErrorReason,
    readonly retryAfterMs = 0,
  ) {
    super(`${channelName(channel)} ${operation}: ${code ? `${code} ` : ''}${description}`);
    this.name = 'ChannelError';
  }
}

/** A condition a restart cannot fix: the relay says why and ends without failing. */
export class RelayStopped extends Error {
  constructor(
    readonly reason:
      | 'conflict'
      | 'token'
      | 'otherAccount'
      | 'webhook'
      /** QQ 4013/4014: no permission for private-chat (C2C) events. */
      | 'intents'
      /** QQ 4914: "delisted, sandbox only", with its own message. */
      | 'delisted'
      /** QQ 4915 only. */
      | 'banned'
      /** A close code that means a client bug (QQ 4001/4002/4010-4012). */
      | 'protocol'
      /** WeChat: the login ended (repeated -14, 401/403): run --login again. */
      | 'session',
    message: string,
  ) {
    super(message);
    this.name = 'RelayStopped';
  }
}

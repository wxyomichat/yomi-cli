import { randomUUID } from 'node:crypto';

import type { Context } from '../../commands/context.js';
import { UsageError } from '../../core/env.js';
import { tr } from '../../core/i18n.js';
import { warn } from '../../core/ui.js';
import { PLAIN } from '../render.js';
import { OutOfContextQueue } from './queue.js';
import type { BotRecord } from '../registry.js';
import { botCommand, type ChannelSetup, type CredentialRequest } from './setup.js';
import { TextQuestions } from './text-ask.js';
import { type RawInbound, TextInbound } from './text-inbound.js';
import {
  type AskRef,
  type BotIdentity,
  type ChannelCaps,
  type ChannelHost,
  channelName,
  type InboundEvent,
  type OutgoingFile,
  type OutgoingText,
  type PresenterRequest,
  type Question,
  type RelayChannel,
  RelayStopped,
  type ReplyContext,
  type ReplyPresenter,
  type Sent,
} from './types.js';
import {
  isLoopbackOrigin,
  isStaleToken,
  LONG_POLL_MAX_MS,
  LONG_POLL_MS,
  trustedUrl,
  UntrustedHost,
  WECHAT_CDN,
  WechatApi,
  WechatError,
  type WechatItem,
  type WechatMessage,
  wechatOrigin,
  type WechatUpdates,
} from './wechat-api.js';
import {
  ownerHash,
  parseCredentials,
  type WechatCredentials,
  wechatLogin,
} from './wechat-login.js';
import { imageItem, uploadImage } from './wechat-media.js';
import {
  isWechatContext,
  type WechatContext,
  WechatPresenter,
  type WechatReplyHost,
} from './wechat-presenter.js';

/**
 * WeChat ClawBot (iLink) as a relay channel (design §10): experimental, off unless
 * `--experimental` is given, personal use only. The owner is whoever scanned the login QR code
 * (`--login`, channels/wechat-login.ts). The relay's state and lock are the bot's registry
 * record's: a ClawBot added under the registry has its own (`bot:<key>`, `bot-<key>`), whoever
 * scans it; only a login of before the registry keeps its scanner's (`wx:<sha256(ilink_user_id)
 * [0:16]>`, `wx-<same>`), as the ClawBot id a new login may change never named them.
 *
 * In: `getupdates` long polling with the cursor saved before a batch is handled; each message
 * through the shared text pipeline (replays dropped, the owner's queue delivered, typed answers to
 * questions), the newest owner message kept as the context to answer in. Out: `sendmessage` with
 * the `context_token` of the message it answers, one message at a time at least a second apart,
 * at most ten per message and within its reply window (23 h assumed); anything else waits in the
 * queue for the owner's next message. No edits, no streaming, no buttons: typing, then the reply
 * in pieces (wechat-presenter.ts); questions by a typed code. -14 (a stale login) pauses
 * relaying for an hour, as the plugin does; the third in a row ends the relay with "log in
 * again".
 */

export const WECHAT_REPLY_WINDOW_MS = 23 * 3_600_000;
export const WECHAT_MAX_PER_CONTEXT = 10;
export const WECHAT_SEND_INTERVAL_MS = 1000;
export const WECHAT_TYPING_REFRESH_MS = 5000;
export const WECHAT_MAX_TEXT = 2000;
export const WECHAT_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const WECHAT_PAUSE_ON_EXPIRED_MS = 3_600_000;
export const WECHAT_MAX_EXPIRED = 3;
/** A failed send on a message older than this means its window ended earlier than assumed. */
export const WECHAT_DEAD_AFTER_MS = 3_600_000;
/** How long close() waits for sends still held. */
const CLOSE_WAIT_MS = 3000;
/** Inbound contexts remembered (the newest owner one is also in the state file). */
const CONTEXTS_MAX = 100;
/**
 * Keys of the newest inbound messages, kept in the state file with the cursor (as the plugin's
 * inbound journal keeps them): a batch WeChat sends again after a restart is not relayed, or
 * charged, twice.
 */
const SEEN_KEPT = 200;

/** The message's id as the text pipeline and the state file know it ('' when it has none). */
function keyOf(message: WechatMessage): string {
  const id = message.message_id ?? message.client_id ?? message.seq;
  return id !== undefined && id !== '' ? `wx:${id}` : '';
}

export const WECHAT_COMMAND = 'yomi relay --channel wechat --experimental';

export type WechatChannelOptions = {
  /** `YOMI_WECHAT_API_ORIGIN`: a loopback mock in tests; unset is iLink itself. */
  apiOrigin?: string;
  fetch?: typeof fetch;
  replyWindowMs?: number;
  maxPerContext?: number;
  sendIntervalMs?: number;
  typingRefreshMs?: number;
  maxText?: number;
  maxPhotoBytes?: number;
  pauseOnExpiredMs?: number;
  maxExpired?: number;
  deadAfterMs?: number;
  /** The first wait after a failed poll (doubling to 30 s). */
  backoffMs?: number;
  /**
   * The bot's state scope and lock (its registry record's); by default the scanner's, as a login
   * of before the registry has them (`wx:<sha256(ilink_user_id)[0:16]>`, `wx-<same>`).
   */
  place?: { scope: string; lockName: string };
  /** What signs this bot in again, said when WeChat ends its login (the channel's by default). */
  renewCommand?: string;
};

type Settings = Required<
  Omit<WechatChannelOptions, 'apiOrigin' | 'fetch' | 'place' | 'renewCommand'>
>;

/** The newest owner context as the state file keeps it. */
type StoredContext = {
  token: string;
  toUserId: string;
  createdAt: number;
  receivedAt: number;
  sent: number;
};

/** Ends early when `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** Text cut into pieces of at most `max` characters, at a line break or space when one is near. */
export function splitText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    let at = cut > max / 2 ? cut + 1 : max;
    // Never between the two halves of a surrogate pair.
    if (/[\uD800-\uDBFF]/.test(rest[at - 1])) at -= 1;
    const piece = rest.slice(0, at).trimEnd();
    if (piece) pieces.push(piece);
    rest = rest.slice(at).trimStart();
  }
  if (rest || !pieces.length) pieces.push(rest);
  return pieces;
}

export class WechatChannel implements RelayChannel, WechatReplyHost {
  readonly kind = 'wechat' as const;
  readonly displayName = channelName('wechat');
  readonly caps: ChannelCaps;
  readonly scope: string;
  readonly lockName: string;
  /** What signs this bot in again (`WechatChannelOptions.renewCommand`). */
  readonly renewCommand: string;
  private readonly api: WechatApi;
  private readonly settings: Settings;
  private host: ChannelHost | null = null;
  private inbound: TextInbound | null = null;
  private questions: TextQuestions | null = null;
  private queue: OutOfContextQueue | null = null;
  private readonly contexts = new Map<string, WechatContext>();
  private newest: WechatContext | null = null;
  private readonly tickets = new Map<string, string>();
  /** Every sendmessage goes through this chain, one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;
  /** Aborts sends in flight once close() has waited for them. */
  private readonly sends = new AbortController();
  private closing = false;
  private closed: Promise<void> | null = null;
  private readonly presenters = new Set<WechatPresenter>();
  /** Messages a picture's "typing" was shown for (ended once the picture is sent). */
  private readonly typingOn = new Set<string>();
  private groupLogged = false;
  private authFailures = 0;

  constructor(
    private readonly credentials: WechatCredentials,
    options: WechatChannelOptions = {},
  ) {
    const origin = wechatOrigin(options.apiOrigin);
    const loopback = isLoopbackOrigin(origin);
    // Checked before any token is sent: a stored baseurl must still be WeChat's.
    const baseUrl = trustedUrl(credentials.baseUrl || origin, 'baseurl', loopback);
    this.api = new WechatApi({
      baseUrl,
      botToken: credentials.botToken,
      cdnBaseUrl: loopback ? `${origin}/c2c` : WECHAT_CDN,
      loopback,
      fetch: options.fetch,
    });
    this.settings = {
      replyWindowMs: options.replyWindowMs ?? WECHAT_REPLY_WINDOW_MS,
      maxPerContext: options.maxPerContext ?? WECHAT_MAX_PER_CONTEXT,
      sendIntervalMs: options.sendIntervalMs ?? WECHAT_SEND_INTERVAL_MS,
      typingRefreshMs: options.typingRefreshMs ?? WECHAT_TYPING_REFRESH_MS,
      maxText: options.maxText ?? WECHAT_MAX_TEXT,
      maxPhotoBytes: options.maxPhotoBytes ?? WECHAT_MAX_PHOTO_BYTES,
      pauseOnExpiredMs: options.pauseOnExpiredMs ?? WECHAT_PAUSE_ON_EXPIRED_MS,
      maxExpired: options.maxExpired ?? WECHAT_MAX_EXPIRED,
      deadAfterMs: options.deadAfterMs ?? WECHAT_DEAD_AFTER_MS,
      backoffMs: options.backoffMs ?? 1000,
    };
    this.caps = {
      maxText: this.settings.maxText,
      format: PLAIN,
      maxPhotoBytes: this.settings.maxPhotoBytes,
      quotes: false,
      pairing: 'login',
    };
    const hash = ownerHash(credentials.ilinkUserId);
    this.scope = options.place?.scope ?? `wx:${hash}`;
    this.lockName = options.place?.lockName ?? `wx-${hash}`;
    this.renewCommand = options.renewCommand ?? `${WECHAT_COMMAND} --login`;
  }

  /**
   * The login still works: `getconfig` for the owner (no side effects). Only a refusal of the
   * token (HTTP 401/403) or no answer at all stops the start; -14 and other refusals in the body
   * are left to the long poll, which pauses and tells.
   */
  async verify(): Promise<BotIdentity> {
    try {
      await this.api.getConfig(this.credentials.ilinkUserId, '');
    } catch (error) {
      if (!(error instanceof WechatError) || error.refused || error.status === 0) throw error;
      if (error.status >= 500) throw error;
    }
    return { id: this.credentials.ilinkBotId, name: '', handle: '' };
  }

  async connect(host: ChannelHost): Promise<void> {
    this.host = host;
    this.questions = new TextQuestions(host.store, host.texts);
    this.queue = new OutOfContextQueue(host.store, host.log);
    this.inbound = new TextInbound(host, this.questions, {
      deliverQueue: (context) => this.deliverQueue(context),
      reply: (context, text) => this.reply(context, text),
    });
    const store = host.store;
    // A login with another bot: its cursor and its messages' tokens mean nothing to this one.
    if (store.get<string>('bot') !== this.credentials.ilinkBotId) {
      store.set('cursor', undefined);
      store.set('seen', undefined);
      store.set('context', undefined);
      store.set('bot', this.credentials.ilinkBotId);
    }
    const saved = store.get<StoredContext>('context');
    if (saved && typeof saved.token === 'string' && saved.token) {
      const context = this.remember({
        channel: 'wechat',
        receivedAt: saved.receivedAt,
        toUserId: saved.toUserId,
        contextToken: saved.token,
        createdAt: saved.createdAt,
        sent: saved.sent,
        dead: false,
      });
      this.newest = context;
    }
    // The relay that queued "another account signed in" has stopped: not for this run's owner.
    const stale = host.texts.otherAccount(WECHAT_COMMAND);
    const queued = store.get<{ text: string; at: number }[]>('queue');
    if (Array.isArray(queued) && queued.some((item) => item?.text === stale))
      store.set(
        'queue',
        queued.filter((item) => item?.text !== stale),
      );
    const until = this.pausedUntil();
    if (until > Date.now()) host.pause('unavailable', until);
    await this.api
      .notifyStart(AbortSignal.timeout(10_000))
      .catch((error) =>
        host.log(
          tr(
            `微信 notifystart 失败（${detail(error)}），继续运行`,
            `WeChat notifystart failed (${detail(error)}); carrying on`,
            `WeChat notifystart falló (${detail(error)}); se continúa`,
            `O notifystart do WeChat falhou (${detail(error)}); continuando`,
          ),
        ),
      );
  }

  async *events(): AsyncIterable<InboundEvent> {
    const host = this.requireHost();
    let holdMs = LONG_POLL_MS;
    let backoff = this.settings.backoffMs;
    while (!host.signal.aborted) {
      const until = this.pausedUntil();
      if (until > Date.now()) {
        await sleep(until - Date.now(), host.signal);
        continue;
      }
      let answer: WechatUpdates;
      try {
        answer = await this.api.getUpdates(
          host.store.get<string>('cursor') ?? '',
          holdMs,
          host.signal,
        );
      } catch (error) {
        if (host.signal.aborted) return;
        if (error instanceof WechatError && error.refused) {
          this.authFailures += 1;
          if (this.authFailures >= this.settings.maxExpired) throw this.sessionEnded();
        }
        host.log(
          tr(
            `微信暂时连不上（${detail(error)}），${Math.round(backoff / 1000)} 秒后重试`,
            `Can't reach WeChat right now (${detail(error)}), retrying in ${Math.round(backoff / 1000)} s`,
            `No se puede conectar con WeChat en este momento (${detail(error)}), se reintentará en ${Math.round(backoff / 1000)} s`,
            `Não foi possível conectar ao WeChat agora (${detail(error)}), tentando novamente em ${Math.round(backoff / 1000)} s`,
          ),
        );
        await sleep(backoff, host.signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      if (isStaleToken(answer)) {
        this.expired();
        continue;
      }
      const code =
        (typeof answer.errcode === 'number' && answer.errcode) ||
        (typeof answer.ret === 'number' && answer.ret) ||
        0;
      if (code) {
        host.log(
          tr(
            `微信拒绝了收消息的请求（${code}），${Math.round(backoff / 1000)} 秒后重试`,
            `WeChat refused to deliver messages (${code}), retrying in ${Math.round(backoff / 1000)} s`,
            `WeChat se negó a entregar mensajes (${code}), se reintentará en ${Math.round(backoff / 1000)} s`,
            `O WeChat recusou a entrega de mensagens (${code}), tentando novamente em ${Math.round(backoff / 1000)} s`,
          ),
        );
        await sleep(backoff, host.signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      this.authFailures = 0;
      backoff = this.settings.backoffMs;
      if (host.store.get('expiredCount') !== undefined) host.store.set('expiredCount', undefined);
      if (host.store.get('pausedUntil') !== undefined) host.store.set('pausedUntil', undefined);
      host.resume();
      if (typeof answer.longpolling_timeout_ms === 'number' && answer.longpolling_timeout_ms > 0)
        holdMs = Math.min(answer.longpolling_timeout_ms, LONG_POLL_MAX_MS);
      const messages = this.unseen(answer.msgs ?? []);
      // Saved before the batch is handled, as Telegram's offset: what breaks the relay is not
      // read again.
      if (answer.get_updates_buf) host.store.set('cursor', answer.get_updates_buf);
      for (const raw of this.batch(messages)) {
        const event = await this.inbound!.accept(raw);
        if (event) yield event;
        if (host.signal.aborted) return;
      }
    }
  }

  /**
   * The messages of a batch not handled before, this run or an earlier one; their keys are saved
   * at once (before they are handled, like the cursor).
   */
  private unseen(messages: WechatMessage[]): WechatMessage[] {
    const store = this.requireHost().store;
    const stored = store.get<unknown>('seen');
    const kept = Array.isArray(stored)
      ? stored.filter((key): key is string => typeof key === 'string')
      : [];
    const known = new Set(kept);
    const fresh = messages.filter((message) => {
      const key = keyOf(message);
      if (!key) return true;
      if (known.has(key)) return false;
      known.add(key);
      kept.push(key);
      return true;
    });
    if (fresh.length) store.set('seen', kept.slice(-SEEN_KEPT));
    return fresh;
  }

  /**
   * A batch as the text pipeline takes it: people's messages in private chats only, and of the
   * owner's messages that are already stale (sent while the relay was off or paused) only the
   * newest, which the core answers "sent while offline"; one such answer is enough.
   */
  private batch(messages: WechatMessage[]): RawInbound[] {
    const host = this.requireHost();
    const owner = host.owner();
    const now = Date.now();
    const parsed: (Omit<RawInbound, 'context'> & { token: string; owner: boolean })[] = [];
    for (const message of messages) {
      // The bot's own messages (2) only: the field is optional and the plugin filters on nothing.
      if (message.message_type === 2 || !message.from_user_id) continue;
      if (message.group_id) {
        if (!this.groupLogged)
          host.log(
            tr(
              '收到一条群消息，已忽略（relay 只处理私聊）',
              'Ignored a group message (relay handles private chats only)',
              'Se ignoró un mensaje de grupo (relay solo atiende chats privados)',
              'Uma mensagem de grupo foi ignorada (o relay só trata chats privados)',
            ),
          );
        this.groupLogged = true;
        continue;
      }
      const from = message.from_user_id;
      const createdAt =
        typeof message.create_time_ms === 'number' && message.create_time_ms > 0
          ? message.create_time_ms
          : now;
      const text = (message.item_list ?? [])
        .filter((item) => item?.type === 1 && typeof item.text_item?.text === 'string')
        .map((item) => item.text_item!.text as string)
        .join('\n')
        .trim();
      parsed.push({
        key: keyOf(message) || `wx:local-${randomUUID()}`,
        from: { id: from, name: '', language: '' },
        chatId: from,
        text,
        sentAt: createdAt,
        replyTo: '',
        token: typeof message.context_token === 'string' ? message.context_token : '',
        owner: Boolean(owner && owner.userId === from),
      });
    }
    const stale = parsed.filter((raw) => raw.owner && now - raw.sentAt > host.staleMs);
    const keep = stale.reduce<(typeof parsed)[number] | null>(
      (newest, raw) => (!newest || raw.sentAt >= newest.sentAt ? raw : newest),
      null,
    );
    if (stale.length > 1)
      host.log(
        tr(
          `有 ${stale.length - 1} 条离线期间的旧消息没有转发（只回复最新的一条）`,
          `Skipped ${stale.length - 1} old messages sent while the relay was away (only the newest is answered)`,
          `Se omitieron ${stale.length - 1} mensajes antiguos enviados mientras el relay no estaba (solo se responde el más reciente)`,
          `${stale.length - 1} mensagens antigas enviadas enquanto o relay estava fora foram ignoradas (só a mais recente é respondida)`,
        ),
      );
    return parsed
      .filter((raw) => !stale.includes(raw) || raw === keep)
      .map(({ token, owner: mine, ...raw }) => {
        const context = this.remember({
          channel: 'wechat',
          receivedAt: now,
          toUserId: raw.from.id,
          contextToken: token,
          createdAt: raw.sentAt,
          sent: 0,
          dead: false,
        });
        if (mine && token) {
          this.newest = context;
          this.saveNewest();
        }
        return { ...raw, context };
      });
  }

  /** Nothing waits: queued items are delivered by the owner's next message. */
  async flush(): Promise<void> {}

  persistId(id: string): string {
    return id;
  }

  async send(to: string, message: OutgoingText, context: ReplyContext | null): Promise<Sent> {
    return this.sendText(to, message.text, context);
  }

  /**
   * Uploads the picture, then says its caption and shows it in the message's window; outside it
   * (or paused) the picture waits in memory for the owner's next message, its fallback line in
   * the queue.
   */
  async sendPhoto(
    to: string,
    file: OutgoingFile,
    caption: string,
    context: ReplyContext | null,
  ): Promise<Sent> {
    const needed = caption ? 2 : 1;
    const first = this.pick(to, context, needed);
    if (!first) return this.queuePhoto(file, caption);
    let uploaded;
    try {
      uploaded = await uploadImage(this.api, to, file, this.sends.signal);
    } catch (error) {
      await this.endTyping(first);
      throw error;
    }
    return this.serial(async () => {
      const target = this.pick(to, context, needed);
      if (!target) return this.queuePhoto(file, caption);
      try {
        if (caption) await this.post(target, [{ type: 1, text_item: { text: caption } }]);
        const ref = await this.post(target, [imageItem(uploaded)]);
        await this.endTyping(target);
        return { status: 'sent', refs: [ref] } satisfies Sent;
      } catch (error) {
        if (this.queueable(error, target)) return this.queuePhoto(file, caption);
        throw error;
      }
    });
  }

  /** "Typing" for a picture on its way (WeChat has no "sending a photo"). */
  async typing(to: string, _action: 'text' | 'photo', context: ReplyContext | null) {
    const target = this.pick(to, context, 0);
    if (!target) return;
    const ticket = await this.typingTicket(target);
    if (ticket) {
      await this.sendTyping(target, ticket, 1);
      this.typingOn.add(target.contextToken);
    }
  }

  private async endTyping(context: WechatContext) {
    if (!this.typingOn.delete(context.contextToken)) return;
    const ticket = this.tickets.get(context.contextToken);
    if (ticket) await this.sendTyping(context, ticket, 2).catch(() => undefined);
  }

  /** WeChat has no command menu for a ClawBot. */
  async setCommands(): Promise<void> {}

  /** The options numbered, with a one-time code to answer with (text-ask.ts). */
  async ask(to: string, question: Question, context: ReplyContext | null): Promise<AskRef> {
    const { text } = this.requireQuestions().open(question);
    await this.sendText(to, text, context);
    return { questionId: question.id, ref: question.id };
  }

  async closeQuestion(ref: AskRef): Promise<void> {
    this.requireQuestions().close(ref.questionId);
  }

  presenter(request: PresenterRequest): ReplyPresenter {
    const presenter = new WechatPresenter(this, request, {
      maxText: this.settings.maxText,
      typingRefreshMs: this.settings.typingRefreshMs,
    });
    for (const open of this.presenters) if (open.isClosed) this.presenters.delete(open);
    this.presenters.add(presenter);
    return presenter;
  }

  /**
   * Waits up to 3 s for the sends still held; what cannot go out by then is queued for the owner's
   * next message (a send cut off in flight too). Then tells iLink this client stops.
   */
  close(): Promise<void> {
    this.closed ??= (async () => {
      for (const presenter of this.presenters) presenter.dispose();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.chain,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      this.closing = true;
      this.sends.abort();
      await this.chain;
      if (this.host) await this.api.notifyStop(AbortSignal.timeout(3000)).catch(() => undefined);
    })();
    return this.closed;
  }

  // ---------------------------------------------------------------------------------------------
  // WechatReplyHost (the presenter's side)

  get paused(): boolean {
    return this.pausedUntil() > Date.now();
  }

  async typingTicket(context: WechatContext): Promise<string> {
    const known = this.tickets.get(context.contextToken);
    if (known !== undefined) return known;
    const ticket = await this.api.getConfig(
      context.toUserId,
      context.contextToken,
      this.sends.signal,
    );
    this.tickets.set(context.contextToken, ticket);
    if (this.tickets.size > CONTEXTS_MAX)
      this.tickets.delete(this.tickets.keys().next().value as string);
    return ticket;
  }

  async sendTyping(context: WechatContext, ticket: string, status: 1 | 2): Promise<void> {
    await this.api.sendTyping(context.toUserId, ticket, status, this.sends.signal);
  }

  /** A reply's pieces in order; when they cannot go out, one "read it in the app" line waits. */
  deliverReply(to: string, context: WechatContext | null, pieces: string[]): Promise<string[]> {
    return this.serial(async () => {
      const refs: string[] = [];
      for (const piece of pieces) {
        const target = this.pick(to, context, 1);
        if (!target) {
          this.undelivered();
          break;
        }
        try {
          refs.push(await this.post(target, [{ type: 1, text_item: { text: piece } }]));
        } catch (error) {
          if (this.queueable(error, target)) {
            this.undelivered();
            break;
          }
          if (!refs.length) throw error;
          // Part of it is shown: the rest is in the app.
          this.requireHost().log(failedSend(error));
          this.undelivered();
          break;
        }
      }
      return refs;
    });
  }

  async note(to: string, context: WechatContext | null, text: string): Promise<void> {
    await this.sendText(to, text, context);
  }

  // ---------------------------------------------------------------------------------------------
  // Sending

  /** Text to the owner in a usable window, in pieces within the limit; else into the queue. */
  private sendText(to: string, text: string, context: ReplyContext | null): Promise<Sent> {
    return this.serial(async () => {
      const pieces = splitText(text, this.settings.maxText);
      const refs: string[] = [];
      for (let index = 0; index < pieces.length; index++) {
        const target = this.pick(to, context, 1);
        const rest = () => pieces.slice(index).join('\n');
        if (!target) {
          this.enqueue(rest());
          return refs.length ? ({ status: 'sent', refs } as Sent) : ({ status: 'queued' } as Sent);
        }
        try {
          refs.push(await this.post(target, [{ type: 1, text_item: { text: pieces[index] } }]));
        } catch (error) {
          if (!this.queueable(error, target)) throw error;
          this.enqueue(rest());
          return refs.length ? ({ status: 'sent', refs } as Sent) : ({ status: 'queued' } as Sent);
        }
      }
      return { status: 'sent', refs } as Sent;
    });
  }

  /**
   * The context a send to `to` goes out in, with room for `needed` more messages: the one given
   * (the message it answers), else the owner's newest; null when neither is usable (outside its
   * window, at its cap, or the login is paused), or the channel is closing.
   */
  private pick(to: string, context: ReplyContext | null, needed: number): WechatContext | null {
    if (this.closing || this.paused) return null;
    const given = isWechatContext(context)
      ? (this.contexts.get(context.contextToken) ?? context)
      : null;
    const now = Date.now();
    for (const candidate of [given, this.newest])
      if (
        candidate &&
        candidate.contextToken &&
        !candidate.dead &&
        candidate.toUserId === to &&
        now - candidate.createdAt < this.settings.replyWindowMs &&
        candidate.sent + needed <= this.settings.maxPerContext
      )
        return candidate;
    return null;
  }

  /** One sendmessage, at least `sendIntervalMs` after the last; its `client_id`. */
  private async post(context: WechatContext, items: WechatItem[]): Promise<string> {
    const wait = this.lastSendAt + this.settings.sendIntervalMs - Date.now();
    if (wait > 0) await sleep(wait, this.sends.signal);
    if (this.closing) throw new WechatError('sendmessage', 0, 'closing', 0);
    const clientId = `yomi-${randomUUID()}`;
    try {
      await this.api.sendMessage(
        {
          to_user_id: context.toUserId,
          client_id: clientId,
          context_token: context.contextToken,
          item_list: items,
        },
        this.sends.signal,
      );
    } finally {
      this.lastSendAt = Date.now();
    }
    context.sent += 1;
    if (context === this.newest) this.saveNewest();
    return clientId;
  }

  /**
   * Whether a failed send should wait in the queue instead of failing: -14 (the login is paused
   * now), the channel closing, or a refusal on a message older than an hour (its window ended
   * sooner than assumed: the message is marked dead).
   */
  private queueable(error: unknown, context: WechatContext): boolean {
    if (this.closing) return true;
    if (!(error instanceof WechatError)) return false;
    if (error.sessionExpired) {
      this.pauseForSend();
      return true;
    }
    if (error.status === 200 && Date.now() - context.createdAt > this.settings.deadAfterMs) {
      context.dead = true;
      this.requireHost().log(
        tr(
          `微信不再接受对一条旧消息的回复（${error.code}）：之后的消息先排队，等主人下一条消息时再发`,
          `WeChat no longer accepts replies to an old message (${error.code}): later messages wait for the owner's next message`,
          `WeChat ya no acepta respuestas a un mensaje antiguo (${error.code}): los siguientes mensajes esperan al próximo mensaje del dueño`,
          `O WeChat não aceita mais respostas a uma mensagem antiga (${error.code}): as próximas mensagens esperam a próxima mensagem do dono`,
        ),
      );
      return true;
    }
    return false;
  }

  private enqueue(text: string) {
    if (!text) return;
    this.requireQueue().push({ text, at: Date.now() });
  }

  private queuePhoto(file: OutgoingFile, caption: string): Sent {
    const host = this.requireHost();
    this.requireQueue().push({
      text: host.texts.imageForwardFailed(this.displayName),
      at: Date.now(),
      photo: { ...file, caption },
    });
    return { status: 'queued' };
  }

  private undelivered() {
    const host = this.requireHost();
    this.enqueue(host.texts.replyUndelivered(this.displayName));
    host.log(
      tr(
        '回复没能发到微信：主人下一条消息时会提醒去 Yomi 查看',
        "Couldn't deliver a reply to WeChat: the owner is told to read it in Yomi at their next message",
        'No se pudo entregar una respuesta a WeChat: en su próximo mensaje se le dirá al dueño que la lea en Yomi',
        'Não foi possível entregar uma resposta ao WeChat: na próxima mensagem o dono será avisado para lê-la no Yomi',
      ),
    );
  }

  /** One job at a time on the send chain (a failed job does not stop the next). */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---------------------------------------------------------------------------------------------
  // The owner's next message: what waited goes first

  private async deliverQueue(context: ReplyContext): Promise<void> {
    const queue = this.requireQueue();
    if (!queue.size || !isWechatContext(context)) return;
    const host = this.requireHost();
    const items = queue.drain();
    if (!items.length) return;
    const texts = items.filter((item) => !item.photo).map((item) => item.text);
    const photos = items.filter((item) => item.photo);
    const message = [host.texts.queuedHeader(items.length), ...texts].join('\n\n');
    const sent = await this.serial(async () => {
      for (const piece of splitText(message, this.settings.maxText)) {
        const target = this.pick(context.toUserId, context, 1);
        if (!target) return false;
        try {
          await this.post(target, [{ type: 1, text_item: { text: piece } }]);
        } catch (error) {
          if (this.queueable(error, target)) return false;
          host.log(failedSend(error));
          return false;
        }
      }
      return true;
    });
    // Not delivered: back in the queue as they were, for the message after.
    if (!sent) for (const item of items) if (!item.photo) queue.push(item);
    for (const item of photos) {
      const photo = item.photo!;
      try {
        await this.sendPhoto(
          context.toUserId,
          { bytes: photo.bytes, mime: photo.mime, name: photo.name },
          photo.caption,
          context,
        );
      } catch (error) {
        host.log(failedSend(error));
        queue.push({ text: item.text, at: item.at });
      }
    }
  }

  private async reply(context: ReplyContext, text: string): Promise<void> {
    if (!isWechatContext(context)) return;
    await this.sendText(context.toUserId, text, context);
  }

  // ---------------------------------------------------------------------------------------------
  // The login's health

  private pausedUntil(): number {
    const until = this.host?.store.get<number>('pausedUntil');
    return typeof until === 'number' ? until : 0;
  }

  /** -14 on the long poll: pause for an hour (counted); the third in a row ends the relay. */
  private expired() {
    const host = this.requireHost();
    const count = (host.store.get<number>('expiredCount') ?? 0) + 1;
    if (count >= this.settings.maxExpired) {
      host.store.set('pausedUntil', undefined);
      host.store.set('expiredCount', count);
      throw this.sessionEnded();
    }
    const until = Date.now() + this.settings.pauseOnExpiredMs;
    host.store.set('expiredCount', count);
    host.store.set('pausedUntil', until);
    host.pause('unavailable', until);
    const minutes = Math.max(1, Math.round(this.settings.pauseOnExpiredMs / 60_000));
    const max = this.settings.maxExpired;
    host.log(
      tr(
        `微信说这次登录已失效（-14）：暂停 ${minutes} 分钟后再试（连续第 ${count} 次，第 ${max} 次时停止）`,
        `WeChat says this login is stale (-14): pausing for ${minutes} min, then trying again (${count} in a row; stops at ${max})`,
        `WeChat dice que este inicio de sesión caducó (-14): pausa de ${minutes} min y luego se vuelve a intentar (${count} seguidos; se detiene en ${max})`,
        `O WeChat diz que este login expirou (-14): pausa de ${minutes} min e depois nova tentativa (${count} seguidos; para em ${max})`,
      ),
    );
  }

  /** -14 on a send: pause like the long poll would (not counted: the poll decides). */
  private pauseForSend() {
    if (this.paused) return;
    const host = this.requireHost();
    const until = Date.now() + this.settings.pauseOnExpiredMs;
    host.store.set('pausedUntil', until);
    host.pause('unavailable', until);
  }

  private sessionEnded(): RelayStopped {
    const again = this.renewCommand;
    return new RelayStopped(
      'session',
      tr(
        `微信结束了这次登录：请运行 ${again} 重新扫码登录。`,
        `WeChat ended this login: run ${again} and scan the QR code again.`,
        `WeChat terminó este inicio de sesión: ejecuta ${again} y vuelve a escanear el código QR.`,
        `O WeChat encerrou este login: execute ${again} e escaneie o código QR de novo.`,
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------

  /** Keeps the canonical object of a message's context (the core passes it back). */
  private remember(context: WechatContext): WechatContext {
    if (!context.contextToken) return context;
    const known = this.contexts.get(context.contextToken);
    if (known) {
      // The plugin says a token is issued per message; should a newer message ever carry a known
      // one, its window and its count start again (else the relay would go quiet after ten).
      if (context.createdAt > known.createdAt) {
        known.createdAt = context.createdAt;
        known.sent = 0;
        known.dead = false;
      }
      return known;
    }
    this.contexts.set(context.contextToken, context);
    if (this.contexts.size > CONTEXTS_MAX) {
      const oldest = this.contexts.keys().next().value as string;
      if (this.contexts.get(oldest) !== this.newest) this.contexts.delete(oldest);
    }
    return context;
  }

  private saveNewest() {
    const context = this.newest;
    if (!context) return;
    const stored: StoredContext = {
      token: context.contextToken,
      toUserId: context.toUserId,
      createdAt: context.createdAt,
      receivedAt: context.receivedAt,
      sent: context.sent,
    };
    this.requireHost().store.set('context', stored);
  }

  private requireHost(): ChannelHost {
    if (!this.host) throw new Error('WechatChannel.connect() was not called');
    return this.host;
  }

  private requireQueue(): OutOfContextQueue {
    if (!this.queue) throw new Error('WechatChannel.connect() was not called');
    return this.queue;
  }

  private requireQuestions(): TextQuestions {
    if (!this.questions) throw new Error('WechatChannel.connect() was not called');
    return this.questions;
  }
}

/** "getupdates -14", "sendmessage 0": what failed, never a token or a URL. */
function detail(error: unknown): string {
  if (error instanceof WechatError) return `${error.operation} ${error.code}`;
  return error instanceof Error ? error.name : 'error';
}

function failedSend(error: unknown): string {
  return tr(
    `发给微信失败（${detail(error)}）`,
    `Couldn't send to WeChat (${detail(error)})`,
    `No se pudo enviar a WeChat (${detail(error)})`,
    `Não foi possível enviar ao WeChat (${detail(error)})`,
  );
}

// -------------------------------------------------------------------------------------------------
// `yomi relay --channel wechat --experimental`: the login lives in the keychain (`--login`), the
// owner is its scanner, and the state and the lock are the bot's record's (a login of before the
// registry: named after its scanner).

const secretName = (account: string) => `wechat-ilink:${account}`;

/** What signs `record` in again, or (none yet) the channel's login. */
const loginCommand = (record?: BotRecord) =>
  record ? botCommand(record, '--login') : `${WECHAT_COMMAND} --login`;

const unpairedHint = (record?: BotRecord) => {
  const command = loginCommand(record);
  return tr(
    `还没有登录微信：在终端里运行 ${command}，用手机微信扫码。`,
    `Not signed in to WeChat yet: run ${command} in a terminal and scan the QR code with WeChat on your phone.`,
    `Todavía no iniciaste sesión en WeChat: ejecuta ${command} en una terminal y escanea el código QR con WeChat en tu teléfono.`,
    `Você ainda não entrou no WeChat: execute ${command} em um terminal e escaneie o código QR com o WeChat no seu celular.`,
  );
};

/** A saved login whose host is not WeChat's: never used, whatever wrote it. */
function untrustedLogin(again: string): UsageError {
  return new UsageError(
    tr(
      `保存的微信登录指向的不是微信的地址，没有使用：请运行 ${again} 重新登录。`,
      `The saved WeChat login points at an address that is not WeChat's, so it was not used: run ${again} again.`,
      `El inicio de sesión de WeChat guardado apunta a una dirección que no es de WeChat, así que no se usó: vuelve a ejecutar ${again}.`,
      `O login do WeChat salvo aponta para um endereço que não é do WeChat, então não foi usado: execute ${again} de novo.`,
    ),
  );
}

export const wechatSetup: ChannelSetup = {
  kind: 'wechat',
  command: WECHAT_COMMAND,
  get displayName() {
    return channelName('wechat');
  },
  experimental: true,
  personalUseOnly: true,
  secretLabel: 'bot_token',
  secretName,
  credentialsFlag: '--login',

  setCredentials: (context: Context, request: CredentialRequest) => wechatLogin(context, request),

  async open(context: Context, record: BotRecord) {
    const credentials = parseCredentials(context.store.getSecret(record.secretName));
    if (!credentials) {
      // Nobody to scan in a service, and the scanner is the owner: --login in a terminal first.
      warn(context.io, unpairedHint(record));
      return null;
    }
    try {
      // Its state and lock are its record's: a ClawBot added under the registry has its own.
      return new WechatChannel(credentials, {
        apiOrigin: process.env.YOMI_WECHAT_API_ORIGIN,
        place: { scope: record.scope, lockName: record.lockName },
        renewCommand: loginCommand(record),
      });
    } catch (error) {
      if (error instanceof UntrustedHost) throw untrustedLogin(loginCommand(record));
      throw error;
    }
  },

  async verify(channel) {
    try {
      return await channel.verify();
    } catch (error) {
      if (error instanceof WechatError && error.refused) {
        const again =
          channel instanceof WechatChannel ? channel.renewCommand : `${WECHAT_COMMAND} --login`;
        throw new UsageError(
          tr(
            `微信不再接受这次登录：请运行 ${again} 重新扫码。`,
            `WeChat no longer accepts this login: run ${again} and scan again.`,
            `WeChat ya no acepta este inicio de sesión: ejecuta ${again} y vuelve a escanear.`,
            `O WeChat não aceita mais este login: execute ${again} e escaneie de novo.`,
          ),
        );
      }
      throw error;
    }
  },

  missingCredentials: unpairedHint,

  /**
   * The scanner names the scope and the lock of a login of before the registry (a re-login may
   * change ilink_bot_id); a login without its token still names them. A ClawBot added under the
   * registry has a scope and lock of its own (relay/registry.ts).
   */
  storedBot(secret: string) {
    let userId = '';
    let botId = '';
    const credentials = parseCredentials(secret);
    if (credentials) {
      userId = credentials.ilinkUserId;
      botId = credentials.ilinkBotId;
    } else
      try {
        const parsed = JSON.parse(secret) as { ilinkUserId?: unknown };
        if (typeof parsed.ilinkUserId === 'string') userId = parsed.ilinkUserId;
      } catch {
        return null;
      }
    if (!userId) return null;
    const hash = ownerHash(userId);
    return { platformId: botId, scope: `wx:${hash}`, lockName: `wx-${hash}` };
  },

  unpairedHint,

  forgetHint: () =>
    tr(
      '要让这次登录彻底失效，还要在手机微信里解除 ClawBot 的绑定。',
      'To end this sign-in for good, also unbind ClawBot in WeChat on your phone.',
      'Para terminar este inicio de sesión del todo, desvincula también ClawBot en WeChat en tu teléfono.',
      'Para encerrar este login de vez, desvincule também o ClawBot no WeChat do seu celular.',
    ),

  label: (identity: BotIdentity) => identity.name || identity.id,
};

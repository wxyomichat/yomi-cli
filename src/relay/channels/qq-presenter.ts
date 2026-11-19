import { tr } from '../../core/i18n.js';
import type { ImParagraph } from '../../im/models.js';
import { type Formatter, PLAIN, renderReply } from '../render.js';
import { codeOf, MARKDOWN_CODES, QQ_CODE, type QqStreamSent } from './qq-api.js';
import {
  ChannelError,
  type PresenterRequest,
  type ReplyContext,
  type ReplyPresenter,
} from './types.js';

/**
 * A reply in a QQ private chat (design §2.2): QQ's native stream (`stream_messages`, replace
 * mode) of the paragraphs that are finished. A reply arrives as cumulative snapshots and the last
 * paragraph keeps growing; its rendering is not a prefix of the next one (narration's closing
 * marker moves), while replace mode refuses any change to what was already streamed (40007). So
 * only paragraphs followed by another one are streamed, and the one still being written appears
 * at `finish()`. The notices said just before the reply (AI notice, price line, what was queued
 * for the owner) ride as its first lines (the prefix), so they use no reply slot of their own;
 * when nothing was streamed they go back to the context and are never lost. A finished paragraph
 * that review changed (the stream diverged) is closed as shown, recalled, and the final text is
 * sent as a new message.
 */

/** Text held for a reply context, released merged (plain unless `formatted`). */
export type Held = {
  text: string;
  formatted: boolean;
  /** A piece of a reply: never dropped as a duplicate of another item. */
  keep?: boolean;
};

/**
 * One inbound message and what answering it has used: QQ allows passive replies to a message
 * for a while and a few times (the conservative reading: 4 replies within 5 minutes), each with
 * its own `msg_seq`. Events (C2C_MSG_RECEIVE, FRIEND_ADD) are answered with `event_id`.
 */
export type QqContext = ReplyContext & {
  readonly channel: 'qq';
  readonly receivedAt: number;
  readonly openid: string;
  /** The inbound message's id ('' for an event reply). */
  readonly msgId: string;
  /** The event's id (the payload's outer `id`). */
  readonly eventId: string;
  nextSeq: number;
  /** Passive replies used. */
  replies: number;
  /** QQ said the context is expired or used up. */
  usedUp: boolean;
  /** Held sends, released merged (design §3.4). */
  pending: Held[];
  /** A reply's presenter is open on this context: its sends wait for the reply. */
  presenterOpen: boolean;
  /** The core is handling this context's event: its sends wait for flush(). */
  handling: boolean;
  /** The background release (500 ms after the last held send). */
  timer: ReturnType<typeof setTimeout> | null;
};

export const isQqContext = (context: ReplyContext | null | undefined): context is QqContext =>
  Boolean(context && context.channel === 'qq' && 'openid' in context);

/** What a presenter uses of the channel. */
export interface QqOutlet {
  readonly maxText: number;
  /** The channel's format now (markdown falls back to plain for the run). */
  readonly format: Formatter;
  readonly prefixMax: number;
  readonly streamIntervalMs: number;
  readonly retryDelayMs: number;
  /** Streaming failed for the run (logged once): replies are sent whole. */
  readonly streamingDisabled: boolean;
  usable(context: QqContext): boolean;
  /** Uses one reply slot; its `msg_seq`. */
  take(context: QqContext): number;
  stream(openid: string, body: Record<string, unknown>): Promise<QqStreamSent>;
  recall(openid: string, messageId: string): Promise<void>;
  /** Sends `items` through the outbox now (merged, split, passive while slots last, else active or the queue). */
  deliver(context: QqContext, items: Held[]): Promise<string[]>;
  /** Releases what the context holds, unless the core is still handling its event (then flush() does). */
  release(context: QqContext, now?: boolean): Promise<string[]>;
  /** QQ refused text under its content rules (counts; tells the owner once a run; pauses after 3). */
  contentRefused(context: QqContext | null): void;
  /** QQ refused markdown: plain text for the rest of the run. */
  markdownRefused(): void;
  /** The first stream call failed for a reason a retry would not fix: whole replies for the run. */
  disableStreaming(error: unknown): void;
}

/** Held items as one text in `format`: duplicates dropped (a reply's pieces never), joined by a blank line. */
export function heldText(items: readonly Held[], format: Formatter): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const item of items) {
    const text = item.formatted ? item.text : format.escape(item.text);
    if (!text) continue;
    if (!item.keep) {
      if (seen.has(text)) continue;
      seen.add(text);
    }
    parts.push(text);
  }
  return parts.join('\n\n');
}

const join = (prefix: string, text: string) => (prefix ? `${prefix}\n\n${text}` : text);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the prefix leaves of a message at least (renderReply's pieces can be 200 + markers). */
const PREFIX_ROOM = 400;

/** How many 50002 waits a stream's last chunk gets (1 s, 2 s, 4 s) before the recall path. */
const CLOSE_WAITS = 3;

export class QqPresenter implements ReplyPresenter {
  /** QQ has no "stop generating" control: /stop is a command. */
  readonly streamRef = '';
  private closed = false;
  private readonly context: QqContext | null;
  private format: Formatter;
  private prefix = '';
  private prefixItems: Held[] = [];
  /** Held items too long to be the prefix: sent as their own message before the first chunk. */
  private leftover = 0;
  private limit: number;
  private lastSent = '';
  /** The latest `id` a stream response returned: the next chunk names it, a recall too. */
  private streamId = '';
  private refIdx = '';
  private index = 0;
  private seq = 0;
  private mode: 'stream' | 'buffered' = 'stream';
  private diverged = false;
  private refused = false;
  /** The first message is complete (the reply runs past it): no more chunks before finish(). */
  private grown = false;
  private remain: number | null = null;
  private latest: readonly ImParagraph[] = [];
  private pumping: Promise<void> | null = null;
  private dirty = false;
  private lastCallAt = 0;
  private waitUntil = 0;
  private limitWaits = 0;
  private wake: (() => void) | null = null;
  /**
   * The first finish() or stop(), once started. The core may stop a reply that already ended
   * (the watchdog after /stop, shutdown while the reply is being booked): that must not hand the
   * prefix back a second time (the AI notice and the price line would be sent twice) nor end the
   * stream again.
   */
  private ending: Promise<unknown> | null = null;

  constructor(
    private readonly outlet: QqOutlet,
    private readonly request: PresenterRequest,
  ) {
    this.context = request.context.channel === 'qq' ? (request.context as QqContext) : null;
    this.format = outlet.format;
    this.limit = outlet.maxText;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Takes the notices held for the context as the reply's first lines; sends nothing. */
  start(): void {
    const context = this.context;
    if (!context) {
      this.mode = 'buffered';
      return;
    }
    context.presenterOpen = true;
    if (context.timer) clearTimeout(context.timer);
    context.timer = null;
    this.takePrefix();
    if (this.outlet.streamingDisabled || !this.outlet.usable(context)) this.mode = 'buffered';
  }

  update(paragraphs: readonly ImParagraph[]): void {
    if (this.closed) return;
    this.latest = paragraphs;
    if (this.mode !== 'stream' || this.diverged || this.refused || this.grown) return;
    if (paragraphs.length < 2) return;
    this.kick();
  }

  finish(paragraphs: readonly ImParagraph[], emptyText: string): Promise<string[]> {
    if (this.ending) return this.ending.then(() => []);
    const run = this.finishNow(paragraphs, emptyText);
    this.ending = run.catch(() => undefined);
    return run;
  }

  /** Stops showing the reply; after finish() or an earlier stop() only a new `note` is sent. */
  async stop(note = ''): Promise<void> {
    if (this.ending) {
      await this.ending;
      const context = this.context;
      if (!note || !context) return;
      context.pending.push({ text: note, formatted: false });
      await this.outlet.release(context);
      return;
    }
    const run = this.stopNow(note);
    this.ending = run.catch(() => undefined);
    return run;
  }

  private async finishNow(
    paragraphs: readonly ImParagraph[],
    emptyText: string,
  ): Promise<string[]> {
    await this.close();
    const context = this.context;
    if (!context) return [];
    const refs: string[] = [];
    try {
      if (this.refused) {
        // QQ refused this reply's text: what it accepted stays, nothing of the rest is sent again.
        if (this.streamId) await this.end(this.lastSent);
        else context.pending.unshift(...this.prefixItems);
        return refs;
      }
      const pieces = (texts: string[]): Held[] =>
        texts.map((text) => ({ text, formatted: true, keep: true }));
      if (this.streamId) {
        let final = renderReply(paragraphs, this.request.render, this.limit, this.format);
        if (!final.length) final = [this.format.escape(emptyText)];
        const first = join(this.prefix, final[0]);
        let ended = false;
        if (!this.diverged && first.startsWith(this.lastSent)) ended = await this.end(first);
        if (this.refused) {
          // The last chunk was refused: the stream ends with what QQ accepted before.
          await this.end(this.lastSent);
          return refs;
        }
        if (ended) {
          refs.push(this.refIdx || this.streamId);
          context.pending.unshift(...pieces(final.slice(1)));
        } else {
          await this.withdraw(context);
          context.pending.unshift(...pieces([first, ...final.slice(1)]));
        }
        return refs;
      }
      // Nothing streamed: the notices it held, then the reply, as the outbox merges them. Notices
      // too long to be the prefix are still first in the context: the reply goes after them.
      let final = renderReply(
        paragraphs,
        this.request.render,
        this.outlet.maxText,
        this.outlet.format,
      );
      if (!final.length) final = [this.outlet.format.escape(emptyText)];
      context.pending.splice(this.leftover, 0, ...pieces(final));
      context.pending.unshift(...this.prefixItems);
      return refs;
    } finally {
      context.presenterOpen = false;
      refs.push(...(await this.outlet.release(context, true)));
    }
  }

  private async stopNow(note: string): Promise<void> {
    await this.close();
    const context = this.context;
    if (!context) return;
    if (this.streamId) await this.end(this.lastSent);
    else context.pending.unshift(...this.prefixItems);
    if (note) context.pending.push({ text: note, formatted: false });
    context.presenterOpen = false;
    await this.outlet.release(context);
  }

  // -------------------------------------------------------------------------------------------

  private takePrefix() {
    const context = this.context!;
    const held = heldText(context.pending, this.format);
    // Room is left for a whole piece of the reply (renderReply never cuts below 200 characters).
    const most = Math.min(this.outlet.prefixMax, this.outlet.maxText - PREFIX_ROOM);
    if (held && this.format.measure(held, held) <= most) {
      this.prefix = held;
      this.prefixItems = context.pending.splice(0);
    } else this.leftover = context.pending.length;
    // Every rendering of this reply is cut at the same places, and its first message never
    // passes the limit by the prefix's length.
    this.limit =
      this.outlet.maxText - (this.prefix ? this.format.measure(this.prefix, this.prefix) + 2 : 0);
  }

  /** Stops streaming: waits for a chunk in flight. */
  private async close() {
    this.closed = true;
    this.wake?.();
    await this.pumping;
  }

  private kick() {
    if (this.pumping) {
      this.dirty = true;
      return;
    }
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
    });
  }

  /** One chunk at a time, at most one per interval (or after a 50002 wait), the newest content. */
  private async pump() {
    do {
      this.dirty = false;
      const wait =
        Math.max(this.lastCallAt + this.outlet.streamIntervalMs, this.waitUntil) - Date.now();
      if (wait > 0)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.wake = null;
            resolve();
          };
          const timer = setTimeout(done, wait);
          this.wake = done;
        });
      if (this.closed) return;
      await this.tick();
    } while (this.dirty && !this.closed);
  }

  private async tick(plainRetry = false): Promise<void> {
    const context = this.context!;
    if (this.mode !== 'stream' || this.diverged || this.refused || this.grown) return;
    const settled = this.latest.slice(0, -1);
    if (!settled.length) return;
    const rendered = renderReply(settled, this.request.render, this.limit, this.format);
    if (!rendered.length) return;
    const head = join(this.prefix, rendered[0]);
    const complete = rendered.length > 1;
    if (head === this.lastSent) {
      if (complete) this.grown = true;
      return;
    }
    if (!head.startsWith(this.lastSent)) {
      // Review changed a paragraph already shown: no more chunks; finish() recalls.
      this.diverged = true;
      return;
    }
    const growth =
      this.format.measure(head, head) - this.format.measure(this.lastSent, this.lastSent);
    if (this.remain !== null && growth > this.remain) {
      this.grown = true;
      return;
    }
    if (!this.streamId) {
      if (!this.outlet.usable(context)) {
        this.mode = 'buffered';
        return;
      }
      if (this.leftover) {
        const items = context.pending.splice(0, this.leftover);
        this.leftover = 0;
        await this.outlet.deliver(context, items);
        if (!this.outlet.usable(context)) {
          this.mode = 'buffered';
          return;
        }
      }
      if (!this.seq) this.seq = this.outlet.take(context);
    }
    const result = await this.call(head, 1);
    if (result === 'sent' && complete) this.grown = true;
    if (result === 'plain' && !plainRetry) {
      // QQ refused markdown on the first chunk: the same paragraphs, as plain text, once.
      this.outlet.markdownRefused();
      this.format = PLAIN;
      this.prefix = heldText(this.prefixItems, PLAIN);
      this.limit =
        this.outlet.maxText - (this.prefix ? PLAIN.measure(this.prefix, this.prefix) + 2 : 0);
      await this.tick(true);
    }
  }

  /** One chunk (`input_state` 1, or 10 to end the stream); what happened to it. */
  private async call(
    content: string,
    state: 1 | 10,
  ): Promise<'sent' | 'failed' | 'limited' | 'plain'> {
    const context = this.context!;
    for (let attempt = 0; ; attempt++) {
      const body: Record<string, unknown> = {
        input_mode: 'replace',
        input_state: state,
        index: this.index,
        content_type: this.format.name === 'qq-markdown' ? 'markdown' : 'text',
        content_raw: content,
        msg_seq: this.seq,
        ...(context.msgId ? { msg_id: context.msgId } : { event_id: context.eventId }),
        ...(this.streamId ? { stream_msg_id: this.streamId } : {}),
      };
      try {
        const sent = await this.outlet.stream(context.openid, body);
        this.lastCallAt = Date.now();
        this.index += 1;
        if (sent.id) this.streamId = String(sent.id);
        if (sent.ext_info?.ref_idx) this.refIdx = String(sent.ext_info.ref_idx);
        if (typeof sent.remain_msg_len === 'number') this.remain = sent.remain_msg_len;
        this.lastSent = content;
        this.limitWaits = 0;
        return 'sent';
      } catch (error) {
        this.lastCallAt = Date.now();
        const code = codeOf(error);
        const reason = error instanceof ChannelError ? error.reason : 'other';
        if (code === QQ_CODE.duplicate && attempt > 0) {
          // The first try had arrived after all.
          this.index += 1;
          this.lastSent = content;
          if (this.streamId) return 'sent';
          this.diverged = true;
          return 'failed';
        }
        if (reason === 'transient' && attempt === 0) {
          await sleep(this.outlet.retryDelayMs);
          continue;
        }
        if (reason === 'contentRefused') {
          // Never sent again: a second violation could get the bot banned.
          this.refused = true;
          this.outlet.contentRefused(context);
          return 'failed';
        }
        if (code === QQ_CODE.replaceChanged) {
          this.diverged = true;
          return 'failed';
        }
        if (code === QQ_CODE.streamLimit) {
          // The failed index is not used again; the newest content goes next, after the wait.
          this.index += 1;
          this.limitWaits += 1;
          this.waitUntil = Date.now() + Math.min(1000 * 2 ** (this.limitWaits - 1), 8000);
          this.dirty = true;
          return 'limited';
        }
        if (reason === 'expired') {
          context.usedUp = true;
          if (this.streamId) this.diverged = true;
          else this.mode = 'buffered';
          return 'failed';
        }
        if (this.format.name === 'qq-markdown' && MARKDOWN_CODES.has(code) && !this.streamId)
          return 'plain';
        if (!this.streamId) {
          // QQ refused the stream itself: whole replies for the run. A failure that passes (the
          // network twice, the bot not a friend yet, ...): this reply only.
          if (reason === 'other' || reason === 'rejected') this.outlet.disableStreaming(error);
          this.mode = 'buffered';
          return 'failed';
        }
        this.diverged = true;
        return 'failed';
      }
    }
  }

  /** The last chunk (`input_state: 10`); 50002 is waited out a few times. */
  private async end(content: string): Promise<boolean> {
    for (let waits = 0; ; waits++) {
      const wait = this.waitUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const result = await this.call(content, 10);
      if (result === 'sent') return true;
      if (result !== 'limited' || waits >= CLOSE_WAITS) return false;
    }
  }

  /** The stream showed text the reply no longer has: closed as shown, then recalled. */
  private async withdraw(context: QqContext) {
    await this.end(this.lastSent);
    try {
      await this.outlet.recall(context.openid, this.streamId);
    } catch {
      this.request.log(
        tr(
          '流式显示的文字和最终回复不同，但没能撤回（已另外发送最终回复）',
          'The streamed text differed from the final reply and could not be withdrawn (the final reply was sent separately)',
          'El texto mostrado en streaming era distinto de la respuesta final y no se pudo retirar (la respuesta final se envió aparte)',
          'O texto exibido em streaming era diferente da resposta final e não pôde ser retirado (a resposta final foi enviada à parte)',
        ),
      );
    }
  }
}

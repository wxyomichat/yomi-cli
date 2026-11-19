import { tr } from '../../core/i18n.js';
import type { ImParagraph } from '../../im/models.js';
import { PLAIN, renderReply } from '../render.js';
import {
  ChannelError,
  type PresenterRequest,
  type ReplyContext,
  type ReplyPresenter,
} from './types.js';

/**
 * A reply in WeChat ClawBot (design §2.3): WeChat cannot edit a message, and reviewed paragraphs
 * may still change until the reply is complete, so nothing is sent before `finish()`. Meanwhile
 * the person sees "typing" (a ticket from `getconfig`, renewed every few seconds). At the end the
 * reply goes out as plain-text pieces within the length limit, one message each, in the reply
 * window of the message it answers; when it cannot go out at all (the login is paused, or no
 * message of the owner is in its window) a single "read it in the Yomi app" line is queued
 * instead of the pieces. There is no stop control: `/stop` is a command.
 */

/** One inbound message of the person, as the WeChat channel answers it. */
export type WechatContext = ReplyContext & {
  channel: 'wechat';
  toUserId: string;
  /** The inbound message's `context_token`, echoed by every reply to it. */
  contextToken: string;
  /** When the person sent it (`create_time_ms`): the reply window counts from here. */
  createdAt: number;
  /** Bot messages sent with this context_token so far. */
  sent: number;
  /** A send on it failed when it was old: its window ended earlier than assumed. */
  dead: boolean;
};

export const isWechatContext = (context: ReplyContext | null): context is WechatContext =>
  Boolean(context && context.channel === 'wechat' && 'contextToken' in context);

/** What a presenter asks of the WeChat channel. */
export interface WechatReplyHost {
  /** The login is paused (-14): nothing can be shown now. */
  readonly paused: boolean;
  /** The typing ticket for this message ('' when WeChat gave none). */
  typingTicket(context: WechatContext): Promise<string>;
  sendTyping(context: WechatContext, ticket: string, status: 1 | 2): Promise<void>;
  /**
   * Sends the pieces in order through the channel's sender; the `client_id`s of those sent. When
   * they cannot go out, one `replyUndelivered` line is queued instead.
   */
  deliverReply(to: string, context: WechatContext | null, pieces: string[]): Promise<string[]>;
  /** A plain text, queued when it cannot go out now. */
  note(to: string, context: WechatContext | null, text: string): Promise<void>;
}

export type WechatPresenterOptions = {
  maxText: number;
  /** How often "typing" is said again while the reply is coming. */
  typingRefreshMs: number;
};

export class WechatPresenter implements ReplyPresenter {
  /** WeChat has no "stop generating" control. */
  readonly streamRef = '';
  private closed = false;
  private started = false;
  private ticket = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private typing: Promise<void> = Promise.resolve();
  private typingFailed = false;
  private readonly context: WechatContext | null;

  constructor(
    private readonly host: WechatReplyHost,
    private readonly request: PresenterRequest,
    private readonly options: WechatPresenterOptions,
  ) {
    this.context = isWechatContext(request.context) ? request.context : null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** "Typing" now and every few seconds until the reply is sent (not while the login is paused). */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    const context = this.context;
    if (!context || this.host.paused) return;
    this.typing = (async () => {
      try {
        const ticket = await this.host.typingTicket(context);
        if (!ticket || this.closed) return;
        this.ticket = ticket;
        await this.host.sendTyping(context, ticket, 1);
        if (this.closed) return;
        this.timer = setInterval(() => {
          if (!this.ticket) return;
          this.host.sendTyping(context, this.ticket, 1).catch((error) => this.dropTyping(error));
        }, this.options.typingRefreshMs);
        this.timer.unref?.();
      } catch (error) {
        this.dropTyping(error);
      }
    })();
  }

  /** Nothing is shown before the end: a piece sent now could not be taken back. */
  update(_paragraphs: readonly ImParagraph[]): void {}

  async finish(paragraphs: readonly ImParagraph[], emptyText: string): Promise<string[]> {
    if (this.closed) return [];
    this.closed = true;
    await this.endTyping();
    let pieces = renderReply(paragraphs, this.request.render, this.options.maxText, PLAIN);
    if (!pieces.length) pieces = [emptyText];
    return this.host.deliverReply(this.request.to, this.context, pieces);
  }

  async stop(note?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.endTyping();
    if (note) await this.host.note(this.request.to, this.context, note);
  }

  /** Clears the timer only (the channel is closing and will not wait for a typing call). */
  dispose(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async endTyping() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.typing;
    const ticket = this.ticket;
    this.ticket = '';
    if (ticket && this.context)
      await this.host.sendTyping(this.context, ticket, 2).catch(() => undefined);
  }

  /** A typing call failed: said once, and no more typing for this reply. */
  private dropTyping(error: unknown) {
    this.ticket = '';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.typingFailed) return;
    this.typingFailed = true;
    const detail = error instanceof ChannelError ? `${error.operation} ${error.code}` : '';
    this.request.log(
      tr(
        `微信的「正在输入」没有发出去${detail ? `（${detail}）` : ''}，这条回复不再显示`,
        `WeChat's "typing" could not be shown${detail ? ` (${detail})` : ''}; not shown for this reply`,
        `No se pudo mostrar "escribiendo" en WeChat${detail ? ` (${detail})` : ''}; no se mostrará en esta respuesta`,
        `Não foi possível mostrar "digitando" no WeChat${detail ? ` (${detail})` : ''}; não será mostrado nesta resposta`,
      ),
    );
  }
}

import { tr } from '../core/i18n.js';
import type { ImParagraph } from '../im/models.js';
import type { ReplyPresenter } from './channels/types.js';
import { renderReply, type RenderOptions } from './render.js';
import { type TelegramBot, TelegramError } from './telegram.js';

/**
 * Telegram's presenter (drafts, then edits): one reply as it streams into the owner's private
 * chat. Only reviewed paragraphs come in; each update replaces the last (they are cumulative). By
 * default it streams a draft (`sendMessageDraft`, Bot API 9.5+): an empty one shows "Thinking…"
 * at once, the user gets a Stop button (`can_stop`), and the finished reply goes out as real
 * messages (`sendMessage` clears the draft). Where drafts are refused it sends a message and edits
 * it instead. Either way there is at most one call per `intervalMs` in the chat (Telegram allows
 * about 20 per 5 s and 40 per 30 s per chat, typing included), a 429 waits its `retry_after`, and
 * HTML Telegram cannot parse is sent again as plain text.
 */

export type PresenterOptions = {
  render: RenderOptions;
  /** Minimum time between two calls in this chat. */
  intervalMs: number;
  /** Start with drafts; switches to edits for good if a draft is refused. */
  drafts: boolean;
  /** A draft lives 30 s; refresh it before that. */
  draftRefreshMs?: number;
  /** Logs a failure without content (the relay's terminal). */
  log?: (line: string) => void;
};

/** Text Telegram shows for HTML it could not parse: tags dropped, entities decoded. */
export function plainOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let drafts = Math.floor(Math.random() * 1_000_000) + 1;
/** A non-zero draft id, unique in this process (sent back as a string by `stopped_message_generation`). */
export function nextDraftId(): number {
  drafts = (drafts % 2_000_000_000) + 1;
  return drafts;
}

export class TelegramPresenter implements ReplyPresenter {
  readonly draftId = nextDraftId();
  private latest: readonly ImParagraph[] = [];
  private version = 0;
  private shownVersion = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> = Promise.resolve();
  private nextAt = 0;
  private closed = false;
  private useDrafts: boolean;
  /** Edit mode: the messages shown so far and their HTML. */
  private edited: { id: number; html: string }[] = [];
  private draftHtml = '';

  constructor(
    private readonly bot: TelegramBot,
    private readonly chatId: number,
    private readonly options: PresenterOptions,
  ) {
    this.useDrafts = options.drafts;
  }

  /** Shows that a reply is coming ("Thinking…" draft, or typing). */
  start() {
    this.enqueue(() => this.waiting());
    const refresh = this.useDrafts ? (this.options.draftRefreshMs ?? 20_000) : 4_500;
    this.keepAlive = setInterval(() => {
      if (this.closed) return;
      if (this.useDrafts) this.enqueue(() => this.sendDraft(this.draftHtml, true));
      else if (this.edited.length === 0) this.enqueue(() => this.waiting());
    }, refresh);
    this.keepAlive.unref?.();
  }

  /** The reviewed paragraphs so far (cumulative). */
  update(paragraphs: readonly ImParagraph[]) {
    if (this.closed) return;
    this.latest = paragraphs;
    this.version += 1;
    this.schedule();
  }

  /** What the draft's Stop button names (`stopped_message_generation.draft_id`). */
  get streamRef(): string {
    return String(this.draftId);
  }

  /** Sends the finished reply; resolves with the Telegram message ids that hold it. */
  async finish(paragraphs: readonly ImParagraph[], emptyText: string): Promise<string[]> {
    this.close();
    await this.running;
    const messages = renderReply(paragraphs, this.options.render);
    if (messages.length === 0) messages.push(emptyText);
    const ids: number[] = [];
    for (let index = 0; index < messages.length; index++) {
      const shown = this.edited[index];
      if (shown && !this.useDrafts) {
        if (shown.html !== messages[index]) await this.edit(shown.id, messages[index]);
        ids.push(shown.id);
      } else {
        const id = await this.send(messages[index]);
        if (id) ids.push(id);
      }
    }
    // Streamed pieces the final reply no longer has (it can come out shorter) go away.
    if (!this.useDrafts)
      for (const extra of this.edited.slice(messages.length))
        await this.bot.deleteMessage(this.chatId, extra.id).catch(() => this.edit(extra.id, '…'));
    return ids.map(String);
  }

  /** Stops showing this reply (what was shown stays); `note` is sent after it. */
  async stop(note = ''): Promise<void> {
    this.close();
    await this.running;
    if (note) await this.send(note);
  }

  get isClosed() {
    return this.closed;
  }

  private close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.timer = null;
    this.keepAlive = null;
  }

  private schedule() {
    if (this.timer || this.closed) return;
    const delay = Math.max(0, this.nextAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueue(() => this.flush());
    }, delay);
    this.timer.unref?.();
  }

  /** Calls run one after another; each waits its turn in the chat's rate. */
  private enqueue(work: () => Promise<void>) {
    this.running = this.running.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        await work();
      } catch (error) {
        this.failed(error);
      }
      this.nextAt = Math.max(this.nextAt, Date.now() + this.options.intervalMs);
    });
  }

  private failed(error: unknown) {
    if (error instanceof TelegramError && error.code === 429)
      this.nextAt = Date.now() + Math.max(1, error.retryAfter) * 1000;
    this.options.log?.(
      tr(
        `Telegram 调用失败：${error instanceof TelegramError ? `${error.method} ${error.code}` : 'error'}`,
        `Telegram call failed: ${error instanceof TelegramError ? `${error.method} ${error.code}` : 'error'}`,
        `Falló la llamada a Telegram: ${error instanceof TelegramError ? `${error.method} ${error.code}` : 'error'}`,
        `Falha na chamada ao Telegram: ${error instanceof TelegramError ? `${error.method} ${error.code}` : 'error'}`,
      ),
    );
  }

  private async waiting() {
    if (this.closed) return;
    if (this.useDrafts) await this.sendDraft('', false);
    else await this.bot.sendChatAction(this.chatId, 'typing');
  }

  private async flush(): Promise<void> {
    if (this.closed || this.shownVersion === this.version) return;
    const version = this.version;
    const messages = renderReply(this.latest, this.options.render);
    if (messages.length === 0) return;
    if (this.useDrafts) {
      // A draft is one message: the part still being written.
      await this.sendDraft(messages[messages.length - 1], false);
      // Drafts were refused just now: show this version by editing instead.
      if (!this.useDrafts) return this.flush();
    } else {
      for (let index = 0; index < messages.length; index++) {
        const shown = this.edited[index];
        if (!shown) {
          const id = await this.send(messages[index]);
          if (id) this.edited.push({ id, html: messages[index] });
        } else if (shown.html !== messages[index]) {
          await this.edit(shown.id, messages[index]);
          shown.html = messages[index];
        }
      }
    }
    this.shownVersion = version;
    if (this.version !== version) this.schedule();
  }

  private async sendDraft(html: string, refresh: boolean) {
    if (this.closed || !this.useDrafts) return;
    try {
      await this.bot.call('sendMessageDraft', {
        chat_id: this.chatId,
        draft_id: this.draftId,
        text: html,
        ...(html ? { parse_mode: 'HTML' } : {}),
        can_stop: true,
      });
      this.draftHtml = html;
    } catch (error) {
      if (
        error instanceof TelegramError &&
        error.code === 400 &&
        /parse entities/i.test(error.description)
      ) {
        await this.bot.call('sendMessageDraft', {
          chat_id: this.chatId,
          draft_id: this.draftId,
          text: plainOf(html),
          can_stop: true,
        });
        return;
      }
      if (error instanceof TelegramError && !error.transient && !refresh) {
        // Drafts refused here (an older server, a client setting): edit a message instead.
        this.useDrafts = false;
        this.options.log?.(
          tr(
            '这个 bot 不能发流式草稿，改为编辑消息',
            "This bot can't stream drafts, editing messages instead",
            'Este bot no puede transmitir borradores; se editarán los mensajes en su lugar',
            'Este bot não consegue transmitir rascunhos; editando as mensagens em vez disso',
          ),
        );
        return;
      }
      throw error;
    }
  }

  /** Sends one message; HTML Telegram rejects goes again as plain text. Returns its id. */
  private async send(html: string): Promise<number> {
    try {
      return (await this.bot.sendMessage(this.chatId, html)).message_id;
    } catch (error) {
      if (error instanceof TelegramError && error.code === 429) {
        await sleep(Math.max(1, error.retryAfter) * 1000);
        return (await this.bot.sendMessage(this.chatId, html)).message_id;
      }
      if (
        error instanceof TelegramError &&
        error.code === 400 &&
        /parse entities/i.test(error.description)
      )
        return (
          await this.bot.call<{ message_id: number }>('sendMessage', {
            chat_id: this.chatId,
            text: plainOf(html),
            link_preview_options: { is_disabled: true },
          })
        ).message_id;
      throw error;
    }
  }

  private async edit(messageId: number, html: string) {
    try {
      await this.bot.editMessageText(this.chatId, messageId, html);
    } catch (error) {
      if (error instanceof TelegramError && /not modified/i.test(error.description)) return;
      if (
        error instanceof TelegramError &&
        error.code === 400 &&
        /parse entities/i.test(error.description)
      ) {
        await this.bot.call('editMessageText', {
          chat_id: this.chatId,
          message_id: messageId,
          text: plainOf(html),
        });
        return;
      }
      throw error;
    }
  }
}

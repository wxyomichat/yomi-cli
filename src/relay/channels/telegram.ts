import { tr } from '../../core/i18n.js';
import { TelegramPresenter } from '../presenter.js';
import { escapeHtml, MESSAGE_LIMIT, TELEGRAM_HTML } from '../render.js';
import {
  MAX_PHOTO_BYTES,
  type TelegramBot,
  TelegramError,
  type TelegramUpdate,
} from '../telegram.js';
import {
  type AskRef,
  type BotCommand,
  type BotIdentity,
  type ChannelCaps,
  type ChannelHost,
  channelName,
  type InboundEvent,
  type OutgoingFile,
  type OutgoingText,
  parseCommand,
  type PresenterRequest,
  type Question,
  type RelayChannel,
  RelayStopped,
  type ReplyContext,
  type ReplyPresenter,
  type Sent,
} from './types.js';

/**
 * Telegram as a relay channel: the owner's private chat with their own bot, over the Bot API
 * (telegram.ts). Long polling with the offset saved before an update is handled (so nothing is
 * handled twice and no dedupe is needed), drafts or edits for a streaming reply (presenter.ts),
 * inline buttons for questions, and every send at once: a bot may write to its private chat at
 * any time. What the relay did before channels existed, call for call.
 */

/** Update ids restart at random after a quiet week: an old offset could skip new messages. */
const OFFSET_MAX_AGE = 6 * 24 * 60 * 60 * 1000;

export type TelegramChannelOptions = {
  /** Start a reply's presenter with drafts (`--no-drafts`: edits). */
  drafts: boolean;
  /** Minimum time between two calls in the chat. */
  intervalMs: number;
  pollTimeoutSeconds: number;
};

/** All a Telegram reply needs is the chat, which every send names anyway. */
type TelegramContext = ReplyContext & { channel: 'telegram' };

const context = (): TelegramContext => ({ channel: 'telegram', receivedAt: Date.now() });

/** Ends early when `signal` aborts; its listener goes with it, as a long run backs off many times. */
const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

export class TelegramChannel implements RelayChannel {
  readonly kind = 'telegram' as const;
  readonly displayName = channelName('telegram');
  readonly caps: ChannelCaps = {
    maxText: MESSAGE_LIMIT,
    format: TELEGRAM_HTML,
    maxPhotoBytes: MAX_PHOTO_BYTES,
    quotes: true,
    pairing: 'code',
  };
  private host: ChannelHost | null = null;

  constructor(
    private readonly bot: TelegramBot,
    private readonly options: TelegramChannelOptions,
  ) {}

  /** The bot id: the state file, the image record and the lock are named after it, as before. */
  get scope(): string {
    return this.bot.id;
  }

  get lockName(): string {
    return this.bot.id;
  }

  async verify(): Promise<BotIdentity> {
    const me = await this.bot.getMe();
    return { id: String(me.id), name: me.first_name, handle: me.username ?? '' };
  }

  /** Long polling refuses to run beside a webhook; another service's webhook is never deleted. */
  async connect(host: ChannelHost): Promise<void> {
    this.host = host;
    const webhook = await this.bot.call<{ url?: string }>('getWebhookInfo');
    if (webhook.url)
      throw new RelayStopped(
        'webhook',
        tr(
          '这个 bot 设置了 webhook（正被别的服务使用）。relay 不会删除它：请为 relay 单独建一个 bot。',
          'This bot has a webhook set (another service is using it). Relay will not delete it: please create a separate bot for relay.',
          'Este bot tiene un webhook configurado (otro servicio lo está usando). Relay no lo eliminará: crea un bot aparte para relay.',
          'Este bot tem um webhook configurado (outro serviço está usando). O relay não vai excluí-lo: crie um bot separado para o relay.',
        ),
      );
  }

  async *events(): AsyncIterable<InboundEvent> {
    const host = this.requireHost();
    const saved = host.state.data;
    let offset = Date.now() - saved.offsetSavedAt < OFFSET_MAX_AGE ? saved.offset : 0;
    let backoff = 1000;
    while (!host.signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.bot.getUpdates(offset, this.options.pollTimeoutSeconds, host.signal);
        backoff = 1000;
      } catch (error) {
        if (host.signal.aborted) return;
        if (error instanceof TelegramError && error.conflict)
          throw new RelayStopped(
            'conflict',
            tr(
              '另一个程序正在用这个 bot 收消息（Telegram 409）。同一个 bot 只能运行一个 relay。',
              'Another program is receiving messages with this bot (Telegram 409). Only one relay can run per bot.',
              'Otro programa está recibiendo mensajes con este bot (Telegram 409). Solo puede ejecutarse un relay por bot.',
              'Outro programa está recebendo mensagens com este bot (Telegram 409). Só é possível executar um relay por bot.',
            ),
          );
        if (error instanceof TelegramError && error.unauthorized)
          throw new RelayStopped(
            'token',
            tr(
              'Telegram 不认这个 bot token（可能在 BotFather 里重置了）。请用 yomi relay --telegram --set-token 重新设置。',
              'Telegram does not accept this bot token (it may have been reset in BotFather). Set it again with yomi relay --telegram --set-token.',
              'Telegram no acepta este token de bot (puede que se haya restablecido en BotFather). Vuelve a configurarlo con yomi relay --telegram --set-token.',
              'O Telegram não aceita este token de bot (ele pode ter sido redefinido no BotFather). Configure-o novamente com yomi relay --telegram --set-token.',
            ),
          );
        host.log(
          tr(
            `Telegram 暂时连不上，${Math.round(backoff / 1000)} 秒后重试`,
            `Can't reach Telegram right now, retrying in ${Math.round(backoff / 1000)} s`,
            `No se puede conectar con Telegram en este momento, se reintentará en ${Math.round(backoff / 1000)} s`,
            `Não foi possível conectar ao Telegram agora, tentando novamente em ${Math.round(backoff / 1000)} s`,
          ),
        );
        await sleep(backoff, host.signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        // Saved before it is handled: an update that breaks the relay is not read again.
        host.state.update({ offset, offsetSavedAt: Date.now() });
        const event = await this.translate(update, host);
        if (event) yield event;
      }
    }
  }

  /** What one update means to the relay; null for anything it does not answer. */
  private async translate(update: TelegramUpdate, host: ChannelHost): Promise<InboundEvent | null> {
    const stopped = update.stopped_message_generation;
    if (stopped)
      return { kind: 'stop', chatId: String(stopped.chat.id), streamRef: String(stopped.draft_id) };
    if (update.my_chat_member) {
      const { chat, new_chat_member: member } = update.my_chat_member;
      // A relay lives in private chats only: added to a group, it leaves.
      if (
        chat.type !== 'private' &&
        ['member', 'administrator', 'restricted'].includes(member.status)
      ) {
        host.log(
          tr(
            '有人把 bot 拉进了群，已退出',
            'Someone added the bot to a group; it left',
            'Alguien agregó el bot a un grupo; el bot salió',
            'Alguém adicionou o bot a um grupo; ele saiu',
          ),
        );
        await this.bot.leaveChat(chat.id).catch(() => undefined);
      }
      return null;
    }
    const query = update.callback_query;
    if (query) {
      const [questionId, optionId] = (query.data ?? '').split(':');
      return {
        kind: 'answer',
        from: {
          id: String(query.from.id),
          name: query.from.first_name,
          language: query.from.language_code ?? '',
        },
        chatId: query.message ? String(query.message.chat.id) : '',
        context: context(),
        questionId,
        optionId: optionId ?? '',
        // An empty text answers with `callback_query_id` alone.
        ack: async (result) => {
          await this.bot.answerCallbackQuery(
            query.id,
            result === 'expired' ? host.texts.expired : '',
          );
        },
      };
    }
    const message = update.message;
    if (!message || message.chat.type !== 'private' || !message.from || message.from.is_bot)
      return null;
    const text = message.text?.trim() ?? '';
    const base = {
      from: {
        id: String(message.from.id),
        name: message.from.first_name,
        language: message.from.language_code ?? '',
      },
      chatId: String(message.chat.id),
      context: context(),
      text,
      rawText: message.text ?? '',
      sentAt: message.date * 1000,
      replyTo: message.reply_to_message ? String(message.reply_to_message.message_id) : '',
    };
    const command = parseCommand(text);
    return command ? { ...base, kind: 'command', ...command } : { ...base, kind: 'message' };
  }

  /** Nothing is held back: every send went out when it was made. */
  async close(): Promise<void> {}

  /** Telegram's ids are numbers in the state file, as they always were. */
  persistId(id: string): number {
    return Number(id);
  }

  async send(to: string, message: OutgoingText): Promise<Sent> {
    const html = message.formatted ? message.text : escapeHtml(message.text);
    const sent = await this.bot.sendMessage(Number(to), html);
    return { status: 'sent', refs: [String(sent.message_id)] };
  }

  /** Uploads the picture; once more after Telegram's flood wait (a refused upload was not sent). */
  async sendPhoto(to: string, file: OutgoingFile, caption: string): Promise<Sent> {
    const html = escapeHtml(caption);
    let sent;
    try {
      sent = await this.bot.sendPhoto(Number(to), file, html);
    } catch (error) {
      if (!(error instanceof TelegramError) || error.code !== 429) throw error;
      await sleep(Math.min(error.retryAfter || 1, 30) * 1000, this.host?.signal);
      sent = await this.bot.sendPhoto(Number(to), file, html);
    }
    return { status: 'sent', refs: [String(sent.message_id)] };
  }

  async typing(to: string, action: 'text' | 'photo'): Promise<void> {
    await this.bot.sendChatAction(Number(to), action === 'photo' ? 'upload_photo' : 'typing');
  }

  async setCommands(commands: readonly BotCommand[]): Promise<void> {
    await this.bot.setMyCommands([...commands]);
  }

  /** Inline buttons: one row (`row`) or one button per row (`column`), each `<id>:<option>`. */
  async ask(to: string, question: Question): Promise<AskRef> {
    const button = (option: Question['options'][number]) => ({
      text: option.label,
      callback_data: `${question.id}:${option.id}`,
    });
    const inline_keyboard =
      question.layout === 'row'
        ? [question.options.map(button)]
        : question.options.map((option) => [button(option)]);
    const sent = await this.bot.sendMessage(Number(to), escapeHtml(question.prompt), {
      reply_markup: { inline_keyboard },
    });
    return { questionId: question.id, ref: `${to}:${sent.message_id}` };
  }

  /** Takes the buttons off the question once it is answered. */
  async closeQuestion(ref: AskRef): Promise<void> {
    const at = ref.ref.lastIndexOf(':');
    await this.bot.editMessageReplyMarkup(
      Number(ref.ref.slice(0, at)),
      Number(ref.ref.slice(at + 1)),
      null,
    );
  }

  presenter(request: PresenterRequest): ReplyPresenter {
    return new TelegramPresenter(this.bot, Number(request.to), {
      render: request.render,
      intervalMs: this.options.intervalMs,
      drafts: this.options.drafts,
      log: request.log,
    });
  }

  async flush(): Promise<void> {}

  private requireHost(): ChannelHost {
    if (!this.host) throw new Error('TelegramChannel.connect() was not called');
    return this.host;
  }
}

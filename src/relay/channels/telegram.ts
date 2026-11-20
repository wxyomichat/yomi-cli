import type { Context } from '../../commands/context.js';
import type { RelayCommandOptions } from '../../commands/relay.js';
import { UsageError } from '../../core/env.js';
import { tr } from '../../core/i18n.js';
import { readSecret } from '../../core/prompt.js';
import { paint, say, warn } from '../../core/ui.js';
import type { PairingCode } from '../pairing.js';
import { TelegramPresenter } from '../presenter.js';
import { escapeHtml, MESSAGE_LIMIT, TELEGRAM_HTML } from '../render.js';
import {
  BOT_TOKEN,
  MAX_PHOTO_BYTES,
  TelegramBot,
  TelegramError,
  type TelegramUpdate,
} from '../telegram.js';
import type { BotRecord } from '../registry.js';
import { botCommand, type ChannelSetup, type CredentialRequest } from './setup.js';
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
  /** What sets this bot's token again, said when Telegram refuses it (the channel's by default). */
  renewCommand?: string;
};

const SET_TOKEN = 'yomi relay --telegram --set-token';

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
        if (error instanceof TelegramError && error.unauthorized) {
          const again = this.options.renewCommand ?? SET_TOKEN;
          throw new RelayStopped(
            'token',
            tr(
              `Telegram 不认这个 bot token（可能在 BotFather 里重置了）。请用 ${again} 重新设置。`,
              `Telegram does not accept this bot token (it may have been reset in BotFather). Set it again with ${again}.`,
              `Telegram no acepta este token de bot (puede que se haya restablecido en BotFather). Vuelve a configurarlo con ${again}.`,
              `O Telegram não aceita este token de bot (ele pode ter sido redefinido no BotFather). Configure-o novamente com ${again}.`,
            ),
          );
        }
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

// -------------------------------------------------------------------------------------------------
// `yomi relay --telegram` (`--channel telegram`): the bot token, typed without echo or piped on
// stdin, kept in the keychain, never an argument or variable; `/start <code>` pairing with a
// t.me deep link. What the command did before channels, text for text.

const secretName = (account: string) => `telegram-bot:${account}`;

async function askToken(context: Context, fromStdin: boolean): Promise<string> {
  const { io } = context;
  if (!fromStdin)
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '在 Telegram 的 @BotFather 里新建一个 bot（/newbot），把它给的 token 粘贴到这里（不会显示）。',
          'Create a bot with @BotFather in Telegram (/newbot) and paste the token it gives you here (it will not be shown).',
          'Crea un bot con @BotFather en Telegram (/newbot) y pega aquí el token que te dé (no se mostrará).',
          'Crie um bot com o @BotFather no Telegram (/newbot) e cole aqui o token que ele fornecer (ele não será exibido).',
        ),
      ),
    );
  const token = await readSecret(io, 'Bot token: ', { fromStdin });
  if (!BOT_TOKEN.test(token))
    throw new UsageError(
      tr(
        '这不像是 bot token（应为 123456789:AA… 的形式）',
        'This does not look like a bot token (it should look like 123456789:AA…)',
        'Esto no parece un token de bot (debería verse como 123456789:AA…)',
        'Isto não parece um token de bot (deveria ser como 123456789:AA…)',
      ),
    );
  return token;
}

/** Telegram's refusal of a token, as the command words it. */
function refusedToken(): UsageError {
  return new UsageError(
    tr(
      'Telegram 不认这个 token：确认是 BotFather 给的、没有在 /revoke 后失效。',
      'Telegram does not accept this token: check that it came from BotFather and was not invalidated with /revoke.',
      'Telegram no acepta este token: comprueba que venga de BotFather y que no se haya invalidado con /revoke.',
      'O Telegram não aceita este token: verifique se ele veio do BotFather e se não foi invalidado com /revoke.',
    ),
  );
}

async function verifiedBot(token: string) {
  const bot = new TelegramBot(token, { apiOrigin: process.env.YOMI_TELEGRAM_API_ORIGIN });
  try {
    const me = await bot.getMe();
    return { bot, me };
  } catch (error) {
    if (error instanceof TelegramError && error.unauthorized) throw refusedToken();
    throw error;
  }
}

export const telegramSetup: ChannelSetup = {
  kind: 'telegram',
  command: 'yomi relay --telegram',
  displayName: channelName('telegram'),
  experimental: false,
  personalUseOnly: false,
  get secretLabel() {
    return tr('bot token', 'bot token', 'token del bot', 'token do bot');
  },
  secretName,
  credentialsFlag: '--set-token',

  async setCredentials(context: Context, request: CredentialRequest) {
    const { io, store } = context;
    const token = await askToken(context, request.options.tokenStdin);
    // The token names its bot: another one than asked for is refused before Telegram is asked.
    const stored = telegramSetup.storedBot(token)!;
    request.check(stored);
    const { me } = await verifiedBot(token);
    const record = request.save({
      secret: token,
      stored,
      identity: { id: String(me.id), name: me.first_name, handle: me.username ?? '' },
    });
    if (request.atStart) return record;
    say(
      io,
      tr(
        `已保存 @${me.username ?? me.first_name} 的 token（${store.kind === 'file' ? '本地文件 0600' : '系统钥匙串'}）。`,
        `Saved the token for @${me.username ?? me.first_name} (${store.kind === 'file' ? 'local file, mode 0600' : 'system keychain'}).`,
        `Se guardó el token de @${me.username ?? me.first_name} (${store.kind === 'file' ? 'archivo local, permisos 0600' : 'llavero del sistema'}).`,
        `Token de @${me.username ?? me.first_name} salvo (${store.kind === 'file' ? 'arquivo local, modo 0600' : 'Keychain do sistema'}).`,
      ),
    );
    // An added bot pairs by its name: the channel's command asks which once it has several, and
    // a background service running is stopped for the pairing and started again (said).
    const next = request.renew ? 'yomi relay --telegram' : botCommand(record, '--pair');
    say(
      io,
      tr(
        `接下来运行 ${next}，在 Telegram 里完成配对。`,
        `Next, run ${next} and finish pairing in Telegram.`,
        `A continuación, ejecuta ${next} y completa la vinculación en Telegram.`,
        `Em seguida, execute ${next} e conclua o pareamento no Telegram.`,
      ),
    );
    return record;
  },

  async open(context: Context, record: BotRecord, options: RelayCommandOptions) {
    const token = context.store.getSecret(record.secretName);
    if (!token) {
      // A service restarting would not fix this: say so and end without failing.
      warn(context.io, telegramSetup.missingCredentials(record));
      return null;
    }
    const bot = new TelegramBot(token, { apiOrigin: process.env.YOMI_TELEGRAM_API_ORIGIN });
    // The Relay built this from the bot before channels, with the command's timings.
    return new TelegramChannel(bot, {
      drafts: options.drafts,
      intervalMs: 1000,
      pollTimeoutSeconds: 25,
      renewCommand: botCommand(record, '--set-token'),
    });
  },

  missingCredentials: (record?: BotRecord) => {
    const command = record ? botCommand(record, '--set-token') : SET_TOKEN;
    return tr(
      `还没有设置 bot token：先运行 ${command}`,
      `No bot token set yet: run ${command} first`,
      `Todavía no hay un token de bot configurado: ejecuta primero ${command}`,
      `Ainda não há token de bot configurado: execute primeiro ${command}`,
    );
  },

  async verify(channel) {
    try {
      return await channel.verify();
    } catch (error) {
      if (error instanceof TelegramError && error.unauthorized) throw refusedToken();
      throw error;
    }
  },

  /** The bot id is the token's first part: the scope, the lock and the platform id at once. */
  storedBot(secret: string) {
    if (!BOT_TOKEN.test(secret)) return null;
    const id = secret.split(':')[0];
    return { platformId: id, scope: id, lockName: id };
  },

  printPairing(context: Context, code: PairingCode, identity: BotIdentity) {
    const { io } = context;
    const username = identity.handle;
    say(io);
    say(
      io,
      tr(
        `在 Telegram 里打开 @${username}，发送：`,
        `Open @${username} in Telegram and send:`,
        `Abre @${username} en Telegram y envía:`,
        `Abra @${username} no Telegram e envie:`,
      ),
    );
    say(io, `  ${paint(io, 'bold', `/start ${code.code}`)}`);
    say(
      io,
      tr(
        `或直接打开：${code.link(username)}`,
        `Or open: ${code.link(username)}`,
        `O abre: ${code.link(username)}`,
        `Ou abra: ${code.link(username)}`,
      ),
    );
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

  unpairedHint: (record?: BotRecord) => {
    const command = record ? botCommand(record, '--pair') : 'yomi relay --telegram';
    return tr(
      `还没有配对：请在终端里运行一次 ${command}，按提示在 Telegram 里发送配对码。`,
      `Not paired yet: run ${command} once in a terminal and send the pairing code in Telegram as prompted.`,
      `Todavía no está vinculado: ejecuta ${command} una vez en una terminal y envía el código de vinculación en Telegram según las indicaciones.`,
      `Ainda não pareado: execute ${command} uma vez em um terminal e envie o código de pareamento no Telegram conforme indicado.`,
    );
  },

  forgetHint: () =>
    tr(
      '如果 token 可能泄露，请在 @BotFather 里用 /revoke 让它失效。',
      'If the token may have leaked, invalidate it with /revoke in @BotFather.',
      'Si el token pudo haberse filtrado, invalídalo con /revoke en @BotFather.',
      'Se o token pode ter vazado, invalide-o com /revoke no @BotFather.',
    ),

  label: (identity: BotIdentity) => `@${identity.handle}`,
};

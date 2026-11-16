import { tr } from '../core/i18n.js';

/**
 * The Telegram Bot API (https://core.telegram.org/bots/api), the few methods the relay uses,
 * over `fetch` with JSON bodies (a photo goes up as multipart/form-data). The bot token is part of
 * every URL path, so no URL, request or response is ever logged or put in an error; errors carry
 * the method, Telegram's `error_code` and `description` only. Long polling only (`getUpdates`):
 * the relay opens no port.
 */

export const TELEGRAM_API = 'https://api.telegram.org';

/** `<digits>:<35+ url-safe characters>`, as BotFather issues them. */
export const BOT_TOKEN = /^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/;

export class TelegramError extends Error {
  constructor(
    public readonly method: string,
    /** Telegram's `error_code` (HTTP-like), or 0 for a network failure. */
    public readonly code: number,
    public readonly description: string,
    /** Seconds to wait before the next request (429). */
    public readonly retryAfter = 0,
  ) {
    super(`Telegram ${method}: ${code ? `${code} ` : ''}${description}`);
    this.name = 'TelegramError';
  }
  /** Another getUpdates poller (or a webhook) uses this bot. */
  get conflict() {
    return this.code === 409;
  }
  /** The token was revoked or is wrong. */
  get unauthorized() {
    return this.code === 401 || this.code === 404;
  }
  /** The person blocked the bot or deleted the chat. */
  get blocked() {
    return this.code === 403;
  }
  get transient() {
    return this.code === 0 || this.code === 429 || this.code >= 500;
  }
}

export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
};

export type TelegramChat = { id: number; type: string; title?: string };

export type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  reply_to_message?: { message_id: number };
  entities?: { type: string; offset: number; length: number }[];
  /** A photo message's sizes, smallest first. */
  photo?: TelegramPhotoSize[];
  caption?: string;
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: { chat: TelegramChat; from: TelegramUser; new_chat_member: { status: string } };
  /** The user pressed Stop on a draft (`can_stop`); `draft_id` arrives as a string. */
  stopped_message_generation?: { chat: TelegramChat; draft_id: string | number };
};

export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

/** A file to upload: its bytes, media type and file name. */
export type TelegramFile = { bytes: Buffer; mime: string; name: string };

/** `PhotoSize`: one of the sizes Telegram keeps of a photo. */
export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

/** Photos uploaded with multipart/form-data may be 10 MB at most. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export type BotOptions = {
  /** `https://api.telegram.org`; a test may point at a loopback mock. */
  apiOrigin?: string;
  fetch?: typeof fetch;
};

/** Accepts the real API or a loopback mock only, so a setting can never send the token elsewhere. */
export function telegramOrigin(value: string | undefined): string {
  if (!value) return TELEGRAM_API;
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.origin === TELEGRAM_API) return TELEGRAM_API;
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:'))
    throw new Error(
      tr(
        'Telegram API 地址只能是 https://api.telegram.org 或本机测试地址',
        'The Telegram API address can only be https://api.telegram.org or a local test address',
        'La dirección de la API de Telegram solo puede ser https://api.telegram.org o una dirección de prueba local',
        'O endereço da API do Telegram só pode ser https://api.telegram.org ou um endereço de teste local',
      ),
    );
  return url.origin;
}

export class TelegramBot {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly token: string,
    options: BotOptions = {},
  ) {
    if (!BOT_TOKEN.test(token))
      throw new Error(
        tr(
          'bot token 格式不对（应为 123456789:AA… 的形式）',
          'The bot token has the wrong format (it should look like 123456789:AA…)',
          'El token del bot tiene un formato incorrecto (debería verse como 123456789:AA…)',
          'O token do bot está no formato errado (deveria ser como 123456789:AA…)',
        ),
      );
    this.origin = telegramOrigin(options.apiOrigin);
    this.fetcher = options.fetch ?? fetch;
  }

  /** The bot's numeric id: the part of the token before the colon (not secret). */
  get id(): string {
    return this.token.split(':')[0];
  }

  call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.post<T>(
      method,
      { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
      options,
    );
  }

  /**
   * A method with files: `multipart/form-data`, plain fields as text (objects as JSON, as the Bot
   * API reads them) and each file as a part of its own. The token stays in the URL path only.
   */
  callWithFiles<T>(
    method: string,
    params: Record<string, unknown>,
    files: Record<string, TelegramFile>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const form = new FormData();
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    for (const [name, file] of Object.entries(files))
      form.append(name, new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
    // fetch writes the boundary into Content-Type itself.
    return this.post<T>(method, { body: form }, { timeoutMs: 60_000, ...options });
  }

  private async post<T>(
    method: string,
    request: { headers?: Record<string, string>; body: string | FormData },
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 30_000);
    let response: Response;
    let body: {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    try {
      response = await this.fetcher(`${this.origin}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: controller.signal,
      });
      body = (await response.json()) as typeof body;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new TelegramError(
        method,
        0,
        error instanceof Error && error.name === 'AbortError'
          ? tr(
              '请求超时',
              'Request timed out',
              'Se agotó el tiempo de espera de la solicitud',
              'A solicitação excedeu o tempo limite',
            )
          : tr(
              '网络请求失败',
              'Network request failed',
              'Falló la solicitud de red',
              'Falha na solicitação de rede',
            ),
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
    if (body.ok) return body.result as T;
    throw new TelegramError(
      method,
      body.error_code ?? response.status,
      String(body.description ?? `HTTP ${response.status}`).slice(0, 200),
      body.parameters?.retry_after ?? 0,
    );
  }

  getMe() {
    return this.call<TelegramUser>('getMe');
  }

  /** Long polling refuses to run while a webhook is set; the queued updates stay. */
  deleteWebhook() {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: false });
  }

  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal) {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        // An explicit list replaces the default: the draft's Stop button must be named too.
        allowed_updates: [
          'message',
          'callback_query',
          'my_chat_member',
          'stopped_message_generation',
        ],
      },
      { signal, timeoutMs: (timeoutSeconds + 15) * 1000 },
    );
  }

  setMyCommands(commands: { command: string; description: string }[], languageCode?: string) {
    const params: Record<string, unknown> = {
      commands,
      scope: { type: 'all_private_chats' },
    };
    if (languageCode) params.language_code = languageCode;
    return this.call<boolean>('setMyCommands', params);
  }

  sendMessage(chatId: number, html: string, extra: Record<string, unknown> = {}) {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    html: string,
    extra: Record<string, unknown> = {},
  ) {
    return this.call<TelegramMessage | boolean>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  /** Streams a partial message in a private chat (Bot API 9.3+); `draftId` names one reply. */
  sendMessageDraft(chatId: number, draftId: number, html: string) {
    return this.call<boolean>('sendMessageDraft', {
      chat_id: chatId,
      draft_id: draftId,
      text: html,
      parse_mode: 'HTML',
    });
  }

  /**
   * Uploads a photo (JPEG, PNG or WebP, at most 10 MB, as the Bot API allows for uploads) with an
   * optional HTML caption (1024 characters at most). The bytes go up as a file part, never as a
   * link Telegram would fetch.
   */
  sendPhoto(
    chatId: number,
    photo: TelegramFile,
    captionHtml = '',
    extra: Record<string, unknown> = {},
  ) {
    if (photo.bytes.length > MAX_PHOTO_BYTES)
      return Promise.reject(
        new TelegramError(
          'sendPhoto',
          400,
          tr(
            '图片超过 10 MB',
            'The image is over 10 MB',
            'La imagen supera los 10 MB',
            'A imagem passa de 10 MB',
          ),
        ),
      );
    const params: Record<string, unknown> = { chat_id: chatId, ...extra };
    if (captionHtml) {
      params.caption = captionHtml;
      params.parse_mode = 'HTML';
    }
    return this.callWithFiles<TelegramMessage>('sendPhoto', params, { photo });
  }

  sendChatAction(chatId: number, action = 'typing') {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  answerCallbackQuery(id: string, textValue = '') {
    return this.call<boolean>(
      'answerCallbackQuery',
      textValue ? { callback_query_id: id, text: textValue } : { callback_query_id: id },
    );
  }

  editMessageReplyMarkup(chatId: number, messageId: number, markup: InlineKeyboard | null) {
    return this.call<TelegramMessage | boolean>('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: markup ?? { inline_keyboard: [] },
    });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  leaveChat(chatId: number) {
    return this.call<boolean>('leaveChat', { chat_id: chatId });
  }
}

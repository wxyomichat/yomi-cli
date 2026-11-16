import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * An in-process stand-in for the Telegram Bot API (https://core.telegram.org/bots/api), for end to
 * end tests of `yomi relay --telegram`. It speaks the real wire format (JSON POSTs to
 * `<origin>/bot<token>/<method>`; `{ok, result}` or `{ok: false, error_code, description,
 * parameters}` with the HTTP status equal to `error_code`) and refuses what Telegram refuses that
 * matters to the relay: a second long poller or a webhook (409), a wrong or revoked token (401),
 * HTML that does not parse, text over 4096 code points, an edit that changes nothing, drafts
 * outside private chats, per-chat flood (429). Error strings follow the Bot API server source.
 * It listens on 127.0.0.1 only; nothing here reaches the network.
 */

/** A Telegram user as a test describes one; `is_bot` defaults to false. */
export type MockTelegramUser = {
  id: number;
  first_name: string;
  is_bot?: boolean;
  language_code?: string;
  username?: string;
};

/** One Bot API request: `params` is the JSON body (the token is only in the URL, never kept). */
export type MockBotCall = {
  method: string;
  params: Record<string, unknown>;
  /** `Date.now()` when it arrived. A long poll still waiting shows `ok: true`. */
  at: number;
  ok: boolean;
  /** Telegram's `description` when it failed. */
  error?: string;
};

export type MockTelegram = {
  /** `http://127.0.0.1:<port>`, for `new TelegramBot(token, { apiOrigin })`. */
  origin: string;
  /** `<botId>:<35 url-safe characters>`, the only token this bot accepts. */
  token: string;
  botId: number;
  username: string;
  /** Every Bot API call in arrival order. */
  calls: MockBotCall[];
  /** What the chat shows now (after edits): the bot's messages, oldest first, as sent (raw text). */
  messages(chatId: number): {
    message_id: number;
    text: string;
    parse_mode?: string;
    reply_markup?: unknown;
  }[];
  /** The latest draft in that chat; a message from the bot there clears it. */
  draft(chatId: number): { draft_id: number; text: string } | null;
  /** Queues a text message (private chat `from.id` unless `chatId`); returns its `message_id`. */
  userSends(
    from: MockTelegramUser,
    text: string,
    options?: {
      chatId?: number;
      chatType?: 'private' | 'group' | 'supergroup';
      replyTo?: number;
      date?: number;
    },
  ): number;
  /** Queues a photo (a message with no text) in the private chat; returns its `message_id`. */
  sendPhoto(from: MockTelegramUser): number;
  /** Queues a `callback_query` for an inline button; returns the query id. */
  press(from: MockTelegramUser, chatId: number, messageId: number, data: string): string;
  /** Queues `stopped_message_generation` (its `draft_id` is a string, as the real server sends). */
  stopGeneration(chatId: number, draftId: number): void;
  /** Queues `my_chat_member`: the bot joined group `groupChatId` as a member. */
  botAddedToGroup(from: MockTelegramUser, groupChatId: number): void;
  /** Sets a webhook: getUpdates answers 409 until deleteWebhook. */
  setWebhook(url: string): void;
  /** The next call of `method` fails once with this error. */
  failNext(
    method: string,
    error: { error_code: number; description: string; retry_after?: number },
  ): void;
  /**
   * More than this many sendMessageDraft/sendChatAction/sendMessage/editMessageText calls to one
   * chat within 5 s answer 429 "retry after 1"; that chat then stays blocked for exactly that
   * second and starts a fresh window. 0 (the default) turns it off.
   */
  floodLimit: number;
  /** Every later call answers 401 "Unauthorized". */
  revokeToken(): void;
  /** Polls `check` every 10 ms until it returns something other than undefined/null/false. */
  waitFor<T>(check: () => T | undefined | null | false, timeoutMs?: number): Promise<T>;
  /** Answers a waiting getUpdates with [] first, then stops listening. */
  close(): Promise<void>;
};

type Json = Record<string, unknown>;
type Failure = Parameters<MockTelegram['failNext']>[1];
type Entity = { type: string; offset: number; length: number; url?: string };
type Parsed = { text: string; entities: Entity[] };
/** Text as sent (`text`, `parseMode`) and as shown (`parsed`). */
type Content = { text: string; parseMode?: string; parsed: Parsed };
type BotMessage = Content & {
  message_id: number;
  date: number;
  editDate?: number;
  markup: unknown;
};
type ChatState = {
  chat: Json & { id: number; type: string };
  users: Map<number, Json>;
  bot: Map<number, BotMessage>;
  draft: { draft_id: number; text: string; keepOnStop: boolean } | null;
  left: boolean;
};
type Update = Json & { update_id: number };
type Poll = {
  response: ServerResponse;
  limit: number;
  timer: NodeJS.Timeout;
  answer(outcome: Outcome): void;
};
type Handler = (params: Json, response: ServerResponse) => unknown;
type Outcome = Update[] | BotApiError;

const NOT_MODIFIED =
  'message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';
const FLOOD_METHODS = ['sendmessagedraft', 'sendchataction', 'sendmessage', 'editmessagetext'];
const FLOOD_WINDOW_MS = 5000;
/** Update types left out when `allowed_updates` was never given or was empty. */
const NOT_BY_DEFAULT = ['chat_member', 'message_reaction', 'message_reaction_count'];
const CONFLICT =
  'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
const WEBHOOK_ACTIVE =
  "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first";
/** The supported HTML tags (lower case) and the entity type each makes. */
const TAGS = new Map(
  Object.entries({
    bold: 'b strong',
    italic: 'i em',
    underline: 'u ins',
    strikethrough: 's strike del',
    code: 'code',
    pre: 'pre',
    text_link: 'a',
    blockquote: 'blockquote',
    spoiler: 'tg-spoiler',
  }).flatMap(([type, names]) => names.split(' ').map((name) => [name, type] as const)),
);
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };
const ENTITY = /&(?:(lt|gt|amp|quot)|#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6}));/y;
const TAG =
  /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*>/y;
const HREF = /\bhref\s*=\s*["']?([^"'\s>]*)/i;

/** A refusal: `{ok: false, error_code, description, parameters?}` with the same HTTP status. */
class BotApiError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter = 0,
  ) {
    super(description);
  }
}

const bad = (description: string) => new BotApiError(400, `Bad Request: ${description}`);
const now = () => Math.floor(Date.now() / 1000);
const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;

function decodeEntity([, name, decimal, hex]: RegExpExecArray): string | undefined {
  if (name) return NAMED_ENTITIES[name];
  const code = decimal ? Number(decimal) : Number.parseInt(hex, 16);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

/**
 * Telegram's HTML parse mode, a little stricter than the server: every `<` must open or close a
 * supported tag, every `&` must start `&lt;` `&gt;` `&amp;` `&quot;` or a numeric entity, and
 * tags must balance. Returns the text a person sees and its entities (UTF-16 offsets).
 */
function parseHtml(source: string): Parsed {
  const at = (index: number) => `at byte offset ${Buffer.byteLength(source.slice(0, index))}`;
  const fail = (reason: string) => bad(`can't parse entities: ${reason}`);
  const open: { name: string; type: string; offset: number; url?: string }[] = [];
  const entities: Entity[] = [];
  let text = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '&') {
      ENTITY.lastIndex = index;
      const match = ENTITY.exec(source);
      const decoded = match ? decodeEntity(match) : undefined;
      if (decoded === undefined) throw fail(`unsupported HTML entity ${at(index)}; use &amp;`);
      text += decoded;
      index = ENTITY.lastIndex;
      continue;
    }
    if (char !== '<') {
      text += char;
      index += 1;
      continue;
    }
    TAG.lastIndex = index;
    const tag = TAG.exec(source);
    if (!tag) throw fail(`unexpected "<" ${at(index)}; escape it as &lt;`);
    const [, closing, rawName, attributes] = tag;
    const name = rawName.toLowerCase();
    if (closing) {
      const top = open.pop();
      if (!top || top.name !== name)
        throw fail(`unmatched end tag "</${name}>" ${at(index)}, expected "</${top?.name ?? ''}>"`);
      const length = text.length - top.offset;
      if (length > 0 && (top.type !== 'text_link' || top.url))
        entities.push({ type: top.type, offset: top.offset, length, url: top.url });
    } else {
      const type = TAGS.get(name);
      if (!type) throw fail(`unsupported start tag "${name}" ${at(index)}`);
      const url = name === 'a' ? HREF.exec(attributes)?.[1] : undefined;
      open.push({ name, type, offset: text.length, url });
    }
    index = TAG.lastIndex;
  }
  const unclosed = open.pop();
  if (unclosed) throw fail(`can't find end tag corresponding to start tag "${unclosed.name}"`);
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text, entities };
}

/** `text` and `parse_mode` checked as sendMessage checks them; drafts may be empty. */
function readText(params: Json, allowEmpty: boolean): Content {
  const text = String(params.text ?? '');
  if (Buffer.byteLength(text) > 32768) throw bad('text is too long');
  const parseMode = params.parse_mode ? String(params.parse_mode) : undefined;
  const mode = parseMode?.toLowerCase();
  if (mode && !['html', 'markdown', 'markdownv2'].includes(mode))
    throw bad('unsupported parse_mode');
  // Markdown is accepted as plain text: the relay only sends HTML.
  const parsed = mode === 'html' ? parseHtml(text) : { text, entities: [] };
  if (!allowEmpty && !parsed.text.trim()) throw bad('message text is empty');
  if ([...parsed.text].length > 4096) throw bad('message is too long');
  return { text, parseMode, parsed };
}

/** The inline keyboard a message shows: one with at least one button, else none. */
function inlineKeyboard(markup: unknown): unknown {
  const rows = (markup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard;
  return Array.isArray(rows) && rows.some((row) => Array.isArray(row) && row.length)
    ? markup
    : undefined;
}

async function readParams(request: IncomingMessage): Promise<Json | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Json | null;
    return value?.constructor === Object ? value : undefined;
  } catch {
    return undefined;
  }
}

function reply(response: ServerResponse, status: number, body: Json): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function replyError(response: ServerResponse, { code, description, retryAfter }: BotApiError) {
  const parameters = retryAfter ? { parameters: { retry_after: retryAfter } } : {};
  reply(response, code, { ok: false, error_code: code, description, ...parameters });
}

/** The last calls, one per line, for a timeout message. */
function describeCalls(calls: MockBotCall[]): string {
  const line = ({ method, ok, error, params }: MockBotCall) =>
    `  ${method} ${ok ? 'ok' : error} ${JSON.stringify(params).slice(0, 160)}`;
  return calls.slice(-10).map(line).join('\n') || '  (none)';
}

/** Starts the mock on a free loopback port. */
export async function startMockTelegram(
  options: { username?: string; botId?: number } = {},
): Promise<MockTelegram> {
  const botId = options.botId ?? 8_123_456_789;
  if (!Number.isSafeInteger(botId) || botId < 10_000) throw new Error('botId: 5+ digit integer');
  const username = options.username ?? 'yomi_mock_bot';
  const token = `${botId}:AA${randomBytes(25).toString('base64url').slice(0, 33)}`;
  const botUser = { id: botId, is_bot: true, first_name: 'Yomi Mock', username };

  const calls: MockBotCall[] = [];
  const chats = new Map<number, ChatState>();
  const queue: Update[] = [];
  const callbacks = new Set<string>();
  const commands = new Map<string, unknown>();
  const failures = new Map<string, Failure[]>();
  const flood = new Map<string, { times: number[]; until: number }>();
  let nextUpdateId = 100_000 + Math.floor(Math.random() * 900_000);
  let nextMessageId = 100;
  let callbackCount = 0;
  let allowed: string[] | undefined;
  let webhook = '';
  let revoked = false;
  let waiting: Poll | undefined;
  let closing: Promise<void> | undefined;

  const userJson = (from: MockTelegramUser) => ({ ...from, is_bot: from.is_bot ?? false });
  const messageJson = (state: ChatState, message: BotMessage) => ({
    message_id: message.message_id,
    from: botUser,
    chat: state.chat,
    date: message.date,
    ...(message.editDate ? { edit_date: message.editDate } : {}),
    text: message.parsed.text,
    ...(message.parsed.entities.length ? { entities: message.parsed.entities } : {}),
    ...(message.markup ? { reply_markup: message.markup } : {}),
  });

  function find(state: ChatState, messageId: number): Json | undefined {
    const mine = state.bot.get(messageId);
    return mine ? messageJson(state, mine) : state.users.get(messageId);
  }

  function ensureChat(id: number, type: string, from?: MockTelegramUser): ChatState {
    const known = chats.get(id);
    if (known) return known;
    const names =
      type === 'private'
        ? { first_name: from?.first_name, username: from?.username }
        : { title: `Group ${Math.abs(id)}` };
    const state = {
      chat: { id, type, ...names },
      users: new Map(),
      bot: new Map(),
      draft: null,
      left: false,
    };
    chats.set(id, state);
    return state;
  }

  /** The chat a call names; it exists once someone wrote to the bot there. */
  function chatOf(params: Json, privateOnly = false): ChatState {
    const id = privateOnly ? params.chat_id : Number(params.chat_id);
    const state = Number.isInteger(id) ? chats.get(id as number) : undefined;
    if (!state || (privateOnly && state.chat.type !== 'private')) throw bad('chat not found');
    if (state.left) throw new BotApiError(403, 'Forbidden: bot is not a member of the group chat');
    return state;
  }

  function botMessage(state: ChatState, params: Json): BotMessage {
    const message = state.bot.get(Number(params.message_id));
    if (!message) throw bad('message to edit not found');
    return message;
  }

  function edit(state: ChatState, message: BotMessage, content: Content, markup: unknown) {
    const before = JSON.stringify([message.parsed, message.markup]);
    if (before === JSON.stringify([content.parsed, markup])) throw bad(NOT_MODIFIED);
    Object.assign(message, content, { markup, editDate: now() });
    return messageJson(state, message);
  }

  function enqueue(update: Json): void {
    queue.push({ update_id: nextUpdateId++, ...update });
    const updates = waiting ? ready(waiting.limit) : [];
    if (waiting && updates.length) settle(waiting, updates);
  }

  function userMessage(from: MockTelegramUser, state: ChatState, body: Json, date = now()) {
    const message_id = nextMessageId++;
    const message = { message_id, from: userJson(from), chat: state.chat, date, ...body };
    state.users.set(message_id, message);
    enqueue({ message });
    return message_id;
  }

  function ready(limit: number): Update[] {
    const wanted = (update: Update) => {
      const type = Object.keys(update).find((key) => key !== 'update_id') ?? '';
      return allowed ? allowed.includes(type) : !NOT_BY_DEFAULT.includes(type);
    };
    return queue.filter(wanted).slice(0, limit);
  }

  /** Answers the waiting long poll (once) with updates or a 409. */
  function settle(poll: Poll, outcome: Outcome): void {
    if (waiting !== poll) return;
    waiting = undefined;
    clearTimeout(poll.timer);
    poll.answer(outcome);
  }

  function getUpdates(params: Json, response: ServerResponse): unknown {
    if (webhook) throw new BotApiError(409, WEBHOOK_ACTIVE);
    if (waiting) settle(waiting, new BotApiError(409, CONFLICT));
    const offset = Math.trunc(Number(params.offset)) || 0;
    if (offset < 0) queue.splice(0, Math.max(0, queue.length + offset));
    while (offset > 0 && queue.length && queue[0].update_id < offset) queue.shift();
    if (Array.isArray(params.allowed_updates))
      allowed = params.allowed_updates.length ? params.allowed_updates.map(String) : undefined;
    const limit = clamp(Number(params.limit ?? 100), 1, 100);
    const timeout = clamp(Number(params.timeout ?? 0), 0, 50);
    const updates = ready(limit);
    if (updates.length || !timeout) return updates;
    return new Promise<Update[]>((resolve, reject) => {
      const answer = (outcome: Outcome) =>
        outcome instanceof BotApiError ? reject(outcome) : resolve(outcome);
      const timer = setTimeout(() => settle(poll, []), timeout * 1000);
      const poll: Poll = { response, limit, timer, answer };
      waiting = poll;
      response.once('close', () => settle(poll, []));
    });
  }

  function checkFlood(method: string, params: Json): void {
    if (!mock.floodLimit || !FLOOD_METHODS.includes(method)) return;
    const key = String(params.chat_id);
    const entry = flood.get(key) ?? { times: [], until: 0 };
    flood.set(key, entry);
    const at = Date.now();
    const tooMany = new BotApiError(429, 'Too Many Requests: retry after 1', 1);
    if (at < entry.until) throw tooMany;
    entry.times = entry.times.filter((time) => at - time < FLOOD_WINDOW_MS);
    if (entry.times.length >= mock.floodLimit) {
      entry.times = [];
      entry.until = at + 1000;
      throw tooMany;
    }
    entry.times.push(at);
  }

  const methods: Record<string, Handler> = {
    getMe: () => ({ ...botUser, has_topics_enabled: false }),
    getWebhookInfo: () => ({
      url: webhook,
      has_custom_certificate: false,
      pending_update_count: queue.length,
    }),
    deleteWebhook: (params) => {
      webhook = '';
      if (params.drop_pending_updates === true) queue.length = 0;
      return true;
    },
    setMyCommands: (params) => {
      commands.set(String(params.language_code ?? ''), params.commands);
      return true;
    },
    getUpdates,
    sendMessage: (params) => {
      const state = chatOf(params);
      const content = readText(params, false);
      const markup = inlineKeyboard(params.reply_markup);
      const message: BotMessage = { ...content, message_id: nextMessageId++, date: now(), markup };
      state.bot.set(message.message_id, message);
      state.draft = null;
      return messageJson(state, message);
    },
    editMessageText: (params) => {
      const state = chatOf(params);
      const message = botMessage(state, params);
      return edit(state, message, readText(params, false), inlineKeyboard(params.reply_markup));
    },
    editMessageReplyMarkup: (params) => {
      const state = chatOf(params);
      const message = botMessage(state, params);
      return edit(state, message, message, inlineKeyboard(params.reply_markup));
    },
    sendMessageDraft: (params) => {
      const state = chatOf(params, true);
      const draftId = params.draft_id;
      if (typeof draftId !== 'number' || !Number.isInteger(draftId) || draftId === 0)
        throw bad('invalid draft_id');
      const { text } = readText(params, true);
      state.draft = { draft_id: draftId, text, keepOnStop: params.keep_on_stop === true };
      return true;
    },
    sendChatAction: (params) => Boolean(chatOf(params)),
    answerCallbackQuery: (params) => {
      if (!callbacks.delete(String(params.callback_query_id)))
        throw bad('query is too old and response timeout expired or query ID is invalid');
      return true;
    },
    leaveChat: (params) => {
      chatOf(params).left = true;
      return true;
    },
    deleteMessage: (params) => {
      const state = chatOf(params);
      if (!state.bot.delete(Number(params.message_id))) throw bad('message to delete not found');
      return true;
    },
  };
  const handlers = new Map(Object.entries(methods).map(([name, run]) => [name.toLowerCase(), run]));

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://mock').pathname;
    const route = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path);
    if (!route) return replyError(response, new BotApiError(404, 'Not Found'));
    const [, given, method] = route;
    const params = await readParams(request).catch(() => undefined);
    const record: MockBotCall = { method, params: params ?? {}, at: Date.now(), ok: true };
    calls.push(record);
    try {
      if (revoked || given !== token) throw new BotApiError(401, 'Unauthorized');
      if (!params) throw bad("can't parse JSON object");
      const name = method.toLowerCase();
      const handler = handlers.get(name);
      if (!handler) throw new BotApiError(404, 'Not Found: method not found');
      const failure = failures.get(name)?.shift();
      if (failure)
        throw new BotApiError(failure.error_code, failure.description, failure.retry_after);
      checkFlood(name, params);
      reply(response, 200, { ok: true, result: await handler(params, response) });
    } catch (error) {
      const failure =
        error instanceof BotApiError
          ? error
          : new BotApiError(500, `Internal Server Error: ${String(error)}`);
      record.ok = false;
      record.error = failure.description;
      replyError(response, failure);
    }
  }

  const server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  async function shutdown(): Promise<void> {
    const poll = waiting;
    if (poll) {
      settle(poll, []);
      await new Promise<void>((resolve) => {
        if (poll.response.writableFinished || poll.response.destroyed) return resolve();
        poll.response.once('finish', resolve).once('close', resolve);
      });
    }
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  const mock: MockTelegram = {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    botId,
    username,
    calls,
    floodLimit: 0,
    messages: (chatId) =>
      [...(chats.get(chatId)?.bot.values() ?? [])].map((message) => ({
        message_id: message.message_id,
        text: message.text,
        ...(message.parseMode ? { parse_mode: message.parseMode } : {}),
        ...(message.markup ? { reply_markup: message.markup } : {}),
      })),
    draft: (chatId) => {
      const draft = chats.get(chatId)?.draft;
      return draft ? { draft_id: draft.draft_id, text: draft.text } : null;
    },
    userSends(from, text, options = {}) {
      const chatId = options.chatId ?? from.id;
      const state = ensureChat(
        chatId,
        options.chatType ?? (chatId < 0 ? 'group' : 'private'),
        from,
      );
      // Telegram marks `/command` or `/command@bot` at the start as a bot_command entity.
      const command = /^\/[A-Za-z0-9_]{1,64}(?:@[A-Za-z0-9_]{3,32})?/.exec(text);
      const entities = command
        ? [{ type: 'bot_command', offset: 0, length: command[0].length }]
        : undefined;
      const { replyTo } = options;
      const reply_to_message =
        replyTo === undefined
          ? undefined
          : (find(state, replyTo) ?? { message_id: replyTo, chat: state.chat, date: 0 });
      return userMessage(from, state, { text, entities, reply_to_message }, options.date);
    },
    sendPhoto(from) {
      const photo = [{ file_id: 'mock-photo', file_unique_id: 'mock', width: 320, height: 240 }];
      return userMessage(from, ensureChat(from.id, 'private', from), { photo });
    },
    press(from, chatId, messageId, data) {
      const id = String(4_100_000_000_000_000 + ++callbackCount);
      callbacks.add(id);
      const state = chats.get(chatId);
      const chat = state?.chat ?? { id: chatId, type: chatId < 0 ? 'group' : 'private' };
      const message = (state && find(state, messageId)) ?? { chat, message_id: messageId, date: 0 };
      const chat_instance = String(9_000_000_000_000 + Math.abs(chatId));
      enqueue({ callback_query: { id, from: userJson(from), message, chat_instance, data } });
      return id;
    },
    stopGeneration(chatId, draftId) {
      const state = chats.get(chatId);
      if (state?.draft?.draft_id === draftId && !state.draft.keepOnStop) state.draft = null;
      const chat = state?.chat ?? { id: chatId, type: 'private' };
      enqueue({ stopped_message_generation: { chat, draft_id: String(draftId) } });
    },
    botAddedToGroup(from, groupChatId) {
      const state = ensureChat(groupChatId, 'group');
      state.left = false;
      enqueue({
        my_chat_member: {
          chat: state.chat,
          from: userJson(from),
          date: now(),
          old_chat_member: { user: botUser, status: 'left' },
          new_chat_member: { user: botUser, status: 'member' },
        },
      });
    },
    setWebhook(url) {
      webhook = url;
      if (waiting)
        settle(waiting, new BotApiError(409, 'Conflict: terminated by setWebhook request'));
    },
    failNext(method, error) {
      const key = method.toLowerCase();
      failures.set(key, [...(failures.get(key) ?? []), error]);
    },
    revokeToken() {
      revoked = true;
    },
    async waitFor(check, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      let thrown: unknown;
      for (;;) {
        try {
          const value = check();
          if (value !== undefined && value !== null && value !== false) return value;
        } catch (error) {
          thrown = error;
        }
        if (Date.now() >= deadline) {
          const reason =
            thrown instanceof Error ? ` (the check last threw: ${thrown.message})` : '';
          const message = `waitFor gave up after ${timeoutMs} ms${reason}. Last Bot API calls:`;
          throw new Error(`${message}\n${describeCalls(calls)}`);
        }
        await delay(10);
      }
    },
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
  return mock;
}

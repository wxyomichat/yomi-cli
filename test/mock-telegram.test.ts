import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type MockTelegram, startMockTelegram } from '../src/mock/telegram.js';
import {
  BOT_TOKEN,
  TelegramBot,
  TelegramError,
  type TelegramUpdate,
} from '../src/relay/telegram.js';

/**
 * The Telegram Bot API mock driven by the real relay client (`TelegramBot`), so the wire format,
 * error codes and descriptions the relay sees in end-to-end tests match what Telegram sends.
 */

const owner = { id: 5_550_001, first_name: 'Ada', language_code: 'en' };
const keyboard = { inline_keyboard: [[{ text: 'Yes', callback_data: 'yes' }]] };

let mock: MockTelegram;
let bot: TelegramBot;

beforeEach(async () => {
  mock = await startMockTelegram();
  bot = new TelegramBot(mock.token, { apiOrigin: mock.origin });
});

afterEach(() => mock.close());

/** The TelegramError a call fails with (a handler is attached at once, so no unhandled rejection). */
async function failure(call: Promise<unknown>): Promise<TelegramError> {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TelegramError);
  return error as TelegramError;
}

describe('Telegram mock', () => {
  it('answers getMe for its token and never records the token', async () => {
    expect(mock.token).toMatch(BOT_TOKEN);
    expect(mock.token.startsWith(`${mock.botId}:`)).toBe(true);
    expect(await bot.getMe()).toEqual({
      id: mock.botId,
      is_bot: true,
      first_name: expect.any(String),
      username: mock.username,
      has_topics_enabled: false,
    });
    const unknown = await failure(bot.call('logOut'));
    expect([unknown.code, unknown.description]).toEqual([404, 'Not Found: method not found']);
    expect(mock.calls.map((call) => [call.method, call.ok])).toEqual([
      ['getMe', true],
      ['logOut', false],
    ]);
    expect(JSON.stringify(mock.calls)).not.toContain(mock.token.split(':')[1]);
    await expect(mock.waitFor(() => false, 30)).rejects.toThrow(
      /Last Bot API calls:\n {2}getMe ok/,
    );

    const other = await startMockTelegram({ username: 'other_bot', botId: 123_456 });
    expect(other.token).toMatch(/^123456:[A-Za-z0-9_-]{35}$/);
    expect(other.username).toBe('other_bot');
    await other.close();
  });

  it('long polling delivers a queued update and an offset confirms it', async () => {
    const poll = bot.getUpdates(0, 5);
    await mock.waitFor(() => mock.calls.length === 1);
    const messageId = mock.userSends(owner, '/start abc');
    const [update] = await poll;
    expect(update.message).toMatchObject({
      message_id: messageId,
      chat: { id: owner.id, type: 'private' },
      from: { id: owner.id, is_bot: false, first_name: 'Ada' },
      text: '/start abc',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    });
    // Not confirmed yet: the same update comes again.
    expect((await bot.getUpdates(0, 0)).map((item) => item.update_id)).toEqual([update.update_id]);
    expect(await bot.getUpdates(update.update_id + 1, 0)).toEqual([]);
    const info = await bot.call<{ url: string; pending_update_count: number }>('getWebhookInfo');
    expect(info).toMatchObject({ url: '', pending_update_count: 0 });

    // allowed_updates filters; the stop event's draft_id is a string, as Telegram sends it.
    mock.press(owner, owner.id, 1, 'x');
    mock.stopGeneration(owner.id, 42);
    const stops = await bot.call<TelegramUpdate[]>('getUpdates', {
      offset: update.update_id + 1,
      timeout: 0,
      allowed_updates: ['stopped_message_generation'],
    });
    expect(stops).toEqual([
      {
        update_id: expect.any(Number),
        stopped_message_generation: {
          chat: expect.objectContaining({ id: owner.id }),
          draft_id: '42',
        },
      },
    ]);
  });

  it('a second poller ends the first with 409 Conflict, and so does a webhook', async () => {
    const first = failure(bot.getUpdates(0, 10));
    await mock.waitFor(() => mock.calls.length === 1);
    const second = new TelegramBot(mock.token, { apiOrigin: mock.origin });
    expect(await second.getUpdates(0, 0)).toEqual([]);
    const error = await first;
    expect(error.code).toBe(409);
    expect(error.conflict).toBe(true);
    expect(error.description).toBe(
      'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
    );
    expect(mock.calls[0]).toMatchObject({ method: 'getUpdates', ok: false });

    mock.setWebhook('https://example.invalid/hook');
    const webhook = await failure(bot.getUpdates(0, 0));
    expect([webhook.code, webhook.description]).toEqual([
      409,
      "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
    ]);
    expect(await bot.deleteWebhook()).toBe(true);
    expect(await bot.getUpdates(0, 0)).toEqual([]);
  });

  it('sendMessage validates HTML and length like Telegram', async () => {
    mock.userSends(owner, 'hi');
    const html = '<b>Ada</b>: a &lt;b&gt; &amp; c &#128512;';
    const sent = await bot.sendMessage(owner.id, html, { reply_markup: keyboard });
    expect(sent).toMatchObject({
      chat: { id: owner.id, type: 'private' },
      from: { id: mock.botId, is_bot: true },
      text: 'Ada: a <b> & c 😀',
      entities: [{ type: 'bold', offset: 0, length: 3 }],
    });
    expect(mock.messages(owner.id)).toEqual([
      { message_id: sent.message_id, text: html, parse_mode: 'HTML', reply_markup: keyboard },
    ]);
    for (const broken of ['1 < 2', 'a & b', '<b>open', '<b>x</i>', '<span>x</span>']) {
      const error = await failure(bot.sendMessage(owner.id, broken));
      expect(error.code).toBe(400);
      expect(error.description).toMatch(/^Bad Request: can't parse entities: /);
    }
    const long = await failure(bot.sendMessage(owner.id, 'x'.repeat(4097)));
    expect(long.description).toBe('Bad Request: message is too long');
    // 4096 code points is fine even though it is 8192 UTF-16 units.
    expect((await bot.sendMessage(owner.id, '😀'.repeat(4096))).text).toHaveLength(8192);
    const empty = await failure(bot.sendMessage(owner.id, '<b> </b>'));
    expect(empty.description).toBe('Bad Request: message text is empty');
    const nowhere = await failure(bot.sendMessage(999, 'hi'));
    expect(nowhere.description).toBe('Bad Request: chat not found');
    expect(mock.messages(owner.id)).toHaveLength(2);
  });

  it('an edit that changes nothing answers "message is not modified"', async () => {
    mock.userSends(owner, 'hi');
    const sent = await bot.sendMessage(owner.id, '<i>one</i>');
    const same = await failure(bot.editMessageText(owner.id, sent.message_id, '<em>one</em>'));
    expect(same.code).toBe(400);
    expect(same.description).toMatch(/^Bad Request: message is not modified: /);
    const edited = await bot.editMessageText(owner.id, sent.message_id, 'two', {
      reply_markup: keyboard,
    });
    expect(edited).toMatchObject({ message_id: sent.message_id, text: 'two' });
    expect(mock.messages(owner.id)).toEqual([
      { message_id: sent.message_id, text: 'two', parse_mode: 'HTML', reply_markup: keyboard },
    ]);
    await bot.editMessageReplyMarkup(owner.id, sent.message_id, null);
    expect(mock.messages(owner.id)[0].reply_markup).toBeUndefined();
    await failure(bot.editMessageReplyMarkup(owner.id, sent.message_id, null));
    const missing = await failure(bot.editMessageText(owner.id, 999, 'x'));
    expect(missing.description).toBe('Bad Request: message to edit not found');
  });

  it('a draft shows until the bot sends a message to that chat', async () => {
    mock.userSends(owner, 'hi');
    expect(await bot.sendMessageDraft(owner.id, 7, '')).toBe(true);
    await bot.sendMessageDraft(owner.id, 7, 'thinking <b>hard</b>');
    expect(mock.draft(owner.id)).toEqual({ draft_id: 7, text: 'thinking <b>hard</b>' });
    const zero = await failure(bot.sendMessageDraft(owner.id, 0, 'x'));
    expect(zero.description).toBe('Bad Request: invalid draft_id');
    mock.userSends(owner, 'hello all', { chatId: -100, chatType: 'group' });
    const group = await failure(bot.sendMessageDraft(-100, 8, 'x'));
    expect(group.description).toBe('Bad Request: chat not found');
    await bot.sendMessage(owner.id, 'final');
    expect(mock.draft(owner.id)).toBeNull();
  });

  it('flood control answers 429 with retry_after 1, and the retry then goes through', async () => {
    mock.userSends(owner, 'hi');
    mock.floodLimit = 2;
    await bot.sendChatAction(owner.id);
    await bot.sendMessageDraft(owner.id, 1, 'a');
    const error = await failure(bot.sendMessage(owner.id, 'b'));
    expect([error.code, error.retryAfter, error.description]).toEqual([
      429,
      1,
      'Too Many Requests: retry after 1',
    ]);
    expect(error.transient).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(await bot.sendMessage(owner.id, 'b')).toMatchObject({ text: 'b' });
  });

  it('a wrong or revoked token answers 401 Unauthorized', async () => {
    const stranger = new TelegramBot(`${mock.botId}:${'A'.repeat(35)}`, { apiOrigin: mock.origin });
    const wrong = await failure(stranger.getMe());
    expect([wrong.code, wrong.description, wrong.unauthorized]).toEqual([
      401,
      'Unauthorized',
      true,
    ]);
    await bot.getMe();
    mock.revokeToken();
    const revoked = await failure(bot.getMe());
    expect([revoked.code, revoked.description, revoked.unauthorized]).toEqual([
      401,
      'Unauthorized',
      true,
    ]);
  });

  it('failNext fails the next call of that method once', async () => {
    mock.userSends(owner, 'hi');
    mock.failNext('sendMessage', {
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    mock.failNext('getMe', {
      error_code: 429,
      description: 'Too Many Requests: retry after 3',
      retry_after: 3,
    });
    const blocked = await failure(bot.sendMessage(owner.id, 'x'));
    expect([blocked.code, blocked.blocked]).toEqual([403, true]);
    expect(mock.messages(owner.id)).toEqual([]);
    await bot.sendMessage(owner.id, 'x');
    expect((await failure(bot.getMe())).retryAfter).toBe(3);
    await bot.getMe();
    expect(mock.calls.map((call) => [call.method, call.ok])).toEqual([
      ['sendMessage', false],
      ['sendMessage', true],
      ['getMe', false],
      ['getMe', true],
    ]);
  });

  it('delivers buttons, photos and group joins, and close answers a waiting poll', async () => {
    mock.userSends(owner, 'hi');
    const confirm = await bot.sendMessage(owner.id, 'Spend?', { reply_markup: keyboard });
    const queryId = mock.press(owner, owner.id, confirm.message_id, 'yes');
    const photoId = mock.sendPhoto(owner);
    mock.botAddedToGroup(owner, -2001);
    const updates = await bot.getUpdates(0, 0);
    expect(updates.slice(1)).toMatchObject([
      {
        callback_query: {
          id: queryId,
          data: 'yes',
          from: { id: owner.id },
          message: { message_id: confirm.message_id, text: 'Spend?' },
        },
      },
      { message: { message_id: photoId, chat: { id: owner.id } } },
      {
        my_chat_member: {
          chat: { id: -2001, type: 'group' },
          new_chat_member: { status: 'member' },
        },
      },
    ]);
    expect(updates[2].message?.text).toBeUndefined();
    expect(await bot.answerCallbackQuery(queryId)).toBe(true);
    expect((await failure(bot.answerCallbackQuery(queryId))).code).toBe(400);
    expect(await bot.sendMessage(-2001, 'hello group')).toMatchObject({ chat: { type: 'group' } });
    expect(await bot.leaveChat(-2001)).toBe(true);
    expect((await failure(bot.sendMessage(-2001, 'x'))).code).toBe(403);

    const pending = bot.getUpdates(updates[updates.length - 1].update_id + 1, 30);
    await mock.waitFor(() => mock.calls[mock.calls.length - 1].method === 'getUpdates');
    await mock.close();
    expect(await pending).toEqual([]);
  });
});

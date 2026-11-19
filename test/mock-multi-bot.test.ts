import { afterEach, describe, expect, it } from 'vitest';

import { startMockQq, type MockQq, type MockQqApp } from '../src/mock/qq.js';
import { startMockTelegram, type MockTelegram } from '../src/mock/telegram.js';
import { startMockWechat, type MockWechat } from '../src/mock/wechat.js';
import { QqApi, QqError, QqTokens } from '../src/relay/channels/qq-api.js';
import { QqGateway, type QqDispatch } from '../src/relay/channels/qq-gateway.js';
import { RelayStopped } from '../src/relay/channels/types.js';
import { WechatApi, WechatError, WechatLoginApi } from '../src/relay/channels/wechat-api.js';
import { TelegramBot, TelegramError } from '../src/relay/telegram.js';

/**
 * The Telegram, QQ and WeChat mocks serving several bots at once, driven by the relay's own
 * clients: each bot has its own token (or AppID, or ClawBot login), updates, cursor, chats and
 * failures, and what one bot is told never reaches another. Nothing reaches the network.
 */

const ada = { id: 5_550_001, first_name: 'Ada', language_code: 'en' };

const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** What a call fails with (or undefined when it does not). */
const failure = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (reason: unknown) => reason,
  );

describe('the Telegram mock with several bots', () => {
  async function twoBots() {
    const tg: MockTelegram = await startMockTelegram({ username: 'first_bot' });
    cleanup.push(() => tg.close());
    const second = tg.addBot({ username: 'second_bot', botId: 7_000_000_002 });
    const one = new TelegramBot(tg.token, { apiOrigin: tg.origin });
    const two = new TelegramBot(second.token, { apiOrigin: second.origin });
    return { tg, second, one, two };
  }

  it('routes by token: each bot answers as itself and keeps its own updates, chats and calls', async () => {
    const { tg, second, one, two } = await twoBots();
    expect(second.origin).toBe(tg.origin);
    expect(second.token.startsWith('7000000002:')).toBe(true);
    expect(tg.bots.map((bot) => bot.username)).toEqual(['first_bot', 'second_bot']);
    expect(await one.getMe()).toMatchObject({ id: tg.botId, username: 'first_bot' });
    expect(await two.getMe()).toMatchObject({ id: 7_000_000_002, username: 'second_bot' });

    // Both long polls wait at once: no 409 between different bots.
    const first = one.getUpdates(0, 5);
    const other = two.getUpdates(0, 5);
    await tg.waitFor(() => tg.calls.some((call) => call.method === 'getUpdates'));
    await second.waitFor(() => second.calls.some((call) => call.method === 'getUpdates'));
    const toSecond = second.userSends(ada, 'hello second');
    const [update] = await other;
    expect(update.message).toMatchObject({ message_id: toSecond, text: 'hello second' });
    const toFirst = tg.userSends(ada, 'hello first');
    const [firstUpdate] = await first;
    expect(firstUpdate.message).toMatchObject({ message_id: toFirst, text: 'hello first' });
    // Each private chat with Ada is that bot's own: its message ids, its messages.
    expect(toFirst).toBe(toSecond);
    await two.sendMessage(ada.id, 'from two');
    expect(tg.messages(ada.id)).toEqual([]);
    expect(second.messages(ada.id).map((message) => message.text)).toEqual(['from two']);
    expect(tg.calls.map((call) => call.method)).toEqual(['getMe', 'getUpdates']);
    expect(second.calls.map((call) => call.method)).toEqual(['getMe', 'getUpdates', 'sendMessage']);

    expect(() => tg.addBot({ username: 'third_bot', botId: 7_000_000_002 })).toThrow(/already/);
    expect(() => tg.addBot({ username: 'second_bot', botId: 7_000_000_003 })).toThrow(/already/);
  });

  it('a conflict, a failure or a revoked token stays with its bot', async () => {
    const { tg, second, one, two } = await twoBots();
    const waiting = failure(one.getUpdates(0, 10));
    await tg.waitFor(() => tg.calls.length === 1);
    const otherPoll = two.getUpdates(0, 10);
    await second.waitFor(() => second.calls.length === 1);
    // A second poller of the first bot ends only the first bot's poll.
    expect(await new TelegramBot(tg.token, { apiOrigin: tg.origin }).getUpdates(0, 0)).toEqual([]);
    expect(((await waiting) as TelegramError).conflict).toBe(true);
    second.userSends(ada, 'still here');
    expect((await otherPoll)[0].message?.text).toBe('still here');

    second.failNext('getMe', { error_code: 500, description: 'Internal Server Error' });
    expect(await one.getMe()).toMatchObject({ id: tg.botId });
    expect(((await failure(two.getMe())) as TelegramError).code).toBe(500);

    // A wrong token with the second bot's id is the second bot's call.
    const stranger = new TelegramBot(`7000000002:${'A'.repeat(35)}`, { apiOrigin: tg.origin });
    expect(((await failure(stranger.getMe())) as TelegramError).unauthorized).toBe(true);
    expect(second.calls.at(-1)).toMatchObject({
      method: 'getMe',
      ok: false,
      error: 'Unauthorized',
    });

    // BotFather's /revoke: a new token for the same bot; the old one is refused.
    const old = second.token;
    const renewed = second.rotateToken();
    expect(renewed).not.toBe(old);
    expect(renewed.startsWith('7000000002:')).toBe(true);
    expect(((await failure(two.getMe())) as TelegramError).unauthorized).toBe(true);
    const again = new TelegramBot(renewed, { apiOrigin: tg.origin });
    expect(await again.getMe()).toMatchObject({ id: 7_000_000_002 });
    expect(await one.getMe()).toMatchObject({ id: tg.botId });
    tg.revokeToken();
    expect(((await failure(one.getMe())) as TelegramError).unauthorized).toBe(true);
    expect(await again.getMe()).toMatchObject({ id: 7_000_000_002 });
  });

  it('close answers every waiting poll', async () => {
    const tg = await startMockTelegram();
    const second = tg.addBot({ username: 'late_bot', botId: 7_000_000_009 });
    const one = new TelegramBot(tg.token, { apiOrigin: tg.origin }).getUpdates(0, 30);
    const two = new TelegramBot(second.token, { apiOrigin: tg.origin }).getUpdates(0, 30);
    await tg.waitFor(() => tg.calls.length === 1);
    await second.waitFor(() => second.calls.length === 1);
    await tg.close();
    expect(await one).toEqual([]);
    expect(await two).toEqual([]);
  });
});

describe('the QQ mock with several bots', () => {
  const apiFor = (app: MockQqApp, secret = app.secret) =>
    new QqApi(new QqTokens({ appId: app.appId, secret, origin: app.origin }), app.origin);

  /** A gateway of `app` with quick timings: its dispatches, its READYs, how it ended. */
  function gateway(app: MockQqApp) {
    const controller = new AbortController();
    const events: QqDispatch[] = [];
    const readies: boolean[] = [];
    const gate = new QqGateway({
      api: apiFor(app),
      signal: controller.signal,
      log: () => undefined,
      dispatch: (event) => events.push(event),
      ready: (info) => readies.push(info.resumed),
      session: null,
      timings: {
        backoffMinMs: 20,
        backoffMaxMs: 100,
        identifyIntervalMs: 0,
        invalidSessionDelayMs: () => 20,
        resumedTimeoutMs: 1000,
      },
    });
    const done = gate.run().then(
      () => null,
      (error: unknown) => error,
    );
    cleanup.push(async () => {
      controller.abort();
      await done;
    });
    return { events, readies, done };
  }

  async function twoApps(second: Parameters<MockQq['addApp']>[0] = {}) {
    const qq = await startMockQq({ heartbeatMs: 80 });
    cleanup.push(() => qq.shutdown());
    const other = qq.addApp({ botName: 'Second QQ bot', ...second });
    return { qq, other };
  }

  it('gives each AppID its own tokens, identity, friends and calls', async () => {
    const { qq, other } = await twoApps({ appId: '102000222' });
    expect(other.origin).toBe(qq.origin);
    expect(qq.apps.map((app) => app.appId)).toEqual(['102000001', '102000222']);
    expect(qq.addApp().appId).toBe('102000002');
    expect(() => qq.addApp({ appId: '102000222' })).toThrow(/already/);
    const one = apiFor(qq);
    const two = apiFor(other);
    expect(await one.me()).toMatchObject({ id: qq.botId, username: 'Lin QQ bot' });
    expect(await two.me()).toMatchObject({ id: other.botId, username: 'Second QQ bot' });
    expect(other.botId).not.toBe(qq.botId);
    // The first bot's secret is not the second's.
    const wrong = await failure(apiFor(other, qq.secret).me());
    expect(wrong).toBeInstanceOf(QqError);
    expect(other.calls.at(-1)).toMatchObject({ path: '/app/getAppAccessToken', code: 100016 });
    expect(qq.calls.map((call) => call.path)).toEqual(['/app/getAppAccessToken', '/users/@me']);

    // An openid is a friend of the bot it wrote to only.
    other.userSends('OPENID_B', 'hi');
    expect(await two.send('OPENID_B', { content: 'hello', msg_type: 0 })).toMatchObject({
      id: expect.any(String),
    });
    expect(other.messages('OPENID_B').map((message) => message.text)).toEqual(['hello']);
    expect(await failure(one.send('OPENID_B', { content: 'hello', msg_type: 0 }))).toMatchObject({
      code: 40054004,
    });
    expect(qq.messages('OPENID_B')).toEqual([]);
    other.failNext('me', { code: 500 });
    expect(await one.me()).toMatchObject({ id: qq.botId });
    expect(await failure(two.me())).toMatchObject({ code: 500 });

    // Resetting one bot's secret leaves the other bot's tokens working.
    qq.resetSecret();
    expect(await two.me()).toMatchObject({ id: other.botId });
    // A call with a token the reset revoked is still that bot's call, the first bot's or not.
    const token = await two.tokens.get();
    const firstCalls = qq.calls.length;
    const otherCalls = other.calls.length;
    other.resetSecret();
    const stale = await fetch(`${other.origin}/users/@me`, {
      headers: { Authorization: `QQBot ${token}` },
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ code: 11244 });
    expect(other.calls.slice(otherCalls)).toEqual([
      expect.objectContaining({ path: '/users/@me', code: 11244 }),
    ]);
    expect(qq.calls.length).toBe(firstCalls);
  });

  it('keeps one live session per bot: each gets its own events, closes and day’s starts', async () => {
    const { qq, other } = await twoApps({
      sessionLimit: { remaining: 2, resetAfterMs: 86_400_000 },
    });
    const first = gateway(qq);
    const second = gateway(other);
    await qq.waitFor(() => first.readies.length === 1 && second.readies.length === 1);
    expect([qq.identifies, other.identifies]).toEqual([1, 1]);
    expect([qq.sockets, other.sockets]).toEqual([1, 1]);
    // Each bot spent one of its own day's starts.
    expect((await apiFor(qq).gatewayBot()).session_start_limit?.remaining).toBe(999);
    expect((await apiFor(other).gatewayBot()).session_start_limit?.remaining).toBe(1);

    const toSecond = other.userSends('OPENID_B', 'for the second bot');
    await qq.waitFor(() => second.events.length === 1);
    expect(second.events[0]).toMatchObject({ t: 'C2C_MESSAGE_CREATE', d: { id: toSecond } });
    expect(first.events).toEqual([]);

    // A drop of the first bot's socket: only it resumes.
    qq.drop();
    await qq.waitFor(() => first.readies.length === 2);
    expect(first.readies).toEqual([false, true]);
    expect(second.readies).toEqual([false]);
    expect([qq.resumes, other.resumes]).toEqual([1, 0]);

    // The second bot's own close ends only the second gateway.
    other.close(4914);
    expect(await second.done).toBeInstanceOf(RelayStopped);
    expect(await qq.waitFor(() => qq.sockets === 1)).toBe(true);
    const toFirst = qq.userSends('OPENID_A', 'for the first bot');
    await qq.waitFor(() => first.events.length === 1);
    expect(first.events[0]).toMatchObject({ d: { id: toFirst } });
    expect(other.identifies).toBe(1);

    // The second bot out of starts: its new gateway waits for the next day, while the first
    // bot, told its session is gone, identifies again.
    other.setSessionLimit(0, 86_400_000);
    const waiting = other.calls.length;
    const refused = gateway(other);
    await qq.waitFor(() => other.calls.slice(waiting).some((call) => call.path === '/gateway/bot'));
    qq.invalidSession(false);
    await qq.waitFor(() => qq.identifies === 2 && first.readies.length === 3);
    expect(first.readies).toEqual([false, true, false]);
    expect(other.identifies).toBe(1);
    expect(refused.readies).toEqual([]);
  });

  it('closes 4014 for a bot without private chats while the others run', async () => {
    const { qq, other } = await twoApps({ c2c: false });
    const first = gateway(qq);
    await qq.waitFor(() => first.readies.length === 1);
    const closed = gateway(other);
    expect(await closed.done).toMatchObject({ reason: 'intents' });
    expect(other.identifies).toBe(0);
    qq.userSends('OPENID_A', 'still connected');
    await qq.waitFor(() => first.events.length === 1);
    expect(first.readies).toEqual([false]);
  });
});

describe('the WeChat mock with several ClawBots', () => {
  async function mock() {
    const wx = await startMockWechat({ longPollMs: 100, qrPollMs: 100 });
    cleanup.push(() => wx.close());
    return wx;
  }

  /** One QR login: the code (with these tokens kept), the phone confirming `botId`. */
  async function scan(wx: MockWechat, botId: string | undefined, localTokens: string[] = []) {
    const login = new WechatLoginApi(wx.origin);
    const code = await login.qrCode(localTokens);
    wx.confirm(botId ? { botId } : {});
    return login.qrStatus(wx.origin, code.qrcode, '');
  }

  const botApi = (wx: MockWechat, token: string) =>
    new WechatApi({
      baseUrl: wx.origin,
      botToken: token,
      cdnBaseUrl: `${wx.origin}/c2c`,
      loopback: true,
    });

  const poll = (api: WechatApi, cursor = '') =>
    api.getUpdates(cursor, 1000, new AbortController().signal);

  const ids = (answer: Awaited<ReturnType<typeof poll>>) =>
    answer.msgs?.map((message) => String(message.message_id));

  const say = (api: WechatApi, to: string, contextToken: string, text: string) =>
    api.sendMessage({
      to_user_id: to,
      client_id: `yomi-${Math.random()}`,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    });

  it('links a second ClawBot to the same account: its own token, messages, cursor and context', async () => {
    const wx = await mock();
    const first = await scan(wx, 'b1_first@im.bot');
    const second = await scan(wx, 'b2_second@im.bot', [first.bot_token!]);
    expect(first).toMatchObject({ status: 'confirmed', ilink_bot_id: 'b1_first@im.bot' });
    expect(second).toMatchObject({
      status: 'confirmed',
      ilink_bot_id: 'b2_second@im.bot',
      ilink_user_id: wx.owner,
    });
    expect(second.bot_token).not.toBe(first.bot_token);
    expect(wx.botId).toBe('b2_second@im.bot');
    expect(wx.clawBots()).toEqual([
      { botId: 'b1_first@im.bot', userId: wx.owner, live: true },
      { botId: 'b2_second@im.bot', userId: wx.owner, live: true },
    ]);
    const one = botApi(wx, first.bot_token!);
    const two = botApi(wx, second.bot_token!);

    // The newest ClawBot by default; another by name.
    const toSecond = wx.userSends('to the second');
    const toFirst = wx.userSends('to the first', { bot: 'b1_first@im.bot' });
    const seenByOne = await poll(one);
    const seenByTwo = await poll(two);
    // The client reads iLink's uint64 ids exactly, as strings.
    expect(ids(seenByOne)).toEqual([String(toFirst)]);
    expect(seenByOne.msgs?.[0]).toMatchObject({ to_user_id: 'b1_first@im.bot' });
    expect(ids(seenByTwo)).toEqual([String(toSecond)]);
    // Each cursor goes on from where that ClawBot was.
    const later = wx.userSends('later', { bot: 'b1_first@im.bot' });
    expect(ids(await poll(one, seenByOne.get_updates_buf))).toEqual([String(later)]);
    expect((await poll(two, seenByTwo.get_updates_buf)).msgs).toEqual([]);

    // A context_token works only for the ClawBot that received the message.
    const refused = await failure(say(two, wx.owner, wx.contextOf(toFirst), 'wrong bot'));
    expect(refused).toBeInstanceOf(WechatError);
    expect(refused).toMatchObject({ code: -2 });
    await say(one, wx.owner, wx.contextOf(toFirst), 'right bot');
    await say(two, wx.owner, wx.contextOf(toSecond), 'second bot');
    expect(wx.texts()).toEqual(['right bot', 'second bot']);
    expect(wx.texts(wx.owner, 'b1_first@im.bot')).toEqual(['right bot']);
    expect(wx.messages(wx.owner, 'b2_second@im.bot').map((message) => message.bot)).toEqual([
      'b2_second@im.bot',
    ]);

    // Typing tickets are per ClawBot too: another ClawBot's ticket is refused (in the body only,
    // which the client does not read) and shows no typing.
    const ticket = await one.getConfig(wx.owner, '');
    await one.sendTyping(wx.owner, ticket, 1);
    await two.sendTyping(wx.owner, ticket, 1);
    expect(wx.typing()).toEqual([
      { user: wx.owner, status: 1, at: expect.any(Number), bot: 'b1_first@im.bot' },
    ]);
    const raw = await fetch(`${wx.origin}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${second.bot_token!}`,
      },
      body: JSON.stringify({ ilink_user_id: wx.owner, typing_ticket: ticket, status: 1 }),
    });
    expect(raw.status).toBe(200);
    expect(await raw.json()).toMatchObject({ ret: -1 });
    expect(wx.typing()).toHaveLength(1);
  });

  it('replays the last batch of the ClawBot named, and of the first to poll when none is', async () => {
    const wx = await mock();
    const first = await scan(wx, 'b1_first@im.bot');
    const second = await scan(wx, 'b2_second@im.bot', [first.bot_token!]);
    const one = botApi(wx, first.bot_token!);
    const two = botApi(wx, second.bot_token!);
    const m1 = wx.userSends('one', { bot: 'b1_first@im.bot' });
    const m2 = wx.userSends('two', { bot: 'b2_second@im.bot' });
    const a1 = await poll(one);
    const a2 = await poll(two);
    expect(ids(a1)).toEqual([String(m1)]);
    expect(ids(a2)).toEqual([String(m2)]);

    wx.replayNextBatch('b2_second@im.bot');
    expect((await poll(one, a1.get_updates_buf)).msgs).toEqual([]);
    const r2 = await poll(two, a2.get_updates_buf);
    expect(ids(r2)).toEqual([String(m2)]);
    expect(r2.get_updates_buf).toBe(a2.get_updates_buf);
    expect((await poll(two, r2.get_updates_buf)).msgs).toEqual([]);

    // Without a bot: one replay, to whichever ClawBot polls first.
    wx.replayNextBatch();
    const r1 = await poll(one, a1.get_updates_buf);
    expect(ids(r1)).toEqual([String(m1)]);
    expect(r1.get_updates_buf).toBe(a1.get_updates_buf);
    expect((await poll(two, a2.get_updates_buf)).msgs).toEqual([]);
  });

  it('answers binded_redirect for a ClawBot this computer holds, and renews only the one logged in again', async () => {
    const wx = await mock();
    const first = await scan(wx, 'b1_first@im.bot');
    const second = await scan(wx, 'b2_second@im.bot', [first.bot_token!]);
    const held = [first.bot_token!, second.bot_token!];
    // Scanning either linked ClawBot with both tokens held: bound, naming no bot, no new token.
    for (const id of ['b1_first@im.bot', 'b2_second@im.bot']) {
      const again = await scan(wx, id, held);
      expect(again.status).toBe('binded_redirect');
      expect(again.bot_token).toBeFalsy();
      expect(again.ilink_bot_id).toBeFalsy();
    }
    expect(wx.localTokens.at(-1)).toEqual(held);
    // A third ClawBot with the same tokens held: linked.
    const third = await scan(wx, 'b3_third@im.bot', held);
    expect(third).toMatchObject({ status: 'confirmed', ilink_bot_id: 'b3_third@im.bot' });

    // -14 and a revoked token stay with their ClawBot.
    const one = botApi(wx, first.bot_token!);
    const two = botApi(wx, second.bot_token!);
    wx.expireSession(1, 'b2_second@im.bot');
    expect(await poll(one)).toMatchObject({ ret: 0 });
    expect(await poll(two)).toMatchObject({ ret: -14 });
    expect(await poll(two)).toMatchObject({ ret: 0 });
    wx.revokeTokens('b1_first@im.bot');
    expect(await failure(poll(one))).toMatchObject({ status: 401 });
    expect(await poll(two)).toMatchObject({ ret: 0 });
    expect(wx.clawBots().map((bot) => bot.live)).toEqual([false, true, true]);

    // Logged in again (its token no longer works): a new token for that ClawBot only.
    const renewed = await scan(wx, 'b1_first@im.bot', [first.bot_token!]);
    expect(renewed).toMatchObject({ status: 'confirmed', ilink_bot_id: 'b1_first@im.bot' });
    expect(renewed.bot_token).not.toBe(first.bot_token);
    const back = botApi(wx, renewed.bot_token!);
    wx.userSends('after renewal', { bot: 'b1_first@im.bot' });
    expect((await poll(back)).msgs?.map((message) => message.item_list)).toEqual([
      [{ type: 1, text_item: { text: 'after renewal' } }],
    ]);
    expect(await poll(two)).toMatchObject({ ret: 0 });
    // Without a bot id the ClawBot of the latest login gets a new token, even with it held.
    expect(wx.botId).toBe('b1_first@im.bot');
    const latest = await scan(wx, undefined, [renewed.bot_token!, ...held.slice(1)]);
    expect(latest).toMatchObject({ status: 'confirmed', ilink_bot_id: 'b1_first@im.bot' });
    expect(await failure(poll(back))).toMatchObject({ status: 401 });
    expect(await poll(botApi(wx, latest.bot_token!))).toMatchObject({ ret: 0 });
    expect(await poll(botApi(wx, third.bot_token!))).toMatchObject({ ret: 0 });
    expect(await poll(two)).toMatchObject({ ret: 0 });
  });
});

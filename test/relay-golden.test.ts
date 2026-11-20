import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { chatImageStore, type MockChatImage } from '../src/mock/gen/chatImage.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import {
  type MockBotCall,
  type MockTelegram,
  type MockTelegramBot,
  type MockTelegramUser,
  startMockTelegram,
} from '../src/mock/telegram.js';
import { RelayStopped } from '../src/relay/channels/types.js';
import { type HubBot, RelayHub } from '../src/relay/hub/hub.js';
import { PairingCode } from '../src/relay/pairing.js';
import { Relay } from '../src/relay/relay.js';
import { RelayState, relayStatePath } from '../src/relay/state.js';
import { TelegramBot } from '../src/relay/telegram.js';
import { memoryIo } from './helpers/io.js';

/**
 * The golden transcript of `yomi relay --telegram`: one scripted session against the mock gateway
 * and the mock Bot API (pairing and its welcome, a chat with a single character, /character in a
 * bot bound to it, a group character on a second bot, /price, /budget with a press, /report with a
 * press, /image, /stop, a stale message, a non-text message, an unknown command, the bot added to a
 * group, a second poller's 409), and a snapshot of what the relay said, call for call. Taken before
 * the channel refactor, it must not change through it; the welcome at pairing (the character's
 * cover, introduction and opening) came later, and so did one character per bot: the menu and the
 * pairing leave /character out, /character says how to change it on the computer, and the group
 * character is the second bot's (its calls under `bot@bot2`, its chat under `owner@bot2`). Both
 * bots run as every `yomi relay` runs them: two records of one `RelayHub` (one long connection
 * routed by character, one shared ledger under the hub's `--max-spend`), the 409 stopping the
 * first bot alone.
 *
 * Only what is deterministic is in the snapshot: per chat, in order, `sendMessage`, `sendPhoto`,
 * `answerCallbackQuery` and `editMessageReplyMarkup`, plus `getWebhookInfo` and `setMyCommands`,
 * with message ids, callback ids, button nonces, draft ids, update ids, dates and
 * `client_request_id` replaced by placeholders; a photo carries the type and size of the picture
 * Telegram got. Left out because timing decides how many there are: `getUpdates`,
 * `sendChatAction`, `sendMessageDraft`, the edit path's `editMessageText` / `deleteMessage`, and
 * the terminal output. What of them is fixed in this session (drafts on, so no edit path and no
 * typing) is checked apart: the set of methods used, no refused call but the 409, one
 * `upload_photo` action, and the drafts' shape. The script sends no server aside: the relay
 * forwards those without waiting, so they could land anywhere in the order.
 */

let mock: MockServer;
let tg: MockTelegram;
/** The second bot, bound to the group character. */
let tg2: MockTelegramBot;
let dir: string;
const saved: Record<string, string | undefined> = {};
const owner: MockTelegramUser = { id: 5570001, first_name: 'Lin', language_code: 'zh-hans' };
const stranger: MockTelegramUser = { id: 5570999, first_name: 'Eve' };
const GROUP_CHAT = -100777;
const CHATS = new Map([
  [owner.id, 'owner'],
  [stranger.id, 'stranger'],
  [GROUP_CHAT, 'group'],
]);

/** Kept in the snapshot, per chat. */
const CHAT_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'answerCallbackQuery',
  'editMessageReplyMarkup',
]);
/** Kept in the snapshot, apart from any chat. */
const BOT_METHODS = new Set(['getWebhookInfo', 'setMyCommands']);

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}

/** The web authorize page's part of `yomi login`, as the e2e test does it. */
async function signIn() {
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  const link = new URL(url);
  const params = new URLSearchParams(link.hash.slice(1));
  const page = await (await fetch(link.origin + link.pathname)).text();
  const form = [...page.matchAll(/<form method="POST" data-kind="(\w+)">([\s\S]*?)<\/form>/g)].find(
    (match) => match[1] === 'authorize',
  )!;
  const fields = Object.fromEntries(
    [...form[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  fields.state = params.get('state') ?? '';
  await fetch(`http://127.0.0.1:${params.get('port')}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: mock.origin },
    body: new URLSearchParams(fields).toString(),
  });
  expect(await pending).toBe(0);
}

const images = (): MockChatImage => chatImageStore(mock.gen);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for one more bot message matching `pattern` in `chatId` than now; call before acting. */
function expectNew(chatId: number, pattern: RegExp, bot: MockTelegramBot = tg) {
  const matching = () => bot.messages(chatId).filter((message) => pattern.test(message.text));
  const before = matching().length;
  return () => bot.waitFor(() => matching().length > before && matching().at(-1), 8000);
}

/**
 * The snapshotted calls. A message id becomes the place of that message among the bot's messages
 * (or photos) in its chat, so a button removal names the prompt it belongs to; callback ids and
 * button nonces are numbered in order of appearance.
 */
function transcript(
  calls: MockBotCall[],
  presses: Map<string, number>,
  bot: MockTelegramBot = tg,
  suffix = '',
) {
  const numbered = new Map<string, string>();
  const counts = new Map<string, number>();
  const number = (kind: string, value: string) => {
    const key = `${kind}:${value}`;
    let label = numbered.get(key);
    if (!label) {
      const count = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, count);
      label = `<${kind} ${count}>`;
      numbered.set(key, label);
    }
    return label;
  };
  const messageLabel = (chatId: number, id: unknown) => {
    const message = bot.messages(chatId).findIndex((item) => item.message_id === Number(id));
    if (message >= 0) return `<message ${message + 1}>`;
    const photo = bot.photos(chatId).findIndex((item) => item.message_id === Number(id));
    return photo >= 0 ? `<photo ${photo + 1}>` : '<message id>';
  };
  const scrub = (value: unknown, chatId: number, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((item) => scrub(item, chatId));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, scrub(item, chatId, name)]),
      );
    switch (key) {
      case 'message_id':
        return messageLabel(chatId, value);
      case 'callback_query_id':
        return number('callback', String(value));
      case 'callback_data':
        // Only the nonce varies: whatever follows it stays as sent.
        return String(value).replace(/^[^:]*/, (nonce) => number('nonce', nonce));
      case 'draft_id':
        return '<draft id>';
      case 'update_id':
        return '<update id>';
      case 'date':
        return '<date>';
      case 'client_request_id':
        return '<client_request_id>';
      default:
        return value;
    }
  };
  /** The picture an accepted `sendPhoto` uploaded (its name holds a task id, so it is left out). */
  const uploads = new Map<number, number>();
  const upload = (call: MockBotCall, chatId: number) => {
    if (call.method !== 'sendPhoto' || !call.ok) return {};
    const index = uploads.get(chatId) ?? 0;
    uploads.set(chatId, index + 1);
    const photo = bot.photos(chatId)[index];
    return { photo: photo ? { type: photo.mime, width: photo.width, height: photo.height } : null };
  };
  const entry = (call: MockBotCall, chatId: number) => ({
    method: call.method,
    params: scrub(call.params, chatId),
    ...upload(call, chatId),
    ...(call.ok ? {} : { error: call.error }),
  });
  const botCalls: unknown[] = [];
  const chats = new Map<string, unknown[]>();
  for (const call of calls) {
    if (BOT_METHODS.has(call.method)) botCalls.push(entry(call, 0));
    if (!CHAT_METHODS.has(call.method)) continue;
    const chatId =
      call.method === 'answerCallbackQuery'
        ? (presses.get(String(call.params.callback_query_id)) ?? 0)
        : Number(call.params.chat_id);
    const name = (CHATS.get(chatId) ?? String(chatId)) + suffix;
    chats.set(name, [...(chats.get(name) ?? []), entry(call, chatId)]);
  }
  return { bot: botCalls, chats: Object.fromEntries(chats) };
}

beforeAll(async () => {
  mock = await startMockServer();
  tg = await startMockTelegram({ username: 'lin_golden_bot' });
  tg2 = tg.addBot({ username: 'fog_golden_bot', botId: 8_123_456_790 });
  dir = mkdtempSync(join(tmpdir(), 'yomi-relay-golden-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_TELEGRAM_API_ORIGIN: tg.origin,
    YOMI_CONFIG_DIR: dir,
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
  mock.state.relayPolicy = { enabled: true, features: { free_only: true, spend_cap: true } };
  // Every reply is free, the balance never moves, the first picture is free.
  mock.state.chatFreeLimit = 1000;
  mock.state.gems = 500;
  images().config.freeLeft = 1;
  await signIn();
});

afterAll(async () => {
  await tg.close();
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the relay, golden transcript', () => {
  let controller: AbortController;
  let done: Promise<unknown> = Promise.resolve();
  /** Each bot's relay of its current run, by name. */
  const engines = new Map<string, Relay>();

  const busy = (which: Relay) => {
    const inside = which as unknown as { job: unknown; turn: unknown };
    return Boolean(inside.job || inside.turn);
  };
  const kept = (which: Relay) => (which as unknown as { keptImage(): unknown }).keptImage();
  /** Nothing in flight: the reply (or picture) is shown and booked. */
  const idle = (which: Relay) => tg.waitFor(() => !busy(which) && kept(which) === null, 8000);

  afterAll(async () => {
    controller?.abort();
    await done.catch(() => undefined);
  });

  it('says the same things, in the same order, call for call', async () => {
    const context = createContext(
      memoryIo().io,
      {},
      { client: 'relay-telegram', channel: 'cli_relay' },
    );
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    /** A record of the registry's kind: one bot, bound to one character. */
    const hubBot = (
      mockBot: MockTelegramBot,
      character: { npcId: string; name: string; group: boolean },
      pairing: PairingCode,
    ): HubBot & { state: RelayState } => {
      const bot = new TelegramBot(mockBot.token, { apiOrigin: mockBot.origin });
      const state = new RelayState(relayStatePath(context.account, bot.id), bot.id);
      return {
        name: mockBot.username,
        state,
        run: async (services, signal) => {
          const engine = new Relay(context.gateway, bot, state, {
            maxSpend: 50,
            characterId: '',
            boundCharacter: character,
            botName: mockBot.username,
            hub: services,
            pairing,
            replyTimeoutMs: 1500,
            intervalMs: 30,
            staleMs: 10 * 60 * 1000,
            pollTimeoutSeconds: 1,
            drafts: true,
            language: 'zh-Hans',
            log,
            resumeCheckMs: 100,
            imagePollMs: 100,
            imageTimeoutMs: 4000,
          });
          engines.set(mockBot.username, engine);
          await engine.run(signal);
        },
      };
    };
    const pairing = new PairingCode();
    const secondPairing = new PairingCode();
    const lin = hubBot(tg, { npcId: MOCK_NPCS.single, name: '林夏', group: false }, pairing);
    const fog = hubBot(tg2, { npcId: MOCK_NPCS.group, name: '雾港', group: true }, secondPairing);
    const state = lin.state;
    // The 409 stops the first bot alone: the hub says so, and the second bot goes on.
    let conflict: (error: Error | null) => void = () => undefined;
    const ended = new Promise<Error | null>((resolve) => {
      conflict = resolve;
    });
    const stops: string[] = [];
    const hub = new RelayHub(context.gateway, {
      account: context.account,
      log,
      maxSpend: 50,
      ledgerBots: [],
      onStopped: (name, error) => {
        stops.push(name);
        if (name === tg.username) conflict(error);
      },
      resumeCheckMs: 100,
    });
    controller = new AbortController();
    const sockets = mock.state.sockets;
    const polls = (bot: MockTelegramBot) =>
      bot.calls.filter((call) => call.method === 'getUpdates').length;
    done = hub.run([lin, fog], controller.signal);
    await tg.waitFor(() => mock.state.sockets > sockets && polls(tg) > 0 && polls(tg2) > 0);
    const relay = engines.get(tg.username)!;
    const presses = new Map<string, number>();
    const press = (messageId: number, data: string) =>
      presses.set(tg.press(owner, owner.id, messageId, data), owner.id);

    // Pairing: a wrong code (never valid: 0 is not in the alphabet), then the owner's, welcomed
    // with the AI notice, 林夏's cover, her introduction and her opening.
    let next = expectNew(stranger.id, /配对码不对/);
    tg.userSends(stranger, '/start 00000000');
    await next();
    next = expectNew(owner.id, /你来了。/);
    tg.userSends(owner, `/start ${pairing.code}`);
    await next();
    expect(state.data.owner?.userId).toBe(owner.id);
    // Saved once its last message is out.
    await tg.waitFor(() => state.data.greeted.length > 0);
    expect(state.data.greeted).toEqual([MOCK_NPCS.single]);
    expect(tg.photos(owner.id)).toHaveLength(1);

    // Once paired, a stranger gets nothing (the owner's reply below shows it was handled).
    tg.userSends(stranger, '你好，在吗');

    // A chat with the single character: the reply (the welcome gave the AI notice).
    next = expectNew(owner.id, /今天天气怎么样？/);
    tg.userSends(owner, '今天天气怎么样');
    await next();
    await idle(relay);

    // The bot talks as 林夏 only: /character says how to change that on the computer.
    next = expectNew(owner.id, /固定和「林夏」聊天/);
    tg.userSends(owner, `/character ${MOCK_NPCS.group}`);
    await next();

    // A group character is a second bot's: paired and welcomed (notice, cover, introduction,
    // opening), then a reply naming its speakers.
    next = expectNew(owner.id, /新来的？/, tg2);
    tg2.userSends(owner, `/start ${secondPairing.code}`);
    await next();
    next = expectNew(owner.id, /<b>小白<\/b>/, tg2);
    tg2.userSends(owner, '大家好');
    await next();
    await idle(engines.get(tg2.username)!);
    // The last reply in the first bot is 林夏's: /report and /image below name it.
    const lastReply = tg
      .messages(owner.id)
      .filter((message) => /今天天气怎么样？/.test(message.text))
      .at(-1)!;

    // /price, then /budget confirmed with its button.
    next = expectNew(owner.id, /本机上限 50 钻石/);
    tg.userSends(owner, '/price');
    await next();
    next = expectNew(owner.id, /最多花 20 钻石吗/);
    tg.userSends(owner, '/budget 20');
    const ask = await next();
    const budgetButtons = ask.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    next = expectNew(owner.id, /已设置预算 20 钻石/);
    press(ask.message_id, budgetButtons.inline_keyboard[0][0].callback_data);
    await next();
    expect(state.data.billing).toMatchObject({ mode: 'paid', budget: 20 });

    // /report on the last reply, with the first reason.
    next = expectNew(owner.id, /选择举报原因/);
    tg.userSends(owner, '/report');
    const pick = await next();
    const reasons = pick.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    next = expectNew(owner.id, /已提交，谢谢反馈/);
    press(pick.message_id, reasons.inline_keyboard[0][0].callback_data);
    await next();
    // The report names the reply the owner saw last in this bot, with the reason pressed.
    const reportedMid = state.replyMid(lastReply.message_id);
    expect(reportedMid).not.toBe('');
    const feedback = mock.state.feedback.at(-1);
    expect(String(feedback?.entity_id)).toBe(MOCK_NPCS.single);
    expect(String(feedback?.mid)).toBe(reportedMid);
    expect(feedback?.tag_keys).toEqual(['sexual_minor']);

    // /image: a free picture of the last reply, uploaded as a photo.
    next = expectNew(owner.id, /正在生成图片（免费）/);
    tg.userSends(owner, '/image');
    await next();
    await tg.waitFor(() => tg.photos(owner.id).length === 2, 8000);
    await idle(relay);

    // /stop while a slow reply streams; once it has ended, /stop has nothing to stop.
    next = expectNew(owner.id, /已停止转发这条回复/);
    tg.userSends(owner, 'SLOW 很长的故事');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    tg.userSends(owner, '/stop');
    await next();
    await idle(relay);
    next = expectNew(owner.id, /现在没有正在转发的回复/);
    tg.userSends(owner, '/stop');
    await next();

    // A message sent while the relay was off, one without text, a command it does not know.
    next = expectNew(owner.id, /relay 离线时发的/);
    tg.userSends(owner, '昨天的话', { date: Math.floor(Date.now() / 1000) - 3600 });
    await next();
    next = expectNew(owner.id, /只支持文字消息/);
    tg.sendPhoto(owner);
    await next();
    next = expectNew(owner.id, /不认识这个命令/);
    tg.userSends(owner, '/whatever');
    await next();

    // Added to a group, it leaves.
    tg.botAddedToGroup(owner, GROUP_CHAT);
    await tg.waitFor(() =>
      tg.calls.some((call) => call.method === 'leaveChat' && call.params.chat_id === GROUP_CHAT),
    );

    // A second poller (Telegram 409) stops it. It may poll between two long polls of the relay,
    // which then sees nothing: it polls again until the relay has stopped.
    let stopped = false;
    void ended.then(() => {
      stopped = true;
    });
    while (!stopped) {
      const other = new TelegramBot(tg.token, { apiOrigin: tg.origin });
      await other.getUpdates(-1, 0).catch(() => undefined);
      await sleep(50);
    }
    const error = await ended;
    expect(error).toBeInstanceOf(RelayStopped);
    expect((error as RelayStopped).reason).toBe('conflict');
    // The first bot stopped alone: the second one still runs until the hub is stopped.
    expect(stops).toEqual([tg.username]);
    controller.abort();
    expect(await done).toBe('aborted');
    expect(stops).toEqual([tg.username]);

    const calls = (method: string) => tg.calls.filter((call) => call.method === method);
    // Every method used. Any other is a change: an edit or a delete (drafts never need one), a
    // webhook change, another kind of file.
    expect([...new Set(tg.calls.map((call) => call.method))].sort()).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
      'getMe',
      'getUpdates',
      'getWebhookInfo',
      'leaveChat',
      'sendChatAction',
      'sendMessage',
      'sendMessageDraft',
      'sendPhoto',
      'setMyCommands',
    ]);
    // Telegram refused nothing but the relay's long poll the second poller ended.
    expect(tg.calls.filter((call) => !call.ok).map((call) => [call.method, call.error])).toEqual([
      ['getUpdates', expect.stringMatching(/^Conflict/)],
    ]);
    // Drafts on: no typing keep-alive, only "sending a photo" before the /image picture (none
    // before the welcome's cover).
    expect(calls('sendChatAction').map((call) => call.params)).toEqual([
      { chat_id: owner.id, action: 'upload_photo' },
    ]);
    expect(calls('leaveChat').map((call) => call.params)).toEqual([{ chat_id: GROUP_CHAT }]);

    // The second bot: nothing refused, no typing, no group left.
    const secondMethods = (method: string) => tg2.calls.filter((call) => call.method === method);
    expect(tg2.calls.filter((call) => !call.ok)).toEqual([]);
    expect(secondMethods('sendChatAction')).toEqual([]);
    expect(secondMethods('leaveChat')).toEqual([]);

    // Drafts: how many depends on timing. Each streamed reply (林夏's and the slow one in the
    // first bot, the group's in the second) opens with an empty "Thinking…" draft; each draft is
    // in the owner's chat with the Stop button, and one with text is HTML.
    for (const [drafts, count] of [
      [calls('sendMessageDraft'), 2],
      [secondMethods('sendMessageDraft'), 1],
    ] as const) {
      const draftIds = [...new Set(drafts.map((call) => call.params.draft_id))];
      expect(draftIds).toHaveLength(count);
      for (const id of draftIds)
        expect(drafts.find((call) => call.params.draft_id === id)?.params).toEqual({
          chat_id: owner.id,
          draft_id: id,
          text: '',
          can_stop: true,
        });
      expect(drafts.some((call) => call.params.text)).toBe(true);
      for (const call of drafts)
        expect(call.params).toEqual({
          chat_id: owner.id,
          draft_id: call.params.draft_id,
          text: call.params.text,
          ...(call.params.text ? { parse_mode: 'HTML' } : {}),
          can_stop: true,
        });
    }

    const firstBot = transcript(tg.calls, presses);
    const secondBot = transcript(tg2.calls, new Map(), tg2, '@bot2');
    expect({
      bot: firstBot.bot,
      'bot@bot2': secondBot.bot,
      chats: { ...firstBot.chats, ...secondBot.chats },
    }).toMatchSnapshot();
  });
});

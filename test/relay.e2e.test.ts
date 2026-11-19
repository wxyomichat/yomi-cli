import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { MOCK_COVER, type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import {
  type MockTelegram,
  type MockTelegramUser,
  startMockTelegram,
} from '../src/mock/telegram.js';
import { Relay } from '../src/relay/relay.js';
import { RelayState, relayStatePath } from '../src/relay/state.js';
import { TelegramBot } from '../src/relay/telegram.js';
import { memoryIo } from './helpers/io.js';

/**
 * `yomi relay --telegram` end to end against the mock gateway and a mock Telegram Bot API (real
 * HTTP, real WebSocket, real packet and Thrift encoding; nothing reaches the network). The tests
 * share one mock pair and run in order: the CLI flows first (token, pairing, strangers, a second
 * poller, refreshing alongside `yomi create`), then the relay's behaviour with short timings.
 */

let mock: MockServer;
let tg: MockTelegram;
let dir: string;
const saved: Record<string, string | undefined> = {};
const owner: MockTelegramUser = { id: 5550001, first_name: 'Lin', language_code: 'zh-hans' };
const stranger: MockTelegramUser = { id: 5550999, first_name: 'Eve' };
const example = resolve('examples/character.yaml');

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}

async function run(args: string[], options: Parameters<typeof memoryIo>[0] = {}) {
  process.exitCode = undefined;
  const terminal = memoryIo(options);
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
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

const texts = (chatId: number) => tg.messages(chatId).map((message) => message.text);
const said = (chatId: number, pattern: RegExp) =>
  tg.waitFor(() => tg.messages(chatId).find((message) => pattern.test(message.text)), 8000);
/** Like `said`, for an answer sent after this call: one an earlier test got does not count. */
const saidNext = (chatId: number, pattern: RegExp) => {
  const seen = new Set(tg.messages(chatId).map((message) => message.message_id));
  return tg.waitFor(
    () =>
      tg
        .messages(chatId)
        .find((message) => !seen.has(message.message_id) && pattern.test(message.text)),
    8000,
  );
};
/** Like `saidNext`, armed now and awaited later: for an answer that may come before the await. */
const expectNext = (chatId: number, pattern: RegExp) => {
  const seen = new Set(tg.messages(chatId).map((message) => message.message_id));
  return () =>
    tg.waitFor(
      () =>
        tg
          .messages(chatId)
          .find((message) => !seen.has(message.message_id) && pattern.test(message.text)),
      8000,
    );
};
const sends = () =>
  mock.state.requests.filter((request) => request.path === 'conversation/send_message');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes a running relay stop the way a second instance would (Telegram 409). */
async function secondPoller() {
  const other = new TelegramBot(tg.token, { apiOrigin: tg.origin });
  await other.getUpdates(-1, 0).catch(() => undefined);
}

beforeAll(async () => {
  mock = await startMockServer();
  tg = await startMockTelegram({ username: 'lin_relay_bot' });
  dir = mkdtempSync(join(tmpdir(), 'yomi-relay-e2e-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_TELEGRAM_API_ORIGIN: tg.origin,
    YOMI_CONFIG_DIR: dir,
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
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

describe('yomi relay --telegram (the command)', () => {
  it('refuses a plain-file store unless told, and never takes a token from argv', async () => {
    const refused = await run(['relay', '--telegram', '--set-token', '--token-stdin'], {
      input: [tg.token],
    });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--allow-file-store');
    const flag = await run(['relay', '--telegram', '--token', tg.token, '--allow-file-store']);
    expect(flag.code).toBe(2);
    // Pasted as an argument by mistake, it is not printed back.
    const pasted = await run([
      'relay',
      '--telegram',
      '--set-token',
      tg.token,
      '--allow-file-store',
    ]);
    expect(pasted.code).toBe(2);
    expect(pasted.err + flag.err).not.toContain(tg.token.split(':')[1]);
  });

  it('keeps the token from stdin after checking it with Telegram', async () => {
    const result = await run(
      ['relay', '--telegram', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [tg.token] },
    );
    expect(result.err).toBe('');
    expect(result.out).toContain('已保存 @lin_relay_bot');
    expect(result.out + result.err).not.toContain(tg.token.split(':')[1]);
    expect(tg.calls.some((call) => call.method === 'getMe')).toBe(true);
  });

  it('pairs with the code shown in the terminal only, and ignores strangers', async () => {
    mock.state.relayPolicy = { enabled: true, features: { free_only: true } };
    const terminal = memoryIo();
    const pending = main(
      [
        'relay',
        '--telegram',
        '--allow-file-store',
        '--pair',
        '--character',
        MOCK_NPCS.single,
        '--max-spend',
        '20',
      ],
      terminal.io,
    );
    const code = (await terminal.waitFor(/\/start ([A-Z2-9]{8})/))[1];
    expect(terminal.out).toContain(`https://t.me/lin_relay_bot?start=${code}`);
    await tg.waitFor(() => tg.calls.some((call) => call.method === 'getUpdates'));
    const before = sends().length;
    tg.userSends(stranger, '/start AAAABBBB');
    await said(stranger.id, /配对码不对/);
    tg.userSends(owner, `/start ${code}`);
    await said(owner.id, /已配对/);
    // The welcome: the AI notice, the cover uploaded (no "sending a photo" first), the
    // introduction and the opening; free.
    await said(owner.id, /你来了。/);
    expect(texts(owner.id)).toEqual([
      expect.stringMatching(/^已配对/),
      `当前角色：林夏（ID ${MOCK_NPCS.single}）`,
      expect.stringMatching(/^你正在与 AI 角色「林夏」聊天/),
      '旧书店的店主，雨天总坐在窗边看书。',
      '<i>雨停了，书店的门铃响了一声。</i>\n\n你来了。',
    ]);
    const [cover] = tg.photos(owner.id);
    const served = await fetch(`${mock.origin}/media/cover-${MOCK_NPCS.single}.png`);
    expect(cover.bytes.equals(Buffer.from(await served.arrayBuffer()))).toBe(true);
    expect([cover.mime, cover.caption, cover.width, cover.height]).toEqual([
      'image/png',
      '',
      MOCK_COVER.width,
      MOCK_COVER.height,
    ]);
    // Between the AI notice and the introduction.
    const ids = tg.messages(owner.id).map((message) => message.message_id);
    expect(cover.message_id).toBeGreaterThan(ids[2]);
    expect(cover.message_id).toBeLessThan(ids[3]);
    expect(tg.calls.some((call) => call.method === 'sendChatAction')).toBe(false);
    expect(sends().length).toBe(before);
    tg.userSends(stranger, '你好，我也想聊');
    tg.userSends(stranger, `/start ${code}`);
    tg.userSends(owner, '第一句');
    await said(owner.id, /第一句/);
    // The stranger got nothing beyond the wrong-code answer, and cost nothing.
    expect(texts(stranger.id)).toHaveLength(1);
    expect(sends().length).toBe(before + 1);
    await secondPoller();
    expect(await pending).toBe(0);
    expect(terminal.err).toContain('另一个程序正在用这个 bot 收消息');
  });

  it('refreshes the session alongside yomi create without signing either out', async () => {
    const terminal = memoryIo();
    const pending = main(
      ['relay', '--telegram', '--allow-file-store', '--character', MOCK_NPCS.single],
      terminal.io,
    );
    const sockets = mock.state.sockets;
    await tg.waitFor(() => terminal.out.includes('relay 运行中') && mock.state.sockets > sockets);
    const refreshes = mock.state.refreshes;
    mock.expireAuthTokens();
    const [create] = await Promise.all([
      run(['create', '-f', example, '--accept-declaration', '--new']),
      (async () => {
        tg.userSends(owner, '一起刷新');
        await said(owner.id, /一起刷新/);
      })(),
    ]);
    expect(create.err).toBe('');
    expect(create.code).toBe(0);
    expect(mock.state.refreshes).toBe(refreshes + 1);
    expect((await run(['whoami'])).code).toBe(0);
    expect(texts(owner.id).join('\n')).not.toContain('登录已失效');
    await secondPoller();
    expect(await pending).toBe(0);
  });
});

describe('the relay', () => {
  let relay: Relay;
  let state: RelayState;
  let controller: AbortController;
  let done: Promise<void>;
  const logs: string[] = [];

  function start(overrides: Partial<ConstructorParameters<typeof Relay>[3]> = {}) {
    const context = createContext(
      memoryIo().io,
      {},
      { client: 'relay-telegram', channel: 'cli_relay' },
    );
    const bot = new TelegramBot(tg.token, { apiOrigin: tg.origin });
    state = new RelayState(relayStatePath(context.account, bot.id), bot.id);
    if (!state.data.owner)
      state.update({
        owner: {
          userId: owner.id,
          chatId: owner.id,
          name: owner.first_name,
          language: 'zh',
          pairedAt: Date.now(),
        },
      });
    relay = new Relay(context.gateway, bot, state, {
      maxSpend: 50,
      characterId: MOCK_NPCS.single,
      pairing: null,
      replyTimeoutMs: 1500,
      intervalMs: 30,
      staleMs: 10 * 60 * 1000,
      pollTimeoutSeconds: 1,
      drafts: true,
      language: 'zh-Hans',
      log: (line) => logs.push(line),
      resumeCheckMs: 100,
      ...overrides,
    });
    controller = new AbortController();
    const sockets = mock.state.sockets;
    done = relay.run(controller.signal);
    return tg.waitFor(
      () => mock.state.sockets > sockets && tg.calls.some((call) => call.method === 'getUpdates'),
    );
  }

  const relayBusy = () => Boolean((relay as unknown as { turn: unknown }).turn);

  async function stop() {
    controller.abort();
    await done.catch(() => undefined);
  }

  beforeAll(async () => {
    mock.state.relayPolicy = { enabled: true, features: { free_only: true, spend_cap: true } };
    mock.state.chatFreeLimit = 1000;
    // Enough gems for every paid test below (each checks its own spending).
    mock.state.gems = 500;
    await start();
  });

  afterAll(stop);

  it('streams reviewed paragraphs as a draft, then sends the reply; raw text and thinking never leave', async () => {
    const calls = tg.calls.length;
    tg.userSends(owner, '今天天气怎么样');
    await said(owner.id, /今天天气怎么样/);
    const mine = tg.calls.slice(calls);
    const drafts = mine.filter((call) => call.method === 'sendMessageDraft');
    expect(drafts.length).toBeGreaterThan(0);
    expect(
      drafts.every((call) => call.params.can_stop === true && Number(call.params.draft_id) > 0),
    ).toBe(true);
    const everything = JSON.stringify(tg.calls.map((call) => call.params));
    expect(everything).not.toContain('RAW-UNREVIEWED');
    expect(everything).not.toContain('THINKING-SECRET');
    expect(tg.draft(owner.id)).toBeNull();
    // The relay's own AI notice (the server does not inject one yet).
    expect(texts(owner.id).join('\n')).toMatch(/AI 角色.*可能不适合部分未成年人/s);
    // No budget in the chat, --max-spend 50: Yomi's normal charging, within the local cap.
    const send = sends().at(-1)!.body;
    expect(send).toMatchObject({
      entity_type: 1,
      consumption_mode: 1,
      max_cost_diamonds: 50,
      text: '今天天气怎么样',
    });
    expect(String(send.client_request_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never shows what the account says to the same character on another device', async () => {
    const shown = texts(owner.id).length;
    mock.replyFromAnotherDevice(MOCK_NPCS.single, 'APP-SIDE-CHAT');
    // And while a reply of its own is streaming.
    tg.userSends(owner, 'SLOW 讲个故事');
    await sleep(200);
    mock.replyFromAnotherDevice(MOCK_NPCS.single, 'APP-SIDE-DURING');
    await said(owner.id, /讲个故事/);
    await sleep(300);
    const all = JSON.stringify(tg.calls.slice(-80).map((call) => call.params));
    expect(all).not.toContain('APP-SIDE');
    expect(texts(owner.id).length).toBeGreaterThan(shown);
  });

  it('names the speakers of a group chat', async () => {
    tg.userSends(owner, `/character ${MOCK_NPCS.group}`);
    await said(owner.id, /已切换到「雾港」/);
    tg.userSends(owner, '大家好');
    const reply = await said(owner.id, /<b>阿青<\/b>：大家好/);
    expect(reply.text).toContain('<b>小白</b>：');
    tg.userSends(owner, `/character ${MOCK_NPCS.single}`);
    await said(owner.id, /已切换到「林夏」/);
  });

  it('stops at the end of the free replies, with the price and no charge', async () => {
    tg.userSends(owner, '/budget off');
    await saidNext(owner.id, /^已改为只用免费额度。$/);
    const gems = mock.state.gems;
    // Every free reply with this character is used now.
    mock.state.chatFreeLimit = mock.state.chats.get(MOCK_NPCS.single)!.freeUsed;
    tg.userSends(owner, '还能聊吗');
    const answer = await said(owner.id, /免费额度已用完/);
    expect(answer.text).toContain('约 5 钻石');
    expect(answer.text).toContain(`余额 ${gems} 钻石`);
    expect(answer.text).toContain('发送 /budget none 按 Yomi 的正常规则扣费');
    expect(answer.text).not.toMatch(/https?:/);
    expect(mock.state.gems).toBe(gems);
  });

  it('spends only after a confirmed budget within the local limit, and pauses when it is spent', async () => {
    tg.userSends(owner, '/budget 100');
    await said(owner.id, /超过本机上限：上限 50 钻石/);
    tg.userSends(owner, '/budget 10');
    const ask = await said(owner.id, /最多花 10 钻石/);
    const keyboard = ask.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    const yes = keyboard.inline_keyboard[0][0].callback_data;
    // A stranger pressing the owner's button does nothing.
    tg.press(stranger, owner.id, ask.message_id, yes);
    await sleep(150);
    expect(state.data.billing.mode).toBe('free');
    tg.press(owner, owner.id, ask.message_id, yes);
    await said(owner.id, /已设置预算 10 钻石/);
    const gems = mock.state.gems;
    tg.userSends(owner, '付费的一句');
    await said(owner.id, /付费的一句/);
    expect(sends().at(-1)!.body).toMatchObject({ consumption_mode: 1, max_cost_diamonds: 10 });
    await tg.waitFor(() => state.data.billing.spent === 5);
    expect(mock.state.gems).toBe(gems - 5);
    tg.userSends(owner, '再来一句');
    await said(owner.id, /再来一句/);
    await said(owner.id, /预算已用完（已花 10 钻石）/);
    expect(state.data.billingPause).toBe('budget');
    const before = sends().length;
    tg.userSends(owner, '还想继续');
    await tg.waitFor(() => texts(owner.id).filter((text) => /预算已用完/.test(text)).length >= 2);
    expect(sends().length).toBe(before);
    tg.userSends(owner, '/budget off');
    await saidNext(owner.id, /^已改为只用免费额度。$/);
    expect(state.data.billingPause).toBe('');
  });

  it('pauses when a free reply was charged anyway', async () => {
    mock.state.ignoreFreeOnly = true;
    tg.userSends(owner, '免费的吗');
    await said(owner.id, /仍被扣了 5 钻石/);
    expect(state.data.billingPause).toBe('freeCharged');
    mock.state.ignoreFreeOnly = false;
    tg.userSends(owner, '/budget 20');
    const ask = await said(owner.id, /最多花 20 钻石/);
    tg.press(
      owner,
      owner.id,
      ask.message_id,
      (ask.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0][0]
        .callback_data,
    );
    await said(owner.id, /已设置预算 20 钻石/);
    expect(state.data.billingPause).toBe('');
    mock.state.chatFreeLimit = 1000;
    tg.userSends(owner, '/budget off');
    await saidNext(owner.id, /^已改为只用免费额度。$/);
  });

  async function confirmBudget(amount: number) {
    tg.userSends(owner, `/budget ${amount}`);
    // The newest prompt that still has its buttons (an earlier one may read the same).
    const ask = await tg.waitFor(() =>
      [...tg.messages(owner.id)]
        .reverse()
        .find((message) => message.text.includes(`最多花 ${amount} 钻石`) && message.reply_markup),
    );
    const keyboard = ask.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    tg.press(owner, owner.id, ask.message_id, keyboard.inline_keyboard[0][0].callback_data);
    await said(owner.id, new RegExp(`已设置预算 ${amount} 钻石`));
  }

  function noFreeReplies() {
    mock.state.chatFreeLimit = mock.state.chats.get(MOCK_NPCS.single)!.freeUsed;
  }

  it('sends nothing paid when the balance cannot be read, and books an unmeasured charge before the next send', async () => {
    await confirmBudget(20);
    noFreeReplies();
    const gems = mock.state.gems;
    const before = sends().length;
    mock.state.walletFailures = 2;
    tg.userSends(owner, '读不到余额');
    await said(owner.id, /暂时读不到钻石余额/);
    expect(sends().length).toBe(before);
    expect(mock.state.gems).toBe(gems);
    // The balance after the reply cannot be read: the charge stays pending, never "free".
    const spent = state.data.billing.spent;
    tg.userSends(owner, 'SLOW 付费但读不到');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    mock.state.walletFailures = 2;
    await said(owner.id, /付费但读不到/);
    await tg.waitFor(() => !relayBusy());
    expect(state.data.pending).not.toBeNull();
    expect(state.data.billing.spent).toBe(spent);
    tg.userSends(owner, '下一条');
    await said(owner.id, /下一条/);
    await tg.waitFor(() => state.data.billing.spent === spent + 10);
    expect(state.data.pending).toBeNull();
    expect(mock.state.gems).toBe(gems - 10);
  });

  it('never spends past a lowered --max-spend; 0 stops paid sends', async () => {
    await stop();
    await start({ maxSpend: 7 });
    noFreeReplies();
    tg.userSends(owner, '上限内的一句');
    await said(owner.id, /上限内的一句/);
    await tg.waitFor(() => state.data.allowance.spent === 5);
    const before = sends().length;
    // The local cap is what is short: the answer names it, not the budget.
    tg.userSends(owner, '超出本机上限');
    await said(owner.id, /本机上限还可花 2 钻石，不够下一条回复（约 5 钻石）/);
    expect(sends().length).toBe(before);
    await stop();
    await start({ maxSpend: 0 });
    // Earlier tests left the same answers in the chat: wait for this relay's own, or the stop
    // below comes before it read the message and the next relay (another limit) answers it.
    tg.userSends(owner, '不许花了');
    await saidNext(owner.id, /本机不允许花钻石（--max-spend 0）。请在电脑上去掉 --max-spend/);
    expect(sends().length).toBe(before);
    await stop();
    // A budget's pause is the owner's to lift, a higher --max-spend or not; it says the local
    // cap caused it and the budget still has room (20, 15 spent).
    await start();
    tg.userSends(owner, '还是暂停');
    await saidNext(
      owner.id,
      /^relay 之前因本机花费上限暂停（预算还剩 5 钻石）。用 \/budget .*设置新的预算，或发送 \/budget none/,
    );
    expect(sends().length).toBe(before);
    tg.userSends(owner, '/budget off');
    await saidNext(owner.id, /^已改为只用免费额度。$/);
    mock.state.chatFreeLimit = 1000;
  });

  it('sends nothing free-only while the server has not confirmed it; /budget none goes on, confirmed', async () => {
    await stop();
    const policy = mock.state.relayPolicy;
    mock.state.relayPolicy = null;
    await start();
    const before = sends().length;
    tg.userSends(owner, '默认策略');
    await saidNext(
      owner.id,
      /^服务端还没有确认支持「只用免费额度」，所以只用免费额度时一条也不发。发送 \/budget none/,
    );
    expect(sends().length).toBe(before);
    // Lifting free-only widens spending: asked first, like a budget.
    tg.userSends(owner, '/budget none');
    const ask = await saidNext(
      owner.id,
      /^确认取消聊天里的钻石上限吗？.*不超过本机上限（还可花 \d+ 钻石）/,
    );
    const keyboard = ask.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(keyboard.inline_keyboard[0].map((button) => button.text)).toEqual(['不设上限', '取消']);
    expect(state.data.billing.mode).toBe('free');
    tg.press(owner, owner.id, ask.message_id, keyboard.inline_keyboard[0][0].callback_data);
    await saidNext(owner.id, /^已取消预算：按 Yomi 的正常规则扣费，不超过本机上限/);
    expect(state.data.billing.mode).toBe('open');
    // No policy at all, and a cap: the price is known, so it goes (without max_cost_diamonds).
    tg.userSends(owner, '没有策略也能发');
    await said(owner.id, /没有策略也能发/);
    expect(sends().at(-1)!.body).toMatchObject({ consumption_mode: 1 });
    expect(sends().at(-1)!.body.max_cost_diamonds).toBeUndefined();
    await stop();
    mock.state.relayPolicy = policy;
    await start();
  });

  it('/stop stops relaying and says the turn is still charged', async () => {
    tg.userSends(owner, 'SLOW 很长的故事');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    tg.userSends(owner, '/stop');
    await said(owner.id, /已停止转发这条回复.*照常扣费/s);
    await sleep(1800);
    expect(texts(owner.id).some((text) => text.includes('很长的故事'))).toBe(false);
    tg.userSends(owner, '/stop');
    await said(owner.id, /现在没有正在转发的回复/);
  });

  it('the draft Stop button does the same', async () => {
    const stops = () => texts(owner.id).filter((text) => /已停止转发/.test(text)).length;
    const before = stops();
    const from = tg.calls.length;
    tg.userSends(owner, 'SLOW 按钮停止');
    const draft = await tg.waitFor(() =>
      tg.calls
        .slice(from)
        .reverse()
        .find((call) => call.method === 'sendMessageDraft' && call.params.text),
    );
    tg.stopGeneration(owner.id, Number(draft.params.draft_id));
    await tg.waitFor(() => stops() > before);
    await sleep(1800);
    expect(texts(owner.id).some((text) => text.includes('按钮停止'))).toBe(false);
  });

  it('gets through a disconnect: what was pushed meanwhile is read with poll_message', async () => {
    const reconnects = mock.state.sockets;
    tg.userSends(owner, 'SLOW 断线也要收到');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    mock.setOffline(true);
    await sleep(700);
    mock.setOffline(false);
    await said(owner.id, /断线也要收到/);
    expect(mock.state.sockets).toBeGreaterThan(reconnects);
    expect(mock.state.requests.some((request) => request.path === 'connection/poll_message')).toBe(
      true,
    );
  });

  it('reads a reply that never streamed back from history', async () => {
    tg.userSends(owner, 'SILENT 安静的回复');
    await said(owner.id, /安静的回复/);
    expect(
      mock.state.requests.some((request) => request.path === 'conversation/list_roaming_messages'),
    ).toBe(true);
  });

  it('turns refusals into plain text, without links or retries', async () => {
    mock.state.nextSendFailure = {
      base_resp: { status_code: 1504011011, status_msg: 'insufficient gems' },
      model_unavailable_dialog: {
        title: '钻石不足',
        content: '去充值',
        right_button: { text: '充值', schema: 'https://example.com/wallet' },
      },
    };
    const before = sends().length;
    tg.userSends(owner, '钻石不够');
    const gems = await said(owner.id, /钻石不足，请在 Yomi App 或网页充值/);
    expect(gems.text).not.toMatch(/https?:/);
    mock.state.nextSendFailure = {
      relay_error: 'RATE_LIMITED',
      retry_after_ms: 3000,
      base_resp: { status_code: 429, status_msg: 'slow down' },
    };
    tg.userSends(owner, '太快了');
    await said(owner.id, /发送太快了，请 3 秒后再试/);
    expect(sends().length).toBe(before + 2);
    tg.userSends(owner, 'FAIL 出错');
    await said(owner.id, /回复没有成功：模型开小差了/);
  });

  it('reports the last reply with a reason the server offers', async () => {
    tg.userSends(owner, '/report');
    const pick = await said(owner.id, /选择举报原因/);
    const rows = (
      pick.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard;
    expect(rows.map((row) => row[0].text)).toContain('涉及未成年人');
    tg.press(owner, owner.id, pick.message_id, rows[0][0].callback_data);
    await said(owner.id, /已提交，谢谢反馈/);
    const report = mock.state.feedback.at(-1)!;
    expect(report.tag_keys).toEqual(['sexual_minor']);
    expect(String(report.mid)).toBe(state.lastReplyMid);
  });

  it('answers non-text, stale and unknown messages without sending anything', async () => {
    const before = sends().length;
    tg.sendPhoto(owner);
    await said(owner.id, /只支持文字消息/);
    tg.userSends(owner, '昨天的话', { date: Math.floor(Date.now() / 1000) - 3600 });
    await said(owner.id, /relay 离线时发的/);
    tg.userSends(owner, '/whatever');
    await said(owner.id, /不认识这个命令/);
    expect(sends().length).toBe(before);
  });

  it('leaves a group it was added to', async () => {
    tg.botAddedToGroup(owner, -100123);
    await tg.waitFor(() =>
      tg.calls.some((call) => call.method === 'leaveChat' && call.params.chat_id === -100123),
    );
  });

  it('pauses when the session ends and resumes after yomi login', async () => {
    for (const session of mock.state.sessions) session.revoked = true;
    tg.userSends(owner, '还在吗');
    await said(owner.id, /Yomi 登录已失效/);
    await signIn();
    await said(owner.id, /Yomi 登录已恢复/);
    tg.userSends(owner, '回来了');
    await said(owner.id, /回来了/);
  });

  it('waits out Telegram flood control and still delivers the reply', async () => {
    tg.floodLimit = 3;
    tg.userSends(owner, 'SLOW 限流也能收到');
    await said(owner.id, /限流也能收到/);
    expect(tg.calls.some((call) => !call.ok && /Too Many Requests/.test(call.error ?? ''))).toBe(
      true,
    );
    tg.floodLimit = 0;
  });

  it('follows the server: switched off, or this version too old', async () => {
    await stop();
    mock.state.relayPolicy = { enabled: false, message: '本地区暂不开放', features: {} };
    await start();
    tg.userSends(owner, '开着吗');
    await said(owner.id, /relay 已被服务端关闭：本地区暂不开放/);
    await stop();
    mock.state.relayPolicy = {
      enabled: true,
      min_cli_version: '99.0.0',
      features: { free_only: true },
    };
    await start();
    const before = sends().length;
    tg.userSends(owner, '旧版本');
    await said(owner.id, /版本的 yomi 太旧了/);
    expect(sends().length).toBe(before);
    await stop();
    mock.state.relayPolicy = { enabled: true, features: { free_only: true } };
    await start();
    // Server switches are not remembered: back on, it relays again.
    tg.userSends(owner, '又开了');
    await said(owner.id, /又开了/);
  });

  it('edits a message instead when drafts are off', async () => {
    await stop();
    await start({ drafts: false });
    const calls = tg.calls.length;
    tg.userSends(owner, 'SLOW 编辑模式');
    await said(owner.id, /编辑模式/);
    const mine = tg.calls.slice(calls);
    expect(mine.some((call) => call.method === 'sendMessageDraft')).toBe(false);
    expect(mine.some((call) => call.method === 'editMessageText')).toBe(true);
  });

  /** Waits until the relay is idle and nothing is left to measure (the reply's cost is booked). */
  const settled = () => tg.waitFor(() => !relayBusy() && state.data.pending === null);

  it('without a cap forwards everything: Yomi charges as usual, the chat stays quiet, /budget shows the total', async () => {
    await stop();
    await start({ maxSpend: null });
    tg.userSends(owner, '/budget none');
    await saidNext(owner.id, /^已取消预算：按 Yomi 的正常规则扣费。钻石不足时会在这里提示。$/);
    expect(state.data.billing.mode).toBe('open');
    expect(logs).toContain(
      '没有设花费上限：按 Yomi 的正常规则扣费，钻石不足时会在聊天里提示；通过 relay 已花 0 钻石',
    );
    noFreeReplies();
    const gems = mock.state.gems;
    const total = state.data.allowance.spent;
    const shown = texts(owner.id).length;
    tg.userSends(owner, '不设上限也能聊');
    await said(owner.id, /不设上限也能聊/);
    expect(sends().at(-1)!.body).toMatchObject({ consumption_mode: 1 });
    expect(sends().at(-1)!.body.max_cost_diamonds).toBeUndefined();
    await settled();
    expect(state.data.allowance.spent).toBe(total + 5);
    expect(mock.state.gems).toBe(gems - 5);
    // The reply only: no price line, no cost line.
    expect(texts(owner.id).slice(shown).join('\n')).not.toMatch(/钻石/);
    expect(logs).toContain(`扣了 5 钻石（通过 relay 累计 ${total + 5}；没有设花费上限）`);
    tg.userSends(owner, '/budget');
    await saidNext(
      owner.id,
      new RegExp(
        `^没有设花费上限：按 Yomi 的正常规则扣费。通过 relay 已花 ${total + 5} 钻石。\n用法`,
      ),
    );
  });

  it('without a cap relays with no server policy, and with one that offers no feature', async () => {
    const policy = mock.state.relayPolicy;
    try {
      for (const next of [null, { enabled: true, features: {} }]) {
        await stop();
        mock.state.relayPolicy = next;
        await start({ maxSpend: null });
        const before = sends().length;
        const text = `策略 ${next ? '没有功能' : '没有'} 也照发`;
        tg.userSends(owner, text);
        await said(owner.id, new RegExp(text));
        expect(sends().length).toBe(before + 1);
        expect(sends().at(-1)!.body).toMatchObject({ consumption_mode: 1 });
        await settled();
      }
    } finally {
      await stop();
      mock.state.relayPolicy = policy;
      await start({ maxSpend: null });
    }
  });

  it('without a cap says when the gems are not enough, keeps running, and sends again after a top-up', async () => {
    noFreeReplies();
    const gems = mock.state.gems;
    mock.state.gems = 3;
    const before = sends().length;
    tg.userSends(owner, '钻石只剩三个');
    await saidNext(owner.id, /^钻石不足，请在 Yomi App 或网页充值后再发。$/);
    expect(state.data.billingPause).toBe('');
    expect(state.data.pending).toBeNull();
    mock.state.nextSendFailure = {
      relay_error: 'INSUFFICIENT_GEMS',
      base_resp: { status_code: 1504019999, status_msg: 'not enough gems' },
    };
    tg.userSends(owner, '还是不够');
    await saidNext(owner.id, /^钻石不足，请在 Yomi App 或网页充值后再发。$/);
    expect(sends().length).toBe(before + 2);
    expect(state.data.billingPause).toBe('');
    // Topped up in the app: the next message simply goes, nothing to lift.
    mock.state.gems = gems;
    tg.userSends(owner, '充值好了');
    await said(owner.id, /充值好了/);
    await settled();
    expect(mock.state.gems).toBe(gems - 5);
  });

  it('without a cap an unreadable balance blocks nothing, and two replies are booked once each', async () => {
    noFreeReplies();
    const gems = mock.state.gems;
    const total = state.data.allowance.spent;
    tg.userSends(owner, 'SLOW 读不到余额也照发');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    // The reading after this reply fails: its charge stays pending.
    mock.state.walletFailures = 2;
    await said(owner.id, /读不到余额也照发/);
    await tg.waitFor(() => !relayBusy());
    expect(state.data.pending).not.toBeNull();
    expect(state.data.allowance.spent).toBe(total);
    // Nothing readable before the next one either: it goes, measured together with the first.
    mock.state.walletFailures = 4;
    tg.userSends(owner, '第二条也照发');
    await said(owner.id, /第二条也照发/);
    await settled();
    expect(state.data.allowance.spent).toBe(total + 10);
    expect(mock.state.gems).toBe(gems - 10);
    expect(logs).toContain('读不到余额：这条的花费和之前的一起核对');
  });

  it('without a cap a reported charge inside a joined measurement is not booked twice', async () => {
    noFreeReplies();
    const gems = mock.state.gems;
    const total = state.data.allowance.spent;
    tg.userSends(owner, 'SLOW 先量不出来');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    mock.state.walletFailures = 2;
    await said(owner.id, /先量不出来/);
    await tg.waitFor(() => !relayBusy());
    expect(state.data.pending).not.toBeNull();
    // The second send's answer says what it cost: booked now, and taken out of the open drop.
    mock.state.walletFailures = 4;
    mock.state.reportCharge = true;
    try {
      tg.userSends(owner, '服务端报了花费');
      await said(owner.id, /服务端报了花费/);
      await tg.waitFor(() => !relayBusy());
    } finally {
      mock.state.reportCharge = false;
    }
    expect(state.data.allowance.spent).toBe(total + 5);
    expect(state.data.pending).not.toBeNull();
    // The next reading books what is left of the first: 5, not 10.
    mock.state.chatFreeLimit = 1000;
    tg.userSends(owner, '免费的一条');
    await said(owner.id, /免费的一条/);
    await settled();
    expect(state.data.allowance.spent).toBe(total + 10);
    expect(mock.state.gems).toBe(gems - 10);
  });

  it('without a cap a refused send keeps the earlier charge it joined', async () => {
    noFreeReplies();
    const total = state.data.allowance.spent;
    tg.userSends(owner, 'SLOW 还没核对');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    mock.state.walletFailures = 2;
    await said(owner.id, /还没核对/);
    await tg.waitFor(() => !relayBusy());
    const open = state.data.pending;
    expect(open).not.toBeNull();
    mock.state.walletFailures = 4;
    mock.state.nextSendFailure = {
      base_resp: { status_code: 1504011011, status_msg: 'insufficient gems' },
    };
    tg.userSends(owner, '被拒的一条');
    await saidNext(owner.id, /^钻石不足/);
    await tg.waitFor(() => !relayBusy());
    expect(state.data.pending?.before).toBe(open!.before);
    mock.state.chatFreeLimit = 1000;
    tg.userSends(owner, '之后的免费一条');
    await said(owner.id, /之后的免费一条/);
    await settled();
    expect(state.data.allowance.spent).toBe(total + 5);
  });

  it('without a cap counts a send nothing could measure, and /budget says the total may be higher', async () => {
    noFreeReplies();
    const unmeasured = state.data.allowance.unmeasured;
    mock.state.walletFailures = 2;
    tg.userSends(owner, '完全量不出来');
    await said(owner.id, /完全量不出来/);
    await settled();
    expect(state.data.allowance.unmeasured).toBe(unmeasured + 1);
    expect(logs).toContain('读不到余额：这条的花费量不出来；没有设花费上限，照常发送');
    tg.userSends(owner, '/budget');
    await saidNext(
      owner.id,
      new RegExp(`另有 ${unmeasured + 1} 次发送的花费没能量出，实际花费可能更多。`),
    );
  });

  it('/budget none lifts a spent budget once confirmed; /budget off without free-only support says how to go on', async () => {
    await confirmBudget(5);
    noFreeReplies();
    const exhausted = expectNext(
      owner.id,
      /^预算已用完（已花 5 钻石），relay 已暂停。.*\/budget none/,
    );
    tg.userSends(owner, '花完预算');
    await said(owner.id, /花完预算/);
    await exhausted();
    expect(state.data.billingPause).toBe('budget');
    tg.userSends(owner, '/budget none');
    const ask = await saidNext(owner.id, /^确认取消聊天里的钻石上限吗？/);
    const keyboard = ask.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    tg.press(owner, owner.id, ask.message_id, keyboard.inline_keyboard[0][0].callback_data);
    await saidNext(owner.id, /^已取消预算/);
    expect(state.data.billingPause).toBe('');
    tg.userSends(owner, '取消预算之后');
    await said(owner.id, /取消预算之后/);
    await settled();
    // A policy without free_only: /budget off still switches, and says nothing goes until then.
    const policy = mock.state.relayPolicy;
    await stop();
    mock.state.relayPolicy = { enabled: true, features: {} };
    try {
      await start({ maxSpend: null });
      tg.userSends(owner, '/budget off');
      await saidNext(owner.id, /^已改为只用免费额度。服务端还没有确认.*\/budget none/);
      expect(state.data.billing.mode).toBe('free');
      const before = sends().length;
      tg.userSends(owner, '只用免费额度');
      await saidNext(owner.id, /^服务端还没有确认支持「只用免费额度」/);
      expect(sends().length).toBe(before);
      tg.userSends(owner, '/budget none');
      const again = await saidNext(owner.id, /^确认取消聊天里的钻石上限吗？/);
      const buttons = again.reply_markup as { inline_keyboard: { callback_data: string }[][] };
      tg.press(owner, owner.id, again.message_id, buttons.inline_keyboard[0][0].callback_data);
      await saidNext(owner.id, /^已取消预算/);
    } finally {
      await stop();
      mock.state.relayPolicy = policy;
      await start({ maxSpend: null });
    }
  });

  it('the local cap alone pauses in its own words; /budget none does not lift it, a restart without it does', async () => {
    await stop();
    await start({ maxSpend: 5 });
    noFreeReplies();
    const spent = expectNext(
      owner.id,
      /^本机花费上限已用完（5\/5 钻石），relay 已暂停。.*--install-service/,
    );
    tg.userSends(owner, '本机上限内');
    await said(owner.id, /本机上限内/);
    expect(sends().at(-1)!.body).toMatchObject({ consumption_mode: 1 });
    await spent();
    expect(state.data.billingPause).toBe('budget');
    const before = sends().length;
    tg.userSends(owner, '/budget none');
    await saidNext(owner.id, /^本机花费上限已用完/);
    expect(state.data.billingPause).toBe('budget');
    tg.userSends(owner, '上限用完了');
    await saidNext(owner.id, /^本机花费上限已用完/);
    expect(sends().length).toBe(before);
    await stop();
    await start({ maxSpend: null });
    expect(state.data.billingPause).toBe('');
    tg.userSends(owner, '去掉上限之后');
    await said(owner.id, /去掉上限之后/);
    await settled();
  });

  it('with only a local cap, a balance that rose during a reply still counts its price', async () => {
    await stop();
    await start({ maxSpend: 50 });
    noFreeReplies();
    const total = state.data.allowance.spent;
    tg.userSends(owner, 'SLOW 充值中的回复');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    // Topped up during the reply: the drop hides its cost, so the quoted price is counted.
    mock.state.gems += 100;
    await said(owner.id, /充值中的回复/);
    await settled();
    expect(state.data.allowance.spent).toBe(total + 5);
    expect(logs).toContain('余额在这条回复期间增加了，无法量出花费：按 5 钻石计入');
  });

  it('--max-spend 0 without a budget is free replies only, and says so where only the computer helps', async () => {
    await stop();
    mock.state.chatFreeLimit = 1000;
    await start({ maxSpend: 0 });
    tg.userSends(owner, '零上限的一句');
    await said(owner.id, /零上限的一句/);
    expect(sends().at(-1)!.body).toMatchObject({ consumption_mode: 0 });
    expect(sends().at(-1)!.body.max_cost_diamonds).toBeUndefined();
    tg.userSends(owner, '/budget none');
    await saidNext(owner.id, /^本机不允许花钻石（--max-spend 0）。请在电脑上去掉 --max-spend/);
    expect(state.data.billing.mode).toBe('open');
    const policy = mock.state.relayPolicy;
    await stop();
    mock.state.relayPolicy = { enabled: true, features: {} };
    try {
      await start({ maxSpend: 0 });
      const before = sends().length;
      tg.userSends(owner, '零上限没有免费模式');
      await saidNext(
        owner.id,
        /^服务端还没有确认支持「只用免费额度」.*去掉 --max-spend.*yomi relay --telegram --install-service/,
      );
      expect(sends().length).toBe(before);
    } finally {
      await stop();
      mock.state.relayPolicy = policy;
    }
  });

  it('restarts with an old saved state: the old default opens up, its pause holds only under --max-spend 0', async () => {
    // A file from before budgets were optional: free-only by default, paused by a charged reply.
    state.update({
      billing: { mode: 'free', budget: 0, spent: 0, setAt: 0 },
      billingPause: 'freeCharged',
      pending: null,
    });
    await start({ maxSpend: 0 });
    expect(state.data.billing.mode).toBe('open');
    expect(state.data.billingPause).toBe('freeCharged');
    const before = sends().length;
    tg.userSends(owner, '旧服务');
    await saidNext(owner.id, /^relay 已暂停：请在电脑上去掉 --max-spend/);
    expect(sends().length).toBe(before);
    await stop();
    await start({ maxSpend: null });
    expect(state.data.billingPause).toBe('');
    tg.userSends(owner, '新的默认');
    await said(owner.id, /新的默认/);
    await settled();
  });

  it('a cap spent under an earlier --max-spend does not hold a restart on free replies only', async () => {
    await stop();
    // Spent under --max-spend 10 with no budget; the next start asks for free replies only.
    state.update({
      billing: { mode: 'open', budget: 0, spent: 0, setAt: 0 },
      billingPause: 'budget',
      allowance: { maxSpend: 10, spent: 10, since: Date.now(), unmeasured: 0 },
      pending: null,
    });
    mock.state.chatFreeLimit = 1000;
    await start({ maxSpend: 0 });
    expect(state.data.billingPause).toBe('');
    const before = sends().length;
    tg.userSends(owner, '换成只用免费额度');
    await said(owner.id, /换成只用免费额度/);
    expect(sends().length).toBe(before + 1);
    expect(sends().at(-1)!.body).toMatchObject({ consumption_mode: 0 });
    await settled();
  });

  it('without a cap a reply the balance could not measure is not counted against a budget set after it', async () => {
    await stop();
    await start({ maxSpend: null });
    expect(state.data.billing.mode).toBe('open');
    noFreeReplies();
    tg.userSends(owner, 'SLOW 预算之前的回复');
    await tg.waitFor(() => tg.draft(owner.id)?.text);
    // The reading after the reply fails: its cost stays pending, taken without a cap.
    mock.state.walletFailures = 2;
    await said(owner.id, /预算之前的回复/);
    await tg.waitFor(() => !relayBusy());
    expect(state.data.pending).toMatchObject({ mode: 'open', price: null, capped: false });
    // A top-up hides that cost, and a budget is set before the next message.
    mock.state.gems += 1000;
    await confirmBudget(60);
    mock.state.chatFreeLimit = 1000;
    const unmeasured = state.data.allowance.unmeasured;
    const before = sends().length;
    tg.userSends(owner, '预算之后的回复');
    await said(owner.id, /预算之后的回复/);
    await settled();
    expect(sends().length).toBe(before + 1);
    expect(state.data.billing).toMatchObject({ mode: 'paid', budget: 60, spent: 0 });
    expect(state.data.billingPause).toBe('');
    expect(state.data.allowance.unmeasured).toBe(unmeasured + 1);
  });
});

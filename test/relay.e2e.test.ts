import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
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
    const send = sends().at(-1)!.body;
    expect(send).toMatchObject({ entity_type: 1, consumption_mode: 0, text: '今天天气怎么样' });
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
    const gems = mock.state.gems;
    // Every free reply with this character is used now.
    mock.state.chatFreeLimit = mock.state.chats.get(MOCK_NPCS.single)!.freeUsed;
    tg.userSends(owner, '还能聊吗');
    const answer = await said(owner.id, /免费额度已用完/);
    expect(answer.text).toContain('约 5 钻石');
    expect(answer.text).toContain(`余额 ${gems} 钻石`);
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
    await said(owner.id, /改回只用免费额度/);
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
    await said(owner.id, /改回只用免费额度/);
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
    tg.userSends(owner, '超出本机上限');
    await said(owner.id, /剩余预算 2 钻石，不够下一条回复/);
    expect(sends().length).toBe(before);
    await stop();
    await start({ maxSpend: 0 });
    // Earlier tests left the same answers in the chat: wait for this relay's own, or the stop
    // below comes before it read the message and the next relay (another limit) answers it.
    tg.userSends(owner, '不许花了');
    await saidNext(owner.id, /预算已用完/);
    expect(sends().length).toBe(before);
    await stop();
    await start();
    tg.userSends(owner, '/budget off');
    await saidNext(owner.id, /改回只用免费额度/);
    mock.state.chatFreeLimit = 1000;
  });

  it('sends nothing before a budget while the server has not confirmed free-only', async () => {
    await stop();
    const policy = mock.state.relayPolicy;
    mock.state.relayPolicy = null;
    await start();
    const before = sends().length;
    tg.userSends(owner, '默认策略');
    await said(owner.id, /没设预算前一条也不发/);
    expect(sends().length).toBe(before);
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
});

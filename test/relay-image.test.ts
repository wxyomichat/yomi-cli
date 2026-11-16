import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import type { Json } from '../src/core/json.js';
import {
  chatImageStore,
  type MockChatImage,
  type MockChatImageTask,
} from '../src/mock/gen/chatImage.js';
import { solidPngBytes } from '../src/mock/gen/png.js';
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
 * `/image` in `yomi relay --telegram`, end to end against the mock gateway (chat images: config,
 * task, delivery as a pushed message, billing on delivery) and the mock Bot API (photos uploaded
 * as multipart/form-data). Nothing reaches the network. The tests share one mock pair and run in
 * order: the CLI first (pairing, a free picture), then the relay with short timings.
 */

let mock: MockServer;
let tg: MockTelegram;
let dir: string;
const saved: Record<string, string | undefined> = {};
const owner: MockTelegramUser = { id: 5560001, first_name: 'Lin', language_code: 'zh-hans' };
const npc = MOCK_NPCS.single;

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

const images = (): MockChatImage => chatImageStore(mock.gen);
const said = (pattern: RegExp) =>
  tg.waitFor(() => tg.messages(owner.id).find((message) => pattern.test(message.text)), 8000);
const photos = () => tg.photos(owner.id);
const sends = () =>
  mock.state.requests.filter((request) => request.path === 'conversation/send_message');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a message matching `pattern` beyond those already shown; call before sending. */
function expectNew(pattern: RegExp) {
  const matching = () => tg.messages(owner.id).filter((message) => pattern.test(message.text));
  const before = matching().length;
  return () => tg.waitFor(() => matching().length > before && matching().at(-1), 8000);
}

/** Waits for one more photo than now; call before sending. */
function expectPhoto() {
  const before = photos().length;
  return () => tg.waitFor(() => photos().length > before && photos().at(-1), 8000);
}

/** The newest reply of the character in the mock's history. */
function latestReplyMid(): string {
  const messages = mock.state.chats.get(npc)!.messages as Json[];
  const replies = messages.filter(
    (message) => message.sender_type === 2 && Number(message.semantic ?? 0) === 0,
  );
  return String(replies.at(-1)!.mid);
}

/** The mock's task for the newest `create_task` (or the one `requestId` names). */
function lastTask(requestId = String(images().creates.at(-1)!.client_request_id)) {
  return images().tasks.get(images().requests.get(requestId)!)!;
}

/** The bytes the mock serves for a task's picture. */
async function served(task: MockChatImageTask): Promise<Buffer> {
  return Buffer.from(await (await fetch(task.url)).arrayBuffer());
}

async function secondPoller() {
  const other = new TelegramBot(tg.token, { apiOrigin: tg.origin });
  await other.getUpdates(-1, 0).catch(() => undefined);
}

beforeAll(async () => {
  mock = await startMockServer();
  tg = await startMockTelegram({ username: 'lin_image_bot' });
  dir = mkdtempSync(join(tmpdir(), 'yomi-relay-image-'));
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
  mock.state.chatFreeLimit = 1000;
  mock.state.gems = 500;
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

describe('/image through yomi relay --telegram', () => {
  it('forwards a free picture of the last reply as an uploaded photo, pushed on delivery', async () => {
    const token = await run(
      ['relay', '--telegram', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [tg.token] },
    );
    expect(token.code).toBe(0);
    const terminal = memoryIo();
    const pending = main(
      [
        'relay',
        '--telegram',
        '--allow-file-store',
        '--pair',
        '--character',
        npc,
        '--max-spend',
        '200',
      ],
      terminal.io,
    );
    const code = (await terminal.waitFor(/\/start ([A-Z2-9]{8})/))[1];
    await tg.waitFor(() => tg.calls.some((call) => call.method === 'getUpdates'));
    tg.userSends(owner, `/start ${code}`);
    await said(/已配对/);
    const commands = tg.calls.filter((call) => call.method === 'setMyCommands').at(-1)!.params
      .commands as { command: string }[];
    expect(commands.map((command) => command.command)).toContain('image');
    tg.userSends(owner, '画一下窗外的雨');
    await said(/画一下窗外的雨/);
    const anchor = latestReplyMid();
    const gems = mock.state.gems;
    const reads = mock.state.requests.length;
    const photo = expectPhoto();
    tg.userSends(owner, '/image');
    await said(/正在生成图片（免费），好了会发到这里/);
    const sent = await photo();
    const task = lastTask();
    // The app's request: the reply as anchor, a 3:4 picture, one id for this request.
    const body = images().creates.at(-1)!;
    expect(body).toMatchObject({ entity_type: 1, options: { aspect_ratio: '3:4' } });
    expect(String(body.entity_id)).toBe(npc);
    expect(String(body.anchor_mid)).toBe(anchor);
    expect(body.is_prologue).toBeUndefined();
    expect(String(body.client_request_id)).toMatch(
      new RegExp(`^chat-image-1-${npc}-${anchor}-[0-9a-f-]{36}$`),
    );
    // The bytes themselves went up (multipart), never a link for Telegram to fetch.
    expect(sent.bytes.equals(await served(task))).toBe(true);
    expect(sent.mime).toBe('image/png');
    expect(sent.caption).toBe('「林夏」的图片');
    const upload = tg.calls.filter((call) => call.method === 'sendPhoto').at(-1)!;
    expect(upload.files?.photo).toMatchObject({ type: 'image/png', size: sent.bytes.length });
    expect(JSON.stringify(upload.params)).not.toContain('/media/');
    // Delivered by the push: history was not read again after the request.
    const after = mock.state.requests.slice(reads);
    const created = after.findIndex((request) => request.path === 'conversation/image/create_task');
    expect(
      after.slice(created).some((request) => request.path === 'conversation/list_roaming_messages'),
    ).toBe(false);
    expect(mock.state.gems).toBe(gems);
    await secondPoller();
    expect(await pending).toBe(0);
    expect(terminal.err).toContain(`已转发一张「林夏」的图片`);
  });
});

describe('the Telegram client', () => {
  it('uploads a photo as multipart/form-data within the Bot API limits', async () => {
    const bot = new TelegramBot(tg.token, { apiOrigin: tg.origin });
    const bytes = solidPngBytes(30, 40, [200, 10, 10]);
    const sent = await bot.sendPhoto(
      owner.id,
      { bytes, mime: 'image/png', name: 'a.png' },
      '<b>雨</b> &amp; 窗',
    );
    expect(sent.caption).toBe('雨 & 窗');
    expect(sent.photo?.at(-1)).toMatchObject({ width: 30, height: 40, file_size: bytes.length });
    const call = tg.calls.at(-1)!;
    expect(call.params).toMatchObject({ chat_id: String(owner.id), parse_mode: 'HTML' });
    expect(JSON.stringify(call.params)).not.toContain(tg.token);
    // Not a picture: Telegram turns it down; over 10 MB: never sent.
    await expect(
      bot.sendPhoto(owner.id, {
        bytes: Buffer.from('not a picture'),
        mime: 'image/png',
        name: 'x',
      }),
    ).rejects.toMatchObject({ code: 400, description: 'Bad Request: IMAGE_PROCESS_FAILED' });
    const calls = tg.calls.length;
    await expect(
      bot.sendPhoto(owner.id, {
        bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
        mime: 'image/png',
        name: 'big.png',
      }),
    ).rejects.toMatchObject({ method: 'sendPhoto', code: 400 });
    expect(tg.calls.length).toBe(calls);
  });
});

describe('/image in the relay', () => {
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
    relay = new Relay(context.gateway, bot, state, {
      maxSpend: 200,
      characterId: npc,
      pairing: null,
      replyTimeoutMs: 1500,
      intervalMs: 30,
      staleMs: 10 * 60 * 1000,
      pollTimeoutSeconds: 1,
      drafts: true,
      language: 'zh-Hans',
      log: (line) => logs.push(line),
      resumeCheckMs: 100,
      imagePollMs: 100,
      imageTimeoutMs: 4000,
      ...overrides,
    });
    controller = new AbortController();
    const sockets = mock.state.sockets;
    done = relay.run(controller.signal);
    return tg.waitFor(
      () => mock.state.sockets > sockets && tg.calls.some((call) => call.method === 'getUpdates'),
    );
  }

  async function stop() {
    controller.abort();
    await done.catch(() => undefined);
  }

  const busy = () => {
    const inside = relay as unknown as { job: unknown; turn: unknown };
    return Boolean(inside.job || inside.turn);
  };
  const kept = () =>
    (relay as unknown as { keptImage(): { requestId: string; taskId: string } | null }).keptImage();

  async function confirmBudget(amount: number) {
    tg.userSends(owner, `/budget ${amount}`);
    const ask = await tg.waitFor(() =>
      [...tg.messages(owner.id)]
        .reverse()
        .find((message) => message.text.includes(`最多花 ${amount} 钻石`) && message.reply_markup),
    );
    const keyboard = ask.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    // A new confirmation only: an earlier test's identical one must not end the wait early.
    const confirmed = expectNew(new RegExp(`已设置预算 ${amount} 钻石`));
    tg.press(owner, owner.id, ask.message_id, keyboard.inline_keyboard[0][0].callback_data);
    await confirmed();
  }

  beforeAll(async () => {
    await start();
  });

  afterAll(stop);

  it('asks for nothing paid without a budget; with one it shows the price and books the charge', async () => {
    images().config.freeLeft = 0;
    const creates = images().creates.length;
    const gems = mock.state.gems;
    const refused = expectNew(/生成一张图片需要 8 钻石（送达时扣费），现在只用免费额度.*\/budget/);
    tg.userSends(owner, '/image');
    await refused();
    expect(images().creates.length).toBe(creates);
    expect(mock.state.gems).toBe(gems);
    await confirmBudget(100);
    const spent = state.data.billing.spent;
    const price = expectNew(/生成一张图片 8 钻石（图片送达时扣费）。当前余额 \d+ 钻石。/);
    const photo = expectPhoto();
    tg.userSends(owner, '/image');
    expect((await price()).text).toContain(`当前余额 ${gems} 钻石`);
    await said(/正在生成图片（8 钻石，送达时扣费）/);
    const sent = await photo();
    expect(sent.bytes.equals(await served(lastTask()))).toBe(true);
    await tg.waitFor(() => !busy() && state.data.billing.spent === spent + 8);
    expect(mock.state.gems).toBe(gems - 8);
    expect(state.data.pending).toBeNull();
    expect(kept()).toBeNull();
    // The photo stands for the picture's message: /report on it reports that message.
    expect(state.replyMid(sent.message_id)).toBe(lastTask().resultMid);
  });

  it('sends nothing the balance cannot pay; a gems refusal charges and keeps nothing', async () => {
    const gems = mock.state.gems;
    mock.state.gems = 5;
    const creates = images().creates.length;
    const short = expectNew(/钻石不足：生成一张图片需要 8 钻石，当前余额 5。/);
    tg.userSends(owner, '/image');
    await short();
    expect(images().creates.length).toBe(creates);
    mock.state.gems = gems;
    images().failNext = {
      base_resp: { status_code: 40201, status_msg: 'insufficient gems' },
      model_unavailable_dialog: { title: '钻石不足', content: '充值后即可生成图片' },
    };
    const refused = expectNew(/钻石不足，没有生成图片，也没有扣费/);
    tg.userSends(owner, '/image');
    await refused();
    expect(images().creates.length).toBe(creates + 1);
    expect(kept()).toBeNull();
    expect(state.data.pending).toBeNull();
    expect(mock.state.gems).toBe(gems);
  });

  it('says a picture failed, and follows a refund until it is back', async () => {
    const gems = mock.state.gems;
    const spent = state.data.billing.spent;
    const count = photos().length;
    images().next = 'fail';
    const failed = expectNew(/图片没有生成成功：图片生成失败。这张图片没有扣费。/);
    tg.userSends(owner, '/image');
    await failed();
    await tg.waitFor(() => !busy());
    expect(kept()).toBeNull();
    images().next = 'refund';
    const refunding = expectNew(/图片没有生成成功：图片保存失败。扣的钻石正在退回（退款处理中）。/);
    const refunded = expectNew(/扣的钻石已经退回/);
    tg.userSends(owner, '/image');
    await refunding();
    await refunded();
    await tg.waitFor(() => !busy());
    expect(photos().length).toBe(count);
    expect(mock.state.gems).toBe(gems);
    expect(state.data.billing.spent).toBe(spent);
    expect(kept()).toBeNull();
  });

  it('says when the content checks turned the picture down', async () => {
    const count = photos().length;
    images().next = 'reject';
    const rejected = expectNew(
      /图片没有通过内容审核（图片内容未通过安全审核），没有发出。这张图片没有扣费。/,
    );
    tg.userSends(owner, '/image');
    await rejected();
    await tg.waitFor(() => !busy());
    expect(photos().length).toBe(count);
  });

  it("never forwards another device's picture, even of the same reply while waiting for its own", async () => {
    const anchor = latestReplyMid();
    const count = photos().length;
    const idle = images().fromAnotherDevice(npc, anchor);
    await tg.waitFor(() => idle.generation === 4);
    await sleep(300);
    expect(photos().length).toBe(count);
    images().config.freeLeft = 1;
    images().stepMs = 150;
    const theirs = images().fromAnotherDevice(npc, anchor);
    const photo = expectPhoto();
    tg.userSends(owner, '/image');
    const sent = await photo();
    images().stepMs = 60;
    const ours = lastTask();
    expect(String(images().creates.at(-1)!.anchor_mid)).toBe(anchor);
    expect(theirs.generation).toBe(4);
    expect(sent.bytes.equals(await served(ours))).toBe(true);
    expect(sent.bytes.equals(await served(theirs))).toBe(false);
    await tg.waitFor(() => !busy());
    await sleep(200);
    expect(photos().length).toBe(count + 1);
  });

  it('finds the picture through the task and history when no push arrives', async () => {
    images().config.freeLeft = 1;
    images().push = false;
    const from = mock.state.requests.length;
    const photo = expectPhoto();
    tg.userSends(owner, '/image');
    const sent = await photo();
    images().push = true;
    const after = mock.state.requests.slice(from).map((request) => request.path);
    const created = after.indexOf('conversation/image/create_task');
    const delivered = after.slice(created);
    expect(delivered).toContain('media/image/get_task');
    expect(delivered).toContain('conversation/list_roaming_messages');
    expect(sent.bytes.equals(await served(lastTask()))).toBe(true);
    await tg.waitFor(() => !busy());
  });

  it('keeps a request whose answer was lost and resends it as is on /image resume, charged once', async () => {
    images().config.freeLeft = 0;
    const gems = mock.state.gems;
    const spent = state.data.billing.spent;
    const sent = sends().length;
    images().loseNextAnswer = true;
    const unknown = expectNew(/没能确认生图请求的结果.*\/image resume/);
    tg.userSends(owner, '/image');
    await unknown();
    const record = kept();
    expect(record?.taskId).toBe('');
    // Nothing else goes out while its outcome is open.
    const blocked = expectNew(/上一次生图请求的结果还不确定/);
    tg.userSends(owner, '先聊一句');
    await blocked();
    expect(sends().length).toBe(sent);
    // Meanwhile the server made it and charged it on delivery.
    await tg.waitFor(() => lastTask(record!.requestId).generation === 4);
    const photo = expectPhoto();
    tg.userSends(owner, '/image resume');
    const picture = await photo();
    const [first, second] = images().creates.slice(-2);
    expect(second.client_request_id).toBe(record!.requestId);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const task = lastTask(record!.requestId);
    expect(
      [...images().tasks.values()].filter((item) => item.requestId === record!.requestId),
    ).toHaveLength(1);
    expect(picture.bytes.equals(await served(task))).toBe(true);
    await tg.waitFor(() => !busy() && kept() === null);
    expect(mock.state.gems).toBe(gems - 8);
    expect(state.data.billing.spent).toBe(spent + 8);
    tg.userSends(owner, '又可以聊了');
    await said(/又可以聊了/);
  });

  it('keeps a request answered with an unrecognised code and resends it as is, charged once', async () => {
    images().config.freeLeft = 0;
    const gems = mock.state.gems;
    const spent = state.data.billing.spent;
    const sent = sends().length;
    // Accepted (and charged on delivery), but answered with a code nobody knows.
    images().answerNextWith = {
      base_resp: { status_code: 1504000002, status_msg: 'unexpected' },
    };
    const unknown = expectNew(/没能确认生图请求的结果.*\/image resume/);
    tg.userSends(owner, '/image');
    await unknown();
    const record = kept()!;
    expect(record.taskId).toBe('');
    expect(state.data.pending).not.toBeNull();
    const blocked = expectNew(/上一次生图请求的结果还不确定/);
    tg.userSends(owner, '结果未知时的一句');
    await blocked();
    expect(sends().length).toBe(sent);
    await tg.waitFor(() => lastTask(record.requestId).generation === 4);
    const photo = expectPhoto();
    tg.userSends(owner, '/image resume');
    const picture = await photo();
    const [first, second] = images().creates.slice(-2);
    expect(second.client_request_id).toBe(record.requestId);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(
      [...images().tasks.values()].filter((item) => item.requestId === record.requestId),
    ).toHaveLength(1);
    expect(picture.bytes.equals(await served(lastTask(record.requestId)))).toBe(true);
    await tg.waitFor(() => !busy() && kept() === null);
    expect(mock.state.gems).toBe(gems - 8);
    expect(state.data.billing.spent).toBe(spent + 8);
    expect(state.data.pending).toBeNull();
    // A known refusal code still forgets the request: nothing was accepted, nothing charged.
    const creates = images().creates.length;
    images().failNext = { base_resp: { status_code: 429, status_msg: 'too many requests' } };
    const limited = expectNew(/发送太快了，请稍后再试/);
    tg.userSends(owner, '/image');
    await limited();
    expect(images().creates.length).toBe(creates + 1);
    expect(kept()).toBeNull();
    expect(state.data.pending).toBeNull();
    expect(mock.state.gems).toBe(gems - 8);
  });

  it('keeps a request and its pending charge when only the resend is refused', async () => {
    images().config.freeLeft = 0;
    const gems = mock.state.gems;
    const spent = state.data.billing.spent;
    images().loseNextAnswer = true;
    const unknown = expectNew(/没能确认生图请求的结果/);
    tg.userSends(owner, '/image');
    await unknown();
    const record = kept()!;
    const pending = state.data.pending;
    expect(pending).not.toBeNull();
    // The first send was accepted and is charged on delivery; the resend is turned away.
    await tg.waitFor(() => lastTask(record.requestId).generation === 4);
    images().failNext = { base_resp: { status_code: 429, status_msg: 'too many requests' } };
    const refused = expectNew(/这次重发被拒了.*上一次的结果仍然未知/);
    tg.userSends(owner, '/image resume');
    await refused();
    expect(kept()?.requestId).toBe(record.requestId);
    expect(kept()?.taskId).toBe('');
    expect(state.data.pending?.before).toBe(pending!.before);
    // Nothing else goes out meanwhile; the next resume finds the accepted task, booked once.
    const blocked = expectNew(/上一次生图请求的结果还不确定/);
    tg.userSends(owner, '还没好吗');
    await blocked();
    const photo = expectPhoto();
    tg.userSends(owner, '/image resume');
    await photo();
    await tg.waitFor(() => !busy() && kept() === null);
    expect(mock.state.gems).toBe(gems - 8);
    expect(state.data.billing.spent).toBe(spent + 8);
    expect(state.data.pending).toBeNull();
  });

  it('asks for a picture shown as free only when its full price fits what the relay may spend', async () => {
    images().config.freeLeft = 1;
    const creates = images().creates.length;
    const cost = images().config.coinCost;
    try {
      // The free image is a snapshot: charged anyway, it would pass --max-spend.
      images().config.coinCost = 100_000;
      const over = expectNew(/这张图片显示免费，但免费次数只是当前快照.*--max-spend/);
      tg.userSends(owner, '/image');
      await over();
      // No price given while billing is on: unknown, not free.
      (images().config as { coinCost?: number }).coinCost = undefined;
      const unknownPrice = expectNew(/暂时读不到生图的价格（不代表免费）/);
      tg.userSends(owner, '/image');
      await unknownPrice();
      expect(images().creates.length).toBe(creates);
      expect(kept()).toBeNull();
    } finally {
      images().config.coinCost = cost;
    }
  });

  it('/stop stops waiting without cancelling; /image resume picks the picture up', async () => {
    images().config.freeLeft = 1;
    images().stepMs = 400;
    const stopped = expectNew(/已停止等待这张图片。服务端仍会继续生成.*\/image resume/);
    tg.userSends(owner, '/image');
    await said(/正在生成图片（免费）/);
    tg.userSends(owner, '/stop');
    await stopped();
    expect(kept()?.taskId).not.toBe('');
    images().stepMs = 60;
    const photo = expectPhoto();
    tg.userSends(owner, '/image resume');
    await said(/继续等待上一次的图片/);
    const sent = await photo();
    expect(sent.bytes.equals(await served(lastTask()))).toBe(true);
    await tg.waitFor(() => !busy() && kept() === null);
  });

  it('/image forget never drops a picture whose task was accepted: its charge still lands', async () => {
    images().config.freeLeft = 0;
    images().stepMs = 400;
    const gems = mock.state.gems;
    const spent = state.data.billing.spent;
    const started = expectNew(/正在生成图片（8 钻石，送达时扣费）/);
    tg.userSends(owner, '/image');
    await started();
    const stopped = expectNew(/已停止等待这张图片/);
    tg.userSends(owner, '/stop');
    await stopped();
    const record = kept()!;
    expect(record.taskId).not.toBe('');
    const refused = expectNew(/已经被服务端受理，送达时会扣费，所以不能放弃追踪.*\/image resume/);
    tg.userSends(owner, '/image forget');
    await refused();
    expect(kept()?.requestId).toBe(record.requestId);
    expect(state.data.pending).not.toBeNull();
    images().stepMs = 60;
    const photo = expectPhoto();
    tg.userSends(owner, '/image resume');
    const sent = await photo();
    expect(sent.bytes.equals(await served(lastTask(record.requestId)))).toBe(true);
    await tg.waitFor(() => !busy() && kept() === null);
    expect(mock.state.gems).toBe(gems - 8);
    expect(state.data.billing.spent).toBe(spent + 8);
    expect(state.data.pending).toBeNull();
  });

  it('after /stop, the next message settles nothing before the picture is delivered and charged', async () => {
    images().config.freeLeft = 0;
    images().stepMs = 500;
    images().chargeLagMs = 1500;
    const gems = mock.state.gems;
    const spent = state.data.billing.spent;
    const sent = sends().length;
    const started = expectNew(/正在生成图片（8 钻石，送达时扣费）/);
    tg.userSends(owner, '/image');
    await started();
    const record = kept()!;
    let stopped = expectNew(/已停止等待这张图片/);
    tg.userSends(owner, '/stop');
    await stopped();
    // Not delivered yet: the message waits, the charge stays pending.
    const waiting = expectNew(/上一张图片还在生成/);
    tg.userSends(owner, '送达之前的一句');
    await waiting();
    expect(lastTask(record.requestId).delivery).not.toBe(2);
    expect(sends().length).toBe(sent);
    expect(state.data.pending).not.toBeNull();
    stopped = expectNew(/已停止等待这张图片/);
    tg.userSends(owner, '/stop');
    await stopped();
    // Delivered, its charge not landed yet: a balance read now would book 0.
    await tg.waitFor(() => lastTask(record.requestId).delivery === 2);
    expect(lastTask(record.requestId).billing).toBe(0);
    const photo = expectPhoto();
    const settling = expectNew(/上一张图片已经送达，扣费还在结算/);
    tg.userSends(owner, '送达之后的一句');
    const picture = await photo();
    await settling();
    expect(picture.bytes.equals(await served(lastTask(record.requestId)))).toBe(true);
    expect(sends().length).toBe(sent);
    expect(state.data.billing.spent).toBe(spent);
    expect(state.data.pending).not.toBeNull();
    // Booked once it lands; then messages go again.
    await tg.waitFor(() => !busy() && kept() === null);
    images().chargeLagMs = 0;
    images().stepMs = 60;
    expect(lastTask(record.requestId).billing).toBe(2);
    expect(mock.state.gems).toBe(gems - 8);
    expect(state.data.billing.spent).toBe(spent + 8);
    expect(state.data.pending).toBeNull();
    tg.userSends(owner, '结算之后的一句');
    await said(/结算之后的一句/);
    expect(sends().length).toBe(sent + 1);
    await tg.waitFor(() => !busy());
  });

  it('after waiting too long, settles (and forwards) the picture before the next message', async () => {
    await stop();
    await start({ imageTimeoutMs: 250 });
    images().config.freeLeft = 1;
    images().stepMs = 200;
    const late = expectNew(/图片还没生成好。服务端会继续生成，送达时才扣费/);
    tg.userSends(owner, '/image');
    await late();
    const record = kept()!;
    await tg.waitFor(() => lastTask(record.requestId).generation === 4);
    images().stepMs = 60;
    const photo = expectPhoto();
    tg.userSends(owner, '图片之后的一句');
    const sent = await photo();
    expect(sent.bytes.equals(await served(lastTask(record.requestId)))).toBe(true);
    await said(/图片之后的一句/);
    expect(kept()).toBeNull();
    await stop();
    await start();
  });

  it('draws from the reply the owner answers, and not from a picture', async () => {
    images().config.freeLeft = 2;
    tg.userSends(owner, '第一段回复');
    const first = await said(/第一段回复/);
    await tg.waitFor(() => !busy());
    const firstMid = state.replyMid(first.message_id);
    tg.userSends(owner, '第二段回复');
    await said(/第二段回复/);
    await tg.waitFor(() => !busy());
    const photo = expectPhoto();
    tg.userSends(owner, '/image', { replyTo: first.message_id });
    const sent = await photo();
    expect(String(images().creates.at(-1)!.anchor_mid)).toBe(firstMid);
    await tg.waitFor(() => !busy());
    const creates = images().creates.length;
    const notReply = expectNew(/只能根据角色的文字回复生成图片/);
    tg.userSends(owner, '/image', { replyTo: sent.message_id });
    await notReply();
    expect(images().creates.length).toBe(creates);
  });

  it('books a priced picture charged on delivery after a restart', async () => {
    images().config.freeLeft = 0;
    images().stepMs = 600;
    const gems = mock.state.gems;
    const spent = state.data.billing.spent;
    const started = expectNew(/正在生成图片（8 钻石，送达时扣费）/);
    tg.userSends(owner, '/image');
    await started();
    const record = kept()!;
    await stop();
    const photo = expectPhoto();
    await start();
    // Restarted before the delivery (and its charge): the reading at start must not settle it.
    expect(lastTask(record.requestId).generation).not.toBe(4);
    await photo();
    images().stepMs = 60;
    await tg.waitFor(() => !busy() && kept() === null);
    expect(mock.state.gems).toBe(gems - 8);
    expect(state.data.billing.spent).toBe(spent + 8);
    expect(state.data.pending).toBeNull();
  });

  it('pauses when a picture sent as free is charged anyway, budget or not', async () => {
    expect(state.data.billing.mode).toBe('paid');
    images().config.freeLeft = 1;
    images().stepMs = 300;
    const allowance = state.data.allowance.spent;
    const started = expectNew(/正在生成图片（免费）/);
    const paused = expectNew(/按免费发出的回复（或图片）仍被扣了 8 钻石，relay 已暂停/);
    // The server charges it after all (its free image was used up elsewhere meanwhile).
    images().chargeFreeNext = true;
    tg.userSends(owner, '/image');
    await started();
    await paused();
    await tg.waitFor(() => !busy() && kept() === null);
    images().stepMs = 60;
    expect(state.data.billingPause).toBe('freeCharged');
    expect(state.data.allowance.spent).toBe(allowance + 8);
    const creates = images().creates.length;
    const blocked = expectNew(/relay 已暂停：/);
    tg.userSends(owner, '/image');
    await blocked();
    expect(images().creates.length).toBe(creates);
    await confirmBudget(100);
  });

  it("books a free picture by its task, not by another process's spending meanwhile", async () => {
    images().config.freeLeft = 1;
    images().stepMs = 300;
    const allowance = state.data.allowance.spent;
    const spent = state.data.billing.spent;
    const started = expectNew(/正在生成图片（免费）/);
    tg.userSends(owner, '/image');
    await started();
    // A `yomi image` in another terminal spends 200 gems while this picture is made.
    mock.state.gems -= 200;
    await tg.waitFor(() => !busy() && kept() === null);
    images().stepMs = 60;
    expect(lastTask().billing).toBe(0);
    expect(state.data.billingPause).toBe('');
    expect(state.data.allowance.spent).toBe(allowance);
    expect(state.data.billing.spent).toBe(spent);
    expect(state.data.pending).toBeNull();
  });

  it('asks for no picture, not even a free one, when the balance cannot be read', async () => {
    images().config.freeLeft = 1;
    const creates = images().creates.length;
    mock.state.walletFailures = 2;
    const refused = expectNew(/暂时读不到钻石余额/);
    tg.userSends(owner, '/image');
    await refused();
    expect(images().creates.length).toBe(creates);
    expect(kept()).toBeNull();
    expect(state.data.pending).toBeNull();
  });

  it('keeps a request whose refusal still carries a task, as an unknown outcome', async () => {
    images().config.freeLeft = 1;
    images().failNext = {
      base_resp: { status_code: 1504000001, status_msg: 'busy' },
      task: { task_id: 990001, generation_status: 1 },
    };
    const unknown = expectNew(/没能确认生图请求的结果/);
    tg.userSends(owner, '/image');
    await unknown();
    expect(kept()?.taskId).toBe('');
    expect(state.data.pending).not.toBeNull();
    const forgotten = expectNew(/已放弃追踪上一次的生图请求/);
    tg.userSends(owner, '/image forget');
    await forgotten();
    expect(kept()).toBeNull();
    // Its pending charge is still settled (measured) before the next message goes.
    expect(state.data.pending).not.toBeNull();
    const spent = state.data.billing.spent;
    tg.userSends(owner, '放弃之后的一句');
    await said(/放弃之后的一句/);
    await tg.waitFor(() => !busy() && state.data.pending === null);
    expect(state.data.billing.spent).toBe(spent);
  });
});

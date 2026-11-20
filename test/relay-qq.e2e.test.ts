import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { configDir } from '../src/core/files.js';
import { lockHolder } from '../src/core/lock.js';
import { sha256 } from '../src/core/state.js';
import { ParagraphType } from '../src/im/models.js';
import { chatImageStore, type MockChatImage } from '../src/mock/gen/chatImage.js';
import { solidPngBytes } from '../src/mock/gen/png.js';
import { type MockQq, startMockQq } from '../src/mock/qq.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import { QqChannel, type QqChannelOptions } from '../src/relay/channels/qq.js';
import { type ChannelHost, type InboundEvent, RelayStopped } from '../src/relay/channels/types.js';
import { ImFeed } from '../src/relay/hub/feed.js';
import { Ledger, stateLedgerStore } from '../src/relay/hub/ledger.js';
import { PolicyService } from '../src/relay/hub/policy.js';
import { SessionGate } from '../src/relay/hub/session.js';
import { PairingCode } from '../src/relay/pairing.js';
import { BotRegistry } from '../src/relay/registry.js';
import { Relay, type RelayOptions } from '../src/relay/relay.js';
import { RelayState, relayStatePath } from '../src/relay/state.js';
import { relayTexts } from '../src/relay/texts.js';
import { memoryIo } from './helpers/io.js';

/**
 * `yomi relay --channel qq` end to end, against the mock gateway (src/mock/server.ts) and the mock
 * QQ (src/mock/qq.ts: token, REST, WebSocket gateway): `--set-app`, pairing with `/pair`, a
 * streamed reply (the AI notice first, also after the message waited for another bot's
 * measurement), passive replies within their window and count, active messages and the queue,
 * `/budget` answered with a typed code (also after a restart), `/image`, content refusals, a bot
 * without the private-chat intent, and a Resume after a restart that relays nothing twice; then
 * the presenter on its own (recall when the stream diverged, the first message's length, QQ's
 * stream rate limit). Nothing reaches the network.
 */

let mock: MockServer;
let qq: MockQq;
let dir: string;
const saved: Record<string, string | undefined> = {};
const OWNER = 'OPENID_OWNER_E2E';
const STRANGER = 'OPENID_STRANGER_E2E';
const npc = MOCK_NPCS.single;
const NOTICE =
  '你正在与 AI 角色「林夏」聊天：回复由 AI 生成，不是真人。陪伴类聊天机器人可能不适合部分未成年人。';
const NARRATION = '（她合上书，看着你。）';

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  }
}

async function run(args: string[], options: Parameters<typeof memoryIo>[0] = {}) {
  process.exitCode = undefined;
  const terminal = memoryIo(options);
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
}

/** The web authorize page's part of `yomi login`, as the other e2e tests do it. */
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The QQ bots the registry holds, by AppID. */
const registered = (appId: string) => {
  const { account } = createContext(memoryIo().io, {});
  return BotRegistry.open(account).byPlatform('qq', appId);
};
const sends = () =>
  mock.state.requests.filter((request) => request.path === 'conversation/send_message');
const shown = (openid = OWNER) => qq.messages(openid).filter((message) => !message.recalled);
const said = (pattern: RegExp, openid = OWNER) =>
  qq.waitFor(() => shown(openid).find((message) => pattern.test(message.text)), 10_000);
/** Waits for one more message matching `pattern`; call before sending. */
function expectNew(pattern: RegExp, openid = OWNER) {
  const matching = () => shown(openid).filter((message) => pattern.test(message.text));
  const before = matching().length;
  return () => qq.waitFor(() => matching().length > before && matching().at(-1), 10_000);
}
/** The finished reply streamed to the message `id`. */
const streamed = (id: string) =>
  qq.waitFor(
    () =>
      qq
        .messages(OWNER)
        .find((message) => message.kind === 'stream' && message.replyTo === id && message.done),
    15_000,
  );

const running: (() => Promise<unknown>)[] = [];

/** A relay on a QQ channel with short timings, paired with OWNER unless `unpaired`. */
async function start(
  channelOptions: Partial<QqChannelOptions> = {},
  relayOptions: Partial<RelayOptions> = {},
  { fresh = true, unpaired = false, origin = qq } = {},
) {
  const context = createContext(memoryIo().io, {}, { client: 'relay-qq', channel: 'cli_relay' });
  const channel = new QqChannel({
    appId: origin.appId,
    secret: origin.secret,
    apiOrigin: origin.origin,
    streamIntervalMs: 100,
    retryDelayMs: 50,
    backgroundFlushMs: 50,
    closeWaitMs: 1000,
    gateway: {
      backoffMinMs: 50,
      backoffMaxMs: 200,
      identifyIntervalMs: 0,
      invalidSessionDelayMs: () => 50,
    },
    ...channelOptions,
  });
  const path = relayStatePath(context.account, channel.scope);
  if (fresh) rmSync(path, { force: true });
  const state = new RelayState(path, channel.scope, context.account, 'qq');
  if (!unpaired && !state.data.owner)
    state.update({
      owner: { userId: OWNER, chatId: OWNER, name: '', language: '', pairedAt: Date.now() },
    });
  const logs: string[] = [];
  const relay = new Relay(context.gateway, channel, state, {
    maxSpend: 50,
    characterId: npc,
    pairing: null,
    replyTimeoutMs: 5000,
    intervalMs: 30,
    staleMs: 10 * 60 * 1000,
    pollTimeoutSeconds: 1,
    drafts: true,
    language: 'zh-Hans',
    log: (line) => logs.push(line),
    resumeCheckMs: 100,
    ...relayOptions,
  });
  const controller = new AbortController();
  const connections = origin.identifies + origin.resumes;
  const sockets = mock.state.sockets;
  const done = relay.run(controller.signal).then(
    () => null,
    (error: unknown) => error,
  );
  const stop = () => {
    controller.abort();
    return done;
  };
  running.push(stop);
  await origin.waitFor(
    () => origin.identifies + origin.resumes > connections && mock.state.sockets > sockets,
  );
  // Let READY (or RESUMED) reach the channel.
  await sleep(50);
  return { relay, state, logs, channel, stop, done, path };
}

/** The owner chats: forwarded, and the streamed reply finished before this returns. */
async function chatted(text: string) {
  const before = sends().length;
  const id = qq.userSends(OWNER, text);
  await qq.waitFor(() => sends().length > before, 10_000);
  expect(sends().at(-1)!.body.text).toBe(text);
  return { id, reply: await streamed(id) };
}

beforeAll(async () => {
  mock = await startMockServer();
  qq = await startMockQq({ botName: 'Lin QQ bot' });
  dir = mkdtempSync(join(tmpdir(), 'yomi-relay-qq-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_QQ_API_ORIGIN: qq.origin,
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

afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
  // A failure a test set up and did not use must not hit the next test.
  qq.clearFailures();
});

afterAll(async () => {
  await qq.shutdown();
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('yomi relay --channel qq', () => {
  it('saves the AppID and AppSecret from stdin after checking them and the private-chat permission', async () => {
    const identifies = qq.identifies;
    const saved = await run(
      ['relay', '--channel', 'qq', '--set-app', '--token-stdin', '--allow-file-store'],
      { input: [qq.appId, qq.secret] },
    );
    expect(saved.code).toBe(0);
    expect(saved.out).toContain('已保存 QQ bot Lin QQ bot 的 AppID 和 AppSecret');
    expect(saved.out).toContain('接下来在 QQ 里加这个 bot 为好友');
    expect(saved.err).not.toContain('单聊');
    expect(saved.out + saved.err).not.toContain(qq.secret);
    // The gateway was tried once with the private-chat intent.
    expect(qq.identifies).toBe(identifies + 1);
    const stored = readFileSync(join(dir, 'secrets.json'), 'utf8');
    expect(stored).toContain(`qq-bot:`);
    expect(stored).toContain(qq.appId);

    const wrong = await run(
      ['relay', '--channel', 'qq', '--set-app', '--token-stdin', '--allow-file-store'],
      { input: [qq.appId, 'not-the-secret-1234'] },
    );
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('QQ 不接受这个 AppID/AppSecret');
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain('not-the-secret');
    const badId = await run(
      ['relay', '--channel', 'qq', '--set-app', '--token-stdin', '--allow-file-store'],
      { input: ['12ab', qq.secret] },
    );
    expect(badId.code).toBe(1);
    expect(badId.err).toContain('这不像是 QQ 机器人的 AppID');

    // Set again for the channel's one bot: only its own AppID. Another one is refused before QQ
    // is asked (no token, no probe), and nothing is saved.
    const closed = await startMockQq({ c2c: false, appId: '102000077' });
    try {
      setEnv({ YOMI_QQ_API_ORIGIN: closed.origin });
      const refused = await run(
        ['relay', '--channel', 'qq', '--set-app', '--token-stdin', '--allow-file-store'],
        { input: [closed.appId, closed.secret] },
      );
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('这些凭证属于另一个 bot');
      expect(closed.identifies).toBe(0);
      // Added as a bot of its own (a name given): saved, with a warning about its intents.
      const warned = await run(
        [
          'relay',
          '--channel',
          'qq',
          '--set-app',
          '--bot',
          'closed',
          '--token-stdin',
          '--allow-file-store',
        ],
        { input: [closed.appId, closed.secret] },
      );
      expect(warned.code).toBe(0);
      expect(warned.err).toContain(
        'QQ 说这个 bot 没有私聊（单聊）消息事件的权限（4014），但 QQ 的文档没有写这个权限在哪里开启',
      );
      expect(warned.err).toContain('AppID 和 AppSecret 已照常保存');
      expect(warned.out).toContain('已添加 bot closed，还没有绑定角色');
      expect(registered(closed.appId)).toMatchObject({ name: 'closed', scope: 'qq:102000077' });
      const listed = await run(['relay', '--list', '--channel', 'qq']);
      expect(listed.out).toContain('closed  QQ');
      expect(listed.out).not.toContain('凭证属于另一个 bot');
      // Never added twice: refused before QQ is asked again.
      const identifies = closed.identifies;
      const twice = await run(
        [
          'relay',
          '--channel',
          'qq',
          '--set-app',
          '--bot',
          'again',
          '--token-stdin',
          '--allow-file-store',
        ],
        { input: [closed.appId, closed.secret] },
      );
      expect(twice.code).toBe(1);
      expect(twice.err).toContain('这个 bot 已经登记在这台电脑上了，名字是 "closed"');
      expect(closed.identifies).toBe(identifies);
      // Set again while QQ calls the intent invalid (4013): an outdated yomi, not a permission.
      closed.closeIdentifyWith(4013);
      const outdated = await run(
        [
          'relay',
          '--channel',
          'qq',
          '--set-app',
          '--bot',
          'closed',
          '--token-stdin',
          '--allow-file-store',
        ],
        { input: [closed.appId, closed.secret] },
      );
      closed.closeIdentifyWith(null);
      expect(outdated.code).toBe(0);
      expect(outdated.err).toContain(
        '这个版本的 yomi 和 QQ 网关的协议对不上（4013，无效的 intent）：请用 npm install -g @yomichat/cli 升级 yomi。AppID 和 AppSecret 已照常保存。',
      );
      expect(outdated.err).not.toContain('权限');
      expect(outdated.out + outdated.err).not.toContain(closed.secret);
      // Two bots now: which one to set again is asked.
      const which = await run(
        ['relay', '--channel', 'qq', '--set-app', '--token-stdin', '--allow-file-store'],
        { input: [closed.appId, closed.secret] },
      );
      expect(which.code).toBe(1);
      expect(which.err).toContain('QQ 有多个 bot（qq-0001、closed）');
      const forgotten = await run(['relay', '--forget', '--bot', 'closed']);
      expect(forgotten.code).toBe(0);
      expect(registered(closed.appId)).toBeUndefined();
    } finally {
      setEnv({ YOMI_QQ_API_ORIGIN: qq.origin });
      await closed.shutdown();
    }
    const again = await run(
      ['relay', '--channel', 'qq', '--set-app', '--token-stdin', '--allow-file-store'],
      { input: [qq.appId, qq.secret] },
    );
    expect(again.code).toBe(0);
    // Its own AppID again: the same bot (the next test runs it).
    expect(again.out).not.toContain('已添加');
    expect(registered(qq.appId)).toMatchObject({ scope: `qq:${qq.appId}`, label: 'Lin QQ bot' });
  });

  it("says what QQ's refusal of the token means, when the AppID and AppSecret are set and when a run starts", async () => {
    const identifies = qq.identifies;
    const secrets = readFileSync(join(dir, 'secrets.json'), 'utf8');
    const setApp = (code: number, message = `error ${code}`) => {
      qq.failNext('token', { code, message });
      return run(['relay', '--channel', 'qq', '--set-app', '--token-stdin', '--allow-file-store'], {
        input: [qq.appId, qq.secret],
      });
    };
    const gone = await setApp(100007, 'appid invalid');
    expect(gone.code).toBe(1);
    expect(gone.err).toContain('QQ 说没有这个机器人，或者它已被封禁、删除（100007）');
    expect(gone.err).toContain('删除后 7 天内可以在 https://q.qq.com/qqbot/openclaw/ 恢复');
    expect(qq.calls.at(-1)).toMatchObject({ path: '/app/getAppAccessToken', status: 200 });
    const noBot = await setApp(10004);
    expect(noBot.code).toBe(1);
    expect(noBot.err).toContain('QQ 说没有这个机器人，或者它已被封禁、删除（10004）');
    const busy = await setApp(100001);
    expect(busy.code).toBe(1);
    expect(busy.err).toContain('QQ 说请求太频繁（100001）：等一会儿再试（QQ 没说要等多久）');
    const other = await setApp(11298, 'ip\u001b[2J not allowed');
    expect(other.code).toBe(1);
    expect(other.err).toContain('QQ 拒绝了换取令牌（11298：ip?[2J not allowed）');
    expect(other.err).toContain('「服务器 IP 白名单」里加过 IP，有可能是白名单拦了（未确认）');
    expect(other.err).not.toContain('\u001b');
    const wrong = await setApp(100016);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('QQ 不接受这个 AppID/AppSecret');
    for (const result of [gone, noBot, busy, other, wrong])
      expect(result.out + result.err).not.toContain(qq.secret);
    // Refused before the gateway is tried, and nothing is saved.
    expect(qq.identifies).toBe(identifies);
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(secrets);

    // A run's start says the same (openBot's verify), and runs nothing.
    qq.failNext('token', { code: 100007 });
    const started = await run(['relay', '--channel', 'qq', '--allow-file-store']);
    expect(started.err).toContain('QQ 说没有这个机器人，或者它已被封禁、删除（100007）');
    expect(started.out).not.toContain('relay 运行中');
    expect(qq.identifies).toBe(identifies);
  });

  it('pairs with /pair in the private chat, ignores strangers, and stops when QQ delists the bot', async () => {
    const terminal = memoryIo();
    const identifies = qq.identifies + qq.resumes;
    const pending = main(
      ['relay', '--channel', 'qq', '--allow-file-store', '--pair', '--character', npc],
      terminal.io,
    );
    const code = (await terminal.waitFor(/\/pair ([A-Z2-9]{4}-[A-Z2-9]{4})/))[1];
    expect(terminal.out).toContain('先在 QQ 里加 bot（Lin QQ bot）为好友');
    await terminal.waitFor(/relay 运行中：Lin QQ bot ⇄ Yomi/);
    expect(terminal.out).toContain('仅限个人使用');
    await qq.waitFor(() => qq.identifies + qq.resumes > identifies);
    await sleep(100);
    qq.userSends(STRANGER, '/pair AAAA-BBBB');
    await said(/配对码不对或已过期/, STRANGER);
    // QQ may put a space before the text: the command is trimmed.
    const pairing = qq.userSends(OWNER, `/pair ${code}`, { lead: ' ' });
    const paired = await said(/已配对/);
    expect(paired.text).toContain('（Lin QQ bot）');
    expect(paired.replyTo).toBe(pairing);
    expect(paired.kind).toBe('text');
    // The welcome in three of the four passive replies: the pairing, the character and the AI
    // notice in one; the cover; the introduction and the opening.
    await said(/你来了。$/);
    const answered = qq.messages(OWNER).filter((message) => message.replyTo === pairing);
    expect(answered.map((message) => [message.kind, message.seq])).toEqual([
      ['text', 1],
      ['media', 2],
      ['text', 3],
    ]);
    expect(answered[0].text).toMatch(
      new RegExp(`^已配对：[^]*\\n\\n当前角色：林夏（ID ${npc}）\\n\\n${NOTICE}$`),
    );
    const served = await fetch(`${mock.origin}/media/cover-${npc}.png`);
    expect(answered[1].bytes!.equals(Buffer.from(await served.arrayBuffer()))).toBe(true);
    expect(answered[1].text).toBe('');
    expect(answered[2].text).toBe(
      '旧书店的店主，雨天总坐在窗边看书。\n\n（雨停了，书店的门铃响了一声。）\n\n你来了。',
    );
    const strangerMessages = qq.messages(STRANGER).length;
    qq.userSends(STRANGER, '你好');
    await sleep(300);
    expect(qq.messages(STRANGER)).toHaveLength(strangerMessages);
    qq.close(4914);
    expect(await pending).toBe(0);
    expect(terminal.err).toContain('QQ 说这个 bot 已下架，只能连接沙箱（4914）');
    expect(terminal.err).toContain('已配对：QQ 用户 ' + OWNER);
  });

  it('stops when the bot may not receive private chats (4014), without retrying', async () => {
    const closed = await startMockQq({ c2c: false, appId: '102000078' });
    try {
      const context = createContext(
        memoryIo().io,
        {},
        { client: 'relay-qq', channel: 'cli_relay' },
      );
      const channel = new QqChannel({
        appId: closed.appId,
        secret: closed.secret,
        apiOrigin: closed.origin,
      });
      const path = relayStatePath(context.account, channel.scope);
      const state = new RelayState(path, channel.scope, context.account, 'qq');
      const relay = new Relay(context.gateway, channel, state, {
        maxSpend: 0,
        characterId: npc,
        pairing: null,
        replyTimeoutMs: 5000,
        intervalMs: 30,
        staleMs: 600_000,
        pollTimeoutSeconds: 1,
        drafts: true,
        language: 'zh-Hans',
        log: () => undefined,
      });
      const error = await relay
        .run(new AbortController().signal)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RelayStopped);
      expect(error).toMatchObject({ reason: 'intents' });
      expect((error as Error).message).toContain('4014');
      expect(closed.calls.filter((call) => call.path === '/gateway/bot')).toHaveLength(1);
    } finally {
      await closed.shutdown();
    }
  });
});

describe('the QQ relay', () => {
  it('lets /report name the latest reply a pairing welcome shows, though QQ held it', async () => {
    // A conversation from the app: the welcome shows its latest reply.
    const other = mock.replyFromAnotherDevice(npc, '书店几点关门');
    await qq.waitFor(
      () =>
        mock.state.chats
          .get(npc)
          ?.messages.some((message) => String(message.mid) === other.assistantMid),
      10_000,
    );
    const pairing = new PairingCode();
    const { state } = await start({}, { pairing }, { unpaired: true });
    const welcomed = expectNew(/书店几点关门？这个问题，我想了很久。$/);
    qq.userSends(OWNER, `/pair ${pairing.display}`);
    await welcomed();
    expect(state.lastReplyMid).toBe(other.assistantMid);
    const next = expectNew(/^选择举报原因/);
    qq.userSends(OWNER, '/report');
    const question = await next();
    expect(question.text).toContain('举报这个角色');
  });

  it('streams the finished paragraphs of a reply, with the AI notice as its first lines', async () => {
    await start();
    const before = qq.messages(OWNER).length;
    const { id, reply } = await chatted('SLOW 窗外的雨');
    const chunks = qq.streams(OWNER).filter((chunk) => chunk.replyTo === id);
    // The narration grew over several updates: streamed once complete, then the end.
    expect(chunks.map((chunk) => chunk.state)).toEqual([1, 10]);
    expect(chunks[0]).toMatchObject({ index: 0, streamMsgId: '', seq: 1 });
    expect(chunks[0].content).toBe(`${NOTICE}\n\n${NARRATION}`);
    // Each chunk names the id the previous response returned.
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index].streamMsgId).toBe(reply.ids[index - 1]);
      expect(chunks[index].seq).toBe(1);
    }
    expect(reply.text).toBe(`${NOTICE}\n\n${NARRATION}\n\nSLOW 窗外的雨？这个问题，我想了很久。`);
    for (const chunk of chunks) {
      expect(chunk.content).not.toMatch(/RAW-UNREVIEWED|THINKING/);
      if (chunk.content.includes('（')) expect(chunk.content).toContain(NARRATION);
    }
    // One passive reply for the notice and the reply together.
    expect(qq.messages(OWNER).slice(before)).toHaveLength(1);
  });

  it('keeps the AI notice before the reply when the message waited for another bot', async () => {
    // Services shared with another bot of the sign-in, which holds the spend window for a while.
    const { gateway, account } = createContext(
      memoryIo().io,
      {},
      { client: 'relay-qq', channel: 'cli_relay' },
    );
    const log = () => undefined;
    const session = new SessionGate(gateway, { log });
    const feed = new ImFeed(gateway, session, { log });
    const ledgerPath = join(dir, 'hub-ledger.json');
    rmSync(ledgerPath, { force: true });
    const ledger = new Ledger(stateLedgerStore(new RelayState(ledgerPath, 'hub', account, 'qq')));
    ledger.useAllowance(50, false);
    const hub = { feed, session, policy: new PolicyService(gateway), ledger };
    const started = start({}, { hub });
    feed.start();
    running.push(async () => {
      feed.close();
      session.close();
    });
    await started;
    const held = ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    const earlier = qq.messages(OWNER).length;
    const id = qq.userSends(OWNER, 'SLOW 窗外的雨');
    // Long enough for the typing the wait shows (QQ: the reply's presenter opened early).
    await sleep(600);
    expect(sends()).toHaveLength(before);
    held.release();
    const reply = await streamed(id);
    expect(reply.text).toBe(`${NOTICE}\n\n${NARRATION}\n\nSLOW 窗外的雨？这个问题，我想了很久。`);
    // The notice went once, in the reply, not after it.
    const since = qq.messages(OWNER).slice(earlier);
    expect(since.filter((message) => message.text.includes(NOTICE))).toHaveLength(1);
  });

  it('answers within the reply window and count, then actively, then at the next message', async () => {
    const { state, logs } = await start({ passiveMax: 3, passiveWindowMs: 1500 });
    const help = qq.userSends(OWNER, '/help');
    const helped = await said(/\/budget/);
    expect(helped).toMatchObject({ replyTo: help, seq: 1, kind: 'text' });
    mock.pushAside(npc, { scene: 'ai_disclosure', text: '提醒一' });
    expect(await said(/提醒一/)).toMatchObject({ replyTo: help, seq: 2 });
    mock.pushAside(npc, { scene: 'break_reminder', text: '提醒二' });
    expect(await said(/提醒二/)).toMatchObject({ replyTo: help, seq: 3 });
    // The message's replies are used up: an active message.
    mock.pushAside(npc, { scene: 'minor_notice', text: '提醒三' });
    expect(await said(/提醒三/)).toMatchObject({ replyTo: '', seq: 0 });
    // The owner switched active messages off: it waits for their next message.
    qq.rejectActive(OWNER);
    mock.pushAside(npc, { scene: 'crisis_support', text: '提醒四' });
    await qq.waitFor(() => logs.some((line) => line.includes('主人关闭了 QQ 主动消息')));
    expect(shown().some((message) => message.text.includes('提醒四'))).toBe(false);
    expect(state.data.channel?.activeOff).toBe(true);
    const price = qq.userSends(OWNER, '/price');
    const delivered = await said(/你不在时的消息（1 条）：\n\n提醒四/);
    expect(delivered.replyTo).toBe(price);
    // The queue and the answer share one message.
    expect(delivered.text).toMatch(/提醒四\n\n[\s\S]*每条回复/);
    expect(qq.messages(OWNER).filter((message) => message.replyTo === price)).toHaveLength(1);
    // Switched back on (C2C_MSG_RECEIVE), and the window is over: active again.
    qq.receiveOn(OWNER);
    await qq.waitFor(() => state.data.channel?.activeOff === false);
    await sleep(1600);
    mock.pushAside(npc, { scene: 'ai_disclosure', text: '提醒五' });
    expect(await said(/提醒五/)).toMatchObject({ replyTo: '' });
  });

  it('confirms /budget with a typed code; a wrong number, a stray "1" and "haha 2" do not', async () => {
    const first = await start();
    let next = expectNew(/最多花 10 钻石吗/);
    qq.userSends(OWNER, '/budget 10');
    const question = await next();
    const code = /回复「([A-Z2-9]{4}) 1」/.exec(question.text)![1];
    expect(question.text).toContain(`\n1. 允许最多 10 钻石\n2. 取消\n回复「${code} 1」`);
    next = expectNew(/没有这个选项/);
    qq.userSends(OWNER, `${code} 3`);
    await next();
    await chatted('1');
    await chatted('haha 2');
    expect(first.state.data.billing.mode).toBe('open');
    next = expectNew(/已设置预算 10 钻石/);
    // A Chinese keyboard's full-width colon and digit.
    qq.userSends(OWNER, `${code}：１`);
    await next();
    expect(first.state.data.billing).toMatchObject({ mode: 'paid', budget: 10 });
    next = expectNew(/这个选择已过期/);
    qq.userSends(OWNER, `${code.toLowerCase()} 1`);
    await next();
    // A restart between the question and the answer: "expired", nothing relayed.
    next = expectNew(/最多花 20 钻石吗/);
    qq.userSends(OWNER, '/budget 20');
    const again = /回复「([A-Z2-9]{4}) 1」/.exec((await next()).text)![1];
    await first.stop();
    const second = await start({}, {}, { fresh: false });
    const before = sends().length;
    next = expectNew(/这个选择已过期/);
    qq.userSends(OWNER, `${again} 1`);
    await next();
    expect(sends().length).toBe(before);
    expect(second.state.data.billing).toMatchObject({ mode: 'paid', budget: 10 });
  });

  it('uploads the /image picture and sends it as a passive media message', async () => {
    await start();
    await chatted('画一下窗外的雨');
    const images = (): MockChatImage => chatImageStore(mock.gen);
    const started = expectNew(/正在生成图片（免费）/);
    const asked = qq.userSends(OWNER, '/image');
    await started();
    const photo = await qq.waitFor(
      () =>
        qq.messages(OWNER).find((message) => message.kind === 'media' && message.replyTo === asked),
      15_000,
    );
    expect(photo.text).toBe('「林夏」的图片');
    const requestId = String(images().creates.at(-1)!.client_request_id);
    const task = images().tasks.get(images().requests.get(requestId)!)!;
    const served = Buffer.from(await (await fetch(task.url)).arrayBuffer());
    expect(photo.bytes!.equals(served)).toBe(true);
    const upload = qq.calls.filter((call) => call.path === `/v2/users/${OWNER}/files`).at(-1)!;
    expect(upload.body).toMatchObject({ file_type: 1, srv_send_msg: false });
    expect(String(upload.body.file_data)).toBe(`<${served.toString('base64').length}>`);
  });

  it('never sends refused text again, tells the owner once, and pauses after three refusals', async () => {
    const { logs } = await start();
    qq.refuseContent('违规');
    const refusals = () =>
      qq.calls.filter((call) => call.code === 40034006 && call.path.endsWith('/stream_messages'));
    for (const n of [1, 2, 3]) {
      const id = qq.userSends(OWNER, `违规${n}`);
      await streamed(id);
      await qq.waitFor(() => refusals().length === n);
    }
    // Streaming stayed on: each turn streamed its narration before the refused end.
    const notice = await said(/按内容规则拒绝了一条回复，它没有送达/);
    expect(notice.text).toContain('一次运行中被拒 3 次后会暂停转发');
    expect(shown().filter((message) => /按内容规则拒绝了一条回复/.test(message.text))).toHaveLength(
      1,
    );
    expect(qq.messages(OWNER).some((message) => message.text.includes('违规'))).toBe(false);
    expect(refusals()).toHaveLength(3);
    await qq.waitFor(() => logs.some((line) => line.includes('转发已暂停')));
    const before = sends().length;
    const paused = expectNew(/转发已暂停：QQ 拒绝了多条回复/);
    qq.userSends(OWNER, '还在吗');
    await paused();
    expect(sends().length).toBe(before);
    // Commands still work.
    const helped = expectNew(/\/budget/);
    qq.userSends(OWNER, '/help');
    await helped();
  });

  it('keeps the AI notice when the send is refused right after the reply started', async () => {
    await start();
    mock.state.nextSendFailure = {
      base_resp: { status_code: 1504011011, status_msg: 'insufficient gems' },
      model_unavailable_dialog: { title: '钻石不足', content: '去充值' },
    };
    const id = qq.userSends(OWNER, '钻石不够');
    const message = await said(/钻石不足/);
    expect(message.replyTo).toBe(id);
    expect(message.text.startsWith(NOTICE)).toBe(true);
    expect(message.text.indexOf('钻石不足')).toBeGreaterThan(NOTICE.length);
    expect(qq.messages(OWNER).filter((item) => item.replyTo === id)).toHaveLength(1);
  });

  it('relays nothing twice after a restart resumes the session, and says what an offline gap lost', async () => {
    const first = await start();
    const hello = await chatted('你好');
    await first.stop();
    // A crash before the position was written: the Resume replays from the start of the session.
    const file = JSON.parse(readFileSync(first.path, 'utf8')) as {
      channel: { gateway: { seq: number; at: number } };
    };
    expect(file.channel.gateway.seq).toBeGreaterThan(0);
    file.channel.gateway.seq = 0;
    writeFileSync(first.path, JSON.stringify(file));
    const missed = qq.userSends(OWNER, '离线时发的');
    const resumes = qq.resumes;
    const identifies = qq.identifies;
    const second = await start({}, {}, { fresh: false });
    expect(qq.resumes).toBe(resumes + 1);
    expect(qq.identifies).toBe(identifies);
    await streamed(missed);
    expect(sends().filter((request) => request.body.text === '你好')).toHaveLength(1);
    expect(sends().filter((request) => request.body.text === '离线时发的')).toHaveLength(1);
    expect(qq.messages(OWNER).filter((message) => message.replyTo === hello.id)).toHaveLength(1);
    await second.stop();
    // Ten minutes away: the session is not resumed, and the owner learns what was lost.
    const later = JSON.parse(readFileSync(first.path, 'utf8')) as typeof file;
    later.channel.gateway.at = Date.now() - 10 * 60_000;
    writeFileSync(first.path, JSON.stringify(later));
    await start({}, {}, { fresh: false });
    expect(qq.identifies).toBe(identifies + 1);
    const help = qq.userSends(OWNER, '/help');
    const told = await said(/relay 离线期间发给这个 QQ bot 的消息没有收到/);
    expect(told.replyTo).toBe(help);
    expect(told.text).toContain('/budget');
  });
});

describe('the QQ relay after the AppSecret was reset', () => {
  it('stops with the command to set it again', async () => {
    const { done } = await start();
    qq.resetSecret();
    qq.userSends(OWNER, '/help');
    const error = (await done) as RelayStopped;
    expect(error).toBeInstanceOf(RelayStopped);
    expect(error.reason).toBe('token');
    expect(error.message).toContain('yomi relay --channel qq --set-app');
  });
});

describe('the QQ relay when QQ refuses its token', () => {
  const tokenCalls = (from: number) =>
    qq.calls.slice(from).filter((call) => call.path === '/app/getAppAccessToken');

  it('keeps running when the token was asked for too often (100001), waiting QQ’s backoff', async () => {
    // As it starts (the run's check of the bot): said, and the backoff waited out.
    let from = qq.calls.length;
    qq.failNext('token', { code: 100001 });
    const notices: string[] = [];
    const { done, logs } = await start({
      tokenRetryMs: 300,
      notice: (line) => notices.push(line),
    });
    expect(notices).toEqual(['QQ 说换取令牌的请求太频繁（100001），1 秒后重试']);
    let connecting = tokenCalls(from);
    expect(connecting.map((call) => [call.status, call.code])).toEqual([
      [200, 100001],
      [200, 0],
    ]);
    expect(connecting[1].at - connecting[0].at).toBeGreaterThanOrEqual(250);
    let ended = false;
    void done.then(() => {
      ended = true;
    });

    // While running: the reply's token waits the backoff out, and the reply goes.
    qq.expireTokens();
    qq.failNext('token', { code: 100001 });
    from = qq.calls.length;
    const answered = expectNew(/直接发文字，就会转给当前角色/);
    const help = qq.userSends(OWNER, '/help');
    expect((await answered()).replyTo).toBe(help);
    connecting = tokenCalls(from);
    expect(connecting.map((call) => call.code)).toEqual([100001, 0]);
    expect(connecting[1].at - connecting[0].at).toBeGreaterThanOrEqual(250);
    expect(ended).toBe(false);
    expect(logs.join('\n')).not.toContain('发给 QQ 失败');
  });

  it('stops when QQ says the bot is gone (100007)', async () => {
    const { done } = await start();
    qq.expireTokens();
    qq.failNext('token', { code: 100007, message: 'appid invalid' });
    qq.userSends(OWNER, '/help');
    const error = (await done) as RelayStopped;
    expect(error).toBeInstanceOf(RelayStopped);
    expect(error.reason).toBe('gone');
    expect(error.message).toContain('QQ 说没有这个机器人，或者它已被封禁、删除（100007）');
    expect(error.message).not.toContain('重置');
  });

  it('stops with QQ’s own words, safe to print, when it refuses the token with another code', async () => {
    const { done } = await start();
    qq.expireTokens();
    qq.failNext('token', { code: 11298, message: 'ip\u001b[2J not allowed' });
    qq.userSends(OWNER, '/help');
    const error = (await done) as RelayStopped;
    expect(error).toBeInstanceOf(RelayStopped);
    expect(error.reason).toBe('refused');
    expect(error.message).toContain('QQ 拒绝了换取令牌（11298：ip?[2J not allowed）');
    expect(error.message).toContain('有可能是白名单拦了（未确认）');
    expect(error.message).not.toContain('\u001b');
  });

  it('leaves "too many requests" to the run’s own check, which waits it out until the run ends', async () => {
    const notices: string[] = [];
    const channel = new QqChannel({
      appId: qq.appId,
      secret: qq.secret,
      apiOrigin: qq.origin,
      tokenRetryMs: 300,
      notice: (line) => notices.push(line),
      label: 'Registered QQ bot',
    });
    const from = qq.calls.length;
    qq.failNext('token', { code: 100001 });
    // The check before the run (a command's, before any lock): said, never waited for; the bot
    // is the one registered.
    const checking = Date.now();
    await expect(channel.verify()).resolves.toEqual({
      id: qq.appId,
      name: 'Registered QQ bot',
      handle: '',
    });
    expect(Date.now() - checking).toBeLessThan(250);
    expect(tokenCalls(from).map((call) => call.code)).toEqual([100001]);
    expect(notices).toEqual(['QQ 说换取令牌的请求太频繁（100001），1 秒后重试']);
    // The run's own check waits the rest of QQ's backoff out, then asks once.
    await expect(channel.verify(new AbortController().signal)).resolves.toMatchObject({
      name: 'Lin QQ bot',
    });
    const asked = tokenCalls(from);
    expect(asked.map((call) => call.code)).toEqual([100001, 0]);
    expect(asked[1].at - asked[0].at).toBeGreaterThanOrEqual(250);
    expect(notices).toHaveLength(1);

    // A refusal the run's check meets after the wait stops the run, as once connected.
    const gone = new QqChannel({
      appId: qq.appId,
      secret: qq.secret,
      apiOrigin: qq.origin,
      tokenRetryMs: 100,
    });
    qq.failNext('token', { code: 100001 });
    await expect(gone.verify()).resolves.toMatchObject({ id: qq.appId, name: '' });
    qq.failNext('token', { code: 100007, message: 'appid invalid' });
    const stopped = await gone
      .verify(new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(stopped).toBeInstanceOf(RelayStopped);
    expect(stopped).toMatchObject({ reason: 'gone' });
    expect((stopped as Error).message).toContain(
      'QQ 说没有这个机器人，或者它已被封禁、删除（100007）',
    );

    // The run ends during the wait (Ctrl+C): the check ends at once, without asking QQ again.
    const waiting = new QqChannel({ appId: qq.appId, secret: qq.secret, apiOrigin: qq.origin });
    const controller = new AbortController();
    qq.failNext('token', { code: 100001 });
    const checked = waiting.verify(controller.signal).catch((caught: unknown) => caught);
    await qq.waitFor(() => qq.calls.at(-1)?.code === 100001);
    const before = qq.calls.length;
    await sleep(50);
    controller.abort();
    const ended = await Promise.race([checked, sleep(1000).then(() => 'still waiting')]);
    expect(ended).toMatchObject({ reason: 'rateLimited', code: 100001 });
    expect(qq.calls.length).toBe(before);
  });

  it('starts the other bots of a run while one waits out "too many requests", under the run’s locks', async () => {
    // Two QQ bots that may run: the registered one first, then another one added now.
    const harbor = qq.addApp({ botName: 'Harbor QQ bot' });
    const added = await run(
      [
        'relay',
        '--channel',
        'qq',
        '--set-app',
        '--bot',
        'harbor',
        '--token-stdin',
        '--allow-file-store',
      ],
      { input: [harbor.appId, harbor.secret] },
    );
    expect(added.code).toBe(0);
    const { account } = createContext(memoryIo().io, {});
    for (const appId of [qq.appId, harbor.appId]) {
      const scope = `qq:${appId}`;
      new RelayState(relayStatePath(account, scope), scope, account, 'qq').update({
        owner: { userId: OWNER, chatId: OWNER, name: '', language: '', pairedAt: Date.now() },
      });
    }
    const environmentLock = join(
      configDir(),
      'locks',
      `relay-env-${sha256(account).slice(0, 16)}.lock`,
    );
    const from = qq.calls.length;
    const connections = harbor.identifies + harbor.resumes;
    const listeners = new Set(process.listeners('SIGINT'));
    const terminal = memoryIo();
    // The first bot's check meets QQ's "too many requests" (its wait is QQ's 60 s).
    qq.failNext('token', { code: 100001 });
    const started = Date.now();
    const pending = main(['relay', '--channel', 'qq', '--allow-file-store'], terminal.io);
    try {
      // The other bot runs at once, not after the first one's wait.
      await harbor.waitFor(() => harbor.identifies + harbor.resumes > connections, 10_000);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(terminal.err).toContain('QQ 说换取令牌的请求太频繁（100001），60 秒后重试');
      // The waiting bot is named as registered, and it waits under the run's locks: a change to
      // the bots sees a relay running.
      expect(terminal.out).toContain('relay 运行中：Lin QQ bot');
      expect(terminal.out).toContain('relay 运行中：Harbor QQ bot');
      expect(lockHolder(environmentLock)).toMatchObject({ pid: process.pid });
      // QQ is not asked again before its backoff ends.
      await sleep(200);
      expect(tokenCalls(from).map((call) => call.code)).toEqual([100001]);
    } finally {
      // Ctrl+C: the wait ends with the run.
      for (const listener of process.listeners('SIGINT'))
        if (!listeners.has(listener)) (listener as () => void)();
      expect(await pending).toBe(0);
    }
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(terminal.out).toContain('relay 已停止。');
    expect(tokenCalls(from)).toHaveLength(1);
    expect(lockHolder(environmentLock)).toBeNull();
    const forgotten = await run(['relay', '--forget', '--bot', 'harbor']);
    expect(forgotten.code).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------

const narration = (text: string) => ({
  type: ParagraphType.narration,
  text,
  npcId: '',
  npcName: '',
});
const line = (text: string) => ({
  type: ParagraphType.dialogue,
  text,
  npcId: npc,
  npcName: '林夏',
});

describe('the QQ presenter', () => {
  /** A connected channel and one owner message's event, for a presenter of its own. */
  async function opened(options: Partial<QqChannelOptions> = {}, origin = qq) {
    const context = createContext(memoryIo().io, {}, { client: 'relay-qq', channel: 'cli_relay' });
    const channel = new QqChannel({
      appId: origin.appId,
      secret: origin.secret,
      apiOrigin: origin.origin,
      streamIntervalMs: 50,
      retryDelayMs: 50,
      backgroundFlushMs: 50,
      ...options,
    });
    const path = relayStatePath(context.account, `${channel.scope}:presenter`);
    rmSync(path, { force: true });
    const state = new RelayState(path, channel.scope, context.account, 'qq');
    const controller = new AbortController();
    const logs: string[] = [];
    const host: ChannelHost = {
      state,
      store: state.channelStore(),
      texts: relayTexts('zh-Hans'),
      language: 'zh-Hans',
      log: (entry) => logs.push(entry),
      signal: controller.signal,
      staleMs: 600_000,
      owner: () => ({ userId: OWNER, chatId: OWNER }),
      pause: () => undefined,
      resume: () => undefined,
    };
    const connections = origin.identifies + origin.resumes;
    await channel.connect(host);
    running.push(async () => {
      controller.abort();
      await channel.close();
    });
    await origin.waitFor(() => origin.identifies + origin.resumes > connections);
    await sleep(50);
    const events = channel.events()[Symbol.asyncIterator]();
    /** The owner's next message, handled at once (as the core does with a command). */
    const next = async (text = 'x', flush = true) => {
      const id = origin.userSends(OWNER, text);
      const event = (await events.next()).value as InboundEvent & { kind: 'message' };
      if (flush) await channel.flush();
      const presenter = channel.presenter({
        to: OWNER,
        context: event.context,
        render: { characterName: '林夏', group: false },
        log: (entry) => logs.push(entry),
      });
      return { id, event, presenter };
    };
    const { id, event, presenter } = await next();
    return { channel, presenter, id, logs, event, next, state, events };
  }

  const chunksOf = (id: string) => qq.streams(OWNER).filter((chunk) => chunk.replyTo === id);

  it('recalls a stream that review changed, and sends the final text once', async () => {
    const { presenter, id } = await opened();
    presenter.start();
    presenter.update([narration('她看着窗外。'), line('早')]);
    await qq.waitFor(() => chunksOf(id).length === 1);
    // Review changed the paragraph already shown.
    presenter.update([narration('她看着窗外的雨。'), line('早上好')]);
    await sleep(150);
    expect(chunksOf(id)).toHaveLength(1);
    const refs = await presenter.finish([narration('她看着窗外的雨。'), line('早上好')], '');
    const stream = qq
      .messages(OWNER)
      .find((message) => message.kind === 'stream' && message.replyTo === id)!;
    expect(stream).toMatchObject({ recalled: true, done: true, text: '（她看着窗外。）' });
    const final = shown().filter((message) => message.replyTo === id);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      kind: 'text',
      text: '（她看着窗外的雨。）\n\n早上好',
      seq: 2,
    });
    expect(refs).toEqual([final[0].refIdx]);
  });

  it('still sends the final text when the recall is refused, and says so', async () => {
    const { presenter, id, logs } = await opened();
    qq.refuseRecall(true);
    try {
      presenter.start();
      presenter.update([narration('雨。'), line('嗯')]);
      await qq.waitFor(() => chunksOf(id).length === 1);
      await presenter.finish([narration('雪。'), line('嗯')], '');
      expect(logs.some((entry) => entry.includes('没能撤回'))).toBe(true);
      expect(
        shown()
          .filter((message) => message.replyTo === id)
          .map((message) => message.text),
      ).toEqual(['（雨。）', '（雪。）\n\n嗯']);
    } finally {
      qq.refuseRecall(false);
    }
  });

  it('never lets the notices and the reply pass the length limit in the first message', async () => {
    const { channel, presenter, id, event } = await opened({ maxText: 600, prefixMax: 300 });
    // A notice held for this message (the core is handling it): it becomes the prefix.
    (event.context as unknown as { handling: boolean }).handling = true;
    await channel.send(OWNER, { text: '注'.repeat(190) }, event.context);
    (event.context as unknown as { handling: boolean }).handling = false;
    presenter.start();
    const long = [narration('雨'.repeat(500)), line('风'.repeat(300)), line('完')];
    presenter.update(long.slice(0, 2));
    await qq.waitFor(() => chunksOf(id).length >= 1);
    await presenter.finish(long, '');
    for (const chunk of chunksOf(id)) expect(chunk.content.length).toBeLessThanOrEqual(600);
    const messages = qq.messages(OWNER).filter((message) => message.replyTo === id);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.text.length).toBeLessThanOrEqual(600);
    expect(messages[0].text.startsWith('注'.repeat(190) + '\n\n（')).toBe(true);
    const all = messages.map((message) => message.text).join('');
    expect(all.replace(/[注（）\n]/g, '')).toBe('雨'.repeat(500) + '风'.repeat(300) + '完');
  });

  it('waits out QQ’s stream rate limit (50002) and keeps the stream', async () => {
    const { presenter, id } = await opened();
    qq.failNext('stream_messages', { code: 50002, status: 429 });
    presenter.start();
    presenter.update([narration('一'), line('二')]);
    await qq.waitFor(() => chunksOf(id).length === 1, 5000);
    const limited = qq.calls.filter((call) => call.code === 50002);
    expect(limited.length).toBeGreaterThanOrEqual(1);
    const accepted = chunksOf(id)[0];
    // The refused index was not used again.
    expect(accepted.index).toBe(1);
    await presenter.finish([narration('一'), line('二')], '');
    const stream = qq
      .messages(OWNER)
      .find((message) => message.kind === 'stream' && message.replyTo === id)!;
    expect(stream).toMatchObject({ done: true, recalled: false, text: '（一）\n\n二' });
  });

  it('retries a transient failure once with the same msg_seq', async () => {
    const { channel, id, event } = await opened();
    qq.failNext('messages', { code: 40054006 });
    await channel.send(OWNER, { text: '重试一次' }, event.context);
    const message = await said(/重试一次/);
    expect(message).toMatchObject({ replyTo: id, seq: 1 });
    const tries = qq.calls.filter(
      (call) => call.path === `/v2/users/${OWNER}/messages` && call.body.msg_id === id,
    );
    expect(tries.map((call) => [call.code, call.body.msg_seq])).toEqual([
      [40054006, 1],
      [0, 1],
    ]);
  });

  it('sends whole replies for the run when QQ refuses the first chunk', async () => {
    const { channel, presenter, id, logs, next } = await opened();
    qq.failNext('stream_messages', { code: 304061 });
    presenter.start();
    presenter.update([narration('一'), line('二')]);
    await qq.waitFor(() => qq.calls.some((call) => call.code === 304061));
    await presenter.finish([narration('一'), line('二')], '');
    expect(shown().filter((message) => message.replyTo === id)).toMatchObject([
      { kind: 'text', text: '（一）\n\n二' },
    ]);
    expect(logs.some((entry) => entry.includes('QQ 流式消息不可用（304061）'))).toBe(true);
    expect(channel.streamingDisabled).toBe(true);
    const later = await next('y');
    later.presenter.start();
    later.presenter.update([narration('三'), line('四')]);
    await later.presenter.finish([narration('三'), line('四')], '');
    expect(chunksOf(later.id)).toHaveLength(0);
    expect(await said(/（三）\n\n四/)).toMatchObject({ replyTo: later.id, kind: 'text' });
  });

  it('falls back from refused markdown to plain text for the rest of the run', async () => {
    const broken = await startMockQq({ markdownBroken: true, appId: '102000079' });
    try {
      const { channel, presenter, id, logs } = await opened({ markdown: true }, broken);
      expect(channel.caps.format.name).toBe('qq-markdown');
      presenter.start();
      presenter.update([narration('一'), line('二')]);
      await broken.waitFor(() => broken.streams(OWNER).length === 1);
      await presenter.finish([narration('一'), line('二')], '');
      const stream = broken.messages(OWNER).find((message) => message.replyTo === id)!;
      expect(stream).toMatchObject({ kind: 'stream', done: true, text: '（一）\n\n二' });
      expect(broken.streams(OWNER).every((chunk) => !chunk.content.includes('*'))).toBe(true);
      expect(broken.calls.filter((call) => call.code === 40034011)).toHaveLength(1);
      expect(channel.caps.format.name).toBe('plain');
      expect(logs.some((entry) => entry.includes('QQ 不接受 markdown'))).toBe(true);
    } finally {
      await broken.shutdown();
    }
  });

  it('delivers one queued picture per message, the rest as text in the reply’s first lines', async () => {
    const { channel, event, next, state } = await opened();
    // The first message can no longer be answered, and active messages are off.
    (event.context as unknown as { usedUp: boolean }).usedUp = true;
    qq.rejectActive(OWNER);
    const picture = { bytes: solidPngBytes(8, 8, [10, 200, 10]), mime: 'image/png', name: 'p.png' };
    for (const n of [1, 2, 3]) {
      const sent = await channel.sendPhoto(OWNER, picture, `图${n}`, event.context);
      expect(sent.status).toBe('queued');
    }
    expect((state.data.channel?.queue as unknown[]).length).toBe(3);
    qq.allowActive(OWNER);
    // A chat message: the reply starts before the core is done with the message.
    const { id, presenter } = await next('回来了', false);
    presenter.start();
    await channel.flush();
    const photo = await qq.waitFor(() =>
      qq.messages(OWNER).find((message) => message.kind === 'media' && message.replyTo === id),
    );
    expect(photo).toMatchObject({ text: '图1', seq: 1 });
    expect(photo.bytes!.equals(picture.bytes)).toBe(true);
    presenter.update([narration('一'), line('二')]);
    await qq.waitFor(() => chunksOf(id).length === 1);
    await presenter.finish([narration('一'), line('二')], '');
    const reply = qq
      .messages(OWNER)
      .find((message) => message.kind === 'stream' && message.replyTo === id)!;
    expect(reply.seq).toBe(2);
    expect(reply.text).toMatch(
      /^你不在时的消息（2 条）：\n\n图片已经生成[^]*\n\n图片已经生成[^]*\n\n（一）\n\n二$/,
    );
    expect(qq.messages(OWNER).filter((message) => message.replyTo === id)).toHaveLength(2);
  });

  it('sends what it held before a picture sent while the message is still handled', async () => {
    const { channel, next } = await opened();
    // A message the core is still handling (a pairing and its welcome): its sends wait.
    const { id, event } = await next('配对', false);
    await channel.send(OWNER, { text: '先说的话' }, event.context);
    const picture = { bytes: solidPngBytes(8, 8, [10, 10, 200]), mime: 'image/png', name: 'c.png' };
    const sent = await channel.sendPhoto(OWNER, picture, '', event.context);
    expect(sent.status).toBe('sent');
    await channel.send(OWNER, { text: '后说的话' }, event.context);
    await channel.flush();
    await qq.waitFor(
      () => qq.messages(OWNER).filter((message) => message.replyTo === id).length === 3,
    );
    expect(
      qq
        .messages(OWNER)
        .filter((message) => message.replyTo === id)
        .map((message) => [message.kind, message.seq, message.text]),
    ).toEqual([
      ['text', 1, '先说的话'],
      ['media', 2, ''],
      ['text', 3, '后说的话'],
    ]);
  });

  it('hands the held notices back when stopped, and queues what cannot go out at shutdown', async () => {
    const { channel, presenter, event, id, state } = await opened({ closeWaitMs: 300 });
    (event.context as unknown as { handling: boolean }).handling = true;
    await channel.send(OWNER, { text: '先说一句' }, event.context);
    (event.context as unknown as { handling: boolean }).handling = false;
    presenter.start();
    // Stopped before anything was streamed (the send was refused, the watchdog gave up, ...).
    await presenter.stop('后来的话');
    expect(await said(/先说一句\n\n后来的话/)).toMatchObject({ replyTo: id, seq: 1 });
    // At shutdown, QQ cannot be reached: the held text waits for the owner's next message.
    (event.context as unknown as { handling: boolean }).handling = true;
    await channel.send(OWNER, { text: '关机前的话' }, event.context);
    qq.failNext('messages', { code: 500 }, 4);
    await channel.close();
    expect(state.data.channel?.queue).toMatchObject([{ text: '关机前的话' }]);
  });

  it('sends the held notices once when a finished reply is stopped again', async () => {
    const { channel, presenter, event, id } = await opened();
    (event.context as unknown as { handling: boolean }).handling = true;
    await channel.send(OWNER, { text: '只说一次的提示' }, event.context);
    (event.context as unknown as { handling: boolean }).handling = false;
    presenter.start();
    await presenter.finish([line('早')], '');
    expect(await said(/只说一次的提示\n\n早/)).toMatchObject({ replyTo: id });
    // The watchdog after /stop, or shutdown while the reply is being booked, stops it again.
    await presenter.stop();
    await presenter.stop('');
    await sleep(200);
    expect(shown().filter((message) => message.text.includes('只说一次的提示'))).toHaveLength(1);
  });

  it('keeps notices too long to lead the reply before it when nothing was streamed', async () => {
    const { channel, presenter, event, id } = await opened({ prefixMax: 50 });
    const notice = '长'.repeat(80);
    (event.context as unknown as { handling: boolean }).handling = true;
    await channel.send(OWNER, { text: notice }, event.context);
    (event.context as unknown as { handling: boolean }).handling = false;
    presenter.start();
    // One paragraph: never streamed, the reply goes out at finish().
    await presenter.finish([line('早')], '');
    const messages = shown().filter((message) => message.replyTo === id);
    expect(messages.map((message) => message.text)).toEqual([`${notice}\n\n早`]);
  });

  it('sends one reply whole when its first chunk fails twice, and streams the next', async () => {
    const { channel, presenter, id, next } = await opened();
    const failures = () =>
      qq.calls.filter(
        (call) => call.path === `/v2/users/${OWNER}/stream_messages` && call.code === 500,
      ).length;
    const before = failures();
    qq.failNext('stream_messages', { code: 500 }, 2);
    presenter.start();
    presenter.update([narration('一'), line('二')]);
    await qq.waitFor(() => failures() === before + 2);
    await presenter.finish([narration('一'), line('二')], '');
    expect(shown().filter((message) => message.replyTo === id)).toMatchObject([
      { kind: 'text', text: '（一）\n\n二' },
    ]);
    expect(channel.streamingDisabled).toBe(false);
    const later = await next('y');
    later.presenter.start();
    later.presenter.update([narration('三'), line('四')]);
    await qq.waitFor(() => chunksOf(later.id).length === 1);
    await later.presenter.finish([narration('三'), line('四')], '');
    expect(qq.messages(OWNER).find((message) => message.replyTo === later.id)).toMatchObject({
      kind: 'stream',
      done: true,
      text: '（三）\n\n四',
    });
  });

  it('counts the reply window from when a message arrived, not from when it was handled', async () => {
    const { events } = await opened();
    qq.userSends(OWNER, '等了一会儿');
    await sleep(300);
    const event = (await events.next()).value as InboundEvent & { kind: 'message' };
    expect(event.text).toBe('等了一会儿');
    expect(Date.now() - event.context.receivedAt).toBeGreaterThanOrEqual(250);
  });
});

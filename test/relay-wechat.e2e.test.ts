import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { chatImageStore, type MockChatImage } from '../src/mock/gen/chatImage.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import { type MockWechat, startMockWechat } from '../src/mock/wechat.js';
import { RelayStopped } from '../src/relay/channels/types.js';
import { type WechatChannelOptions, WechatChannel } from '../src/relay/channels/wechat.js';
import { WechatLoginApi } from '../src/relay/channels/wechat-api.js';
import { parseCredentials, type WechatCredentials } from '../src/relay/channels/wechat-login.js';
import { aesEcbPaddedSize } from '../src/relay/channels/wechat-media.js';
import { BotRegistry } from '../src/relay/registry.js';
import { Relay, type RelayOptions } from '../src/relay/relay.js';
import { ownerKey, RelayState, relayStatePath } from '../src/relay/state.js';
import { memoryIo } from './helpers/io.js';

/**
 * `yomi relay --channel wechat --experimental` end to end against the mock gateway and the mock
 * iLink (design §8 C6; real HTTP and WebSocket, nothing reaches the network). The tests share one
 * mock pair and run in order: the QR login as a command first (scan, digits, redirect, expiry,
 * refusals, the owner from the scan), then the command running a relay, then the relay itself
 * with short timings (pieces, context tokens, typed codes, the queue, pictures, -14, the cursor).
 */

let mock: MockServer;
let wx: MockWechat;
let dir: string;
const saved: Record<string, string | undefined> = {};
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

/** The web authorize page's part of `yomi login`, as the e2e tests do it. */
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
const context = () => createContext(memoryIo().io, {}, {});
/** The WeChat bot the first login added (`wechat-1`), as the registry holds it now. */
const registered = (name = 'wechat-1') => {
  const { account } = context();
  return BotRegistry.open(account).find(name);
};
/** Its saved login. */
const secret = (name = 'wechat-1') => {
  const { store } = context();
  const record = registered(name);
  return record ? store.getSecret(record.secretName) : null;
};
/** Its relay state: a scope of its own, whoever scans. */
const stateOf = (name = 'wechat-1') => {
  const { account } = context();
  const { scope } = registered(name)!;
  return new RelayState(relayStatePath(account, scope), scope, account, 'wechat');
};
const sends = () =>
  mock.state.requests.filter((request) => request.path === 'conversation/send_message');

/** Polls until `check` returns something truthy (8 s). */
async function until<T>(check: () => T | undefined | null | false, timeoutMs = 8000): Promise<T> {
  return wx.waitFor(check, timeoutMs);
}

/**
 * `--login` at a terminal: answers `yes`, then the test drives the phone. `type` writes a line on
 * stdin (the prompt it answers must already be on screen).
 */
async function startLogin(extra: string[] = []) {
  const terminal = memoryIo({ interactive: true });
  const codes = wx.qrcodes.length;
  const pending = main(
    ['relay', '--channel', 'wechat', '--experimental', '--login', '--allow-file-store', ...extra],
    terminal.io,
  );
  await terminal.waitFor(/输入 yes 继续|Type yes to continue/);
  terminal.stdin.write('yes\n');
  await until(() => wx.qrcodes.length > codes);
  return {
    terminal,
    pending,
    type: (line: string) => terminal.stdin.write(line + '\n'),
  };
}

beforeAll(async () => {
  mock = await startMockServer();
  // uint64 message ids on the wire, as iLink sends them; QR polls held longer than the client's
  // gap between polls that repeat a status.
  wx = await startMockWechat({ longPollMs: 300, qrPollMs: 1200, bigIds: true });
  dir = mkdtempSync(join(tmpdir(), 'yomi-relay-wechat-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_WECHAT_API_ORIGIN: wx.origin,
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
  await wx.close();
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('yomi relay --channel wechat --experimental --login', () => {
  it('needs a terminal and a typed yes before any code is asked for', async () => {
    const codes = wx.qrcodes.length;
    const headless = await run([
      'relay',
      '--channel',
      'wechat',
      '--experimental',
      '--login',
      '--allow-file-store',
    ]);
    expect(headless.code).toBe(1);
    expect(headless.err).toContain('--login 要在终端里运行');
    const terminal = memoryIo({ interactive: true });
    const pending = main(
      ['relay', '--channel', 'wechat', '--experimental', '--login', '--allow-file-store'],
      terminal.io,
    );
    await terminal.waitFor(/输入 yes 继续/);
    expect(terminal.out).toContain('实验功能：微信 ClawBot（iLink）不是给第三方客户端的官方接口');
    expect(terminal.out).toContain('请先在手机微信里阅读 ClawBot 的条款');
    expect(terminal.out).toContain('仅限个人使用');
    expect(terminal.out).toContain('不要在共享屏幕、录屏或直播里显示二维码');
    terminal.stdin.write('y\n');
    expect(await pending).toBe(0);
    expect(terminal.out).toContain('已取消登录');
    expect(wx.qrcodes.length).toBe(codes);
    expect(secret()).toBeNull();
  });

  it('logs in with the QR code in the terminal: the scanner is the owner, the link stays hidden', async () => {
    const login = await startLogin();
    // The code is drawn, not printed as a link.
    await login.terminal.waitFor(/用手机微信扫上面的二维码并确认/);
    const link = wx.qrcodes.at(-1)!;
    expect(login.terminal.out).toMatch(/[█▀▄]{10}/);
    expect(login.terminal.out).not.toContain(link);
    expect(login.terminal.out).not.toContain('qrcode=');
    wx.scan();
    await login.terminal.waitFor(/已扫码，请在手机上确认/);
    wx.confirm();
    expect(await login.pending).toBe(0);
    const out = login.terminal.out;
    expect(out).toContain('已保存微信 ClawBot 的登录（本地文件 0600）');
    expect(out).toContain('扫码的微信号现在是这个 relay 的主人');
    expect(out).toContain('接下来运行 yomi relay --channel wechat --experimental');
    const credentials = parseCredentials(secret())!;
    expect(credentials).toMatchObject({
      baseUrl: `${wx.origin}/`,
      ilinkBotId: wx.botId,
      ilinkUserId: wx.owner,
    });
    expect(out + login.terminal.err).not.toContain(credentials.botToken);
    // A bot of its own, its state under a scope of its own (whoever scans it).
    const record = registered()!;
    expect(record).toMatchObject({ platformId: wx.botId, scope: `bot:${record.key}` });
    expect(out).toContain('已添加 bot wechat-1，还没有绑定角色');
    const state = stateOf();
    expect(state.data.kind).toBe('wechat');
    expect(state.data.botId).toBe(`bot:${record.key}`);
    expect(state.data.owner).toMatchObject({ userId: wx.owner, chatId: wx.owner, name: '' });
    // Bound: owed the welcome, kept by a hash of the scanner.
    expect(state.welcomeOwed).toBe(true);
    expect(JSON.stringify(state.data.welcomed)).not.toContain(wx.owner);
  });

  it('prints the link with --qr-link, asks for the digits on the phone and follows a redirect', async () => {
    const login = await startLogin(['--qr-link']);
    await login.terminal.waitFor(/用手机微信扫上面的二维码并确认/);
    const link = wx.qrcodes.at(-1)!;
    expect(login.terminal.out).toContain(`  ${link}`);
    // The code this computer holds goes with the request for a new one.
    expect(wx.localTokens.at(-1)).toEqual([parseCredentials(secret())!.botToken]);
    const from = wx.calls.length;
    wx.redirectTo(wx.altHost);
    wx.askPin('482913');
    await login.terminal.waitFor(/微信要求确认：输入手机上显示的数字。/);
    login.type('111111');
    await login.terminal.waitFor(/数字不对：请再输入一次手机上显示的数字。/);
    login.type('482913');
    await login.terminal.waitFor(/已扫码，请在手机上确认/);
    // WeChat ended the saved login (a live one held here is answered binded_redirect): the same
    // person's scan signs their ClawBot in again, here under a new id.
    wx.revokeTokens();
    wx.confirm({ botId: 'b2_second@im.bot' });
    expect(await login.pending).toBe(0);
    const polls = wx.calls.slice(from).filter((call) => call.endpoint === 'get_qrcode_status');
    // After the redirect every poll went to the redirect host; each digit went with one poll.
    const redirected = polls.findIndex((call) => call.host === wx.altHost);
    expect(redirected).toBeGreaterThanOrEqual(0);
    expect(polls.slice(redirected).every((call) => call.host === wx.altHost)).toBe(true);
    expect(polls.filter((call) => call.body.verify_code === '111111')).toHaveLength(1);
    expect(polls.filter((call) => call.body.verify_code === '482913')).toHaveLength(1);
    // The same person: their state is kept.
    expect(login.terminal.out).toContain('还是同一个微信号：主人、预算和记录都保留');
    expect(parseCredentials(secret())!.ilinkBotId).toBe('b2_second@im.bot');
  });

  it('shows a new code when one expires, and gives up after three', async () => {
    const before = secret();
    const login = await startLogin();
    const codes = wx.qrcodes.length;
    wx.expireQr();
    await login.terminal.waitFor(/二维码已刷新（第 2 个）/);
    wx.verifyBlocked();
    await login.terminal.waitFor(/二维码已刷新（第 3 个）/);
    expect(login.terminal.out).toContain('二维码过期了。');
    expect(login.terminal.out).toContain('手机上的数字输错太多次了。');
    wx.expireQr();
    expect(await login.pending).toBe(1);
    expect(login.terminal.err).toContain('二维码已经换了 3 次还没有完成登录');
    expect(wx.qrcodes.length).toBe(codes + 2);
    expect(secret()).toBe(before);
  });

  it('refuses a redirect or a baseurl that is not a WeChat host, sending nothing there', async () => {
    const before = secret();
    const redirect = await startLogin();
    wx.redirectTo('ilink.evil.example');
    expect(await redirect.pending).toBe(1);
    expect(redirect.terminal.err).toContain('微信返回的 redirect_host 不是微信的地址');
    expect(wx.calls.some((call) => call.host.includes('evil'))).toBe(false);
    const base = await startLogin();
    wx.revokeTokens();
    wx.confirm({ baseurl: 'https://ilink.evil.example' });
    expect(await base.pending).toBe(1);
    expect(base.terminal.err).toContain('微信返回的 baseurl 不是微信的地址');
    expect(secret()).toBe(before);
    const realname = await startLogin();
    wx.status('need_realname_ticket');
    expect(await realname.pending).toBe(1);
    expect(realname.terminal.err).toContain('不支持绑定别人的 ClawBot');
  });

  it('keeps the saved login when WeChat says it is bound; without one, says how to unbind', async () => {
    const before = secret();
    const bound = await startLogin();
    wx.bindedRedirect();
    expect(await bound.pending).toBe(0);
    expect(bound.terminal.out).toContain('保留已经保存的登录');
    expect(secret()).toBe(before);
    const { store } = context();
    const { secretName } = registered()!;
    store.deleteSecret(secretName);
    const lost = await startLogin();
    expect(wx.localTokens.at(-1)).toEqual([]);
    wx.bindedRedirect();
    expect(await lost.pending).toBe(1);
    expect(lost.terminal.err).toContain('先在手机微信的设置里解除 ClawBot 的绑定，再运行 --login');
    store.setSecret(secretName, before!);
  });

  it('keeps the owner, budget, pending charge and spending total across logins; another scanner replaces the owner', async () => {
    const state = stateOf();
    const pairedAt = state.data.owner!.pairedAt;
    state.update({
      billing: { mode: 'paid', budget: 30, spent: 4, setAt: 1 },
      allowance: { maxSpend: 50, spent: 12, since: 2, unmeasured: 0 },
      pending: { before: 99, mode: 'paid', price: 3, at: 3 },
      channel: { ...state.data.channel, expiredCount: 2, pausedUntil: Date.now() + 60_000 },
    });
    const again = await startLogin();
    wx.confirm({ botId: 'b3_third@im.bot' });
    expect(await again.pending).toBe(0);
    const kept = stateOf().data;
    expect(kept.owner!.pairedAt).toBe(pairedAt);
    expect(kept.billing).toMatchObject({ mode: 'paid', budget: 30, spent: 4 });
    expect(kept.allowance).toMatchObject({ maxSpend: 50, spent: 12 });
    expect(kept.pending).toMatchObject({ before: 99 });
    // Still owed the one welcome (not given yet), and no second one.
    expect(kept.welcomeDue).toBe(ownerKey(wx.owner));
    expect(kept.welcomed).toEqual([]);
    // A new login starts healthy.
    expect(kept.channel?.expiredCount).toBeUndefined();
    expect(kept.channel?.pausedUntil).toBeUndefined();
    // The same bot, its ClawBot id brought up to date.
    expect(registered()).toMatchObject({ platformId: 'b3_third@im.bot' });
    const record = registered()!;
    // What WeChat could not deliver to the owner yet, and a question asked of them: theirs only.
    const queued = { text: '只说给上一个主人', at: Date.now() };
    const asked = {
      code: 'K7QX',
      questionId: 'q1',
      optionIds: ['a'],
      expiresAt: Date.now() + 60_000,
      closedAt: null,
    };
    stateOf().update({
      channel: { ...stateOf().data.channel, queue: [queued], questions: [asked] },
    });
    const other = await startLogin();
    wx.confirm({ userId: 'q7_other@im.wechat' });
    expect(await other.pending).toBe(0);
    expect(other.terminal.out).toContain('扫码的微信号现在是这个 relay 的主人');
    expect(other.terminal.err).toContain(
      'bot wechat-1 换了一个微信号扫码：之前的主人、预算和记录已清除。',
    );
    const fresh = stateOf().data;
    expect(fresh.owner!.userId).toBe('q7_other@im.wechat');
    expect(fresh.welcomeDue).toBe(ownerKey('q7_other@im.wechat'));
    // A new owner starts with no budget: Yomi charges by its normal rules. What the account
    // still has to measure (a pending charge) stays the bot's, for its next start.
    expect(fresh.billing.mode).toBe('open');
    expect(fresh.pending).toMatchObject({ before: 99 });
    // Nothing the bot kept for the previous owner is delivered to the new one.
    expect(fresh.channel?.queue).toBeUndefined();
    expect(fresh.channel?.questions).toBeUndefined();
    // Still the channel's one bot, never refused as another bot's.
    expect(registered()).toMatchObject({ key: record.key, scope: record.scope });
    const listed = await run(['relay', '--list', '--channel', 'wechat']);
    // Ready to run, but bound to no character yet.
    expect(listed.out).toContain('  状态：需要绑定角色：yomi relay --bot wechat-1 --character ID');
    expect(listed.out).not.toContain('凭证属于另一个 bot');
    // Back to the first owner, without the money state (the tests below chat with it).
    stateOf().update({
      billing: { mode: 'open', budget: 0, spent: 0, setAt: 0 },
      allowance: { maxSpend: null, spent: 0, since: 0, unmeasured: 0 },
      pending: null,
    });
    const back = await startLogin();
    wx.confirm();
    expect(await back.pending).toBe(0);
    expect(parseCredentials(secret())!.ilinkUserId).toBe(wx.owner);
    expect(stateOf().data.owner!.userId).toBe(wx.owner);
    // Its bot again (the next test runs it).
    expect(registered()).toMatchObject({ key: record.key });
  });
});

describe('yomi relay --channel wechat --experimental (the command)', () => {
  it('runs marked experimental and personal use only, refuses --login beside it, and stops when WeChat ends the login', async () => {
    const terminal = memoryIo();
    const pending = main(
      [
        'relay',
        '--channel',
        'wechat',
        '--experimental',
        '--allow-file-store',
        '--character',
        npc,
        '--max-spend',
        '20',
      ],
      terminal.io,
    );
    await terminal.waitFor(/relay 运行中：\S+@im\.bot ⇄ Yomi/);
    expect(terminal.out).toContain(`relay 运行中：${wx.botId} ⇄ Yomi`);
    expect(terminal.out).toContain('仅限个人使用：relay 只转发你本人和你自己的 bot 之间的消息。');
    expect(terminal.out).toContain('实验功能：微信 ClawBot（iLink）不是给第三方客户端的官方接口。');
    await until(() => wx.calls.some((call) => call.endpoint === 'msg/notifystart'));
    const from = wx.messages().length;
    const id = wx.userSends('第一句');
    const reply = await until(() => wx.texts().find((text) => text.includes('第一句？')));
    expect(reply).toContain('这个问题，我想了很久');
    // Everything said in answer echoes that message's context_token.
    const answered = wx.messages().slice(from);
    expect(answered.length).toBeGreaterThan(1);
    expect(answered.every((message) => message.context_token === wx.contextOf(id))).toBe(true);
    // The first message after the login: the welcome before the reply (WeChat cannot speak
    // first), the cover encrypted and uploaded like any picture.
    const served = Buffer.from(
      await (await fetch(`${mock.origin}/media/cover-${npc}.png`)).arrayBuffer(),
    );
    expect(answered.map((message) => (message.image ? message.image : message.text))).toEqual([
      expect.stringMatching(/^你正在与 AI 角色「林夏」聊天/),
      served,
      '旧书店的店主，雨天总坐在窗边看书。',
      '（雨停了，书店的门铃响了一声。）\n\n你来了。',
      '（她合上书，看着你。）\n\n第一句？这个问题，我想了很久。',
    ]);
    expect(wx.uploads.at(-1)).toMatchObject({ media_type: 1, rawsize: served.length });
    expect(stateOf().welcomeOwed).toBe(false);
    // The next message: only its reply.
    const second = wx.messages().length;
    const next = wx.userSends('第二句');
    await until(() => wx.texts().find((text) => text.includes('第二句？')));
    const later = wx.messages().slice(second);
    expect(later.every((message) => message.context_token === wx.contextOf(next))).toBe(true);
    expect(later.map((message) => message.text)).toEqual([
      '（她合上书，看着你。）\n\n第二句？这个问题，我想了很久。',
    ]);
    const login = await run([
      'relay',
      '--channel',
      'wechat',
      '--experimental',
      '--login',
      '--allow-file-store',
    ]);
    expect(login.code).toBe(1);
    expect(login.err).toContain(`relay 正在运行（微信 bot ${wx.botId}，进程 ${process.pid}）`);
    // WeChat refuses the token (HTTP 401) three times in a row: the relay ends, saying what to do.
    wx.revokeTokens();
    expect(await pending).toBe(0);
    // The bot's own command, which the CLI takes however many WeChat bots there are.
    expect(terminal.err).toContain(
      '微信结束了这次登录：请运行 yomi relay --bot wechat-1 --login 重新扫码登录。',
    );
  });
});

describe('the welcome over WeChat', () => {
  it('owes nothing to the same scanner logging in again after it', async () => {
    const welcomed = stateOf().data.welcomed;
    expect(welcomed).toEqual([{ owner: ownerKey(wx.owner), npcId: npc, at: expect.any(Number) }]);
    const again = await startLogin();
    wx.confirm();
    expect(await again.pending).toBe(0);
    expect(again.terminal.out).toContain('还是同一个微信号');
    const state = stateOf();
    expect(state.welcomeOwed).toBe(false);
    expect(state.data.welcomed).toEqual(welcomed);
  });
});

describe('one ClawBot per WeChat account', () => {
  /** Another WeChat account: a ClawBot of its own. */
  const lin = 'm2_lin@im.wechat';
  /** The registry, as kept on disk. */
  const registry = () => BotRegistry.open(context().account).data;

  /** `yomi relay --bot NAME --login` at a terminal (no --experimental: the bot's record has it). */
  async function signInAgain(name: string) {
    const terminal = memoryIo({ interactive: true });
    const codes = wx.qrcodes.length;
    const pending = main(['relay', '--bot', name, '--login', '--allow-file-store'], terminal.io);
    await terminal.waitFor(/输入 yes 继续/);
    terminal.stdin.write('yes\n');
    await until(() => wx.qrcodes.length > codes);
    return { terminal, pending };
  }

  it('adds nothing when the scanner already has the ClawBot here: says how to rebind that bot, or unbind on the phone', async () => {
    const first = registered()!;
    const kept = { secret: secret(), state: JSON.stringify(stateOf().data), registry: registry() };
    // The person whose ClawBot is wechat-1 scans to add another bot for another character: WeChat
    // answers that the ClawBot is bound here already (its login goes with the code).
    const add = await startLogin(['--bot', 'wechat-2', '--character', MOCK_NPCS.group]);
    expect(wx.localTokens.at(-1)).toEqual([parseCredentials(kept.secret)!.botToken]);
    wx.confirm();
    expect(await add.pending).toBe(1);
    // WeChat names neither the ClawBot nor the scanner: most likely wechat-1's account, with the
    // character given ready to rebind it; else another account whose ClawBot is bound elsewhere.
    expect(add.terminal.err).toContain(
      `微信说这个 ClawBot 已经绑定了，所以没有添加新的 bot，也没有保存任何东西：一个微信号只有一个 ClawBot。如果扫码的是 bot wechat-1 的微信号，它的登录不变；要和别的角色聊天，给它换绑角色：yomi relay --bot wechat-1 --character ${MOCK_NPCS.group}。如果扫码的是别的微信号，它的 ClawBot 可能绑定在别处：先在手机微信的设置里解除 ClawBot 的绑定，再运行 --login。`,
    );
    expect(add.terminal.err).not.toContain('要重新登录它');
    expect(add.terminal.out).not.toContain('已添加');
    // In English too.
    const english = await startLogin([
      '--bot',
      'wechat-2',
      '--character',
      MOCK_NPCS.group,
      '--lang',
      'en',
    ]);
    wx.confirm();
    expect(await english.pending).toBe(1);
    expect(english.terminal.err).toContain(
      `WeChat says this ClawBot is already bound, so no bot was added and nothing was saved: one WeChat account has one ClawBot. If the code was scanned with the WeChat account of the bot wechat-1, its login is unchanged; to chat with another character, rebind it: yomi relay --bot wechat-1 --character ${MOCK_NPCS.group}. If it was scanned with another WeChat account, that account's ClawBot may be bound somewhere else: unbind ClawBot in WeChat's settings on your phone, then run --login again.`,
    );
    // Nothing written: no bot, no login, no state; the character went to no bot.
    expect(registry()).toEqual(kept.registry);
    expect(registered('wechat-2')).toBeUndefined();
    expect(registered()).toEqual(first);
    expect(registered()!.character).toMatchObject({ npcId: npc });
    expect(secret()).toBe(kept.secret);
    expect(JSON.stringify(stateOf().data)).toBe(kept.state);
    // Still one ClawBot for that person, its login working.
    expect(wx.clawBots().filter((bot) => bot.userId === wx.owner)).toEqual([
      { botId: first.platformId, userId: wx.owner, live: true },
    ]);
  });

  it('signs the same ClawBot in again when WeChat gives it a new login: no bot added, --character not applied', async () => {
    const first = registered()!;
    const before = parseCredentials(secret())!;
    // This computer lost the login: no token goes with the code, and WeChat logs the scanner's
    // one ClawBot in again (the same ilink_bot_id, a new token).
    context().store.deleteSecret(first.secretName);
    const anew = await startLogin(['--bot', 'wechat-3', '--character', MOCK_NPCS.group]);
    expect(wx.localTokens.at(-1)).toEqual([]);
    wx.confirm();
    expect(await anew.pending).toBe(0);
    expect(anew.terminal.err).toContain(
      `这个 ClawBot 已经是 bot wechat-1（一个微信号只有一个 ClawBot）：重新登录了它，没有添加新的 bot（--character 和 --bot 没有生效）。要和别的角色聊天，给它换绑角色：yomi relay --bot wechat-1 --character ${MOCK_NPCS.group}`,
    );
    expect(anew.terminal.out).toContain('还是同一个微信号：主人、预算和记录都保留。');
    expect(anew.terminal.out).not.toContain('已添加');
    expect(registered('wechat-3')).toBeUndefined();
    const after = parseCredentials(secret())!;
    expect(after.ilinkBotId).toBe(before.ilinkBotId);
    expect(after.botToken).not.toBe(before.botToken);
    expect(registered()).toMatchObject({
      key: first.key,
      platformId: first.platformId,
      character: { npcId: npc },
      generation: first.generation + 1,
    });
    expect(wx.clawBots().filter((bot) => bot.userId === wx.owner)).toHaveLength(1);
  });

  it("signs the scanner's bot in again when WeChat gives their ClawBot a new id: no bot added", async () => {
    // Its saved login expired (still kept) or is gone, and WeChat gives the scanner's one ClawBot
    // a new login under a new id: by its owner, it is still wechat-1.
    for (const [lost, newId] of [
      ['expired', 'b7_new@im.bot'],
      ['deleted', 'b8_new@im.bot'],
    ] as const) {
      const first = registered()!;
      const kept = { revision: registry().revision, bots: registry().bots.length };
      wx.revokeTokens();
      if (lost === 'deleted') context().store.deleteSecret(first.secretName);
      const anew = await startLogin(['--bot', 'wechat-2', '--character', MOCK_NPCS.group]);
      wx.confirm({ botId: newId });
      expect(await anew.pending).toBe(0);
      expect(anew.terminal.err).toContain(
        `这个 ClawBot 已经是 bot wechat-1（一个微信号只有一个 ClawBot）：重新登录了它，没有添加新的 bot（--character 和 --bot 没有生效）。要和别的角色聊天，给它换绑角色：yomi relay --bot wechat-1 --character ${MOCK_NPCS.group}`,
      );
      expect(anew.terminal.out).toContain('还是同一个微信号：主人、预算和记录都保留。');
      expect(anew.terminal.out).not.toContain('已添加');
      // No bot added and no character given; wechat-1 now has the new id and a working login.
      expect(registered('wechat-2')).toBeUndefined();
      expect(registry().bots).toHaveLength(kept.bots);
      expect(registry().revision).toBe(kept.revision + 1);
      expect(registered()).toMatchObject({
        key: first.key,
        platformId: newId,
        character: { npcId: npc },
        generation: first.generation + 1,
      });
      expect(parseCredentials(secret())).toMatchObject({
        ilinkBotId: newId,
        ilinkUserId: wx.owner,
      });
      expect(stateOf().data.owner!.userId).toBe(wx.owner);
      expect(wx.clawBots().filter((bot) => bot.userId === wx.owner)).toEqual([
        { botId: newId, userId: wx.owner, live: true },
      ]);
    }
  });

  it("adds another WeChat account's ClawBot as a bot of its own, signs one in again alone, and never links one twice", async () => {
    const first = registered()!;
    const firstToken = parseCredentials(secret())!.botToken;
    // Another person's ClawBot: a bot of its own, bound to its character.
    const add = await startLogin(['--character', MOCK_NPCS.group]);
    // The logins this computer holds go with the code: a ClawBot linked here is not linked twice.
    expect(wx.localTokens.at(-1)).toEqual([firstToken]);
    wx.confirm({ userId: lin, botId: 'b9_second@im.bot' });
    expect(await add.pending).toBe(0);
    expect(add.terminal.out).toContain(
      `已添加 bot wechat-2，固定和雾港（${MOCK_NPCS.group}）聊天。`,
    );
    const second = registered('wechat-2')!;
    expect(second).toMatchObject({
      platformId: 'b9_second@im.bot',
      scope: `bot:${second.key}`,
      character: { npcId: MOCK_NPCS.group },
    });
    expect(second.scope).not.toBe(first.scope);
    expect(stateOf('wechat-2').data.owner!.userId).toBe(lin);
    // The first one's login and state are untouched.
    expect(parseCredentials(secret())!.botToken).toBe(firstToken);
    expect(registered()).toEqual(first);

    // A character another bot has: refused before anything is asked.
    const taken = await run([
      'relay',
      '--channel',
      'wechat',
      '--experimental',
      '--login',
      '--character',
      npc,
      '--allow-file-store',
    ]);
    expect(taken.code).toBe(1);
    expect(taken.err).toContain(`角色 ${npc} 已经绑在 bot "wechat-1" 上`);
    // Either person scanning again to add a bot: WeChat says it is bound and names none, so the
    // bot is not named either; nothing written.
    const revision = registry().revision;
    const twice = await startLogin(['--bot', 'wechat-x']);
    expect(wx.localTokens.at(-1)).toHaveLength(2);
    wx.confirm();
    expect(await twice.pending).toBe(1);
    expect(twice.terminal.err).toContain(
      '微信说这个 ClawBot 已经绑定了，所以没有添加新的 bot，也没有保存任何东西：一个微信号只有一个 ClawBot。如果扫码的是这台电脑上某个 bot 的微信号，它的登录不变；要和别的角色聊天，给它换绑角色：yomi relay --bot 名字 --character ID（名字见 yomi relay --list）。如果扫码的是别的微信号，它的 ClawBot 可能绑定在别处：先在手机微信的设置里解除 ClawBot 的绑定，再运行 --login。',
    );
    const english = await startLogin(['--bot', 'wechat-x', '--lang', 'en']);
    wx.confirm({ userId: lin });
    expect(await english.pending).toBe(1);
    expect(english.terminal.err).toContain(
      "WeChat says this ClawBot is already bound, so no bot was added and nothing was saved: one WeChat account has one ClawBot. If the code was scanned with the WeChat account of a bot on this computer, its login is unchanged; to chat with another character, rebind it: yomi relay --bot NAME --character ID (the names are in yomi relay --list). If it was scanned with another WeChat account, that account's ClawBot may be bound somewhere else: unbind ClawBot in WeChat's settings on your phone, then run --login again.",
    );
    expect(registry().revision).toBe(revision);
    expect(registered('wechat-x')).toBeUndefined();

    // Two bots: --login alone asks which.
    const which = await run(['relay', '--channel', 'wechat', '--experimental', '--login']);
    expect(which.code).toBe(1);
    expect(which.err).toContain('微信有多个 bot（wechat-1、wechat-2）');

    // One signed in again by name: only its token goes with the code. While that login works,
    // WeChat says it is bound and the login is kept.
    const held = await signInAgain('wechat-2');
    expect(wx.localTokens.at(-1)).toEqual([parseCredentials(secret('wechat-2'))!.botToken]);
    wx.confirm({ userId: lin });
    expect(await held.pending).toBe(0);
    expect(held.terminal.out).toContain('保留已经保存的登录');
    expect(registered('wechat-2')!.generation).toBe(second.generation);
    // Once WeChat ended it: the same ClawBot, a new login.
    wx.revokeTokens('b9_second@im.bot');
    const again = await signInAgain('wechat-2');
    wx.confirm({ userId: lin });
    expect(await again.pending).toBe(0);
    expect(again.terminal.out).toContain('还是同一个微信号：主人、预算和记录都保留。');
    expect(again.terminal.out).not.toContain('已添加');
    expect(registered('wechat-2')).toMatchObject({
      platformId: 'b9_second@im.bot',
      generation: second.generation + 1,
    });
    expect(registered()).toEqual(first);
    // One ClawBot per person throughout.
    expect(wx.clawBots().filter((bot) => bot.userId === lin)).toEqual([
      { botId: 'b9_second@im.bot', userId: lin, live: true },
    ]);
    expect(wx.clawBots().filter((bot) => bot.userId === wx.owner)).toHaveLength(1);

    // Removed alone: the other one and its login stay.
    const forgotten = await run(['relay', '--forget', '--bot', 'wechat-2']);
    expect(forgotten.code).toBe(0);
    expect(registered('wechat-2')).toBeUndefined();
    expect(parseCredentials(secret())!.botToken).toBe(firstToken);
  });
});

describe('the relay over WeChat', () => {
  const owner = 'r5_owner@im.wechat';
  let credentials: WechatCredentials;
  let state: RelayState;
  let relay: Relay;
  let controller: AbortController;
  let done: Promise<void>;
  const logs: string[] = [];

  const texts = () => wx.texts(owner);
  /** Waits for a text matching `pattern` beyond those already sent; call before sending. */
  function expectText(pattern: RegExp) {
    const before = texts().length;
    return () =>
      until(() =>
        texts()
          .slice(before)
          .find((text) => pattern.test(text)),
      );
  }

  async function start(
    channel: WechatChannelOptions = {},
    overrides: Partial<RelayOptions> = {},
  ): Promise<WechatChannel> {
    const ctx = createContext(memoryIo().io, {}, { client: 'relay-wechat', channel: 'cli_relay' });
    const wechat = new WechatChannel(credentials, {
      apiOrigin: wx.origin,
      sendIntervalMs: 20,
      typingRefreshMs: 100,
      backoffMs: 50,
      ...channel,
    });
    state = new RelayState(
      relayStatePath(ctx.account, wechat.scope),
      wechat.scope,
      ctx.account,
      'wechat',
    );
    if (!state.data.owner)
      state.update({
        owner: { userId: owner, chatId: owner, name: '', language: '', pairedAt: Date.now() },
      });
    relay = new Relay(ctx.gateway, wechat, state, {
      maxSpend: 50,
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
    const polls = wx.calls.filter((call) => call.endpoint === 'getupdates').length;
    done = relay.run(controller.signal);
    await until(
      () =>
        mock.state.sockets > sockets &&
        wx.calls.filter((call) => call.endpoint === 'getupdates').length > polls,
    );
    return wechat;
  }

  async function stop() {
    controller.abort();
    await done.catch(() => undefined);
  }

  const busy = () => {
    const inside = relay as unknown as { job: unknown; turn: unknown };
    return Boolean(inside.job || inside.turn);
  };

  beforeAll(async () => {
    const api = new WechatLoginApi(wx.origin);
    const code = await api.qrCode([]);
    wx.confirm({ userId: owner, botId: 'b5_relay@im.bot' });
    const status = await api.qrStatus(wx.origin, code.qrcode, '');
    credentials = {
      botToken: status.bot_token!,
      baseUrl: status.baseurl!,
      ilinkBotId: status.ilink_bot_id!,
      ilinkUserId: status.ilink_user_id!,
      savedAt: Date.now(),
    };
  });

  it('shows typing, then the reply in pieces within the limit, each answering the message', async () => {
    await start({ maxText: 25 });
    try {
      const from = wx.messages(owner).length;
      const typingFrom = wx.typing().length;
      const id = wx.userSends('今天天气怎么样', { from: owner });
      await until(() => texts().find((text) => text.includes('今天天气怎么样？')));
      await until(() => !busy());
      const mine = wx.messages(owner).slice(from);
      const shown = mine.map((message) => message.text);
      // The relay's AI notice comes first, as its own message(s); then the reply in two pieces.
      expect(shown.join('')).toMatch(/AI 角色.*可能不适合部分未成年人/s);
      const narration = shown.findIndex((text) => text === '（她合上书，看着你。）');
      expect(narration).toBeGreaterThan(0);
      expect(shown[narration + 1]).toBe('今天天气怎么样？这个问题，我想了很久。');
      for (const text of shown) expect(text!.length).toBeLessThanOrEqual(25);
      // Every message of the turn echoes the context_token of the message it answers.
      const token = wx.contextOf(id);
      expect(mine.every((message) => message.context_token === token)).toBe(true);
      // One at a time, at least the interval apart.
      for (let index = 1; index < mine.length; index++)
        expect(mine[index].at - mine[index - 1].at).toBeGreaterThanOrEqual(15);
      // Typing before the reply, stopped before its first piece.
      const typing = wx.typing().slice(typingFrom);
      expect(typing[0]).toMatchObject({ user: owner, status: 1 });
      const stopped = typing.find((event) => event.status === 2)!;
      expect(stopped.at).toBeLessThanOrEqual(mine[narration].at);
      const everything = JSON.stringify(wx.messages());
      expect(everything).not.toContain('RAW-UNREVIEWED');
      expect(everything).not.toContain('THINKING-SECRET');
      expect(sends().at(-1)!.body).toMatchObject({ text: '今天天气怎么样' });
    } finally {
      await stop();
    }
  });

  it('asks for a budget with a typed code: a wrong number keeps it, a stray number is chat', async () => {
    await start();
    try {
      const asked = expectText(/最多花 30 钻石/);
      wx.userSends('/budget 30', { from: owner });
      const question = await asked();
      expect(question).toContain('1. 允许最多 30 钻石');
      expect(question).toContain('2. 取消');
      const code = /回复「([A-Z2-9]{4}) 1」/.exec(question)![1];
      const invalid = expectText(/没有这个选项/);
      wx.userSends(`${code} 5`, { from: owner });
      await invalid();
      // A full-width digit, as a Chinese keyboard types it.
      const set = expectText(/已设置预算 30 钻石/);
      wx.userSends(`${code.toLowerCase()}：１`, { from: owner });
      await set();
      expect(state.data.billing).toMatchObject({ mode: 'paid', budget: 30 });
      const again = expectText(/这个选择已过期/);
      wx.userSends(`${code} 1`, { from: owner });
      await again();
    } finally {
      await stop();
    }
  });

  it('after a restart an answer to an old question only says it expired', async () => {
    await start();
    let code = '';
    try {
      const asked = expectText(/最多花 20 钻石/);
      wx.userSends('/budget 20', { from: owner });
      code = /回复「([A-Z2-9]{4}) 1」/.exec(await asked())![1];
    } finally {
      await stop();
    }
    await start();
    try {
      const count = sends().length;
      const expired = expectText(/这个选择已过期，请重新发送命令/);
      wx.userSends(`${code} 1`, { from: owner });
      await expired();
      expect(state.data.billing).toMatchObject({ budget: 30 });
      expect(sends().length).toBe(count);
    } finally {
      await stop();
    }
  });

  it('keeps what it cannot send outside the reply window, and says it first at the next message', async () => {
    await start({ replyWindowMs: 1200 });
    try {
      const replied = expectText(/在吗？/);
      wx.userSends('在吗', { from: owner });
      await replied();
      await until(() => !busy());
      await sleep(1300);
      const count = wx.messages(owner).length;
      mock.pushAside(npc, { scene: 'break_reminder', text: '聊了很久了，休息一下吧' });
      await until(() =>
        (state.data.channel?.queue as { text: string }[] | undefined)?.some((item) =>
          item.text.includes('休息一下吧'),
        ),
      );
      expect(wx.messages(owner).length).toBe(count);
      const header = expectText(/你不在时的消息（1 条）/);
      const id = wx.userSends('回来了', { from: owner });
      const delivered = await header();
      expect(delivered).toBe('你不在时的消息（1 条）：\n\n聊了很久了，休息一下吧');
      await until(() => texts().find((text) => text.includes('回来了？')));
      const after = wx.messages(owner).slice(count);
      expect(after[0].text).toBe(delivered);
      expect(after.every((message) => message.context_token === wx.contextOf(id))).toBe(true);
      expect(state.data.channel?.queue).toEqual([]);
      await until(() => !busy());
    } finally {
      await stop();
    }
  });

  it('queues a send WeChat refuses on an old message, and stops using that message', async () => {
    // Messages older than 300 ms count as old here (an hour in the relay).
    await start({ deadAfterMs: 300 });
    try {
      const replied = expectText(/早上好？/);
      wx.userSends('早上好', { from: owner });
      await replied();
      await until(() => !busy());
      await sleep(400);
      const count = wx.messages(owner).length;
      wx.failNext('sendmessage', { body: { ret: -2, errcode: -2, errmsg: 'context expired' } });
      mock.pushAside(npc, { scene: 'break_reminder', text: '喝口水吧' });
      await until(() => logs.some((line) => line.includes('微信不再接受对一条旧消息的回复（-2）')));
      await until(() =>
        (state.data.channel?.queue as { text: string }[] | undefined)?.some(
          (item) => item.text === '喝口水吧',
        ),
      );
      // Later sends no longer try the dead message: straight to the queue.
      mock.pushAside(npc, { scene: 'minor_notice', text: '注意休息' });
      await until(() =>
        (state.data.channel?.queue as { text: string }[] | undefined)?.some(
          (item) => item.text === '注意休息',
        ),
      );
      expect(wx.messages(owner).length).toBe(count);
      const header = expectText(/你不在时的消息（2 条）/);
      wx.userSends('我回来了', { from: owner });
      expect(await header()).toBe('你不在时的消息（2 条）：\n\n喝口水吧\n\n注意休息');
      await until(() => texts().find((text) => text.includes('我回来了？')));
      await until(() => !busy());
    } finally {
      await stop();
    }
  });

  it('uploads a picture encrypted and shows it after its caption', async () => {
    await start();
    try {
      const images: MockChatImage = chatImageStore(mock.gen);
      images.config.freeLeft = 1;
      const replied = expectText(/画一下窗外的雨？/);
      wx.userSends('画一下窗外的雨', { from: owner });
      await replied();
      await until(() => !busy());
      const photos = () => wx.messages(owner).filter((message) => message.image);
      const before = photos().length;
      const started = expectText(/正在生成图片（免费），好了会发到这里/);
      wx.userSends('/image', { from: owner });
      await started();
      const photo = await until(() => photos().length > before && photos().at(-1));
      const requestId = String(images.creates.at(-1)!.client_request_id);
      const task = images.tasks.get(images.requests.get(requestId)!)!;
      const served = Buffer.from(await (await fetch(task.url)).arrayBuffer());
      expect(photo.image!.equals(served)).toBe(true);
      const upload = wx.uploads.at(-1)!;
      expect(upload).toMatchObject({
        media_type: 1,
        rawsize: served.length,
        filesize: aesEcbPaddedSize(served.length),
        received: aesEcbPaddedSize(served.length),
      });
      expect(photo.midSize).toBe(upload.filesize);
      // The caption is its own message, just before the picture.
      const all = wx.messages(owner);
      expect(all[all.indexOf(photo) - 1].text).toBe('「林夏」的图片');
      await until(() => logs.some((line) => line.includes('已转发一张「林夏」的图片')));
      await until(() => !busy());
    } finally {
      await stop();
    }
  });

  it('pauses on -14; a reply finished meanwhile waits as a note, given at the next message', async () => {
    // Longer than the SLOW reply (about 1.6 s), so it finishes inside the pause.
    await start({ pauseOnExpiredMs: 3000 });
    try {
      const count = wx.messages(owner).length;
      wx.userSends('SLOW 讲个故事', { from: owner });
      await until(() => busy());
      wx.expireSession(1);
      await until(() => logs.some((line) => line.includes('微信说这次登录已失效（-14）')));
      expect(logs.some((line) => line.includes('微信暂时不可用，转发已暂停'))).toBe(true);
      await until(() =>
        (state.data.channel?.queue as { text: string }[] | undefined)?.some((item) =>
          item.text.includes('有一条回复没能发到微信'),
        ),
      );
      await until(() => !busy());
      // Nothing of the reply went out while paused.
      expect(
        wx
          .messages(owner)
          .slice(count)
          .some((m) => m.text?.includes('讲个故事？')),
      ).toBe(false);
      await until(() => logs.some((line) => line.includes('微信恢复转发')), 6000);
      const header = expectText(/你不在时的消息/);
      wx.userSends('还在吗', { from: owner });
      expect(await header()).toBe(
        '你不在时的消息（1 条）：\n\n有一条回复没能发到微信，请在 Yomi App 或网页查看。',
      );
      await until(() => texts().find((text) => text.includes('还在吗？')));
      await until(() => !busy());
      expect(state.data.channel?.expiredCount).toBeUndefined();
    } finally {
      await stop();
    }
  });

  it('ends with "log in again" after -14 three times in a row', async () => {
    await start({ pauseOnExpiredMs: 100 });
    wx.expireSession(3);
    const error = await done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayStopped);
    expect(error).toMatchObject({ reason: 'session' });
    expect((error as Error).message).toContain('--login');
    expect(state.data.channel?.expiredCount).toBe(3);
  });

  it('keeps the cursor across a restart and drops a batch read twice: nothing is relayed twice', async () => {
    await start();
    try {
      // The success that follows resets the count of the stop before.
      await until(() => state.data.channel?.expiredCount === undefined);
      const first = expectText(/第一条？/);
      wx.userSends('第一条', { from: owner });
      await first();
      await until(() => !busy());
      const count = sends().length;
      const polls = () => wx.calls.filter((call) => call.endpoint === 'getupdates').length;
      const before = polls();
      wx.replayNextBatch();
      // The replayed batch, then one more poll after it was handled.
      await until(() => polls() >= before + 2);
      await sleep(100);
      expect(sends().length).toBe(count);
      const second = expectText(/第二条？/);
      wx.userSends('第二条', { from: owner });
      await second();
      await until(() => !busy());
    } finally {
      await stop();
    }
    const cursor = state.data.channel?.cursor as string;
    expect(cursor).toBeTruthy();
    const count = sends().length;
    const polls = wx.calls.length;
    // WeChat sends the last batch again to the new process: the keys saved with the cursor drop it.
    wx.replayNextBatch();
    await start();
    try {
      await sleep(800);
      const resumed = wx.calls.slice(polls).find((call) => call.endpoint === 'getupdates')!;
      expect(resumed.body.get_updates_buf).toBe(cursor);
      expect(sends().length).toBe(count);
    } finally {
      await stop();
    }
  });

  it('answers only the newest of the owner messages sent while it was away; ignores others and groups', async () => {
    const count = sends().length;
    const old = Date.now() - 20 * 60 * 1000;
    wx.userSends('旧的一', { from: owner, at: old });
    wx.userSends('旧的二', { from: owner, at: old + 1000 });
    wx.userSends('旧的三', { from: owner, at: old + 2000 });
    wx.userSends('你好', { from: 'z9_stranger@im.wechat' });
    wx.userSends('群里好', { from: owner, group: 'g1@chatroom' });
    const stale = expectText(/这条消息是 relay 离线时发的/);
    await start();
    try {
      await stale();
      await sleep(500);
      expect(texts().filter((text) => text.includes('relay 离线时发的'))).toHaveLength(1);
      expect(logs.some((line) => line.includes('有 2 条离线期间的旧消息没有转发'))).toBe(true);
      expect(logs.some((line) => line.includes('收到一条群消息，已忽略'))).toBe(true);
      expect(wx.messages('z9_stranger@im.wechat')).toEqual([]);
      expect(sends().length).toBe(count);
    } finally {
      await stop();
    }
  });

  it("reads iLink's uint64 message ids exactly: two messages in one batch are both answered", async () => {
    await start();
    try {
      const helps = () => texts().filter((text) => text.includes('/budget [数量|none|off]')).length;
      const before = helps();
      // Ids 1 apart past 2^62: as JS numbers they would be one id, and the second a "replay".
      wx.userSends('/help', { from: owner });
      wx.userSends('/help', { from: owner });
      await until(() => helps() >= before + 2);
    } finally {
      await stop();
    }
  });

  it('relays a message without message_type (the field is optional), never one of the bot', async () => {
    await start();
    try {
      const bare = expectText(/没有类型？/);
      wx.userSends('没有类型', { from: owner, messageType: null });
      await bare();
      await until(() => !busy());
      wx.userSends('机器人自己说的', { from: owner, messageType: 2 });
      const next = expectText(/之后一条？/);
      wx.userSends('之后一条', { from: owner });
      await next();
      await until(() => !busy());
      expect(sends().map((request) => request.body.text)).not.toContain('机器人自己说的');
    } finally {
      await stop();
    }
  });

  it('starts the window again when a newer message carries a context_token seen before', async () => {
    await start({ replyWindowMs: 1200 });
    try {
      const first = expectText(/复用一？/);
      const id = wx.userSends('复用一', { from: owner });
      await first();
      await until(() => !busy());
      await sleep(1300);
      // The plugin says tokens are per message; if one ever comes again, it is answered in.
      const second = expectText(/复用二？/);
      wx.userSends('复用二', { from: owner, token: wx.contextOf(id) });
      await second();
      await until(() => !busy());
      expect(wx.messages(owner).at(-1)!.context_token).toBe(wx.contextOf(id));
    } finally {
      await stop();
    }
  });
});

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { type RelayCommandOptions, relayServiceArgs } from '../src/commands/relay.js';
import type { Environment } from '../src/core/env.js';
import { configDir } from '../src/core/files.js';
import { acquireProcessLock } from '../src/core/lock.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
import { type MockTelegram, startMockTelegram } from '../src/mock/telegram.js';
import { CHANNEL_KINDS, channelSetup } from '../src/relay/channels/index.js';
import { servicePlan } from '../src/relay/service.js';
import { RelayState, relayStatePath } from '../src/relay/state.js';
import { TelegramBot } from '../src/relay/telegram.js';
import { type FakeSwitch, StoppingChannel } from './helpers/fakeSetup.js';
import { memoryIo } from './helpers/io.js';

/**
 * `yomi relay --channel telegram|qq|wechat` as a command (design §6, step A5): choosing the
 * channel (`--telegram` is `--channel telegram`), the flags each channel takes, WeChat only with
 * `--experimental`, the registry and each channel's names (keychain entry, lock, service), help in
 * four languages and `--forget` for one channel only. The flow every channel shares is then run
 * on scripted QQ and WeChat channels (`fakeSetup`): their start-up lines and the User-Agent each
 * relay identifies itself with.
 *
 * Shared by every channel: what is asserted here is the shared flow, and a channel's own texts
 * (secret label, hints, label) are read from its setup, so the QQ and WeChat work never edits this
 * file. Each channel's own behaviour is tested in its own file: test/relay-qq.e2e.test.ts,
 * test/relay-wechat.e2e.test.ts.
 */

const fake: FakeSwitch = vi.hoisted(() => ({ on: false, opened: [] }));

vi.mock('../src/relay/channels/qq.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/channels/qq.js')>();
  const { fakeSetup } = await import('./helpers/fakeSetup.js');
  return { ...real, qqSetup: fakeSetup(real.qqSetup, fake) };
});
vi.mock('../src/relay/channels/wechat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/channels/wechat.js')>();
  const { fakeSetup } = await import('./helpers/fakeSetup.js');
  return { ...real, wechatSetup: fakeSetup(real.wechatSetup, fake) };
});

const CJK = /[㐀-鿿＀-￯　-〿]/;
let mock: MockServer;
let tg: MockTelegram;
let dir: string;
const saved: Record<string, string | undefined> = {};

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

/** This environment's account key and credential store, as the command sees them. */
const context = () => createContext(memoryIo().io, {});

const QQ_SECRET = JSON.stringify({ appId: '1020304', secret: 'qq-app-secret-1' });
const WECHAT_SECRET = JSON.stringify({ botToken: 'b', ilinkBotId: 'bot@im', ilinkUserId: 'u@im' });

beforeAll(async () => {
  mock = await startMockServer();
  tg = await startMockTelegram({ username: 'lin_cli_bot' });
  dir = mkdtempSync(join(tmpdir(), 'yomi-relay-cli-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_TELEGRAM_API_ORIGIN: tg.origin,
    YOMI_CONFIG_DIR: dir,
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
});

afterAll(async () => {
  await tg.close();
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('choosing the channel', () => {
  it('needs one, knows three, and takes --telegram as --channel telegram', async () => {
    const none = await run(['relay', '--allow-file-store']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('选择一个通道：--channel telegram|qq|wechat（或 --telegram）');
    const unknown = await run(['relay', '--channel', 'irc']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('不认识的通道："irc"。可选 telegram、qq、wechat');
    // A credential pasted in place of the name is not printed back, not even in part.
    const pasted = await run(['relay', `--channel=${tg.token}`]);
    expect(pasted.code).toBe(1);
    expect(pasted.err).toContain('不认识的通道。可选 telegram、qq、wechat');
    expect(pasted.err).not.toContain(tg.token.split(':')[1].slice(2, 10));
    const both = await run(['relay', '--telegram', '--channel', 'qq']);
    expect(both.code).toBe(1);
    expect(both.err).toContain('--telegram 和 --channel qq 不能同时使用');
    expect((await run(['relay', '--channel'])).code).toBe(2);
    setEnv({ YOMI_LANG: 'en' });
    try {
      expect((await run(['relay'])).err).toContain(
        'Choose a channel: --channel telegram|qq|wechat (or --telegram)',
      );
    } finally {
      setEnv({ YOMI_LANG: 'zh-Hans' });
    }

    // The alias and the name do the same, together or apart, in any case.
    const alias = await run(['relay', '--telegram', '--set-token', '--token-stdin'], {
      input: [tg.token],
    });
    expect(alias.code).toBe(1);
    expect(alias.err).toContain('--allow-file-store');
    for (const args of [
      ['--channel', 'telegram'],
      ['--channel=Telegram'],
      ['--telegram', '--channel', 'telegram'],
    ]) {
      const named = await run(['relay', ...args, '--set-token', '--token-stdin'], {
        input: [tg.token],
      });
      expect(named).toEqual(alias);
    }
    const kept = await run(
      ['relay', '--channel', 'telegram', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [tg.token] },
    );
    expect(kept.err).toBe('');
    expect(kept.out).toContain('已保存 @lin_cli_bot 的 token');
    expect(kept.out).toContain('接下来运行 yomi relay --telegram');
    const { store, account } = context();
    expect(store.getSecret(`telegram-bot:${account}`)).toBe(tg.token);
  });

  it('refuses flags meant for another channel, and WeChat without --experimental (design §6.2)', async () => {
    const cases: [string[], string][] = [
      [['--channel', 'qq', '--set-token'], 'QQ 用 --set-app 设置 AppID 和 AppSecret'],
      [['--channel', 'wechat', '--experimental', '--set-token'], '微信用 --login 扫码登录'],
      [['--telegram', '--set-app'], '--set-app 只用于 QQ'],
      [['--channel', 'wechat', '--experimental', '--set-app'], '--set-app 只用于 QQ'],
      [['--telegram', '--login'], '--login 只用于微信'],
      [['--channel', 'qq', '--login'], '--login 只用于微信'],
      [['--channel', 'qq', '--qr-link'], '--qr-link 只和微信的 --login 一起用'],
      [['--channel', 'wechat', '--experimental', '--qr-link'], '--qr-link 只和微信的 --login'],
      [['--channel', 'wechat', '--experimental', '--login', '--token-stdin'], '微信要用手机扫码'],
      [['--channel', 'wechat', '--experimental', '--pair'], '微信没有配对码'],
      [['--channel', 'qq', '--no-drafts'], '--no-drafts 只用于 Telegram'],
      [['--channel', 'wechat', '--experimental', '--no-drafts'], '--no-drafts 只用于 Telegram'],
      [['--channel', 'wechat'], '微信 ClawBot（iLink）通道是实验功能'],
      [['--channel', 'wechat', '--login'], '加 --experimental 启用'],
      [['--channel', 'wechat', '--install-service'], '加 --experimental 启用'],
    ];
    for (const [args, message] of cases) {
      const result = await run(['relay', ...args, '--allow-file-store']);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.err, args.join(' ')).toContain(message);
    }
    setEnv({ YOMI_LANG: 'en' });
    try {
      const english = await run(['relay', '--channel', 'wechat']);
      expect(english.err).toContain(
        'The WeChat ClawBot (iLink) channel is experimental: it is not an official API for third-party clients',
      );
      expect(english.err).toContain(
        'add --experimental: yomi relay --channel wechat --experimental',
      );
    } finally {
      setEnv({ YOMI_LANG: 'zh-Hans' });
    }
    // Telegram ignores --experimental; taking WeChat away needs no opt-in.
    const ignored = await run(['relay', '--telegram', '--experimental', '--service-status']);
    expect(ignored.code).toBe(0);
    for (const flag of ['--forget', '--service-status']) {
      const result = await run(['relay', '--channel', 'wechat', flag]);
      expect(result.code, flag).toBe(0);
    }
  });
});

describe("each channel's names", () => {
  const options: RelayCommandOptions = {
    channel: 'telegram',
    experimental: false,
    setToken: false,
    setApp: false,
    login: false,
    qrLink: false,
    tokenStdin: false,
    pair: false,
    forget: false,
    characterId: '',
    maxSpend: null,
    allowFileStore: false,
    installService: false,
    uninstallService: false,
    serviceStatus: false,
    replyTimeoutMs: 120_000,
    drafts: true,
    confirmProd: false,
    resetSpend: false,
  };
  const prod: Environment = {
    name: 'prod',
    apiOrigin: 'https://api.yomichat.io',
    webOrigin: 'https://www.yomichat.io',
    lane: '',
    custom: false,
  };
  const test: Environment = { ...prod, name: 'test', lane: 'l1', custom: true };

  it('are in the registry, final already for QQ and WeChat', () => {
    expect(CHANNEL_KINDS.map((kind) => channelSetup(kind).kind)).toEqual(CHANNEL_KINDS);
    expect(CHANNEL_KINDS.map((kind) => channelSetup(kind).command)).toEqual([
      'yomi relay --telegram',
      'yomi relay --channel qq',
      'yomi relay --channel wechat --experimental',
    ]);
    expect(CHANNEL_KINDS.map((kind) => channelSetup(kind).secretName('prod'))).toEqual([
      'telegram-bot:prod',
      'qq-bot:prod',
      'wechat-ilink:prod',
    ]);
    const telegram = channelSetup('telegram');
    expect(telegram.lockNameOf(tg.token)).toBe(String(tg.botId));
    expect(telegram.lockNameOf('not a token')).toBeNull();
    expect(channelSetup('qq').lockNameOf(QQ_SECRET)).toBe('qq-1020304');
    expect(channelSetup('qq').lockNameOf('{"appId":"x1"}')).toBeNull();
    expect(channelSetup('wechat').lockNameOf(WECHAT_SECRET)).toMatch(/^wx-[0-9a-f]{16}$/);
    expect(channelSetup('wechat').lockNameOf('{}')).toBeNull();
    expect(
      CHANNEL_KINDS.map((kind) => [
        channelSetup(kind).experimental,
        channelSetup(kind).personalUseOnly,
      ]),
    ).toEqual([
      [false, false],
      [false, true],
      [true, true],
    ]);
  });

  it("give each channel its service, with Telegram's arguments as they always were", () => {
    const telegram = channelSetup('telegram');
    // No cap chosen: none written, so the service runs uncapped like the foreground relay.
    expect(relayServiceArgs(prod, telegram, options)).toEqual([
      'relay',
      '--telegram',
      '--env',
      'prod',
      '--confirm-prod',
    ]);
    expect(relayServiceArgs(prod, telegram, { ...options, maxSpend: 0 })).toEqual([
      'relay',
      '--telegram',
      '--env',
      'prod',
      '--max-spend',
      '0',
      '--confirm-prod',
    ]);
    expect(
      relayServiceArgs(test, telegram, {
        ...options,
        allowFileStore: true,
        maxSpend: 20,
        characterId: '7300000000000009001',
        drafts: false,
      }),
    ).toEqual([
      'relay',
      '--telegram',
      '--env',
      'test',
      '--lane',
      'l1',
      '--allow-file-store',
      '--max-spend',
      '20',
      '--character',
      '7300000000000009001',
      '--no-drafts',
    ]);
    expect(relayServiceArgs(prod, channelSetup('qq'), { ...options, channel: 'qq' })).toEqual([
      'relay',
      '--channel',
      'qq',
      '--env',
      'prod',
      '--confirm-prod',
    ]);
    const args = relayServiceArgs(prod, channelSetup('wechat'), {
      ...options,
      channel: 'wechat',
      experimental: true,
    });
    expect(args.slice(0, 4)).toEqual(['relay', '--channel', 'wechat', '--experimental']);
    const plan = servicePlan({
      account: 'prod',
      channel: 'wechat',
      node: '/usr/bin/node',
      script: '/opt/yomi/dist/cli.js',
      args,
      environment: {},
      logDir: '/home/me/.config/yomi-cli/logs',
      platform: 'linux',
      home: '/home/me',
      uid: 1000,
    });
    expect(plan.label).toBe('yomi-relay-wechat-prod.service');
    expect(plan.content).toContain(
      'ExecStart="/usr/bin/node" "/opt/yomi/dist/cli.js" "relay" "--channel" "wechat" "--experimental" "--env" "prod"',
    );
  });

  it('are in the help, with QQ and WeChat for personal use only and WeChat experimental', async () => {
    const zh = await run(['relay', '--help']);
    expect(zh.code).toBe(0);
    expect(zh.out).toContain('yomi relay --channel telegram|qq|wechat');
    expect(zh.out).toContain('--telegram 等同 --channel telegram');
    expect(zh.out).toMatch(/qq .*仅限个人使用/);
    expect(zh.out).toMatch(/wechat .*实验功能，仅限个人使用/);
    for (const flag of ['--set-app', '--login', '--qr-link', '--experimental', '--set-token'])
      expect(zh.out).toContain(flag);
    const marks = {
      en: ['personal use only', 'experimental, personal use only'],
      es: ['solo para uso', 'experimental, solo para uso'],
      pt: ['somente para uso', 'experimental, somente para uso'],
    };
    for (const [lang, [personal, experimental]] of Object.entries(marks)) {
      const help = await run(['--lang', lang, 'relay', '--help']);
      expect(help.out, lang).toContain('yomi relay --channel telegram|qq|wechat');
      expect(help.out, lang).toContain(personal);
      expect(help.out, lang).toContain(experimental);
      expect(help.out.search(CJK), lang).toBe(-1);
      const summary = await run(['--lang', lang, '--help']);
      expect(summary.out, lang).toContain('relay --channel …');
      expect(summary.out, lang).toContain('WeChat ClawBot');
    }
    expect((await run(['--help'])).out).toContain('微信 ClawBot');
  });
});

describe('--forget', () => {
  /** A state file of each channel and a secret of each, for this environment. */
  function seed() {
    const { store, account } = context();
    const scopes = { telegram: String(tg.botId), qq: 'qq:1020304', wechat: 'wx:0123456789abcdef' };
    for (const kind of CHANNEL_KINDS)
      new RelayState(relayStatePath(account, scopes[kind]), scopes[kind], account, kind).save();
    store.setSecret(`telegram-bot:${account}`, tg.token);
    store.setSecret(`qq-bot:${account}`, QQ_SECRET);
    store.setSecret(`wechat-ilink:${account}`, WECHAT_SECRET);
    return {
      store,
      account,
      states: () =>
        CHANNEL_KINDS.filter((kind) => existsSync(relayStatePath(account, scopes[kind]))),
      secrets: () =>
        CHANNEL_KINDS.filter((kind) => store.getSecret(channelSetup(kind).secretName(account))),
    };
  }

  it("takes one channel's secret and pairing, and leaves the other channels theirs", async () => {
    const { states, secrets } = seed();
    // QQ's and WeChat's own words (secret label, hint) come from their setups.
    const [qqSetup, wechatSetup] = [channelSetup('qq'), channelSetup('wechat')];
    const qq = await run(['relay', '--channel', 'qq', '--forget']);
    expect(qq.code).toBe(0);
    expect(qq.out).toContain(`已删除本机保存的 ${qqSetup.secretLabel} 和配对信息（1 份）。`);
    expect(qq.out).toContain(qqSetup.forgetHint());
    expect(states()).toEqual(['telegram', 'wechat']);
    expect(secrets()).toEqual(['telegram', 'wechat']);
    expect((await run(['relay', '--channel', 'qq', '--forget'])).out).toContain(
      `本机没有保存 ${qqSetup.secretLabel} 或配对信息。`,
    );
    const wechat = await run(['relay', '--channel', 'wechat', '--forget']);
    expect(wechat.code).toBe(0);
    expect(wechat.out).toContain(
      `已删除本机保存的 ${wechatSetup.secretLabel} 和配对信息（1 份）。`,
    );
    expect(wechat.out).toContain(wechatSetup.forgetHint());
    expect(states()).toEqual(['telegram']);
    expect(secrets()).toEqual(['telegram']);
    // Telegram's lines are the ones it always printed.
    const telegram = await run(['relay', '--telegram', '--forget']);
    expect(telegram.out).toContain('已删除本机保存的 bot token 和配对信息（1 份）。');
    expect(telegram.out).toContain('如果 token 可能泄露，请在 @BotFather 里用 /revoke 让它失效。');
    expect([states(), secrets()]).toEqual([[], []]);
    setEnv({ YOMI_LANG: 'es' });
    try {
      expect((await run(['relay', '--telegram', '--forget'])).out).toContain(
        'No hay ningún token de bot ni datos de vinculación guardados en este equipo.',
      );
      expect((await run(['relay', '--channel', 'qq', '--forget'])).out).toContain(
        `No hay ningún ${qqSetup.secretLabel} ni datos de vinculación guardados en este equipo.`,
      );
    } finally {
      setEnv({ YOMI_LANG: 'zh-Hans' });
    }
  });

  it("is refused while that channel's relay runs, by the lock named from its secret", async () => {
    const { states } = seed();
    const lock = acquireProcessLock(join(configDir(), 'locks', 'relay-qq-1020304.lock'));
    expect('release' in lock).toBe(true);
    try {
      const refused = await run(['relay', '--channel', 'qq', '--forget']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        `relay 正在运行（进程 ${process.pid}）：先停止它（Ctrl+C，或 --uninstall-service），再 --forget。`,
      );
      expect(states()).toEqual(['telegram', 'qq', 'wechat']);
      // Another channel's relay is no reason to keep this one's.
      expect((await run(['relay', '--channel', 'wechat', '--forget'])).code).toBe(0);
    } finally {
      if ('release' in lock) lock.release();
    }
    expect((await run(['relay', '--channel', 'qq', '--forget'])).code).toBe(0);
    expect((await run(['relay', '--telegram', '--forget'])).code).toBe(0);
    expect(states()).toEqual([]);
  });
});

describe('the flow every channel runs', () => {
  const sends = () => mock.state.requests.length;
  const policyAgents = (from: number) =>
    mock.state.requests
      .slice(from)
      .filter((request) => request.path === 'relay/get_policy')
      .map((request) => [String(request.headers['user-agent']), request.body.channel]);

  /** How the scripted channels name their bot (fakeSetup's identity), in each setup's words. */
  const label = (kind: 'qq' | 'wechat') =>
    channelSetup(kind).label({ id: '42', name: 'Lin bot', handle: '' });

  /** Gives the channel's fake an owner, as a pairing or login would. */
  function paired(kind: 'qq' | 'wechat') {
    const { account } = context();
    const scope = `fake:${kind}`;
    const state = new RelayState(relayStatePath(account, scope), scope, account, kind);
    state.update({
      owner: { userId: 'owner-1', chatId: 'owner-1', name: '', language: '', pairedAt: Date.now() },
    });
  }

  beforeAll(async () => {
    await signIn();
    fake.on = true;
  });

  afterEach(() => {
    fake.opened.length = 0;
  });

  afterAll(() => {
    fake.on = false;
  });

  it('runs QQ named by its bot, marked personal use only, and says which relay it is', async () => {
    paired('qq');
    const from = sends();
    const result = await run(['relay', '--channel', 'qq', '--allow-file-store']);
    expect(result.code).toBe(0);
    expect(fake.opened).toHaveLength(1);
    expect(result.out).toContain(`relay 运行中：${label('qq')} ⇄ Yomi`);
    expect(result.out).toContain('仅限个人使用：relay 只转发你本人和你自己的 bot 之间的消息。');
    expect(result.out).not.toContain('实验功能');
    expect(result.err).toContain(StoppingChannel.message);
    expect(policyAgents(from)).toEqual([[expect.stringMatching(/ relay-qq$/), 'qq']]);
    // Not production: it runs on the defaults and says the server has not confirmed QQ.
    expect(result.err).toContain('服务端没有确认这个通道（QQ）');
  });

  it('says the spending cap at the start: none by default, 0 is free replies only, else the amount', async () => {
    paired('qq');
    const base = ['relay', '--channel', 'qq', '--allow-file-store'];
    const none = await run(base);
    expect(none.code).toBe(0);
    expect(none.out).toContain(
      '没有本机花费上限：按 Yomi 的正常规则扣费，钻石不足时会在聊天里提示（要设上限：--max-spend <数量>，或在聊天里用 /budget <数量>）。',
    );
    expect(none.out).not.toContain('一条也不发');
    expect(none.err).toContain('没有设花费上限：按 Yomi 的正常规则扣费');
    const zero = await run([...base, '--max-spend', '0']);
    expect(zero.code).toBe(0);
    expect(zero.out).toContain('本机花费上限 0：relay 不花钻石，只用免费额度');
    expect(zero.err).toContain('只用免费额度（不花钻石）');
    const capped = await run([...base, '--max-spend', '30']);
    expect(capped.out).toContain('本机允许 relay 最多花 30 钻石（累计；--reset-spend 重新计算）。');
    expect(capped.err).toContain('不超过本机上限 30 钻石');
    const bad = await run([...base, '--max-spend', '1.5']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('--max-spend 必须是 0–1000000 的整数（钻石）');
    setEnv({ YOMI_LANG: 'en' });
    try {
      const en = await run(base);
      expect(en.out).toContain(
        'No local spending cap: Yomi charges by its normal rules, and a low balance is reported in the chat',
      );
    } finally {
      setEnv({ YOMI_LANG: 'zh-Hans' });
    }
  });

  it('starts WeChat only with --experimental and an owner from --login, marked experimental', async () => {
    const unpaired = await run([
      'relay',
      '--channel',
      'wechat',
      '--experimental',
      '--allow-file-store',
    ]);
    expect(unpaired.code).toBe(0);
    expect(unpaired.err).toContain(channelSetup('wechat').unpairedHint());
    expect(unpaired.out).not.toContain('relay 运行中');
    paired('wechat');
    const from = sends();
    setEnv({ YOMI_LANG: 'en' });
    let result;
    let named;
    try {
      result = await run(['relay', '--channel', 'wechat', '--experimental', '--allow-file-store']);
      named = label('wechat');
    } finally {
      setEnv({ YOMI_LANG: 'zh-Hans' });
    }
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Relay running: ${named} ⇄ Yomi`);
    expect(result.out).toContain(
      'Personal use only: this relays your own messages to your own bot.',
    );
    expect(result.out).toContain(
      'Experimental: WeChat ClawBot (iLink) is not an official API for third-party clients.',
    );
    expect(policyAgents(from)).toEqual([[expect.stringMatching(/ relay-wechat$/), 'wechat']]);
  });

  it('runs Telegram by --channel telegram as by --telegram, with nothing added', async () => {
    const { store, account } = context();
    store.setSecret(`telegram-bot:${account}`, tg.token);
    const from = sends();
    const polls = tg.calls.filter((call) => call.method === 'getUpdates').length;
    const terminal = memoryIo();
    const pending = main(
      ['relay', '--channel', 'telegram', '--allow-file-store', '--pair'],
      terminal.io,
    );
    await terminal.waitFor(/\/start ([A-Z2-9]{8})/);
    expect(terminal.out).toContain('https://t.me/lin_cli_bot?start=');
    await tg.waitFor(() => terminal.out.includes('relay 运行中：@lin_cli_bot ⇄ Yomi'));
    await tg.waitFor(() => tg.calls.filter((call) => call.method === 'getUpdates').length > polls);
    // A second poller: Telegram's 409 stops the relay, as in relay.e2e.test.ts.
    await new TelegramBot(tg.token, { apiOrigin: tg.origin }).getUpdates(-1, 0).catch(() => {});
    expect(await pending).toBe(0);
    expect(terminal.out).not.toContain('仅限个人使用');
    expect(terminal.err).toContain('另一个程序正在用这个 bot 收消息');
    expect(policyAgents(from)).toEqual([[expect.stringMatching(/ relay-telegram$/), 'telegram']]);
    expect(fake.opened).toEqual([]);
  });
});

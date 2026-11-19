import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import type { Gateway } from '../src/core/api.js';
import { setLanguage } from '../src/core/i18n.js';
import { ParagraphType } from '../src/im/models.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import { startMockTelegram } from '../src/mock/telegram.js';
import { OutOfContextQueue } from '../src/relay/channels/queue.js';
import { TelegramChannel } from '../src/relay/channels/telegram.js';
import { ASK_MEMORY_MS, ASK_TTL_MS, TextQuestions } from '../src/relay/channels/text-ask.js';
import { type RawInbound, TextInbound } from '../src/relay/channels/text-inbound.js';
import {
  ChannelError,
  type ChannelHost,
  channelName,
  parseCommand,
  type Question,
  RelayStopped,
} from '../src/relay/channels/types.js';
import { PairingCode } from '../src/relay/pairing.js';
import {
  channelPolicy,
  DEFAULT_POLICY,
  parsePolicy,
  type RelayPolicy,
  relayPolicy,
} from '../src/relay/policy.js';
import {
  Relay,
  type RelayOptions,
  RelayStopped as RelayStoppedFromRelay,
} from '../src/relay/relay.js';
import {
  type Formatter,
  MESSAGE_LIMIT,
  PLAIN,
  renderReply,
  TELEGRAM_HTML,
} from '../src/relay/render.js';
import { servicePlan } from '../src/relay/service.js';
import { forgetRelayStates, RelayState, relayStatePath } from '../src/relay/state.js';
import { TelegramBot, TelegramError } from '../src/relay/telegram.js';
import { relayTexts } from '../src/relay/texts.js';
import { FakeChannel, waitFor } from './helpers/fakeChannel.js';
import { memoryIo } from './helpers/io.js';

/**
 * The parts every relay channel shares, and that Telegram reads with its old defaults: the channel
 * types, formatters, texts that depend on the channel, the state file's channel data, the policy
 * per channel and the service names; the pieces QQ and WeChat build on (questions answered with a
 * typed code, the way in for text messages, the queue for the owner's next message); and the core
 * itself on a scripted channel (test/helpers/fakeChannel.ts) against the mock gateway.
 */

const narration = (text: string) => ({
  type: ParagraphType.narration,
  text,
  npcId: '',
  npcName: '',
});
const line = (text: string, npcName = '', npcId = '') => ({
  type: ParagraphType.dialogue,
  text,
  npcId,
  npcName,
});
const LANGUAGES = ['zh', 'en', 'es', 'pt'] as const;

afterEach(() => setLanguage(null));

describe('the channel types', () => {
  it('split a command as the relay always has', () => {
    expect(parseCommand('/budget@Yomi_Bot  100   gems')).toEqual({
      name: 'budget',
      target: 'Yomi_Bot',
      argument: '100 gems',
    });
    expect(parseCommand('/Start')).toEqual({ name: 'Start', target: '', argument: '' });
    expect(parseCommand('hello /budget')).toBeNull();
  });

  it('keep TelegramError as it was, as a ChannelError with a reason', () => {
    const conflict = new TelegramError(
      'getUpdates',
      409,
      'Conflict: terminated by other getUpdates',
    );
    expect(conflict).toBeInstanceOf(ChannelError);
    expect(conflict.name).toBe('TelegramError');
    expect(conflict.message).toBe(
      'Telegram getUpdates: 409 Conflict: terminated by other getUpdates',
    );
    expect([conflict.channel, conflict.method, conflict.operation]).toEqual([
      'telegram',
      'getUpdates',
      'getUpdates',
    ]);
    expect([conflict.reason, conflict.conflict]).toEqual(['conflict', true]);
    const limited = new TelegramError('sendMessage', 429, 'Too Many Requests: retry after 3', 3);
    expect([limited.reason, limited.retryAfter, limited.retryAfterMs]).toEqual([
      'rateLimited',
      3,
      3000,
    ]);
    const reasons = [401, 404, 403, 0, 502, 400].map(
      (code) => new TelegramError('sendMessage', code, 'x').reason,
    );
    expect(reasons).toEqual([
      'unauthorized',
      'unauthorized',
      'blocked',
      'transient',
      'transient',
      'other',
    ]);
    expect(new TelegramError('getMe', 0, 'Network request failed').message).toBe(
      'Telegram getMe: Network request failed',
    );
  });

  it('name the channel in errors and keep RelayStopped where it was', () => {
    const refused = new ChannelError(
      'qq',
      'POST /v2/users/{openid}/messages',
      40034006,
      'content',
      'contentRefused',
    );
    expect(refused.message).toBe('QQ POST /v2/users/{openid}/messages: 40034006 content');
    expect(refused.retryAfterMs).toBe(0);
    setLanguage('zh');
    expect(channelName('wechat')).toBe('微信');
    setLanguage('en');
    expect(channelName('wechat')).toBe('WeChat');
    expect(RelayStoppedFromRelay).toBe(RelayStopped);
    const stopped = new RelayStopped('delisted', 'delisted');
    expect([stopped.name, stopped.reason]).toEqual(['RelayStopped', 'delisted']);
  });
});

describe('formatters', () => {
  const group = { characterName: '雾港', group: true };

  it('default to Telegram HTML', () => {
    const paragraphs = [narration('她笑了 <b>'), line('早 & 好', '阿青', '1')];
    expect(renderReply(paragraphs, group)).toEqual(
      renderReply(paragraphs, group, MESSAGE_LIMIT, TELEGRAM_HTML),
    );
    expect(renderReply(paragraphs, group)).toEqual([
      '<i>她笑了 &lt;b&gt;</i>\n\n<b>阿青</b>：早 &amp; 好',
    ]);
  });

  it('write plain text without escaping, in each language', () => {
    const paragraphs = [narration('She smiles <b>'), line('Hi & bye', 'Ada', '1')];
    const expected = {
      zh: '（She smiles <b>）\n\nAda：Hi & bye',
      en: '*She smiles <b>*\n\nAda: Hi & bye',
      es: '*She smiles <b>*\n\nAda: Hi & bye',
      pt: '*She smiles <b>*\n\nAda: Hi & bye',
    };
    for (const language of LANGUAGES) {
      setLanguage(language);
      expect(renderReply(paragraphs, group, MESSAGE_LIMIT, PLAIN), language).toEqual([
        expected[language],
      ]);
    }
  });

  it('count plain markers and labels against the limit', () => {
    setLanguage('zh');
    const messages = renderReply(
      [narration('雨'.repeat(700)), line('风'.repeat(700), '阿青', '1')],
      group,
      300,
      PLAIN,
    );
    expect(messages.length).toBeGreaterThan(4);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(300);
    expect(messages.join('').replace(/[（）\n]|阿青：/g, '')).toBe(
      '雨'.repeat(700) + '风'.repeat(700),
    );
  });

  it('split again what a format measures longer than its text', () => {
    const doubled: Formatter = {
      ...PLAIN,
      name: 'qq-markdown',
      measure: (_visible, formatted) => formatted.length * 2,
    };
    const paragraphs = [line('a'.repeat(500)), line('b'.repeat(120), 'Ada', '1')];
    expect(renderReply(paragraphs, group, 600, PLAIN)).toHaveLength(2);
    const messages = renderReply(paragraphs, group, 600, doubled);
    expect(messages.length).toBeGreaterThan(2);
    for (const message of messages) expect(message.length * 2).toBeLessThanOrEqual(600);
    expect(messages.join('').replace(/\n|Ada：|Ada: /g, '')).toBe(
      'a'.repeat(500) + 'b'.repeat(120),
    );
    // never between the halves of a surrogate pair
    const quadrupled: Formatter = {
      ...doubled,
      measure: (_visible, formatted) => formatted.length * 4,
    };
    const emoji = renderReply([line('😀'.repeat(101))], group, 600, quadrupled);
    expect(emoji).toHaveLength(2);
    for (const message of emoji) expect(message).toMatch(/^(😀)+$/u);
  });
});

describe('texts that depend on the channel', () => {
  it("give Telegram's texts with Telegram's arguments", () => {
    const zh = relayTexts('zh-Hans');
    expect(zh.otherAccount('yomi relay --telegram')).toBe(
      '电脑上登录的 Yomi 账号变了，relay 已停止。请重新运行 yomi relay --telegram。',
    );
    expect(zh.reportNothing(true)).toBe('没有可以举报的回复：回复这条消息或在回复出现后再试。');
    expect(zh.imageForwardFailed('Telegram')).toBe(
      '图片已经生成并保存在 Yomi 对话里，但没能转发到 Telegram：请在 Yomi App 或网页查看。',
    );
    expect(zh.help(true)).toContain(
      '/image 根据最近一条回复生成一张图片（回复角色的某条消息再发，则根据那一条）\n/report',
    );
    expect(zh.imageUsage(true)).toBe(
      '用法：/image 根据最近一条回复生成图片；回复角色的某条消息再发 /image，则根据那一条。/image resume 继续上一次没有结果的生图；/image forget 放弃追踪一个结果未知的请求（已被受理的不能放弃）。',
    );
    const en = relayTexts('en');
    expect(en.otherAccount('yomi relay --telegram')).toBe(
      'A different Yomi account is signed in on the computer; the relay stopped. Run yomi relay --telegram again.',
    );
    expect(en.reportNothing(true)).toBe(
      'Nothing to report yet: reply to a message, or try after a reply arrives.',
    );
    expect(en.imageForwardFailed('Telegram')).toBe(
      "The picture was made and is in the Yomi chat, but couldn't be forwarded to Telegram: see it in the Yomi app or on the web.",
    );
    expect(en.help(true)).toContain(
      '/image make a picture of the last reply (or of the reply you answer with it)\n',
    );
    expect(relayTexts('pt').imageForwardFailed('Telegram')).toContain('para o Telegram:');
  });

  it('leave out quoting where a channel has none, in every language', () => {
    // how each language says "answer one of the bot's messages"
    const quoting =
      /回复角色的某条消息|回复这条消息|answer|reply to a message|contestes|responde a|responder com|responda a/;
    for (const language of LANGUAGES) {
      const texts = relayTexts(language);
      for (const text of [texts.help, texts.reportNothing, texts.imageUsage]) {
        expect(text(true), language).toMatch(quoting);
        expect(text(false), language).not.toMatch(quoting);
      }
      expect(texts.imageUsage(false), language).toContain('/image resume');
    }
  });

  it('name the channel, set apart in Chinese only when it is in Latin letters', () => {
    const zh = relayTexts('zh');
    expect(zh.imageForwardFailed('微信')).toContain('没能转发到微信：');
    expect(zh.contentRefused('QQ')).toMatch(/^QQ 按内容规则/);
    expect(zh.contentRefused('微信')).toMatch(/^微信按内容规则/);
    expect(zh.offlineNotReceived('QQ')).toContain('发给这个 QQ bot');
    expect(zh.offlineNotReceived('微信')).toContain('发给这个微信 bot');
    expect(zh.replyUndelivered('QQ')).toContain('没能发到 QQ，');
    for (const language of LANGUAGES) {
      const texts = relayTexts(language);
      expect(texts.askChoose('K7Q2')).toContain('K7Q2 1');
      expect(texts.queuedHeader(3)).toContain('3');
      for (const text of [
        texts.contentRefused('QQ'),
        texts.channelPaused('QQ', 'contentRefused'),
        texts.channelPaused('QQ', 'unavailable'),
        texts.offlineNotReceived('QQ'),
        texts.replyUndelivered('QQ'),
      ])
        expect(text, language).toContain('QQ');
      expect(texts.channelPaused('QQ', 'contentRefused')).not.toBe(
        texts.channelPaused('QQ', 'unavailable'),
      );
      expect(texts.pairHint).toContain('/pair');
      expect(texts.askExpired).not.toBe(texts.askInvalid);
    }
  });
});

describe('the relay state per channel', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'yomi-relay-channel-'));

  it('writes a Telegram file without kind or channel data', () => {
    const folder = dir();
    const path = relayStatePath('test', '7000000001', folder);
    const state = new RelayState(path, '7000000001', 'test');
    state.bindAccount('7300000000000000101');
    state.bindAccount('7300000000000000999');
    state.rememberReply(42, 'm1');
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(stored)).not.toContain('kind');
    expect(Object.keys(stored)).not.toContain('channel');
    expect(stored.replies).toEqual([[42, 'm1']]);
    expect(state.replyMid('42')).toBe('m1');
    expect(state.replyMid(42)).toBe('m1');
  });

  it("keeps a channel's own data, and never reads another channel's file as its own", () => {
    const folder = dir();
    const path = relayStatePath('test', 'qq:102000001', folder);
    const state = new RelayState(path, 'qq:102000001', 'test', 'qq');
    expect(state.data.kind).toBe('qq');
    const store = state.channelStore();
    expect(store.get('activeOff')).toBeUndefined();
    store.set('activeOff', true);
    store.set('queue', [{ text: 'hi', at: 1 }]);
    state.rememberReply('REFIDX_1', 'm1');
    const again = new RelayState(path, 'qq:102000001', 'test', 'qq');
    expect(again.channelStore().get<boolean>('activeOff')).toBe(true);
    expect(again.replyMid('REFIDX_1')).toBe('m1');
    again.channelStore().set('activeOff', undefined);
    expect(JSON.parse(readFileSync(path, 'utf8')).channel).toEqual({
      queue: [{ text: 'hi', at: 1 }],
    });
    // the same scope read as another kind starts empty
    expect(new RelayState(path, 'qq:102000001', 'test', 'wechat').data.channel).toBeUndefined();
  });

  it('drops the queue, and only the queue, when another Yomi account signs in', () => {
    const folder = dir();
    const path = relayStatePath('test', 'wx:0123456789abcdef', folder);
    const state = new RelayState(path, 'wx:0123456789abcdef', 'test', 'wechat');
    state.bindAccount('7300000000000000101');
    state.channelStore().set('queue', [{ text: 'hi', at: 1 }]);
    state.channelStore().set('cursor', 'abc');
    expect(state.bindAccount('7300000000000000101')).toBe(false);
    expect(state.channelStore().get('queue')).toHaveLength(1);
    expect(state.bindAccount('7300000000000000999')).toBe(true);
    expect(state.data.channel).toEqual({ cursor: 'abc' });
  });

  it("forgets one channel's files and leaves the others", () => {
    const folder = dir();
    const scopes = [
      ['7000000001', 'telegram'],
      ['qq:102000001', 'qq'],
      ['wx:0123456789abcdef', 'wechat'],
    ] as const;
    for (const [scope, kind] of scopes)
      new RelayState(relayStatePath('test', scope, folder), scope, 'test', kind).save();
    new RelayState(
      relayStatePath('prod', 'qq:102000001', folder),
      'qq:102000001',
      'prod',
      'qq',
    ).save();
    expect(forgetRelayStates('test', folder, 'qq')).toBe(1);
    expect(forgetRelayStates('test', folder, 'qq')).toBe(0);
    expect(forgetRelayStates('test', folder, 'telegram')).toBe(1);
    expect(forgetRelayStates('test', folder)).toBe(1);
    expect(forgetRelayStates('prod', folder, 'wechat')).toBe(0);
    expect(forgetRelayStates('prod', folder, 'qq')).toBe(1);
  });
});

describe('the policy per channel', () => {
  const server = (data: Record<string, unknown>): RelayPolicy => parsePolicy({ data });

  it('asks for the channel and reads which channel the answer is for', async () => {
    const bodies: unknown[] = [];
    const gateway = {
      request: async (_path: string, body: unknown) => {
        bodies.push(body);
        return { data: { enabled: true, channel: 'qq' } };
      },
    } as unknown as Gateway;
    expect((await relayPolicy(gateway, 'qq')).channel).toBe('qq');
    await relayPolicy(gateway);
    expect(bodies).toEqual([
      expect.objectContaining({ client: 'yomi-cli', channel: 'qq' }),
      expect.objectContaining({ client: 'yomi-cli', channel: 'telegram' }),
    ]);
    expect(Object.keys(bodies[1] as object)).toEqual(['client', 'client_version', 'channel']);
    expect(DEFAULT_POLICY.channel).toBe('');
    expect(server({}).channel).toBe('');
    // an echo of another shape names no channel, and costs nothing else the server said
    const odd = server({ enabled: true, channel: 7, features: { free_only: true } });
    expect([odd.source, odd.channel, odd.freeOnly]).toEqual(['server', '', true]);
  });

  it('leaves Telegram as it was', () => {
    expect(channelPolicy(DEFAULT_POLICY, 'telegram', true)).toEqual({
      policy: DEFAULT_POLICY,
      gated: false,
      warning: '',
    });
  });

  it('runs QQ and WeChat in production only on a policy the server sent for them', () => {
    const confirmed = server({ enabled: true, channel: 'qq' });
    expect(channelPolicy(confirmed, 'qq', true)).toEqual({
      policy: confirmed,
      gated: false,
      warning: '',
    });
    for (const policy of [DEFAULT_POLICY, server({ enabled: true }), confirmed]) {
      const gate = channelPolicy(policy, 'wechat', true);
      expect(gate.gated).toBe(true);
      expect(gate.policy.enabled).toBe(false);
      expect(gate.policy.message).toBe('服务端还没有开放这个通道');
      expect(gate.warning).toContain('微信');
    }
    // a server that switched relays off keeps its own reason
    const off = channelPolicy(server({ enabled: false, message: '维护中' }), 'qq', true);
    expect([off.gated, off.policy.enabled, off.policy.message]).toEqual([true, false, '维护中']);
  });

  it('warns and runs elsewhere', () => {
    const gate = channelPolicy(DEFAULT_POLICY, 'qq', false);
    expect([gate.gated, gate.policy]).toEqual([false, DEFAULT_POLICY]);
    expect(gate.warning).toContain('QQ');
    setLanguage('en');
    expect(channelPolicy(DEFAULT_POLICY, 'qq', false).warning).toContain(
      'not the production environment',
    );
  });
});

describe('the background service per channel', () => {
  const base = {
    account: 'test',
    node: '/opt/node/bin/node',
    script: '/Users/me/yomi cli/dist/cli.js',
    args: ['relay', '--channel', 'qq', '--env', 'test'],
    environment: { YOMI_LANG: 'zh-Hans' },
    logDir: '/Users/me/.config/yomi-cli/logs',
  };

  it('keeps Telegram names and gives the others their own', () => {
    const telegram = servicePlan({ ...base, platform: 'darwin', home: '/Users/me', uid: 501 });
    expect(
      servicePlan({
        ...base,
        channel: 'telegram',
        platform: 'darwin',
        home: '/Users/me',
        uid: 501,
      }),
    ).toEqual(telegram);
    expect(telegram.label).toBe('io.yomichat.yomi-cli.relay.test');
    const qq = servicePlan({
      ...base,
      channel: 'qq',
      platform: 'darwin',
      home: '/Users/me',
      uid: 501,
    });
    expect(qq.label).toBe('io.yomichat.yomi-cli.relay.qq-test');
    expect(qq.content).toContain('/Users/me/.config/yomi-cli/logs/relay-qq-test.log');
    const wechat = servicePlan({
      ...base,
      account: 'prod',
      channel: 'wechat',
      platform: 'linux',
      home: '/home/me',
      uid: 1000,
    });
    expect(wechat.label).toBe('yomi-relay-wechat-prod.service');
    expect(wechat.content).toContain('Description=Yomi CLI WeChat relay (prod)\n');
    expect(
      servicePlan({ ...base, platform: 'linux', home: '/home/me', uid: 1000 }).content,
    ).toContain('Description=Yomi CLI Telegram relay (test)\n');
  });
});

describe('pairing on any channel', () => {
  it('counts wrong tries per sender, whatever its id looks like', () => {
    const code = new PairingCode();
    for (let index = 0; index < 5; index++) expect(code.check('WRONG', 'openid-a')).toBe('wrong');
    expect(code.check(code.code, 'openid-a')).toBe('ignored');
    expect(code.check('WRONG', 'openid-b')).toBe('wrong');
    expect(code.check(code.display, 'openid-b')).toBe('ok');
  });
});

describe('questions answered with a typed code', () => {
  const question: Question = {
    id: 'a1b2c3d4',
    prompt: '确认吗？',
    options: [
      { id: 'y', label: '允许' },
      { id: 'n', label: '取消' },
    ],
    layout: 'row',
  };
  const stateOf = (path = relayStatePath('test', 'qq:1', mkdtempSync(join(tmpdir(), 'ask-')))) =>
    new RelayState(path, 'qq:1', 'test', 'qq');

  it('number the options under a one-time code and take an answer once', () => {
    const questions = new TextQuestions(stateOf().channelStore(), relayTexts('zh'));
    const { code, text } = questions.open(question);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(text).toBe(
      `确认吗？\n1. 允许\n2. 取消\n回复「${code} 1」这样的「代码 序号」来选择（10 分钟内有效）。`,
    );
    // a number without an option keeps the code open
    expect(questions.match(`${code} 3`)).toBe('invalid');
    expect(questions.match(`${code} 0`)).toBe('invalid');
    // lower case, a Chinese keyboard's colon and digit
    expect(questions.match(`  ${code.toLowerCase()}：２ `)).toEqual({
      questionId: 'a1b2c3d4',
      optionId: 'n',
    });
    expect(questions.match(`${code} 1`)).toBe('expired');
  });

  it('never take chat for an answer', () => {
    const questions = new TextQuestions(stateOf().channelStore(), relayTexts('zh'));
    const { code } = questions.open(question);
    for (const text of ['1', 'haha 2', 'HAHA2', code, `${code} 1 please`, `好的 ${code} 1`])
      expect(questions.match(text)).toBeNull();
    expect(questions.match(`${code}#1`)).toEqual({ questionId: 'a1b2c3d4', optionId: 'y' });
  });

  it('expire after ten minutes and are forgotten an hour later', () => {
    let now = 1_000_000;
    const questions = new TextQuestions(stateOf().channelStore(), relayTexts('en'), () => now);
    const { code } = questions.open(question);
    now += ASK_TTL_MS;
    expect(questions.match(`${code} 1`)).toBe('expired');
    now += ASK_MEMORY_MS - 1;
    expect(questions.match(`${code} 1`)).toBe('expired');
    now += 1;
    expect(questions.match(`${code} 1`)).toBeNull();
  });

  it('are kept in the state file, so an answer after a restart is still recognised', () => {
    const state = stateOf();
    const { code } = new TextQuestions(state.channelStore(), relayTexts('zh')).open(question);
    const again = new TextQuestions(stateOf(state.path).channelStore(), relayTexts('zh'));
    expect(again.match(`${code} 1`)).toEqual({ questionId: 'a1b2c3d4', optionId: 'y' });
  });

  it('keep twenty codes at most, all different', () => {
    const state = stateOf();
    const questions = new TextQuestions(state.channelStore(), relayTexts('zh'));
    const codes = Array.from({ length: 25 }, () => questions.open(question).code);
    const stored = state.channelStore().get<{ code: string }[]>('questions')!;
    expect(stored.map((item) => item.code)).toEqual(codes.slice(-20));
    expect(new Set(stored.map((item) => item.code)).size).toBe(20);
    expect(questions.match(`${codes[0]} 1`)).toBeNull();
  });
});

describe('the queue for the owner’s next message', () => {
  const setup = () => {
    const path = relayStatePath('test', 'wx:1', mkdtempSync(join(tmpdir(), 'queue-')));
    const state = new RelayState(path, 'wx:1', 'test', 'wechat');
    const logs: string[] = [];
    return { state, logs, path, log: (line: string) => logs.push(line) };
  };
  const photo = (name: string) => ({
    bytes: Buffer.from(name),
    mime: 'image/png',
    name,
    caption: name,
  });

  it('delivers oldest first, once, and a text said twice in a row only once', () => {
    const { state, log } = setup();
    const queue = new OutOfContextQueue(state.channelStore(), log);
    const now = Date.now();
    for (const text of ['a', 'b', 'b', 'c', 'b']) queue.push({ text, at: now });
    expect(queue.size).toBe(4);
    expect(queue.drain(now).map((item) => item.text)).toEqual(['a', 'b', 'c', 'b']);
    expect(queue.drain(now)).toEqual([]);
    expect(state.channelStore().get('queue')).toEqual([]);
  });

  it('drops the oldest beyond its size, and what is too old, saying so', () => {
    const { state, logs, log } = setup();
    const queue = new OutOfContextQueue(state.channelStore(), log, { max: 3, maxAgeMs: 1000 });
    for (let index = 1; index <= 5; index++) queue.push({ text: `n${index}`, at: index * 1000 });
    expect(logs.filter((line) => line.includes('丢掉了最早的'))).toHaveLength(2);
    expect(queue.drain(4500).map((item) => item.text)).toEqual(['n4', 'n5']);
    expect(logs.at(-1)).toContain('超过一天');
  });

  it('keeps pictures in memory only, three at most, and their fallback text in the file', () => {
    const { state, path, log } = setup();
    const queue = new OutOfContextQueue(state.channelStore(), log);
    const now = Date.now();
    for (const name of ['p1', 'p2', 'p3', 'p4'])
      queue.push({ text: '图片没能转发', at: now, photo: photo(name) });
    expect(readFileSync(path, 'utf8')).not.toContain('bytes');
    // after a restart only the texts are left
    const restarted = new OutOfContextQueue(
      new RelayState(path, 'wx:1', 'test', 'wechat').channelStore(),
      log,
    );
    expect(restarted.size).toBe(4);
    const items = queue.drain(now);
    expect(items.map((item) => item.photo?.name ?? item.text)).toEqual([
      'p1',
      'p2',
      'p3',
      '图片没能转发',
    ]);
  });

  it('goes with the Yomi account it was queued under', () => {
    const { state, log } = setup();
    state.bindAccount('7300000000000000101');
    const queue = new OutOfContextQueue(state.channelStore(), log);
    queue.push({ text: '离线时的通知', at: Date.now(), photo: photo('p1') });
    expect(state.bindAccount('7300000000000000999')).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });
});

describe('the way in for text messages', () => {
  const setup = (owner: { userId: string; chatId: string } | null) => {
    const path = relayStatePath('test', 'qq:2', mkdtempSync(join(tmpdir(), 'inbound-')));
    const state = new RelayState(path, 'qq:2', 'test', 'qq');
    const texts = relayTexts('zh');
    const host = { state, store: state.channelStore(), texts, owner: () => owner } as ChannelHost;
    const questions = new TextQuestions(host.store, texts);
    const said: string[] = [];
    let deliveries = 0;
    const inbound = new TextInbound(host, questions, {
      deliverQueue: async () => {
        deliveries += 1;
      },
      reply: async (_context, text) => {
        said.push(text);
      },
    });
    return { inbound, questions, said, deliveries: () => deliveries };
  };
  const raw = (text: string, key: string, from = 'u1'): RawInbound => ({
    key,
    from: { id: from, name: '', language: '' },
    chatId: from,
    context: { channel: 'qq', receivedAt: Date.now() },
    text,
    sentAt: Date.now(),
    replyTo: '',
  });

  it('drops a message seen before, before anything else', async () => {
    const { inbound, questions, said, deliveries } = setup({ userId: 'u1', chatId: 'u1' });
    const { code } = questions.open({ id: 'q1', prompt: 'p', options: [], layout: 'row' });
    expect(await inbound.accept(raw(`${code} 1`, 'k1'))).toBeNull();
    expect(said).toEqual(['没有这个选项。']);
    expect(await inbound.accept(raw(`${code} 1`, 'k1'))).toBeNull();
    expect(said).toHaveLength(1);
    expect(deliveries()).toBe(1);
  });

  it('passes strangers and anyone while unpaired on as they are', async () => {
    const paired = setup({ userId: 'u1', chatId: 'u1' });
    expect(await paired.inbound.accept(raw('/pair ABCD-EFGH', 'k1', 'u2'))).toMatchObject({
      kind: 'command',
      name: 'pair',
      argument: 'ABCD-EFGH',
      rawText: '/pair ABCD-EFGH',
    });
    expect(paired.deliveries()).toBe(0);
    const unpaired = setup(null);
    expect(await unpaired.inbound.accept(raw('你好', 'k1'))).toMatchObject({
      kind: 'message',
      text: '你好',
    });
    expect(unpaired.deliveries()).toBe(0);
  });

  it('answers through the core, which says "expired" for a question it does not know', async () => {
    const { inbound, questions, said } = setup({ userId: 'u1', chatId: 'u1' });
    const { code } = questions.open({
      id: 'q1',
      prompt: 'p',
      options: [{ id: 'y', label: 'yes' }],
      layout: 'row',
    });
    const answer = await inbound.accept(raw(`${code} 1`, 'k1'));
    expect(answer).toMatchObject({ kind: 'answer', questionId: 'q1', optionId: 'y' });
    if (answer?.kind !== 'answer') throw new Error('not an answer');
    await answer.ack();
    expect(said).toEqual([]);
    await answer.ack('expired');
    const again = await inbound.accept(raw(`${code} 1`, 'k2'));
    expect(again).toMatchObject({ kind: 'answer', questionId: '', optionId: '' });
    if (again?.kind === 'answer') await again.ack('expired');
    expect(said).toEqual(['这个选择已过期，请重新发送命令。', '这个选择已过期，请重新发送命令。']);
  });

  it("goes on with the owner's message when the channel cannot deliver what it holds", async () => {
    const state = new RelayState(
      relayStatePath('test', 'qq:3', mkdtempSync(join(tmpdir(), 'inbound-'))),
      'qq:3',
      'test',
      'qq',
    );
    const texts = relayTexts('zh');
    const owner = { userId: 'u1', chatId: 'u1' };
    const host = { state, store: state.channelStore(), texts, owner: () => owner } as ChannelHost;
    const questions = new TextQuestions(host.store, texts);
    const inbound = new TextInbound(host, questions, {
      deliverQueue: async () => {
        throw new Error('network');
      },
      reply: async () => {
        throw new Error('network');
      },
    });
    expect(await inbound.accept(raw('你好', 'k1'))).toMatchObject({ kind: 'message' });
    const { code } = questions.open({ id: 'q1', prompt: 'p', options: [], layout: 'row' });
    expect(await inbound.accept(raw(`${code} 1`, 'k2'))).toBeNull();
  });
});

describe("Telegram's channel", () => {
  it('writes ids as numbers and is named after the bot, as the relay always was', () => {
    const bot = new TelegramBot(`7000000001:${'A'.repeat(35)}`);
    const channel = new TelegramChannel(bot, {
      drafts: true,
      intervalMs: 30,
      pollTimeoutSeconds: 1,
    });
    expect([channel.kind, channel.scope, channel.lockName, channel.displayName]).toEqual([
      'telegram',
      '7000000001',
      '7000000001',
      'Telegram',
    ]);
    expect(channel.persistId('5570001')).toBe(5570001);
    expect(channel.caps).toMatchObject({ maxText: MESSAGE_LIMIT, quotes: true, pairing: 'code' });
    expect(channel.caps.format).toBe(TELEGRAM_HTML);
  });
});

describe('the core on any channel', () => {
  let mock: MockServer;
  const saved: Record<string, string | undefined> = {};
  const running: (() => Promise<unknown>)[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const sends = () =>
    mock.state.requests.filter((request) => request.path === 'conversation/send_message');
  const busy = (relay: Relay) => Boolean((relay as unknown as { turn: unknown }).turn);

  /** The web authorize page's part of `yomi login`, as the e2e tests do it. */
  async function signIn() {
    const terminal = memoryIo();
    const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
    const link = new URL(url);
    const params = new URLSearchParams(link.hash.slice(1));
    const page = await (await fetch(link.origin + link.pathname)).text();
    const form = [
      ...page.matchAll(/<form method="POST" data-kind="(\w+)">([\s\S]*?)<\/form>/g),
    ].find((match) => match[1] === 'authorize')!;
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

  /** A relay on `fake`, paired with its owner unless `unpaired`, listening for events. */
  async function start(
    fake: FakeChannel,
    { unpaired = false, ...overrides }: Partial<RelayOptions> & { unpaired?: boolean } = {},
  ) {
    const context = createContext(
      memoryIo().io,
      {},
      { client: `relay-${fake.kind}`, channel: 'cli_relay' },
    );
    const path = relayStatePath(context.account, fake.scope);
    const state = new RelayState(path, fake.scope, context.account, fake.kind);
    if (!unpaired && !state.data.owner)
      state.update({
        owner: {
          userId: fake.ownerId,
          chatId: fake.ownerId,
          name: '',
          language: '',
          pairedAt: Date.now(),
        },
      });
    const logs: string[] = [];
    const relay = new Relay(context.gateway, fake, state, {
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
    const controller = new AbortController();
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
    await waitFor(() => mock.state.sockets > sockets && fake.listening);
    return { relay, state, logs, controller, done, stop };
  }

  /** The owner chats: forwarded as is, and the reply shown before this returns. */
  async function chatted(fake: FakeChannel, relay: Relay, text: string) {
    const before = sends().length;
    fake.say(text);
    await waitFor(
      () => sends().length > before && !busy(relay) && fake.presenters.at(-1)?.isClosed,
    );
    expect(sends().at(-1)!.body.text).toBe(text);
  }

  beforeAll(async () => {
    mock = await startMockServer();
    const dir = mkdtempSync(join(tmpdir(), 'yomi-relay-core-'));
    const values: Record<string, string> = {
      YOMI_API_ORIGIN: mock.origin,
      YOMI_WEB_ORIGIN: mock.origin,
      YOMI_CONFIG_DIR: dir,
      YOMI_CREDENTIAL_STORE: 'file',
      NO_COLOR: '1',
    };
    for (const [key, value] of Object.entries(values)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    mock.state.relayPolicy = { enabled: true, features: { free_only: true, spend_cap: true } };
    mock.state.chatFreeLimit = 1000;
    mock.state.gems = 500;
    await signIn();
  });

  afterEach(async () => {
    for (const stop of running.splice(0)) await stop();
  });

  afterAll(async () => {
    await mock.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('confirms a budget with a typed code; a wrong number, a stray "1" and "haha 2" do not', async () => {
    const fake = new FakeChannel({ scope: 'fake:ask' });
    const { relay, state, logs } = await start(fake);
    // the server sent no policy for QQ, and this is not production: it runs, and says so
    expect(logs.some((line) => line.includes('服务端没有确认这个通道（QQ）'))).toBe(true);
    let next = fake.expect(/最多花 10 钻石吗/);
    fake.say('/budget 10');
    const ask = await next();
    const code = fake.codes.at(-1)!;
    expect(ask.text).toContain(`\n1. 允许最多 10 钻石\n2. 取消\n回复「${code} 1」`);
    next = fake.expect(/没有这个选项/);
    fake.say(`${code} 3`);
    await next();
    await chatted(fake, relay, '1');
    await chatted(fake, relay, 'haha 2');
    expect(state.data.billing.mode).toBe('open');
    next = fake.expect(/已设置预算 10 钻石/);
    fake.say(`${code} 1`);
    await next();
    expect(state.data.billing).toMatchObject({ mode: 'paid', budget: 10, spent: 0 });
    next = fake.expect(/这个选择已过期/);
    fake.say(`${code.toLowerCase()} 1`);
    await next();
  });

  it('answers "expired" to a code from before a restart, relaying and charging nothing', async () => {
    const first = new FakeChannel({ scope: 'fake:restart' });
    const one = await start(first);
    const next = first.expect(/最多花 10 钻石吗/);
    first.say('/budget 10');
    await next();
    const code = first.codes.at(-1)!;
    await one.stop();
    const second = new FakeChannel({ scope: 'fake:restart' });
    const two = await start(second);
    const before = sends().length;
    const expired = second.expect(/这个选择已过期/);
    second.say(`${code} 1`);
    await expired();
    await second.idle();
    expect(sends()).toHaveLength(before);
    expect(two.state.data.billing.mode).toBe('open');
    expect(second.texts()).not.toContainEqual(expect.stringMatching(/已设置预算/));
  });

  it('drops a replayed answer and a replayed message, and delivers the queue once', async () => {
    const fake = new FakeChannel({ scope: 'fake:replay' });
    const { relay, state } = await start(fake);
    fake.queue!.push({ text: '离线时的通知', at: Date.now() });
    const before = sends().length;
    fake.say('同一句话', { key: 'chat' });
    fake.say('同一句话', { key: 'chat' });
    await fake.idle();
    await waitFor(() => !busy(relay) && fake.presenters.at(-1)?.isClosed);
    expect(sends()).toHaveLength(before + 1);
    expect(fake.texts().filter((text) => text.startsWith('你不在时的消息（1 条）'))).toEqual([
      '你不在时的消息（1 条）：\n\n离线时的通知',
    ]);
    const next = fake.expect(/最多花 10 钻石吗/);
    fake.say('/budget 10');
    await next();
    const code = fake.codes.at(-1)!;
    fake.say(`${code} 1`, { key: 'answer' });
    fake.say(`${code} 1`, { key: 'answer' });
    await fake.idle();
    expect(fake.texts().filter((text) => /已设置预算 10 钻石/.test(text))).toHaveLength(1);
    expect(fake.texts()).not.toContainEqual(expect.stringMatching(/已过期/));
    expect(state.data.billing).toMatchObject({ mode: 'paid', budget: 10 });
    // the chat, /budget and the answer: the replays delivered nothing
    expect(fake.deliveries).toBe(3);
  });

  it('lets the channel flush after each event, and keeps reply refs as the channel writes them', async () => {
    const fake = new FakeChannel({ scope: 'fake:flush' });
    const { relay, state } = await start(fake);
    fake.timeline.splice(0);
    fake.say('/help');
    fake.say('/whatever');
    await fake.idle();
    expect(
      fake.timeline.filter((entry) => /^(event|send|flush)/.test(entry) && entry !== 'send:ask'),
    ).toEqual(['event:command', 'send:text', 'flush', 'event:command', 'send:text', 'flush']);
    // no quoting on this channel: /help does not offer it
    expect(fake.texts()[0]).toContain('/image 根据最近一条回复生成一张图片\n');
    await chatted(fake, relay, '讲个笑话');
    const [ref, mid] = state.data.replies.at(-1)!;
    // refs are numbered in the order things were said: the reply's is the last reply's
    const reply = fake.sends.map((send) => send.kind).lastIndexOf('reply');
    expect(ref).toBe(`ref-${reply + 1}`);
    // a report naming that reply finds it again
    let next = fake.expect(/选择举报原因/);
    fake.say('/report', { replyTo: String(ref) });
    await next();
    next = fake.expect(/已提交，谢谢反馈/);
    fake.say(`${fake.codes.at(-1)} 1`);
    await next();
    expect(String(mock.state.feedback.at(-1)?.mid)).toBe(mid);
  });

  it('names the bot by the channel when it has neither a handle nor a name', async () => {
    const pairing = new PairingCode();
    const fake = new FakeChannel({ scope: 'fake:pair' });
    const { state, logs } = await start(fake, { pairing, unpaired: true });
    const next = fake.expect(/已配对/);
    fake.say(`/pair ${pairing.display}`, { from: 'openid-7' });
    const paired = await next();
    expect(paired.text).toContain('（QQ）');
    expect(paired.text).not.toContain('（）');
    expect(paired.to).toBe('openid-7');
    expect(state.data.owner).toMatchObject({ userId: 'openid-7', chatId: 'openid-7', name: '' });
    expect(logs).toContain('已配对：QQ 用户 openid-7');
  });

  it('ends the channel through its own signal when another Yomi account signs in', async () => {
    const fake = new FakeChannel({ scope: 'fake:signal' });
    const { relay, controller, done } = await start(fake, {
      rerunCommand: 'yomi relay --channel qq',
    });
    expect(fake.host!.signal).not.toBe(controller.signal);
    (relay as unknown as { otherAccount(): void }).otherAccount();
    const error = await done;
    expect(error).toBeInstanceOf(RelayStopped);
    expect((error as RelayStopped).reason).toBe('otherAccount');
    expect(controller.signal.aborted).toBe(false);
    expect(fake.eventsEnded).toBe(true);
    expect(fake.closes).toBe(1);
    expect(fake.texts().at(-1)).toBe(
      '电脑上登录的 Yomi 账号变了，relay 已停止。请重新运行 yomi relay --channel qq。',
    );
  });

  it('stops the open reply before closing the channel, and gives up on a stop that hangs', async () => {
    const order = (fake: FakeChannel) =>
      fake.timeline.filter((entry) => /^(presenter:stop|close)/.test(entry));
    const fake = new FakeChannel({ scope: 'fake:shutdown' });
    const one = await start(fake);
    fake.stopDelayMs = 200;
    fake.say('SLOW 一个很长的故事');
    await waitFor(() => fake.presenters[0]?.calls.includes('start') && busy(one.relay));
    await one.stop();
    expect(order(fake)).toEqual(['presenter:stop', 'presenter:stopped', 'close']);

    const hung = new FakeChannel({ scope: 'fake:hang' });
    const two = await start(hung);
    const release = hung.holdStops();
    hung.say('SLOW 另一个很长的故事');
    await waitFor(() => hung.presenters[0]?.calls.includes('start') && busy(two.relay));
    const stopping = Date.now();
    await two.stop();
    const took = Date.now() - stopping;
    expect(took).toBeGreaterThanOrEqual(2900);
    expect(took).toBeLessThan(6000);
    expect(order(hung)).toEqual(['presenter:stop', 'close']);
    release();
  });

  it('starts nothing while the channel is paused; commands still work', async () => {
    const fake = new FakeChannel({ scope: 'fake:pause' });
    const { relay, state, logs } = await start(fake);
    const paused = () => logs.filter((line) => line.includes('转发已暂停'));
    const resumed = () => logs.filter((line) => line.includes('恢复转发'));
    fake.host!.pause('contentRefused', null);
    fake.host!.pause('contentRefused', null);
    expect(paused()).toEqual(['QQ 多次按内容规则拒绝了回复，转发已暂停（重新启动 relay 后恢复）']);
    const before = sends().length;
    let next = fake.expect(/^转发已暂停：QQ 拒绝了多条回复。/);
    fake.say('你好');
    await next();
    next = fake.expect(/^转发已暂停：QQ 拒绝了多条回复。/);
    fake.say('/image');
    await next();
    next = fake.expect(/本机上限 50 钻石/);
    fake.say('/budget');
    await next();
    next = fake.expect(/^直接发文字/);
    fake.say('/help');
    await next();
    await fake.idle();
    expect(sends()).toHaveLength(before);
    expect(state.data.pending).toBeNull();
    fake.host!.resume();
    fake.host!.resume();
    expect(resumed()).toEqual(['QQ 恢复转发']);
    // unavailable for a while: it ends by itself
    fake.host!.pause('unavailable', Date.now() + 300);
    next = fake.expect(/^QQ 暂时不可用，这条消息没有转发（没有扣费）。$/);
    fake.say('还在吗');
    await next();
    await sleep(350);
    await chatted(fake, relay, '现在呢');
    expect(resumed()).toHaveLength(2);
  });

  it('relays QQ in production only once the server confirms it, asking again after a while', async () => {
    const policy = mock.state.relayPolicy;
    mock.state.relayPolicy = null;
    try {
      const fake = new FakeChannel({ scope: 'fake:gated' });
      const { relay, logs } = await start(fake, {
        requireServerPolicy: true,
        policyRefetchMs: 300,
      });
      expect(logs.some((line) => line.includes('服务端还没有开放这个通道（QQ）'))).toBe(true);
      const before = sends().length;
      let next = fake.expect(/^relay 已被服务端关闭：服务端还没有开放这个通道。$/);
      fake.say('你好');
      await next();
      // the server confirms it now, but is asked again only after the wait: still off
      mock.state.relayPolicy = {
        enabled: true,
        channel: 'qq',
        features: { free_only: true, spend_cap: true },
      };
      next = fake.expect(/^relay 已被服务端关闭/);
      fake.say('你好');
      await next();
      expect(sends()).toHaveLength(before);
      await sleep(350);
      await chatted(fake, relay, '现在可以了吗');
      // read twice: the defaults at the start, the server's policy once it confirmed the channel
      expect(
        logs.filter((line) => line.startsWith('服务端策略：')).map((line) => line.split('；')[0]),
      ).toEqual(['服务端策略：未提供（按最严格的默认值）', '服务端策略：已读取']);
    } finally {
      mock.state.relayPolicy = policy;
    }
  });

  it("follows Telegram's Stop button through its channel, and answers buttons it does not know", async () => {
    // What the golden transcript leaves out, through the channel: a draft's Stop (only its own
    // stops the reply), a button from before a restart, and a stranger's press.
    const tg = await startMockTelegram({ username: 'core_relay_bot' });
    const bot = new TelegramBot(tg.token, { apiOrigin: tg.origin });
    const context = createContext(
      memoryIo().io,
      {},
      { client: 'relay-telegram', channel: 'cli_relay' },
    );
    const state = new RelayState(relayStatePath(context.account, bot.id), bot.id, context.account);
    const owner = { id: 5551001, first_name: 'Lin' };
    const stranger = { id: 5551999, first_name: 'Eve' };
    state.update({
      owner: {
        userId: owner.id,
        chatId: owner.id,
        name: 'Lin',
        language: '',
        pairedAt: Date.now(),
      },
    });
    const logs: string[] = [];
    const sockets = mock.state.sockets;
    const relay = new Relay(context.gateway, bot, state, {
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
    });
    const controller = new AbortController();
    const done = relay.run(controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitFor(
        () => mock.state.sockets > sockets && tg.calls.some((call) => call.method === 'getUpdates'),
      );
      tg.userSends(owner, 'SLOW 讲一个很长的故事');
      const draft = await tg.waitFor(() => tg.draft(owner.id), 8000);
      tg.stopGeneration(owner.id, draft.draft_id + 1000);
      tg.stopGeneration(owner.id, draft.draft_id);
      await tg.waitFor(
        () => tg.messages(owner.id).find((message) => /^已停止转发这条回复。/.test(message.text)),
        8000,
      );
      expect(logs.filter((line) => line === '主人停止了这条回复的转发')).toHaveLength(1);
      await waitFor(() => !busy(relay));
      tg.press(owner, owner.id, 1, 'deadbeef:y');
      tg.press(stranger, owner.id, 1, 'deadbeef:y');
      const answers = await tg.waitFor(() => {
        const calls = tg.calls.filter((call) => call.method === 'answerCallbackQuery');
        return calls.length >= 2 ? calls : null;
      }, 8000);
      expect(answers.map((call) => Object.keys(call.params))).toEqual([
        ['callback_query_id', 'text'],
        ['callback_query_id'],
      ]);
      expect(answers[0].params.text).toBe('这个按钮已过期。');
      expect(state.data.billing.mode).toBe('open');
    } finally {
      controller.abort();
      expect(await done).toBeNull();
      await tg.close();
    }
  });

  it('relays WeChat in production on a confirmed channel with no features and no cap: Yomi charges as usual', async () => {
    const policy = mock.state.relayPolicy;
    const freeLimit = mock.state.chatFreeLimit;
    const gems = mock.state.gems;
    // The server enables WeChat and echoes it, but offers no feature at all.
    mock.state.relayPolicy = { enabled: true, channel: 'wechat', features: {} };
    try {
      const fake = new FakeChannel({ kind: 'wechat', scope: 'fake:wx-open' });
      const { relay, state, logs } = await start(fake, {
        requireServerPolicy: true,
        maxSpend: null,
      });
      expect(logs).toContain(
        '没有设花费上限：按 Yomi 的正常规则扣费，钻石不足时会在聊天里提示；通过 relay 已花 0 钻石',
      );
      // Past the free replies: charged by the normal rules, no budget asked for.
      mock.state.chatFreeLimit = 0;
      mock.state.gems = 12;
      await chatted(fake, relay, '不设上限的一句');
      expect(sends().at(-1)!.body).toMatchObject({ consumption_mode: 1 });
      expect(sends().at(-1)!.body.max_cost_diamonds).toBeUndefined();
      await waitFor(() => state.data.allowance.spent === 5 && state.data.pending === null);
      expect(mock.state.gems).toBe(7);
      // No cost line in the chat; the terminal has it.
      expect(fake.texts()).not.toContainEqual(expect.stringMatching(/钻石/));
      expect(logs).toContain('扣了 5 钻石（通过 relay 累计 5；没有设花费上限）');
      // Too few gems: said in the chat, the relay keeps running, nothing is paused.
      mock.state.gems = 3;
      let next = fake.expect(/^钻石不足，请在 Yomi App 或网页充值后再发。$/);
      fake.say('钻石不够了');
      await next();
      expect(state.data.billingPause).toBe('');
      expect(state.data.pending).toBeNull();
      // After a top-up the next message simply goes.
      mock.state.gems = 50;
      await chatted(fake, relay, '充值之后');
      await waitFor(() => state.data.allowance.spent === 10 && state.data.pending === null);
      next = fake.expect(
        /^没有设花费上限：按 Yomi 的正常规则扣费。通过 relay 已花 10 钻石。\n用法/,
      );
      fake.say('/budget');
      await next();
    } finally {
      mock.state.relayPolicy = policy;
      mock.state.chatFreeLimit = freeLimit;
      mock.state.gems = gems;
    }
  });

  it('says a reply that ran out of gems in its own words, on QQ, and keeps relaying', async () => {
    const fake = new FakeChannel({ scope: 'fake:qq-nogems' });
    const { relay, state } = await start(fake, { maxSpend: null });
    const next = fake.expect(/^钻石不足，请在 Yomi App 或网页充值后再发。$/);
    fake.say('NOGEMS 说到一半');
    await next();
    expect(fake.texts()).not.toContainEqual(expect.stringMatching(/insufficient gems/));
    await waitFor(() => !busy(relay));
    expect(state.data.billingPause).toBe('');
    await chatted(fake, relay, '接着聊');
  });

  it('keeps an unconfirmed channel off when the sign-in comes back', async () => {
    const policy = mock.state.relayPolicy;
    mock.state.relayPolicy = null;
    try {
      const fake = new FakeChannel({ scope: 'fake:gated-resume' });
      const { relay } = await start(fake, { requireServerPolicy: true });
      const resumed = fake.expect(/^Yomi 登录已恢复/);
      await (relay as unknown as { signedOut(): Promise<void> }).signedOut();
      await resumed();
      const before = sends().length;
      const next = fake.expect(/^relay 已被服务端关闭：服务端还没有开放这个通道。$/);
      fake.say('你好');
      await next();
      await fake.idle();
      expect(sends()).toHaveLength(before);
    } finally {
      mock.state.relayPolicy = policy;
    }
  });
});

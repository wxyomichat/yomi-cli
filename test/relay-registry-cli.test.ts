import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { writeJsonFile } from '../src/core/files.js';
import { MOCK_NPCS, type MockServer, startMockServer } from '../src/mock/server.js';
import {
  type MockTelegram,
  type MockTelegramBot,
  startMockTelegram,
} from '../src/mock/telegram.js';
import type { ChannelSetup } from '../src/relay/channels/setup.js';
import { wechatSetup } from '../src/relay/channels/wechat.js';
import { BotRegistry, characterOwner, registryPath } from '../src/relay/registry.js';
import { ownerKey, RelayState, relayStatePath } from '../src/relay/state.js';
import { TelegramBot } from '../src/relay/telegram.js';
import { authorizeLikeTheBrowser } from './helpers/authorize.js';
import { memoryIo } from './helpers/io.js';

/**
 * The bot registry through `yomi relay` (relay/registry.ts, commands/relay.ts): a Telegram bot of
 * before the registry taken over on the first command with its owner, budget and character, no
 * welcome sent again; `--list`, read-only, in four languages; the stored credentials checked
 * against the registered bot on every run (another bot's refused, in a terminal and in a service);
 * `--set-token` setting only the bot's own token again, another bot added once it is taken away
 * (`--forget --bot`); `--forget` taking it away; the
 * registered owner's start given back to a state file that lost it; one character per bot (a run's
 * other `--character` ignored, and left out of a service it installs, `--bot NAME --character ID`
 * binding another one while the bot is stopped and its owner welcomed with it, a bot without one
 * paired and answering only how to bind one); a token set by another command while a relay starts;
 * a registered bot whose credentials are gone (listed with the command that sets them, and never
 * asked for in a run of several bots). Against the mock gateway and the mock Bot API, nothing on
 * the network.
 */

/** Run once in a `yomi relay --telegram` start: as another command would run there. */
const hooks = vi.hoisted(() => ({
  /** After the bot it opened answered getMe. */
  afterVerify: null as (() => void) | null,
}));

vi.mock('../src/relay/channels/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/channels/telegram.js')>();
  const once = (key: keyof typeof hooks) => {
    const hook = hooks[key];
    hooks[key] = null;
    hook?.();
  };
  const overrides: Partial<ChannelSetup> = {
    verify: async (channel) => {
      const identity = await real.telegramSetup.verify(channel);
      once('afterVerify');
      return identity;
    },
  };
  return {
    ...real,
    telegramSetup: Object.assign(Object.create(real.telegramSetup) as ChannelSetup, overrides),
  };
});

/** What `--install-service` would have installed (its unit's content), never installed here. */
const installed = vi.hoisted(() => [] as string[]);

vi.mock('../src/relay/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/service.js')>();
  return {
    ...real,
    installService: (plan: { content: string }) => void installed.push(plan.content),
  };
});

let mock: MockServer;
let tg: MockTelegram;
let second: MockTelegramBot;
let dir: string;
const saved: Record<string, string | undefined> = {};
const owner = { id: 5580001, first_name: 'Ada', language_code: 'en' };
const CJK = /[㐀-鿿＀-￯　-〿]/;

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

const context = () => createContext(memoryIo().io, {});
const TOKEN_NAME = () => `telegram-bot:${context().account}`;

/** What a command that does not know the registry might do: write `bot`'s token over `name`'s. */
function setTokenElsewhere(name: string, bot: MockTelegramBot) {
  const { store, account } = context();
  store.setSecret(BotRegistry.open(account).find(name)!.secretName, bot.token);
}

/** A Telegram relay of `bot` runs until a second poller takes the bot over (409). */
async function runUntilConflict(bot: MockTelegramBot, args: string[] = []) {
  const polls = bot.calls.filter((call) => call.method === 'getUpdates').length;
  const terminal = memoryIo();
  const pending = main(['relay', '--telegram', '--allow-file-store', ...args], terminal.io);
  await bot.waitFor(() => bot.calls.filter((call) => call.method === 'getUpdates').length > polls);
  return {
    terminal,
    stop: async () => {
      await new TelegramBot(bot.token, { apiOrigin: bot.origin }).getUpdates(-1, 0).catch(() => {});
      expect(await pending).toBe(0);
    },
  };
}

beforeAll(async () => {
  mock = await startMockServer();
  tg = await startMockTelegram({ username: 'Lin_Registry_Bot' });
  second = tg.addBot({ username: 'second_registry_bot', botId: 7_000_000_202 });
  dir = mkdtempSync(join(tmpdir(), 'yomi-relay-registry-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_TELEGRAM_API_ORIGIN: tg.origin,
    YOMI_CONFIG_DIR: dir,
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  await authorizeLikeTheBrowser(mock, url);
  expect(await pending).toBe(0);
});

afterAll(async () => {
  await tg.close();
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('yomi relay --list', () => {
  it('says there is no bot yet, takes --channel or none, and nothing else', async () => {
    const empty = await run(['relay', '--list']);
    expect(empty.code).toBe(0);
    expect(empty.out).toContain('这台电脑上还没有 bot');
    expect(empty.out).toContain('没有安装后台服务。');
    expect((await run(['relay', '--list', '--channel', 'qq'])).code).toBe(0);
    expect((await run(['relay', '--list', '--telegram'])).code).toBe(0);
    const mixed = await run(['relay', '--list', '--forget']);
    expect(mixed.code).toBe(1);
    expect(mixed.err).toContain('--list 只列出 bot，不能和 --forget 一起用');
    // Without --list or a channel a run takes every bot: there is none yet.
    expect((await run(['relay'])).err).toContain('这台电脑上还没有 bot');
    expect(existsSync(registryPath(context().account))).toBe(false);
    for (const lang of ['en', 'es', 'pt']) {
      const other = await run(['--lang', lang, 'relay', '--list']);
      expect(other.out.search(CJK), lang).toBe(-1);
      expect(other.out, lang).toContain('yomi relay --telegram --set-token');
    }
  });
});

describe('a bot of before the registry', () => {
  it('is taken over with its owner, budget and character, and its owner gets no welcome again', async () => {
    const { store, account } = context();
    store.setSecret(TOKEN_NAME(), tg.token);
    const scope = String(tg.botId);
    const state = new RelayState(relayStatePath(account, scope), scope, account);
    state.update({
      botUsername: 'Lin_Registry_Bot',
      owner: {
        userId: owner.id,
        chatId: owner.id,
        name: owner.first_name,
        language: 'en',
        pairedAt: 1000,
      },
      character: { npcId: MOCK_NPCS.single, name: '林夏', group: false },
      billing: { mode: 'paid', budget: 50, spent: 12, setAt: 5 },
      greeted: [MOCK_NPCS.single],
    });
    // A file as a relay of before welcomes wrote it: no list of whom it welcomed.
    const legacy = JSON.parse(readFileSync(state.path, 'utf8')) as Record<string, unknown>;
    delete legacy.welcomed;
    delete legacy.welcomeDue;
    writeJsonFile(state.path, legacy);
    const before = readFileSync(state.path, 'utf8');

    const listed = await run(['relay', '--list']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('lin_registry_bot  Telegram  @Lin_Registry_Bot');
    expect(listed.out).toContain(`  角色：林夏（${MOCK_NPCS.single}）`);
    expect(listed.out).toContain('  主人：Ada');
    expect(listed.out).toContain('  状态：没有运行');
    // Taken over: the registry only, the state file as it was.
    expect(readFileSync(state.path, 'utf8')).toBe(before);
    const [record] = BotRegistry.open(account).list();
    expect(record).toMatchObject({
      name: 'lin_registry_bot',
      scope,
      lockName: scope,
      secretName: TOKEN_NAME(),
      migratedFrom: 'telegram',
      welcomeBaseline: { owner: ownerKey(owner.id), npcId: MOCK_NPCS.single },
    });
    const english = await run(['--lang', 'en', 'relay', '--list']);
    expect(english.out).toContain(`  Character: 林夏 (${MOCK_NPCS.single})`);
    expect(english.out).toContain('  Owner: Ada');
    expect(english.out).toContain('  Status: not running');

    const running = await runUntilConflict(tg);
    const during = await run(['relay', '--list']);
    expect(during.out).toContain(`  状态：运行中（进程 ${process.pid}）`);
    await running.stop();
    expect(running.terminal.out).toContain('relay 运行中：@Lin_Registry_Bot ⇄ Yomi');
    // Nothing was said in the owner's chat: no welcome, no opening.
    expect(tg.messages(owner.id)).toEqual([]);
    expect(tg.photos(owner.id)).toEqual([]);
    const after = new RelayState(state.path, scope, account);
    expect(after.data.owner?.userId).toBe(owner.id);
    expect(after.data.billing).toMatchObject({ mode: 'paid', budget: 50, spent: 12 });
    expect(after.data.greeted).toEqual([MOCK_NPCS.single]);
    expect(after.welcomeOwed).toBe(false);
    expect(BotRegistry.open(account).list()[0]).toMatchObject({
      key: record.key,
      platformUser: 'Lin_Registry_Bot',
      character: { npcId: MOCK_NPCS.single },
    });
  });

  it('gives its owner of then their start back when a state file lost it: pairing again owes no welcome', async () => {
    const { account } = context();
    const scope = String(tg.botId);
    const [record] = BotRegistry.open(account).list();
    expect(record.welcomeBaseline).toEqual({ owner: ownerKey(owner.id), npcId: MOCK_NPCS.single });
    // Rewritten by a yomi that knew neither: a list of whom it welcomed, without this owner.
    const state = new RelayState(relayStatePath(account, scope), scope, account);
    state.update({ welcomed: [], welcomeDue: '' });

    const running = await runUntilConflict(tg);
    await running.stop();
    expect(tg.messages(owner.id)).toEqual([]);
    const after = new RelayState(state.path, scope, account);
    expect(after.data.welcomed).toEqual([
      { owner: ownerKey(owner.id), npcId: MOCK_NPCS.single, at: 0 },
    ]);
    after.resetOwner();
    after.bindOwner({
      userId: owner.id,
      chatId: owner.id,
      name: owner.first_name,
      language: 'en',
      pairedAt: 2000,
    });
    expect(after.welcomeOwed).toBe(false);
  });

  it('talks as its own character: a run ignores another --character, and the bot is bound to another one only while it is stopped', async () => {
    const { account } = context();
    const [before] = BotRegistry.open(account).list();
    expect(before.character?.npcId).toBe(MOCK_NPCS.single);
    // An older service's --character: said and ignored, and the bot runs as its own character.
    const running = await runUntilConflict(tg, ['--character', MOCK_NPCS.group]);
    const menu = tg.calls.filter((call) => call.method === 'setMyCommands').at(-1)!.params
      .commands as { command: string }[];
    expect(menu.map((item) => item.command)).not.toContain('character');
    // While it runs it is not bound to another one.
    const busy = await run(['relay', '--bot', 'lin_registry_bot', '--character', MOCK_NPCS.group]);
    expect(busy.code).toBe(1);
    expect(busy.err).toContain(
      `relay 正在运行（Telegram bot @Lin_Registry_Bot，进程 ${process.pid}）：先停止它`,
    );
    await running.stop();
    expect(running.terminal.err).toContain(
      `bot lin_registry_bot 固定和林夏（${MOCK_NPCS.single}）聊天：忽略这次的 --character ${MOCK_NPCS.group}。要换角色，先停止 relay，再运行 yomi relay --bot lin_registry_bot --character ID。`,
    );
    expect(BotRegistry.open(account).list()[0]).toEqual(before);

    // Stopped, it is bound to the other one; its owner, budget and records stay.
    const bound = await run(['relay', '--bot', 'lin_registry_bot', '--character', MOCK_NPCS.group]);
    expect(bound.code).toBe(0);
    expect(bound.out).toContain(
      `已把 bot lin_registry_bot 换绑到雾港（${MOCK_NPCS.group}），下次启动 relay 时生效。`,
    );
    expect(bound.out).toContain('主人发下一条消息时，会先收到这个角色的介绍。');
    const [after] = BotRegistry.open(account).list();
    expect(after).toMatchObject({
      key: before.key,
      character: { npcId: MOCK_NPCS.group, name: '雾港', group: true },
      generation: before.generation + 1,
    });
    expect(after.boundAt).toBeGreaterThan(before.boundAt);
    const listed = await run(['relay', '--list']);
    expect(listed.out).toContain(`  角色：雾港（${MOCK_NPCS.group}）`);
    const revision = BotRegistry.open(account).data.revision;
    const same = await run(['relay', '--bot', 'lin_registry_bot', '--character', MOCK_NPCS.group]);
    expect(same.out).toContain(
      `bot lin_registry_bot 已经绑定雾港（${MOCK_NPCS.group}），没有改动。`,
    );
    expect(BotRegistry.open(account).data.revision).toBe(revision);

    // Its owner is welcomed with it before the answer to their next message, once.
    const scope = String(tg.botId);
    const state = () => new RelayState(relayStatePath(account, scope), scope, account);
    expect(state().data.owner?.userId).toBe(owner.id);
    const { billing, replies } = state().data;
    const shown = tg.messages(owner.id).length;
    const again = await runUntilConflict(tg);
    tg.userSends(owner, '大家好');
    await tg.waitFor(
      () => tg.messages(owner.id).find((message) => /<b>阿青<\/b>：大家好/.test(message.text)),
      8000,
    );
    tg.userSends(owner, '/help');
    await tg.waitFor(
      () => tg.messages(owner.id).find((message) => /^直接发文字/.test(message.text)),
      8000,
    );
    tg.userSends(owner, '/character');
    await tg.waitFor(
      () => tg.messages(owner.id).find((message) => /固定和「雾港」聊天/.test(message.text)),
      8000,
    );
    await again.stop();
    const said = tg
      .messages(owner.id)
      .slice(shown)
      .map((message) => message.text);
    expect(said[0]).toMatch(/^你正在与 AI 角色「雾港」聊天/);
    expect(said.findIndex((text) => /<b>阿青<\/b>：大家好/.test(text))).toBeGreaterThan(1);
    expect(said.at(-1)).toBe(
      '这个 bot 固定和「雾港」聊天，不能在聊天里换角色。要换，在电脑上运行：yomi relay --bot lin_registry_bot --character ID',
    );
    expect(said.filter((text) => /AI 角色「雾港」/.test(text))).toHaveLength(1);
    // Its help has no /character: the character is changed on the computer only.
    const help = said.find((text) => /^直接发文字/.test(text))!;
    expect(help).not.toContain('/character');
    for (const command of ['/price', '/budget', '/image', '/report', '/stop'])
      expect(help).toContain(command);
    expect(state().data.welcomed.at(-1)).toMatchObject({
      owner: ownerKey(owner.id),
      npcId: MOCK_NPCS.group,
    });
    expect(BotRegistry.open(account).data.characterOwners[MOCK_NPCS.group]).toBe(
      characterOwner('telegram', owner.id),
    );
    expect(state().data.billing).toEqual(billing);
    expect(state().data.replies.slice(0, replies.length)).toEqual(replies);
  });

  it('binds no bot to a character another bot has, and says what --bot needs', async () => {
    const { account } = context();
    const registry = BotRegistry.open(account);
    const [record] = registry.list();
    // Another bot (of another channel) with 林夏.
    registry.commit((file) => {
      file.bots.push({
        ...record,
        key: 'other-bot',
        name: 'qq-0001',
        kind: 'qq',
        platformId: '10001',
        scope: 'qq:10001',
        lockName: 'qq-10001',
        secretName: 'qq-bot:elsewhere',
        character: { npcId: MOCK_NPCS.single, name: '林夏', group: false },
      });
    });
    const revision = BotRegistry.open(account).data.revision;
    const taken = await run([
      'relay',
      '--bot',
      'lin_registry_bot',
      '--character',
      MOCK_NPCS.single,
    ]);
    expect(taken.code).toBe(1);
    expect(taken.err).toContain(
      `角色 ${MOCK_NPCS.single} 已经绑在 bot "qq-0001" 上：一个角色只能绑一个 bot。要把它给别的 bot，先给 qq-0001 换一个角色：yomi relay --bot qq-0001 --character ID`,
    );
    const english = await run([
      '--lang',
      'en',
      'relay',
      '--bot',
      'lin_registry_bot',
      '--character',
      MOCK_NPCS.single,
    ]);
    expect(english.err).toContain(
      `Character ${MOCK_NPCS.single} is already bound to the bot "qq-0001": a character goes with one bot only.`,
    );
    expect(BotRegistry.open(account).data.revision).toBe(revision);

    const unknown = await run(['relay', '--bot', 'nobody', '--character', MOCK_NPCS.group]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain(
      '没有叫 "nobody" 的 bot。这台电脑上的 bot：lin_registry_bot、qq-0001（yomi relay --list）。',
    );
    const channel = await run([
      'relay',
      '--channel',
      'qq',
      '--bot',
      'lin_registry_bot',
      '--character',
      MOCK_NPCS.group,
    ]);
    expect(channel.err).toContain('"lin_registry_bot" 是 Telegram 的 bot，不是 QQ 的。');
    const englishChannel = await run([
      '--lang',
      'en',
      'relay',
      '--channel',
      'qq',
      '--bot',
      'lin_registry_bot',
      '--character',
      MOCK_NPCS.group,
    ]);
    expect(englishChannel.err).toContain('"lin_registry_bot" is a Telegram bot, not QQ.');
    // Without --character, --bot chooses the bots to run, never with one channel's service.
    const toRun = await run(['relay', '--bot', 'nobody', '--allow-file-store']);
    expect(toRun.code).toBe(1);
    expect(toRun.err).toContain('没有叫 "nobody" 的 bot。这台电脑上的 bot：lin_registry_bot');
    const service = await run(['relay', '--bot', 'lin_registry_bot', '--install-service']);
    expect(service.code).toBe(1);
    expect(service.err).toContain('--bot 不能和 --install-service 一起用');
    // With a credentials flag it sets that bot's again: never with --character.
    const renew = await run([
      'relay',
      '--bot',
      'lin_registry_bot',
      '--set-token',
      '--character',
      MOCK_NPCS.group,
    ]);
    expect(renew.code).toBe(1);
    expect(renew.err).toContain(
      'bot lin_registry_bot 已经登记了：重新设置凭证时不能加 --character。',
    );
    const wrongFlag = await run(['relay', '--bot', 'lin_registry_bot', '--set-app']);
    expect(wrongFlag.err).toContain('--set-app 只用于 QQ');
    const mixed = await run(['relay', '--bot', 'lin_registry_bot', '--pair', '--character', '1']);
    expect(mixed.err).toContain('--bot 和 --character 一起用是给 bot 换绑角色，不能再加 --pair');
    const two = await run(['relay', '--bot', 'lin_registry_bot,other', '--character', '1']);
    expect(two.err).toContain('一次只能给一个 bot 换绑角色');
    const bad = await run(['relay', '--bot', 'lin_registry_bot', '--character', 'nobody']);
    expect(bad.err).toContain('没有找到角色 nobody，或它暂时不能聊天。');
    for (const lang of ['en', 'es', 'pt']) {
      const other = await run(['--lang', lang, 'relay', '--bot', 'nobody', '--character', '1']);
      expect(other.err.search(CJK), lang).toBe(-1);
      expect(other.err, lang).toContain('lin_registry_bot');
    }
    expect(BotRegistry.open(account).data.revision).toBe(revision);

    // A service is installed as its bot's own character: another --character is said and left out.
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'yomi-relay-home-'));
    try {
      const ignored = await run([
        'relay',
        '--telegram',
        '--install-service',
        '--allow-file-store',
        '--character',
        MOCK_NPCS.single,
      ]);
      expect(ignored.code).toBe(0);
      expect(ignored.err).toContain(
        `bot lin_registry_bot 固定和雾港（${MOCK_NPCS.group}）聊天：忽略这次的 --character ${MOCK_NPCS.single}。`,
      );
      expect(ignored.out).toContain('已安装并启动后台服务');
      expect(installed).toHaveLength(1);
      expect(installed[0]).not.toContain('--character');
      // A bot without one: a character another bot has is refused before anything is installed.
      registry.commit((file) => {
        file.bots.find((item) => item.name === 'lin_registry_bot')!.character = null;
      });
      const held = await run([
        'relay',
        '--telegram',
        '--install-service',
        '--allow-file-store',
        '--character',
        MOCK_NPCS.single,
      ]);
      expect(held.code).toBe(1);
      expect(held.err).toContain(
        `角色 ${MOCK_NPCS.single} 已经绑在 bot "qq-0001" 上：一个角色只能绑一个 bot。`,
      );
      expect(installed).toHaveLength(1);
      // One nobody has goes into the service, which binds it when it starts.
      const free = await run([
        'relay',
        '--telegram',
        '--install-service',
        '--allow-file-store',
        '--character',
        MOCK_NPCS.group,
      ]);
      expect(free.code).toBe(0);
      expect(free.err).not.toContain('还没有绑定角色');
      expect(installed[1]).toContain(MOCK_NPCS.group);
    } finally {
      process.env.HOME = home;
      registry.commit((file) => {
        file.bots.find((item) => item.name === 'lin_registry_bot')!.character = {
          npcId: MOCK_NPCS.group,
          name: '雾港',
          group: true,
        };
      });
    }
    registry.commit((file) => {
      file.bots = file.bots.filter((item) => item.key !== 'other-bot');
    });
  });

  it('is not counted as a bot of another channel: --list --channel says that channel has none', async () => {
    const qq = await run(['relay', '--list', '--channel', 'qq']);
    expect(qq.code).toBe(0);
    expect(qq.out).toContain(
      '这台电脑上还没有 QQ 的 bot：用 yomi relay --channel qq --set-app 设置一个。',
    );
    expect(qq.out).toContain('其他通道的 bot：yomi relay --list');
    expect(qq.out).not.toContain('这台电脑上还没有 bot：');
    expect(qq.out).not.toContain('lin_registry_bot');
    const wechat = await run(['relay', '--list', '--channel', 'wechat']);
    expect(wechat.out).toContain(
      '这台电脑上还没有微信的 bot：用 yomi relay --channel wechat --experimental --login 设置一个。',
    );
    const english = await run(['--lang', 'en', 'relay', '--list', '--channel', 'qq']);
    expect(english.out).toContain(
      'No QQ bot on this computer yet: set one up with yomi relay --channel qq --set-app.',
    );
    expect(english.out).toContain("Other channels' bots: yomi relay --list");
    for (const lang of ['es', 'pt']) {
      const other = await run(['--lang', lang, 'relay', '--list', '--channel', 'qq']);
      expect(other.out.search(CJK), lang).toBe(-1);
      expect(other.out, lang).toContain('yomi relay --channel qq --set-app');
    }
  });

  it('never runs credentials of another bot as itself, and --set-token sets only its own', async () => {
    const { store, account } = context();
    // An older yomi (or anything that does not know the registry) put another bot's token there.
    store.setSecret(TOKEN_NAME(), second.token);
    const terminal = await run(['relay', '--telegram', '--allow-file-store'], {
      interactive: true,
    });
    expect(terminal.code).toBe(1);
    expect(terminal.err).toContain(
      '保存的 Telegram 凭证属于另一个 bot，不是登记的 lin_registry_bot，所以没有启动。要给 lin_registry_bot 重新设置它自己的凭证，运行 yomi relay --bot lin_registry_bot --set-token；要删掉它，运行 yomi relay --forget --bot lin_registry_bot。',
    );
    // A service says so and ends without failing: a restart would not fix it.
    const service = await run(['relay', '--telegram', '--allow-file-store']);
    expect(service.code).toBe(0);
    expect(service.err).toContain('凭证属于另一个 bot');
    expect(service.out).not.toContain('relay 运行中');
    expect(second.calls.some((call) => call.method === 'getUpdates')).toBe(false);
    const english = await run(['--lang', 'en', 'relay', '--telegram', '--allow-file-store']);
    expect(english.err).toContain(
      'The saved Telegram credentials belong to a bot other than the registered lin_registry_bot, so the relay was not started.',
    );
    expect((await run(['relay', '--list'])).out).toContain('  状态：凭证属于另一个 bot');
    // The installation is refused too.
    const install = await run(['relay', '--telegram', '--install-service', '--allow-file-store']);
    expect(install.code).toBe(1);
    expect(install.err).toContain('凭证属于另一个 bot');

    // --set-token for the channel's one bot sets its own token again: another bot's is refused
    // before Telegram is asked, and nothing is saved.
    const checks = second.calls.filter((call) => call.method === 'getMe').length;
    const set = await run(
      ['relay', '--telegram', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [second.token] },
    );
    expect(set.code).toBe(1);
    expect(set.err).toContain(
      '这些凭证属于另一个 bot，不是 lin_registry_bot，没有保存。要把它作为新的 bot 加上：yomi relay --telegram --set-token --character ID；要先删掉 lin_registry_bot：yomi relay --forget --bot lin_registry_bot',
    );
    expect(second.calls.filter((call) => call.method === 'getMe')).toHaveLength(checks);
    expect(store.getSecret(TOKEN_NAME())).toBe(second.token);
    // Its own token again: kept, the bot as it was (a new generation).
    const [before] = BotRegistry.open(account).list();
    const own = await run(
      ['relay', '--bot', 'lin_registry_bot', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [tg.token] },
    );
    expect(own.code).toBe(0);
    expect(own.out).toContain('已保存 @Lin_Registry_Bot 的 token');
    expect(own.out).not.toContain('已添加');
    expect(store.getSecret(TOKEN_NAME())).toBe(tg.token);
    expect(BotRegistry.open(account).list()).toEqual([
      { ...before, generation: before.generation + 1 },
    ]);

    // Taken away, the other bot is the channel's bot: added, not bound to a character.
    const removed = await run(['relay', '--forget', '--bot', 'lin_registry_bot']);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain('已删除 bot lin_registry_bot（Telegram @Lin_Registry_Bot）。');
    expect(store.getSecret(TOKEN_NAME())).toBeNull();
    const added = await run(
      ['relay', '--telegram', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [second.token] },
    );
    expect(added.code).toBe(0);
    expect(added.err).toBe('');
    const [record] = BotRegistry.open(account).list();
    expect(record).toMatchObject({
      name: 'second_registry_bot',
      platformId: String(second.botId),
      scope: String(second.botId),
      secretName: `${TOKEN_NAME()}#${record.key}`,
      character: null,
    });
    expect(record.welcomeBaseline).toBeUndefined();
    const listed = await run(['relay', '--list']);
    expect(listed.out).toContain('second_registry_bot  Telegram  @second_registry_bot');
    expect(listed.out).toContain('  状态：需要配对：yomi relay --bot second_registry_bot --pair');
    expect(listed.out).not.toContain('lin_registry_bot');
    // It starts (and, unpaired in a service, says so).
    const unpaired = await run(['relay', '--telegram', '--allow-file-store']);
    expect(unpaired.code).toBe(0);
    expect(unpaired.err).not.toContain('凭证属于另一个 bot');
    expect(unpaired.err).toContain('还没有配对');

    // Paired without a character: it says so at the pairing, and answers only how to bind one,
    // sending nothing and reading no character.
    const sends = () =>
      mock.state.requests.filter((request) => request.path === 'conversation/send_message').length;
    const reads = () =>
      mock.state.requests.filter((request) => request.path === 'npc/get_npc_profile').length;
    const sent = sends();
    const read = reads();
    const answer =
      '这个 bot 还没有绑定角色，消息没有转发，也没有扣费。在电脑上运行：yomi relay --bot second_registry_bot --character ID';
    const pairing = memoryIo();
    const pending = main(['relay', '--telegram', '--allow-file-store', '--pair'], pairing.io);
    const code = (await pairing.waitFor(/\/start ([A-Z2-9]{8})/))[1];
    await second.waitFor(() => second.calls.some((call) => call.method === 'getUpdates'));
    second.userSends(owner, `/start ${code}`);
    await second.waitFor(() => second.messages(owner.id).length === 2, 8000);
    await new TelegramBot(second.token, { apiOrigin: second.origin }).getUpdates(-1, 0);
    expect(await pending).toBe(0);
    expect(second.messages(owner.id).map((message) => message.text)).toEqual([
      '已配对：这个 bot 现在只为你转发消息，/help 查看命令。（@second_registry_bot）',
      answer,
    ]);
    expect(pairing.err).toContain(
      'bot second_registry_bot 还没有绑定角色：消息不会转发，只会提示主人在电脑上绑定。',
    );
    expect(pairing.err).not.toContain('这个 bot 还没有绑定角色');
    expect((await run(['relay', '--list'])).out).toContain(
      '  状态：需要绑定角色：yomi relay --bot second_registry_bot --character ID',
    );
    const quiet = await runUntilConflict(second);
    second.userSends(owner, '你好');
    second.userSends(owner, `/character ${MOCK_NPCS.group}`);
    second.userSends(owner, '/price');
    await second.waitFor(() => second.messages(owner.id).length === 5, 8000);
    await quiet.stop();
    expect(
      second
        .messages(owner.id)
        .slice(2)
        .map((message) => message.text),
    ).toEqual([answer, answer, answer]);
    expect(sends()).toBe(sent);
    expect(reads()).toBe(read);
    expect(quiet.terminal.err).toContain(
      'bot second_registry_bot 还没有绑定角色：消息不会转发，只会提示主人在电脑上绑定。绑定：yomi relay --bot second_registry_bot --character ID',
    );
    expect(BotRegistry.open(account).list()[0].character).toBeNull();

    // --forget takes the bot away with its token.
    const forgotten = await run(['relay', '--telegram', '--forget']);
    expect(forgotten.code).toBe(0);
    expect(BotRegistry.open(account).list()).toEqual([]);
    expect((await run(['relay', '--list'])).out).toContain('这台电脑上还没有 bot');
  });
});

describe('a token set by another command while a relay starts', () => {
  it("stops for another bot's token written after it opened its own, and runs its own again", async () => {
    const { account } = context();
    const set = await run(
      ['relay', '--telegram', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [tg.token] },
    );
    expect(set.code).toBe(0);
    expect(BotRegistry.open(account).list()).toMatchObject([{ name: 'lin_registry_bot' }]);
    // Another bot's token written over its own after this one opened it: it stops and says to
    // run again (the record stays as it was).
    hooks.afterVerify = () => setTokenElsewhere('lin_registry_bot', second);
    const changed = await run(['relay', '--telegram', '--allow-file-store'], { interactive: true });
    expect(changed.code).toBe(1);
    expect(changed.err).toContain(
      '启动时保存的 Telegram 凭证被换掉了，所以没有启动：再运行一次 yomi relay --telegram。',
    );
    expect(changed.err).not.toContain('凭证属于另一个 bot');
    expect(BotRegistry.open(account).list()).toMatchObject([
      { name: 'lin_registry_bot', label: '@Lin_Registry_Bot', platformUser: 'Lin_Registry_Bot' },
    ]);
    // Run again, it is refused as another bot's credentials, until its own are set again.
    const again = await run(['relay', '--telegram', '--allow-file-store']);
    expect(again.err).toContain('凭证属于另一个 bot');
    hooks.afterVerify = () => setTokenElsewhere('lin_registry_bot', tg);
    const own = await run(['relay', '--telegram', '--allow-file-store']);
    expect(own.code).toBe(0);
    expect(own.err).not.toContain('凭证属于另一个 bot');
    expect(own.err).toContain('还没有配对');
    hooks.afterVerify = () => setTokenElsewhere('lin_registry_bot', second);
    const english = await run(['--lang', 'en', 'relay', '--telegram', '--allow-file-store'], {
      interactive: true,
    });
    expect(english.code).toBe(1);
    expect(english.err).toContain(
      'The saved Telegram credentials changed while the relay was starting, so it was not started: run yomi relay --telegram again.',
    );
    setTokenElsewhere('lin_registry_bot', tg);
  });
});

describe('a registered bot whose credentials are gone', () => {
  it('is listed with the command that sets them, and a run of several bots asks for none', async () => {
    const { store, account } = context();
    const set = await run(
      ['relay', '--telegram', '--set-token', '--token-stdin', '--allow-file-store'],
      { input: [tg.token] },
    );
    expect(set.code).toBe(0);
    // An older yomi's --forget (or a hand) took the secrets away and left the registry as it was.
    const registry = BotRegistry.open(account);
    const qq = registry.add({
      kind: 'qq',
      stored: { platformId: '102000777', scope: 'qq:102000777', lockName: 'qq-102000777' },
      label: 'Lin QQ',
    });
    const login = JSON.stringify({
      botToken: 'wx-token',
      ilinkBotId: 'bot',
      ilinkUserId: 'scanner',
    });
    const wechat = registry.add({
      kind: 'wechat',
      stored: wechatSetup.storedBot(login)!,
      label: 'WeChat',
    });
    const telegram = registry.find('lin_registry_bot')!;
    store.deleteSecret(telegram.secretName);
    expect(BotRegistry.open(account).list()).toHaveLength(3);

    // Each with the command that sets that bot's own.
    const listed = await run(['relay', '--list']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('  状态：需要凭证：yomi relay --bot lin_registry_bot --set-token');
    expect(listed.out).toContain(`  状态：需要凭证：yomi relay --bot ${qq.name} --set-app`);
    expect(listed.out).toContain(`  状态：需要登录：yomi relay --bot ${wechat.name} --login`);
    const english = await run(['--lang', 'en', 'relay', '--list']);
    expect(english.out).toContain(
      '  Status: needs credentials: yomi relay --bot lin_registry_bot --set-token',
    );
    expect(english.out).toContain(
      `  Status: needs credentials: yomi relay --bot ${qq.name} --set-app`,
    );
    expect(english.out).toContain(`  Status: needs login: yomi relay --bot ${wechat.name} --login`);
    for (const lang of ['es', 'pt']) {
      const other = await run(['--lang', lang, 'relay', '--list']);
      const statuses = other.out.split('\n').filter((line) => line.includes('yomi relay --'));
      expect(statuses.length, lang).toBeGreaterThanOrEqual(3);
      for (const line of statuses) expect(line.search(CJK), `${lang}: ${line}`).toBe(-1);
    }
    // Logged in, but nobody has scanned for this relay yet: still a login to finish.
    store.setSecret(wechat.secretName, login);
    expect((await run(['relay', '--list'])).out).toContain(
      `  状态：需要登录：yomi relay --bot ${wechat.name} --login`,
    );
    store.deleteSecret(wechat.secretName);

    // A run of every bot, in a terminal: no prompt (a token typed in would replace the selected
    // bot); each bot says which command sets its credentials, and the registry stays as it was.
    const names = BotRegistry.open(account)
      .list()
      .map((record) => record.name);
    const checks = second.calls.filter((call) => call.method === 'getMe').length;
    const all = await run(['relay', '--allow-file-store'], {
      interactive: true,
      input: [second.token],
    });
    expect(all.code).toBe(0);
    expect(all.err).toContain(
      `还没有设置 bot token：先运行 yomi relay --bot ${telegram.name} --set-token`,
    );
    expect(all.err).toContain(`先运行 yomi relay --bot ${qq.name} --set-app`);
    expect(store.getSecret(telegram.secretName)).toBeNull();
    expect(
      BotRegistry.open(account)
        .list()
        .map((record) => record.name),
    ).toEqual(names);
    // The token waiting at the prompt was never read, so never checked.
    expect(second.calls.filter((call) => call.method === 'getMe')).toHaveLength(checks);
  });
});

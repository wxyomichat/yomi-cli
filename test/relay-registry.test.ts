import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../src/core/env.js';
import { CHANNEL_KINDS, type ChannelKind, channelSetup } from '../src/relay/channels/index.js';
import { QqChannel } from '../src/relay/channels/qq.js';
import { TelegramChannel } from '../src/relay/channels/telegram.js';
import { WechatChannel } from '../src/relay/channels/wechat.js';
import {
  BotRegistry,
  characterOwner,
  DuplicateCharacter,
  MAX_BOTS_PER_KIND,
  migrateRegistry,
  registryPath,
} from '../src/relay/registry.js';
import {
  forgetRelayStates,
  ownerKey,
  type RelayOwner,
  RelayState,
  relayStatePath,
} from '../src/relay/state.js';
import { TelegramBot } from '../src/relay/telegram.js';

/**
 * The bot registry (relay/registry.ts): the takeover of the bots each channel's credentials
 * stored before it (scope, secret name and lock kept, nothing else written, nothing resent), the
 * rule for two of them on one character, credentials set later (the same bot kept, another one
 * replacing it), the checks every change goes through, what each channel reads offline from a
 * stored secret, and one character per bot (binding another one, whom a character was shown to,
 * the welcome it owes).
 */

const ACCOUNT = 'test@http://127.0.0.1:1';
const TOKEN = `7000000001:${'a'.repeat(35)}`;
const OTHER_TOKEN = `7000000002:${'b'.repeat(35)}`;
const QQ_SECRET = JSON.stringify({ appId: '1020304', secret: 'qq-app-secret-1' });
const WECHAT_SECRET = JSON.stringify({
  botToken: 'wx-token',
  baseUrl: '',
  ilinkBotId: 'bot-1@im.bot',
  ilinkUserId: 'scanner@im.wechat',
  savedAt: 1,
});
const LIN = { npcId: '7300000000000009001', name: 'Lin', group: false };
const HARBOR = { npcId: '7300000000000009002', name: 'Harbor', group: true };

/** A credential store with what each channel kept before the registry. */
function secrets(values: Partial<Record<ChannelKind, string>>) {
  const map = new Map<string, string>();
  for (const [kind, value] of Object.entries(values))
    map.set(channelSetup(kind as ChannelKind).secretName(ACCOUNT), value);
  return {
    map,
    getSecret: (name: string) => map.get(name) ?? null,
  };
}

const scopes = { telegram: '7000000001', qq: 'qq:1020304', wechat: '' } as Record<
  ChannelKind,
  string
>;
scopes.wechat = channelSetup('wechat').storedBot(WECHAT_SECRET)!.scope;

const owner = (userId: number | string, pairedAt = 1000): RelayOwner => ({
  userId,
  chatId: userId,
  name: 'Ada',
  language: 'en',
  pairedAt,
});

/** A state file as a relay of before the registry left it. */
function legacyState(dir: string, kind: ChannelKind, patch: Record<string, unknown>) {
  const scope = scopes[kind];
  const state = new RelayState(relayStatePath(ACCOUNT, scope, dir), scope, ACCOUNT, kind);
  state.update(patch);
  return state.path;
}

describe('the takeover of the bots stored before the registry', () => {
  it('keeps each channel’s bot under its own names, with its character and owner, and writes nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const store = secrets({ telegram: TOKEN, qq: QQ_SECRET, wechat: WECHAT_SECRET });
    const telegram = legacyState(dir, 'telegram', {
      botUsername: 'Lin_Relay_Bot',
      owner: owner(5550001),
      character: LIN,
      yomiUserId: 'u1',
      offset: 42,
      greeted: [LIN.npcId],
      billing: { mode: 'paid', budget: 50, spent: 12, setAt: 5 },
      pending: { before: 300, mode: 'paid', price: 6, at: 9 },
    });
    // A bot still owed its welcome: no baseline, the welcome stays owed.
    const qq = new RelayState(relayStatePath(ACCOUNT, scopes.qq, dir), scopes.qq, ACCOUNT, 'qq');
    qq.bindOwner(owner('openid-0001'));
    const files = [telegram, qq.path].map((path) => readFileSync(path, 'utf8'));

    const { registry, warnings } = migrateRegistry({ account: ACCOUNT, store, dir, now: 77 });
    expect(warnings).toEqual([]);
    const [tg, qqBot, wx] = registry.list();
    expect(registry.list().map((record) => [record.kind, record.name])).toEqual([
      ['telegram', 'lin_relay_bot'],
      ['qq', 'qq-0304'],
      ['wechat', 'wechat-1'],
    ]);
    // The names a relay always used: the channel's secret, scope and lock.
    for (const record of registry.list()) {
      const setup = channelSetup(record.kind);
      expect(record.secretName).toBe(setup.secretName(ACCOUNT));
      expect(record.scope).toBe(scopes[record.kind]);
      expect(record.lockName).toBe(setup.lockNameOf(store.getSecret(record.secretName)!));
      expect(record.migratedFrom).toBe(record.kind);
      expect(record.createdAt).toBe(77);
      expect(record.generation).toBe(0);
    }
    expect(tg).toMatchObject({
      platformId: '7000000001',
      platformUser: 'Lin_Relay_Bot',
      label: '@Lin_Relay_Bot',
      character: LIN,
      boundAt: 77,
      welcomeBaseline: { owner: ownerKey(5550001), npcId: LIN.npcId },
    });
    expect(qqBot).toMatchObject({ platformId: '1020304', character: null, boundAt: 0 });
    expect(qqBot.welcomeBaseline).toBeUndefined();
    expect(wx).toMatchObject({ platformId: 'bot-1@im.bot', experimentalAcceptedAt: 77 });
    expect(tg.experimentalAcceptedAt).toBeUndefined();
    expect(registry.data).toMatchObject({
      version: 1,
      account: ACCOUNT,
      yomiUserId: 'u1',
      revision: 1,
      migratedAt: 77,
      characterOwners: { [LIN.npcId]: characterOwner('telegram', 5550001) },
    });
    // The owner, budget, pending charge, openings, cursor: still in the state files, untouched.
    expect([telegram, qq.path].map((path) => readFileSync(path, 'utf8'))).toEqual(files);
    const written = readFileSync(registryPath(ACCOUNT, dir), 'utf8');
    // No secret and no chat user id in the registry: owners are kept as hashes.
    for (const part of [TOKEN.split(':')[1], 'qq-app-secret-1', 'wx-token'])
      expect(written).not.toContain(part);
    expect(written).not.toContain('5550001');
    expect(written).not.toContain('scanner@im.wechat');

    // Again: nothing to take over, nothing written.
    const again = migrateRegistry({ account: ACCOUNT, store, dir, now: 99 });
    expect(again.registry.data.revision).toBe(1);
    expect(readFileSync(registryPath(ACCOUNT, dir), 'utf8')).toBe(written);
  });

  it('writes no registry when there is nothing to take over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const { registry } = migrateRegistry({ account: ACCOUNT, store: secrets({}), dir });
    expect(registry.list()).toEqual([]);
    expect(existsSync(registryPath(ACCOUNT, dir))).toBe(false);
  });

  it('takes over a secret saved later by an older version, and never re-reads a registered one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const store = secrets({ telegram: TOKEN });
    migrateRegistry({ account: ACCOUNT, store, dir });
    // An older yomi sets up QQ, and replaces the Telegram token with another bot's.
    store.map.set(channelSetup('qq').secretName(ACCOUNT), QQ_SECRET);
    store.map.set(channelSetup('telegram').secretName(ACCOUNT), OTHER_TOKEN);
    const { registry } = migrateRegistry({ account: ACCOUNT, store, dir });
    expect(registry.list().map((record) => [record.kind, record.platformId])).toEqual([
      ['telegram', '7000000001'],
      ['qq', '1020304'],
    ]);
    // The run then refuses the token: it is not the registered bot's (commands/relay.ts).
    expect(channelSetup('telegram').storedBot(OTHER_TOKEN)!.scope).not.toBe(
      registry.list('telegram')[0].scope,
    );
  });

  it('keeps one character on one bot: the installed service first, then the latest pairing, then the order', () => {
    const run = (installed: ChannelKind[], pairedAt: Partial<Record<ChannelKind, number>>) => {
      const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
      for (const kind of CHANNEL_KINDS)
        legacyState(dir, kind, {
          owner: owner(`${kind}-owner`, pairedAt[kind] ?? 0),
          character: LIN,
        });
      const { registry, warnings } = migrateRegistry({
        account: ACCOUNT,
        store: secrets({ telegram: TOKEN, qq: QQ_SECRET, wechat: WECHAT_SECRET }),
        dir,
        installed: (kind) => installed.includes(kind),
      });
      const holders = registry.list().filter((record) => record.character);
      expect(holders).toHaveLength(1);
      expect(warnings).toHaveLength(2);
      return { holder: holders[0], warnings, registry };
    };
    expect(run(['qq'], { telegram: 9, wechat: 8 }).holder.kind).toBe('qq');
    expect(run([], { telegram: 1, wechat: 8 }).holder.kind).toBe('wechat');
    const tie = run([], {});
    expect(tie.holder.kind).toBe('telegram');
    expect(tie.warnings[0]).toContain('qq-0304');
    expect(tie.warnings[0]).toContain('telegram');
    expect(tie.registry.data.characterOwners[LIN.npcId]).toBe(
      characterOwner('telegram', 'telegram-owner'),
    );
    // The others are registered without one; their state files still have it.
    expect(tie.registry.list('qq')[0]).toMatchObject({ character: null, boundAt: 0 });
  });

  it('gives each bot a name of its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    // An unusable username, and names already taken.
    legacyState(dir, 'telegram', { botUsername: '' });
    const registry = BotRegistry.open(ACCOUNT, dir);
    const qqBot = (appId: string, secretName: string) =>
      registry.adopt({
        kind: 'qq',
        secretName,
        stored: { platformId: appId, scope: `qq:${appId}`, lockName: `qq-${appId}` },
      }).record;
    expect(qqBot('7770304', 'qq-bot:a').name).toBe('qq-0304');
    const renamed = qqBot('8880304', 'qq-bot:b');
    expect(renamed.name).toBe('qq-0304-2');
    registry.commit((file) => {
      file.bots.find((record) => record.key === renamed.key)!.name = 'telegram';
    });
    const { registry: after } = migrateRegistry({
      account: ACCOUNT,
      store: secrets({ telegram: TOKEN, qq: QQ_SECRET }),
      dir,
    });
    expect(after.list().map((record) => record.name)).toEqual([
      'qq-0304',
      'telegram',
      'telegram-2',
      'qq-0304-2',
    ]);
  });
});

describe('credentials set later', () => {
  const telegramBot = (platformId: string) => ({
    platformId,
    scope: platformId,
    lockName: platformId,
  });

  it('keep the registered bot when they are its own, and replace it with the bot they belong to otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const registry = BotRegistry.open(ACCOUNT, dir);
    const secretName = channelSetup('telegram').secretName(ACCOUNT);
    const first = registry.adopt({
      kind: 'telegram',
      secretName,
      stored: telegramBot('7000000001'),
      label: '@first_bot',
      handle: 'first_bot',
    });
    expect(first.record).toMatchObject({ name: 'first_bot', label: '@first_bot' });
    expect(first.record.migratedFrom).toBeUndefined();
    const same = registry.adopt({
      kind: 'telegram',
      secretName,
      stored: telegramBot('7000000001'),
      label: '@first_bot',
      handle: 'first_bot',
    });
    expect(same.record.key).toBe(first.record.key);
    // Nothing changed: nothing written.
    expect(registry.data.revision).toBe(1);
    const other = registry.adopt({
      kind: 'telegram',
      secretName,
      stored: telegramBot('7000000002'),
      handle: 'second_bot',
    });
    expect(other.record.key).not.toBe(first.record.key);
    expect(registry.list()).toEqual([other.record]);
    expect(other.record).toMatchObject({ name: 'second_bot', scope: '7000000002' });
  });

  it('fill in a platform id; WeChat’s may change for the same scanner, the others’ never do', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const registry = BotRegistry.open(ACCOUNT, dir);
    const stored = channelSetup('wechat').storedBot(WECHAT_SECRET)!;
    const secretName = channelSetup('wechat').secretName(ACCOUNT);
    const { record } = registry.adopt({
      kind: 'wechat',
      secretName,
      stored: { ...stored, platformId: '' },
    });
    expect(record.platformId).toBe('');
    expect(registry.refresh(record, { stored }).platformId).toBe('bot-1@im.bot');
    const relogged = registry.adopt({
      kind: 'wechat',
      secretName,
      stored: { ...stored, platformId: 'bot-2@im.bot' },
    });
    expect(relogged.record).toMatchObject({ key: record.key, platformId: 'bot-2@im.bot' });
    const telegram = registry.adopt({
      kind: 'telegram',
      secretName: 'telegram-bot:x',
      stored: telegramBot('7000000001'),
    }).record;
    expect(
      registry.refresh(telegram, { stored: { ...telegramBot('7000000001'), platformId: '9' } })
        .platformId,
    ).toBe('7000000001');
  });

  it('take no character another bot has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const registry = BotRegistry.open(ACCOUNT, dir);
    const a = registry.adopt({
      kind: 'telegram',
      secretName: 'telegram-bot:a',
      stored: telegramBot('7000000001'),
    }).record;
    registry.bindCharacter(a.key, LIN, characterOwner('telegram', 1), 5);
    expect(registry.find(a.name)).toMatchObject({ character: LIN, boundAt: 5 });
    // A state file with the same character: the new bot comes without it, with a warning.
    const scope = '7000000002';
    new RelayState(relayStatePath(ACCOUNT, scope, dir), scope, ACCOUNT).update({
      character: LIN,
    });
    const b = registry.adopt({
      kind: 'telegram',
      secretName: 'telegram-bot:b',
      stored: telegramBot(scope),
      handle: 'b_bot',
    });
    expect(b.record.character).toBeNull();
    expect(b.warnings).toHaveLength(1);
    // Nor when the relay switches to it.
    registry.bindCharacter(b.record.key, LIN, '');
    expect(registry.find('b_bot')!.character).toBeNull();
    registry.bindCharacter(a.key, null, '');
    registry.bindCharacter(b.record.key, LIN, characterOwner('telegram', 2));
    expect(registry.find('b_bot')!.character).toEqual(LIN);
    expect(registry.data.characterOwners[LIN.npcId]).toBe(characterOwner('telegram', 2));
  });
});

describe('every change', () => {
  it('is checked again under the lock: a duplicate character, a bad name, too many bots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const registry = BotRegistry.open(ACCOUNT, dir);
    const record = registry.adopt({
      kind: 'qq',
      secretName: 'qq-bot:a',
      stored: { platformId: '1020304', scope: 'qq:1020304', lockName: 'qq-1020304' },
    }).record;
    registry.bindCharacter(record.key, LIN, '');
    const revision = registry.data.revision;
    const refused = (change: Parameters<BotRegistry['commit']>[0]) => {
      let error: unknown;
      try {
        registry.commit(change);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(UsageError);
      return (error as Error).message;
    };
    expect(
      refused((file) => {
        file.bots.push({ ...record, key: 'k2', name: 'other', character: LIN });
      }),
    ).toContain('一个角色只能绑一个 bot');
    expect(
      refused((file) => {
        file.bots[0].name = 'Not A Name';
      }),
    ).toContain('Not A Name');
    expect(
      refused((file) => {
        for (let index = 0; index < MAX_BOTS_PER_KIND; index += 1)
          file.bots.push({ ...record, key: `k${index}`, name: `qq-${index}`, character: null });
      }),
    ).toContain(String(MAX_BOTS_PER_KIND));
    // Nothing of a refused change was written.
    expect(BotRegistry.open(ACCOUNT, dir).data.revision).toBe(revision);
    expect(BotRegistry.open(ACCOUNT, dir).list()).toHaveLength(1);
  });

  it('starts from what is on disk, not from what this copy read before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const one = BotRegistry.open(ACCOUNT, dir);
    const two = BotRegistry.open(ACCOUNT, dir);
    one.adopt({
      kind: 'qq',
      secretName: 'qq-bot:a',
      stored: { platformId: '1020304', scope: 'qq:1020304', lockName: 'qq-1020304' },
    });
    two.adopt({
      kind: 'telegram',
      secretName: 'telegram-bot:a',
      stored: { platformId: '7000000001', scope: '7000000001', lockName: '7000000001' },
    });
    expect(two.list().map((record) => record.kind)).toEqual(['qq', 'telegram']);
    expect(two.data.revision).toBe(2);
  });

  it('refuses a malformed registry instead of repairing it, and --forget never deletes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    migrateRegistry({ account: ACCOUNT, store: secrets({ telegram: TOKEN }), dir });
    const path = registryPath(ACCOUNT, dir);
    expect(forgetRelayStates(ACCOUNT, dir, 'telegram')).toBe(0);
    expect(existsSync(path)).toBe(true);
    const forgotten = BotRegistry.open(ACCOUNT, dir);
    expect(forgotten.forget('telegram', 'telegram-bot:other')).toBe(false);
    expect(forgotten.forget('telegram', channelSetup('telegram').secretName(ACCOUNT))).toBe(true);
    expect(forgotten.list()).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 1, revision: 1, bots: [{ name: 'x' }] }));
    expect(() => BotRegistry.open(ACCOUNT, dir)).toThrow(UsageError);
    expect(() =>
      migrateRegistry({ account: ACCOUNT, store: secrets({ telegram: TOKEN }), dir }),
    ).toThrow('bot');
    expect(readFileSync(path, 'utf8')).toContain('"name":"x"');
  });
});

describe('what a stored secret says offline', () => {
  it('names the scope and lock the channel itself uses', () => {
    const telegram = new TelegramChannel(new TelegramBot(TOKEN), {
      drafts: true,
      intervalMs: 0,
      pollTimeoutSeconds: 0,
    });
    const qq = new QqChannel({ appId: '1020304', secret: 'qq-app-secret-1' });
    const wechat = new WechatChannel(JSON.parse(WECHAT_SECRET), {
      apiOrigin: 'http://127.0.0.1:1',
    });
    for (const [kind, channel, secret] of [
      ['telegram', telegram, TOKEN],
      ['qq', qq, QQ_SECRET],
      ['wechat', wechat, WECHAT_SECRET],
    ] as const) {
      const stored = channelSetup(kind).storedBot(secret);
      expect(stored, kind).toMatchObject({ scope: channel.scope, lockName: channel.lockName });
      expect(channelSetup(kind).storedBot('not a secret'), kind).toBeNull();
    }
    expect(channelSetup('telegram').storedBot(TOKEN)!.platformId).toBe('7000000001');
    expect(channelSetup('qq').storedBot(QQ_SECRET)!.platformId).toBe('1020304');
    expect(channelSetup('wechat').storedBot(WECHAT_SECRET)!.platformId).toBe('bot-1@im.bot');
    // A WeChat login without its token still names the scanner's lock (for --forget).
    expect(channelSetup('wechat').storedBot('{"ilinkUserId":"scanner@im.wechat"}')).toEqual({
      platformId: '',
      scope: scopes.wechat,
      lockName: channelSetup('wechat').lockNameOf(WECHAT_SECRET),
    });
  });
});

describe('the welcome baseline', () => {
  it('counts the owner of before the registry as welcomed, unless they are owed the welcome now', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const path = relayStatePath(ACCOUNT, 'qq:1', dir);
    const state = new RelayState(path, 'qq:1', ACCOUNT, 'qq');
    state.update({ owner: owner('openid-1'), welcomed: [], welcomeDue: '' });
    state.welcomedBefore({ owner: ownerKey('openid-1'), npcId: LIN.npcId });
    expect(state.data.welcomed).toEqual([{ owner: ownerKey('openid-1'), npcId: LIN.npcId, at: 0 }]);
    // Pairing again: not welcomed twice.
    state.bindOwner(owner('openid-1'));
    expect(state.welcomeOwed).toBe(false);
    // Saved, and not added twice.
    const again = new RelayState(path, 'qq:1', ACCOUNT, 'qq');
    again.welcomedBefore({ owner: ownerKey('openid-1'), npcId: LIN.npcId });
    expect(again.data.welcomed).toHaveLength(1);
    // Owed now: the baseline changes nothing.
    again.bindOwner(owner('openid-2'));
    again.welcomedBefore({ owner: ownerKey('openid-2'), npcId: LIN.npcId });
    expect(again.welcomeOwed).toBe(true);
  });
});

describe('one character per bot', () => {
  const qqBot = (appId: string) => ({
    platformId: appId,
    scope: `qq:${appId}`,
    lockName: `qq-${appId}`,
  });

  it('binds a bot to another character, never to one another bot has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const registry = BotRegistry.open(ACCOUNT, dir);
    const a = registry.adopt({ kind: 'qq', secretName: 'qq-bot:a', stored: qqBot('1020304') });
    const b = registry.adopt({ kind: 'qq', secretName: 'qq-bot:b', stored: qqBot('1020305') });
    const bound = registry.rebind(a.record.key, LIN, 7);
    expect(bound).toMatchObject({ character: LIN, boundAt: 7, generation: 1 });
    expect(registry.rebind(a.record.key, HARBOR, 9)).toMatchObject({
      character: HARBOR,
      boundAt: 9,
      generation: 2,
    });
    // Another bot's character: refused by name, nothing written.
    const revision = registry.data.revision;
    let error: unknown;
    try {
      registry.rebind(b.record.key, HARBOR);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DuplicateCharacter);
    expect(error).toMatchObject({ npcId: HARBOR.npcId, holder: a.record.name });
    expect((error as Error).message).toContain(`yomi relay --bot ${a.record.name} --character ID`);
    expect(BotRegistry.open(ACCOUNT, dir).data.revision).toBe(revision);
    expect(BotRegistry.open(ACCOUNT, dir).find(b.record.name)!.character).toBeNull();
    // A bot removed meanwhile (another command): refused, not recreated.
    registry.commit((file) => {
      file.bots = file.bots.filter((record) => record.key !== b.record.key);
    });
    expect(() => registry.rebind(b.record.key, LIN)).toThrow(UsageError);
    expect(registry.list()).toHaveLength(1);
  });

  it('names the bot that has the character, also when it comes later in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const registry = BotRegistry.open(ACCOUNT, dir);
    const a = registry.adopt({ kind: 'qq', secretName: 'qq-bot:a', stored: qqBot('1020304') });
    const b = registry.adopt({ kind: 'qq', secretName: 'qq-bot:b', stored: qqBot('1020305') });
    registry.rebind(b.record.key, HARBOR);
    let error: unknown;
    try {
      registry.rebind(a.record.key, HARBOR);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DuplicateCharacter);
    expect(error).toMatchObject({ npcId: HARBOR.npcId, holder: b.record.name });
    expect((error as Error).message).toContain(`yomi relay --bot ${b.record.name} --character ID`);
    expect(registry.find(a.record.name)!.character).toBeNull();
  });

  it('renames a character without binding it again, and remembers whom a character was shown to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const registry = BotRegistry.open(ACCOUNT, dir);
    const { record } = registry.adopt({ kind: 'qq', secretName: 'qq-bot:a', stored: qqBot('1') });
    registry.rebind(record.key, LIN, 7);
    registry.bindCharacter(record.key, { ...LIN, name: 'Lin Xia' }, '', 99);
    expect(registry.find(record.name)).toMatchObject({
      character: { ...LIN, name: 'Lin Xia' },
      boundAt: 7,
      generation: 1,
    });
    expect(registry.shownTo(LIN.npcId)).toBeUndefined();
    registry.showedCharacter(LIN.npcId, characterOwner('qq', 'openid-1'));
    const revision = registry.data.revision;
    registry.showedCharacter(LIN.npcId, characterOwner('qq', 'openid-1'));
    expect(registry.data.revision).toBe(revision);
    // Read from the file as it is now: another process may have written it.
    BotRegistry.open(ACCOUNT, dir).showedCharacter(LIN.npcId, characterOwner('qq', 'openid-2'));
    expect(registry.shownTo(LIN.npcId)).toBe(characterOwner('qq', 'openid-2'));
    // Unreadable: someone, so a welcome shows nobody's conversation.
    writeFileSync(registry.path, '{"version":2}');
    expect(registry.shownTo(LIN.npcId)).toBe('?');
  });

  it('owes the owner the welcome with each other character the bot is bound to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const state = new RelayState(relayStatePath(ACCOUNT, 'qq:1', dir), 'qq:1', ACCOUNT, 'qq');
    // Nobody to welcome yet.
    state.characterBound(LIN.npcId);
    expect(state.data.welcomeDue).toBe('');
    // Paired on a bot bound to Lin: owed, then given.
    state.bindOwner(owner('openid-1'), LIN.npcId);
    expect(state.welcomeOwed).toBe(true);
    state.markWelcomed(LIN.npcId);
    // Pairing again, bound to the same character: none.
    state.bindOwner(owner('openid-1'), LIN.npcId);
    expect(state.welcomeOwed).toBe(false);
    // Bound to another character: owed again, with it.
    state.characterBound(HARBOR.npcId);
    expect(state.welcomeOwed).toBe(true);
    state.markWelcomed(HARBOR.npcId);
    // Bound back: the last welcome was Harbor's, so Lin's is owed again.
    state.characterBound(LIN.npcId);
    expect(state.welcomeOwed).toBe(true);
    state.markWelcomed(LIN.npcId);
    state.characterBound(LIN.npcId);
    expect(state.welcomeOwed).toBe(false);
    // A bot of its own choosing (no character given) keeps the rule of one welcome per owner.
    state.bindOwner(owner('openid-1'));
    expect(state.welcomeOwed).toBe(false);
  });

  it('drops a welcome owed for another character when the bot is bound back to the last one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-registry-'));
    const state = new RelayState(relayStatePath(ACCOUNT, 'qq:1', dir), 'qq:1', ACCOUNT, 'qq');
    state.bindOwner(owner('openid-1'), LIN.npcId);
    state.markWelcomed(LIN.npcId);
    // Started bound to Harbor: owed, but the owner sent nothing before it was bound back.
    state.characterBound(HARBOR.npcId);
    expect(state.welcomeOwed).toBe(true);
    state.characterBound(LIN.npcId);
    expect(state.welcomeOwed).toBe(false);
  });
});

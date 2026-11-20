import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import { Gateway } from '../src/core/api.js';
import type { Credential } from '../src/core/credentials.js';
import { resolveEnvironment, UsageError } from '../src/core/env.js';
import { readJsonFile } from '../src/core/files.js';
import { chatImageStore } from '../src/mock/gen/chatImage.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import { type InboundEvent, RelayStopped } from '../src/relay/channels/types.js';
import { type FeedSubscriber, ImFeed } from '../src/relay/hub/feed.js';
import { type HubBot, type HubStatusFile, hubStatusPath, RelayHub } from '../src/relay/hub/hub.js';
import {
  botRecords,
  IMAGE_RECORDS,
  Ledger,
  LedgerFileStore,
  type LedgerStore,
  ledgerPath,
  migrateLedger,
} from '../src/relay/hub/ledger.js';
import { SessionGate } from '../src/relay/hub/session.js';
import { type BotStatus, Supervisor } from '../src/relay/hub/supervisor.js';
import { DuplicateCharacter } from '../src/relay/registry.js';
import { Relay, type RelayOptions, type RelayServices } from '../src/relay/relay.js';
import {
  type Allowance,
  type PendingCharge,
  RelayState,
  relayStatePath,
} from '../src/relay/state.js';
import { LOGIN_URL, authorizeLikeTheBrowser } from './helpers/authorize.js';
import { FakeChannel, waitFor } from './helpers/fakeChannel.js';
import { StoppingChannel } from './helpers/fakeSetup.js';
import { memoryIo } from './helpers/io.js';

/**
 * Several bots in one process (src/relay/hub, design §2): a gateway per client on one sign-in,
 * the long connection routing each character's events to its bot, the supervisor keeping each bot
 * running on its own (its pauses, a restart, another account), the ledger they share (its file,
 * made once from the bots' state files; whose pending charge is whose, what a bot not running
 * owes; what may have landed in a measurement; every registered bot's kept image held from the
 * start), relays on that ledger against the mock gateway (no cap: never waiting, an estimate
 * beside another bot's measurement, marked before it goes, another bot's charge never joined;
 * a charge after a top-up estimated from its own bot's cap; under a cap: one at a time, images
 * too, a spent ceiling pausing nothing; a slow reading or answer at shutdown), and the hub running
 * bots side by side, one stopping alone.
 */

const credential: Credential = {
  version: 1,
  env: 'test',
  apiOrigin: 'http://127.0.0.1:1',
  userId: '42',
  deviceId: 'device',
  authToken: 'auth',
  refreshToken: 'refresh',
  email: '',
  displayName: '',
  createdAt: 1,
  refreshedAt: 1,
};

/** A gateway offline (no store, no requests): what needs only its sign-in. */
const offline = () => new Gateway({ env: resolveEnvironment({}), idfv: 'idfv', credential });

function memoryStore(unset = false): LedgerStore & { unset: boolean } {
  let allowance: Allowance = { maxSpend: null, spent: 0, since: 0, unmeasured: 0 };
  let pending: PendingCharge | null = null;
  const store = {
    unset,
    allowance: () => allowance,
    setAllowance: (next: Allowance) => {
      allowance = next;
      store.unset = false;
    },
    pending: () => pending,
    setPending: (next: PendingCharge | null) => {
      pending = next;
    },
    ceilingUnset: () => store.unset,
  };
  return store;
}

/** A channel whose relay crashes (a plain error) as it asks for events. */
class CrashingChannel extends FakeChannel {
  override async *events(): AsyncIterable<InboundEvent> {
    throw new Error('boom');
  }
}

const subscriber = (): FeedSubscriber => ({
  stream: () => undefined,
  aside: () => undefined,
  reconnected: () => undefined,
  failed: () => undefined,
});

describe('a gateway for another client', () => {
  it('shares its sign-in: a refresh or a sign-out of one is the other one too', () => {
    const gateway = offline();
    const view = gateway.forClient('relay-qq');
    expect(view.credential).toBe(gateway.credential);
    const next = { ...credential, authToken: 'next' };
    view.useCredential(next);
    expect(gateway.credential).toBe(next);
    gateway.useCredential(null);
    expect(view.credential).toBeNull();
  });
});

describe('the long connection, routed', () => {
  it("gives a bound bot its character's events alone, and one character one bot", () => {
    const gateway = offline();
    const session = new SessionGate(gateway, { log: () => undefined });
    const feed = new ImFeed(gateway, session, { log: () => undefined });
    const targets = (npcId: string, cid = '') =>
      (feed as unknown as { targets(n: string, c: string): FeedSubscriber[] }).targets(npcId, cid);
    const lin = subscriber();
    const fog = subscriber();
    const alone = subscriber();
    feed.subscribe(lin, { bot: 'lin', npcId: MOCK_NPCS.single });
    const leaveFog = feed.subscribe(fog, { bot: 'fog', npcId: MOCK_NPCS.group });
    feed.subscribe(alone);
    expect(targets(MOCK_NPCS.single)).toEqual([lin]);
    expect(targets(MOCK_NPCS.group)).toEqual([fog]);
    // Another character's events go to whoever takes every event, never to a bound bot.
    expect(targets('7300000000000009999')).toEqual([alone]);
    // A character goes with one bot only.
    expect(() =>
      feed.subscribe(subscriber(), { bot: 'other', npcId: MOCK_NPCS.single }),
    ).toThrowError(DuplicateCharacter);
    expect(() => feed.subscribe(subscriber(), { bot: 'other', npcId: MOCK_NPCS.single })).toThrow(
      /"lin"/,
    );
    // A bot without a character takes nothing by character.
    feed.subscribe(subscriber(), { bot: 'none', npcId: null });
    expect(targets('7300000000000009999')).toEqual([alone]);
    // An image asked for in a conversation: its persisted messages go to its bot first.
    const release = feed.routeCid('cid-1', fog);
    expect(targets(MOCK_NPCS.single, 'cid-1')).toEqual([fog]);
    release();
    expect(targets(MOCK_NPCS.single, 'cid-1')).toEqual([lin]);
    // Gone, its character is free again.
    leaveFog();
    expect(targets(MOCK_NPCS.group)).toEqual([alone]);
    feed.subscribe(subscriber(), { bot: 'next', npcId: MOCK_NPCS.group });
    feed.close();
    session.close();
  });
});

describe('the supervisor', () => {
  const quick = { backoffMs: 5, maxBackoffMs: 20, healthyMs: 60_000 };

  it('starts a crashed bot again, and stops one a restart cannot fix', async () => {
    const statuses: BotStatus[] = [];
    let runs = 0;
    const controller = new AbortController();
    const done = new Supervisor(
      'lin',
      async (signal) => {
        runs += 1;
        if (runs < 3) throw new Error('boom');
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      { ...quick, log: () => undefined, onStatus: (status) => statuses.push(status) },
    ).supervise(controller.signal);
    await waitFor(() => runs === 3);
    controller.abort();
    await done;
    expect(statuses).toEqual([
      'starting',
      'running',
      'restarting',
      'running',
      'restarting',
      'running',
      'stopped',
    ]);

    const stops: (Error | null)[] = [];
    for (const error of [new RelayStopped('conflict', 'taken'), new UsageError('not yours')]) {
      let count = 0;
      await new Supervisor(
        'qq',
        async () => {
          count += 1;
          throw error;
        },
        { ...quick, log: () => undefined, onStopped: (stopped) => stops.push(stopped) },
      ).supervise(new AbortController().signal);
      expect(count).toBe(1);
    }
    expect(stops.map((error) => error?.message)).toEqual(['taken', 'not yours']);
    // One that could not start at all (it said why).
    await new Supervisor('wx', async () => 'unavailable' as const, {
      log: () => undefined,
      onStopped: (stopped) => stops.push(stopped),
    }).supervise(new AbortController().signal);
    expect(stops.at(-1)).toBeNull();
  });

  it('gives up on a crash loop, and passes another account on', async () => {
    const lines: string[] = [];
    let crashed: Error | null = null;
    let runs = 0;
    await new Supervisor(
      'lin',
      async () => {
        runs += 1;
        throw new Error('boom');
      },
      {
        ...quick,
        maxCrashes: 3,
        log: (line) => lines.push(line),
        onStopped: (error) => {
          crashed = error;
        },
      },
    ).supervise(new AbortController().signal);
    expect(runs).toBe(3);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('bot lin 意外停止（Error boom）');
    expect((crashed as Error | null)?.message).toContain('bot lin 一小时内反复意外停止');
    let other: RelayStopped | null = null;
    await new Supervisor(
      'qq',
      async () => {
        throw new RelayStopped('otherAccount', 'another account');
      },
      {
        log: () => undefined,
        onOtherAccount: (error) => {
          other = error;
        },
      },
    ).supervise(new AbortController().signal);
    expect((other as RelayStopped | null)?.reason).toBe('otherAccount');
  });
});

describe('the supervisor, in time', () => {
  it('doubles its pause up to the most, and starts it over after a healthy run', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      let runs = 0;
      const controller = new AbortController();
      const done = new Supervisor(
        'lin',
        async (signal) => {
          runs += 1;
          // The sixth run is healthy for a while before it crashes too.
          if (runs === 6) await new Promise((resolve) => setTimeout(resolve, 10_000));
          if (runs <= 7) throw new Error('boom');
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        },
        {
          backoffMs: 1000,
          maxBackoffMs: 4000,
          healthyMs: 10_000,
          log: (line) => lines.push(line),
        },
      ).supervise(controller.signal);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toBe(8);
      controller.abort();
      await done;
      const pauses = lines.map((line) => Number(/(\d+) 秒后重新启动/.exec(line)?.[1]));
      expect(pauses).toEqual([1, 2, 4, 4, 4, 1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the shared ledger', () => {
  it("books another bot's settlement through that bot, and marks what a measurement may hold", async () => {
    const ledger = new Ledger(memoryStore(), { shared: true });
    const booked: [number, string][] = [];
    const leave = ledger.register('a', async (amount, mode) => {
      booked.push([amount, mode]);
    });
    expect(await ledger.bookFor('a', 4, 'paid')).toBe('booked');
    expect(booked).toEqual([[4, 'paid']]);
    expect(ledger.spent).toBe(0);
    leave();
    // Not running: in the running total now, owed to its budget until it starts again.
    expect(await ledger.bookFor('a', 3, 'open')).toBe('owed');
    expect(await ledger.bookFor('a', 2, 'open')).toBe('owed');
    expect(ledger.spent).toBe(5);
    expect(ledger.takeOwed('a')).toEqual([{ bot: 'a', amount: 5, mode: 'open' }]);
    expect(ledger.takeOwed('a')).toEqual([]);
    // A bot no longer registered: the running total only.
    const registered = new Ledger(memoryStore(), { shared: true, isBot: (bot) => bot === 'a' });
    expect(await registered.bookFor('gone', 3, 'open')).toBe('total');
    expect(registered.takeOwed('gone')).toEqual([]);
    expect(registered.spent).toBe(3);
    // A send beside the window: the open measurement is marked, or the next one of this window.
    const lease = ledger.window.tryAcquire('b')!;
    ledger.markForeign();
    expect(ledger.takeForeign()).toBe(true);
    expect(ledger.takeForeign()).toBe(false);
    ledger.setPending({ before: 10, mode: 'open', price: 2, at: 1, bot: 'b' });
    ledger.markForeign();
    expect(ledger.pending?.foreign).toBe(true);
    lease.release();
    ledger.setPending({ before: 10, mode: 'open', price: 2, at: 2, bot: 'b' });
    // An image held from the ceiling marks it too.
    const release = ledger.reserve('a', 5, 'image:a');
    expect(ledger.pending?.foreign).toBe(true);
    // One held before a measurement starts marks that measurement: its charge may land in it.
    ledger.setPending(null);
    expect(ledger.takeForeign()).toBe(true);
    release();
    expect(ledger.takeForeign()).toBe(false);
  });

  it("holds every registered bot's kept image from the ceiling at the start, whether it runs or not", () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-relay-hub-images-'));
    const account = 'images-account';
    // 25 of 50 spent; the QQ bot's image, accepted in an earlier run, may still cost 20 on
    // delivery, whether or not the QQ bot runs in this one.
    const store = LedgerFileStore.open(account, dir);
    store.data.yomiUserId = credential.userId;
    store.data.allowance = { maxSpend: 50, spent: 25, since: 1, unmeasured: 0 };
    store.save();
    botRecords(account, 'fake:qq-images', credential.userId, dir).setRecord(
      IMAGE_RECORDS,
      'fake:qq-images',
      { taskId: 'task-1', price: 6, worst: 20 },
    );
    const hub = new RelayHub(offline(), {
      account,
      log: () => undefined,
      maxSpend: 50,
      ledgerBots: [
        { kind: 'qq', scope: 'fake:qq-images' },
        { kind: 'telegram', scope: 'fake:tg-images' },
      ],
      dir,
    });
    const { ledger } = hub.services;
    expect(ledger.ceilingLeft()).toBe(5);
    expect(ledger.held()).toBe(20);
    expect(ledger.imagesOpen()).toBe(true);
    // Booked (or forgotten) by its bot's relay: let go under the key that relay holds it by.
    ledger.unreserve('image:fake:qq-images');
    expect(ledger.ceilingLeft()).toBe(25);
    hub.services.feed.close();
    hub.services.session.close();
  });

  it('takes the first ceiling as it is when this computer never set one', () => {
    const store = memoryStore(true);
    store.setAllowance({ maxSpend: null, spent: 12, since: 5, unmeasured: 1 });
    store.unset = true;
    const ledger = new Ledger(store);
    ledger.useAllowance(40, false);
    expect(store.allowance()).toEqual({ maxSpend: 40, spent: 12, since: 5, unmeasured: 1 });
    // From then on, by the usual rule: another ceiling starts the total over.
    ledger.useAllowance(30, false);
    expect(ledger.spent).toBe(0);
  });

  it("is made once from the bots' state files, which give up only their pending charges", () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-relay-ledger-file-'));
    const lines: string[] = [];
    const account = 'test|account';
    const state = (scope: string, kind: 'telegram' | 'qq' | 'wechat') =>
      new RelayState(relayStatePath(account, scope, dir), scope, account, kind);
    const tg = state('111', 'telegram');
    tg.update({
      yomiUserId: 'user-1',
      allowance: { maxSpend: 50, spent: 7, since: 300, unmeasured: 1 },
      billing: { mode: 'paid', budget: 20, spent: 2, setAt: 1 },
      pending: { before: 100, mode: 'paid', price: 3, at: 10, capped: true },
    });
    const qq = state('qq:1', 'qq');
    qq.update({
      allowance: { maxSpend: 50, spent: 5, since: 200, unmeasured: 0 },
      pending: { before: 95, mode: 'open', price: null, at: 20, capped: false },
    });
    const bots = [
      { kind: 'telegram' as const, scope: '111' },
      { kind: 'qq' as const, scope: 'qq:1' },
      { kind: 'wechat' as const, scope: 'wx:none' },
    ];
    const store = migrateLedger(account, 'user-1', bots, (line) => lines.push(line), dir);
    // The earlier pending charge is booked at its quoted price, the latest one moves over.
    expect(store.data).toEqual({
      version: 1,
      account,
      yomiUserId: 'user-1',
      allowance: { maxSpend: null, spent: 15, since: 200, unmeasured: 1 },
      pending: { before: 95, mode: 'open', price: null, at: 20, capped: false, bot: 'qq:1' },
      ceilingUnset: true,
    });
    expect(lines).toHaveLength(1);
    expect(existsSync(ledgerPath(account, dir))).toBe(true);
    const tgAfter = state('111', 'telegram');
    expect(tgAfter.data.pending).toBeNull();
    expect(tgAfter.data.billing.spent).toBe(5);
    // Their own totals stay as they were.
    expect(tgAfter.data.allowance.spent).toBe(7);
    expect(state('qq:1', 'qq').data.pending).toBeNull();
    // Once only: a second start reads the file.
    tg.update({ pending: { before: 1, mode: 'open', price: 1, at: 30 } });
    expect(migrateLedger(account, 'user-1', bots, () => undefined, dir).data).toEqual(store.data);
    // Read back, kept as written (what a bot owes too); another account starts the total over.
    const again = LedgerFileStore.open(account, dir);
    expect(again.data).toEqual(store.data);
    again.setOwed([{ bot: '111', amount: 2, mode: 'paid' }]);
    expect(LedgerFileStore.open(account, dir).owed()).toEqual([
      { bot: '111', amount: 2, mode: 'paid' },
    ]);
    expect(again.bindAccount('user-1')).toBe(false);
    expect(again.bindAccount('user-2')).toBe(true);
    const other = LedgerFileStore.open(account, dir);
    expect(other.data).toMatchObject({
      yomiUserId: 'user-2',
      allowance: { spent: 0 },
      pending: null,
    });
    expect(other.owed()).toEqual([]);
  });

  it("gives up a kept image's own measurement, and books an earlier charge without a price at the drop to the next reading", () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-relay-ledger-image-'));
    const lines: string[] = [];
    const account = 'test|account';
    const state = (scope: string, kind: 'telegram' | 'qq' | 'wechat') =>
      new RelayState(relayStatePath(account, scope, dir), scope, account, kind);
    // Telegram asked for an image (measured by the balance, replies riding along) before the
    // upgrade; QQ and WeChat left replies to measure after it.
    state('111', 'telegram').update({
      pending: { before: 100, mode: 'paid', price: 20, at: 10, capped: false, extra: true },
    });
    const records = botRecords(account, '111', 'user-1', dir);
    records.setRecord(IMAGE_RECORDS, '111', { requestId: 'image-1', taskId: 'task-1', price: 20 });
    state('qq:1', 'qq').update({
      billing: { mode: 'paid', budget: 50, spent: 1, setAt: 1 },
      pending: { before: 90, mode: 'paid', price: null, at: 20, capped: true },
    });
    state('wx:1', 'wechat').update({
      pending: { before: 70, mode: 'open', price: 4, at: 30, capped: false },
    });
    const store = migrateLedger(
      account,
      'user-1',
      [
        { kind: 'telegram', scope: '111' },
        { kind: 'qq', scope: 'qq:1' },
        { kind: 'wechat', scope: 'wx:1' },
      ],
      (line) => lines.push(line),
      dir,
    );
    // The image is booked by its task alone from now on: its measurement is dropped, not booked,
    // and the replies that rode along it are unmeasured.
    expect(records.record(IMAGE_RECORDS, '111')).toMatchObject({
      taskId: 'task-1',
      measured: false,
    });
    expect(state('111', 'telegram').data.pending).toBeNull();
    // QQ's charge had no price: the drop to WeChat's reading, in its budget too.
    expect(store.data.allowance).toMatchObject({ spent: 20, unmeasured: 1 });
    expect(state('qq:1', 'qq').data.billing.spent).toBe(21);
    expect(lines).toEqual([expect.stringContaining('按 20 钻石计入')]);
    expect(store.data.pending).toMatchObject({ before: 70, price: 4, bot: 'wx:1' });
  });
});

describe('bots of one process', () => {
  let mock: MockServer;
  const saved: Record<string, string | undefined> = {};
  const cleanups: (() => Promise<unknown> | void)[] = [];
  const sends = () =>
    mock.state.requests.filter((request) => request.path === 'conversation/send_message');

  const context = () =>
    createContext(memoryIo().io, {}, { client: 'relay-multi', channel: 'cli_relay' });

  /**
   * The hub's own services on a ledger in memory, connected; `maxSpend` is its ceiling, `isBot`
   * which bots are registered (all of them by default).
   */
  async function services(
    maxSpend: number | null,
    isBot?: (bot: string) => boolean,
  ): Promise<RelayServices> {
    const { gateway } = context();
    const log = () => undefined;
    const session = new SessionGate(gateway, { log, resumeCheckMs: 100 });
    const feed = new ImFeed(gateway, session, { log });
    const ledger = new Ledger(memoryStore(), { shared: true, isBot });
    ledger.useAllowance(maxSpend, false);
    const sockets = mock.state.sockets;
    feed.start();
    cleanups.push(() => {
      feed.close();
      session.close();
    });
    await waitFor(() => mock.state.sockets > sockets);
    return {
      feed,
      session,
      policy: new (await import('../src/relay/hub/policy.js')).PolicyService(gateway),
      ledger,
    };
  }

  /** A paired relay of `fake` bound to `npcId`, its options. */
  function relayOf(
    hub: RelayServices,
    fake: FakeChannel,
    npcId: string,
    logs: string[] = [],
    more: Partial<RelayOptions> = {},
  ) {
    const { gateway, account } = context();
    const state = new RelayState(
      relayStatePath(account, fake.scope),
      fake.scope,
      account,
      fake.kind,
    );
    state.update({
      owner: { userId: fake.ownerId, chatId: fake.ownerId, name: '', language: '', pairedAt: 1 },
    });
    const relay = new Relay(gateway.forClient(`relay-${fake.kind}`), fake, state, {
      maxSpend: null,
      characterId: '',
      boundCharacter: { npcId, name: npcId === MOCK_NPCS.single ? '林夏' : '雾港', group: false },
      botName: fake.scope.replace(/\W/g, '-'),
      pairing: null,
      replyTimeoutMs: 1500,
      intervalMs: 30,
      staleMs: 10 * 60 * 1000,
      pollTimeoutSeconds: 1,
      drafts: true,
      language: 'zh-Hans',
      log: (line) => logs.push(line),
      hub,
      ...more,
    });
    return { relay, state };
  }

  /**
   * Holds `relay`'s balance readings, once `when()` says so, before they are read, until `open()`:
   * what a slow reading lets happen meanwhile. `held` counts the readings held.
   */
  function holdReadings(relay: Relay, when: () => boolean) {
    const inside = relay as unknown as { balance(): Promise<number | null> };
    const read = inside.balance.bind(relay);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const hold = { held: 0, open: () => open() };
    inside.balance = async () => {
      if (when()) {
        hold.held += 1;
        await gate;
      }
      return read();
    };
    return hold;
  }

  /**
   * Holds the answers to `relay`'s sends, once the server has taken them (and charged), until
   * `open()`: what a slow answer lets happen meanwhile. `held` counts the answers held.
   */
  function holdAnswers(relay: Relay) {
    const gateway = (relay as unknown as { gateway: Gateway }).gateway;
    const request = gateway.request.bind(gateway);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const hold = { held: 0, open: () => open() };
    gateway.request = async (path, body, options) => {
      const answer = await request(path, body, options);
      if (path === 'conversation/send_message') {
        hold.held += 1;
        await gate;
      }
      return answer;
    };
    return hold;
  }

  /** Runs `relay` until the test ends. */
  async function start(relay: Relay, fake: FakeChannel) {
    const controller = new AbortController();
    const done = relay.run(controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    cleanups.unshift(() => {
      controller.abort();
      return done;
    });
    await waitFor(() => fake.listening);
    return { done };
  }

  beforeAll(async () => {
    mock = await startMockServer();
    const values: Record<string, string> = {
      YOMI_API_ORIGIN: mock.origin,
      YOMI_WEB_ORIGIN: mock.origin,
      YOMI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'yomi-relay-multi-')),
      YOMI_CREDENTIAL_STORE: 'file',
      YOMI_LANG: 'zh-Hans',
      NO_COLOR: '1',
    };
    for (const [key, value] of Object.entries(values)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    mock.state.relayPolicy = { enabled: true, features: { free_only: true, spend_cap: true } };
    mock.state.chatFreeLimit = 1000;
    mock.state.gems = 500;
    const terminal = memoryIo();
    const login = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
    const [url] = await terminal.waitFor(LOGIN_URL);
    await authorizeLikeTheBrowser(mock, url);
    expect(await login).toBe(0);
  });

  afterEach(async () => {
    mock.state.chatFreeLimit = 1000;
    mock.state.reportCharge = false;
    mock.state.replyCost = 5;
    mock.state.walletFailures = 0;
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  afterAll(async () => {
    await mock.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("never waits without a cap: beside another bot's measurement it books its quoted price", async () => {
    mock.state.chatFreeLimit = 0;
    const hub = await services(null);
    const fake = new FakeChannel({ scope: 'fake:multi-a' });
    const logs: string[] = [];
    const { relay } = relayOf(hub, fake, MOCK_NPCS.single, logs);
    await start(relay, fake);
    // Another bot measures a send of its own (by the balance) right now.
    const held = hub.ledger.window.tryAcquire('another bot')!;
    hub.ledger.setPending({
      before: mock.state.gems,
      mode: 'open',
      price: null,
      at: Date.now(),
      capped: false,
      bot: 'another bot',
    });
    const before = sends().length;
    const replied = fake.expect(/./);
    fake.say('你好');
    await waitFor(() => sends().length === before + 1);
    await replied();
    await waitFor(() => hub.ledger.spent === mock.state.replyCost);
    // Its measurement was not touched, only marked: its drop may hold this reply's cost too.
    expect(hub.ledger.window.holder).toBe('another bot');
    expect(hub.ledger.pending).toMatchObject({ bot: 'another bot', foreign: true });
    expect(logs.join('\n')).toContain(`这条回复按报价估计为 ${mock.state.replyCost} 钻石`);
    held.release();
  });

  it("marks another bot's measurement before a send beside it goes, not once its answer is back", async () => {
    mock.state.chatFreeLimit = 0;
    const hub = await services(null);
    const fake = new FakeChannel({ scope: 'fake:multi-early' });
    const { relay } = relayOf(hub, fake, MOCK_NPCS.single);
    const answers = holdAnswers(relay);
    await start(relay, fake);
    // A capped bot measures its reply right now.
    const held = hub.ledger.window.tryAcquire('capped bot')!;
    hub.ledger.setPending({
      before: mock.state.gems,
      mode: 'paid',
      price: 6,
      at: Date.now(),
      capped: true,
      bot: 'capped bot',
    });
    const replied = fake.expect(/./);
    fake.say('你好');
    // Charged by the server, its answer not back yet: the other bot's settlement may read the
    // balance now, and must book no more than its own price.
    await waitFor(() => answers.held === 1);
    expect(hub.ledger.pending).toMatchObject({ bot: 'capped bot', foreign: true });
    answers.open();
    await replied();
    held.release();
  });

  it("never joins another bot's charge while the balance cannot be read: each bot books its own", async () => {
    mock.state.chatFreeLimit = 0;
    const hub = await services(null);
    const fake = new FakeChannel({ scope: 'fake:multi-join' });
    const logs: string[] = [];
    const { relay } = relayOf(hub, fake, MOCK_NPCS.single, logs);
    await start(relay, fake);
    // A capped bot (a budget, not running now) sent at 6 gems; its reading failed, so its charge
    // stays pending with the window free. The balance still cannot be read.
    mock.state.walletFailures = 1000;
    hub.ledger.setPending({
      before: mock.state.gems + 6,
      mode: 'paid',
      price: 6,
      at: 1,
      capped: true,
      bot: 'fake:multi-capped',
    });
    const price = mock.state.replyCost;
    const idle = () => !(relay as unknown as { turn: unknown }).turn;
    fake.say('你好');
    await waitFor(() => hub.ledger.spent === price && idle());
    // Its charge is still the capped bot's, as it was made, only marked: this reply was estimated.
    expect(hub.ledger.pending).toMatchObject({
      bot: 'fake:multi-capped',
      mode: 'paid',
      price: 6,
      capped: true,
      foreign: true,
    });
    expect(logs.join('\n')).toContain(`这条回复按报价估计为 ${price} 钻石`);
    // Readable again: the next send settles it for the capped bot, at its own price only.
    mock.state.walletFailures = 0;
    fake.say('今天天气怎么样');
    await waitFor(() => hub.ledger.pending === null && hub.ledger.spent === 6 + 2 * price);
    expect(hub.ledger.takeOwed('fake:multi-capped')).toEqual([
      { bot: 'fake:multi-capped', amount: 6, mode: 'paid' },
    ]);
  });

  it("estimates another bot's charge after the balance rose from that bot's cap, not the settling bot's", async () => {
    const hub = await services(null);
    const booked: number[] = [];
    // A capped bot (20 gems of its budget left) sent at a price nobody knew; its reading failed,
    // and the owner topped up before anyone read the balance again.
    hub.ledger.register(
      'fake:multi-risen',
      async (amount) => {
        booked.push(amount);
      },
      () => 20,
    );
    const risen = () =>
      hub.ledger.setPending({
        before: mock.state.gems - 10,
        mode: 'paid',
        price: null,
        at: Date.now(),
        capped: true,
        bot: 'fake:multi-risen',
      });
    // Settled by a bot without a cap, then by one with 7 left of its own budget: 20 either way.
    risen();
    const uncapped = new FakeChannel({ scope: 'fake:multi-uncapped' });
    await start(relayOf(hub, uncapped, MOCK_NPCS.single).relay, uncapped);
    await waitFor(() => hub.ledger.pending === null);
    risen();
    const capped = new FakeChannel({ scope: 'fake:multi-budget' });
    const other = relayOf(hub, capped, MOCK_NPCS.group);
    other.state.update({ billing: { mode: 'paid', budget: 7, spent: 0, setAt: 1 } });
    await start(other.relay, capped);
    await waitFor(() => hub.ledger.pending === null);
    expect(booked).toEqual([20, 20]);
    expect(other.state.data.billing.spent).toBe(0);
  });

  it("settles another bot's pending charge for it, at most its price when something else landed", async () => {
    const hub = await services(null, (bot) => bot !== 'gone bot');
    // A bot no longer registered left a measurement behind: settled at the next start, in the
    // running total only.
    hub.ledger.setPending({
      before: mock.state.gems + 3,
      mode: 'open',
      price: null,
      at: 1,
      capped: false,
      bot: 'gone bot',
    });
    const first = new FakeChannel({ scope: 'fake:multi-b' });
    const logs: string[] = [];
    await start(relayOf(hub, first, MOCK_NPCS.single, logs).relay, first);
    await waitFor(() => hub.ledger.pending === null);
    expect(hub.ledger.spent).toBe(3);
    expect(logs.join('\n')).toContain(
      '一个已删除的 bot 之前的一条消息花了 3 钻石：只计入本机的累计花费',
    );
    // One of a running bot is booked by it; marked, at most its quoted price.
    const booked: number[] = [];
    hub.ledger.register('fake:multi-c', async (amount) => {
      booked.push(amount);
    });
    hub.ledger.setPending({
      before: mock.state.gems + 9,
      mode: 'open',
      price: 4,
      at: 2,
      capped: true,
      bot: 'fake:multi-c',
      foreign: true,
    });
    const second = new FakeChannel({ scope: 'fake:multi-d' });
    const secondLogs: string[] = [];
    await start(relayOf(hub, second, MOCK_NPCS.group, secondLogs).relay, second);
    await waitFor(() => hub.ledger.pending === null);
    expect(booked).toEqual([4]);
    expect(hub.ledger.spent).toBe(3);
    expect(secondLogs.join('\n')).toContain('余额在这条回复期间少了 9 钻石');
  });

  it('settles a measurement as the ledger has it after its reading, at most its own price once marked', async () => {
    mock.state.chatFreeLimit = 0;
    const hub = await services(null);
    const fake = new FakeChannel({ scope: 'fake:multi-read' });
    const logs: string[] = [];
    const { relay } = relayOf(hub, fake, MOCK_NPCS.single, logs);
    const before = sends().length;
    const hold = holdReadings(relay, () => sends().length > before);
    await start(relay, fake);
    fake.say('你好');
    await waitFor(() => hold.held === 1);
    // Measured without a cap (bookkeeping only), it still knows its own price.
    const price = mock.state.replyCost;
    expect(hub.ledger.pending).toMatchObject({ bot: 'fake:multi-read', price, capped: false });
    // While its reading is slow, another bot's send lands in the drop and marks it.
    mock.state.gems -= 4;
    hub.ledger.markForeign();
    hold.open();
    await waitFor(() => hub.ledger.pending === null);
    expect(hub.ledger.spent).toBe(price);
    expect(logs.join('\n')).toContain(`余额在这条回复期间少了 ${price + 4} 钻石`);
  });

  it("limits a measurement to its price while another bot's image may still be charged", async () => {
    mock.state.chatFreeLimit = 0;
    const hub = await services(null);
    // Asked for while nothing was measured: its hold marks no measurement yet.
    const release = hub.ledger.reserve('another bot', 20, 'image:another bot');
    expect(hub.ledger.pending).toBeNull();
    const fake = new FakeChannel({ scope: 'fake:multi-image' });
    const { relay } = relayOf(hub, fake, MOCK_NPCS.single);
    const before = sends().length;
    const hold = holdReadings(relay, () => sends().length > before);
    await start(relay, fake);
    fake.say('你好');
    await waitFor(() => hold.held === 1);
    expect(hub.ledger.pending).toMatchObject({ bot: 'fake:multi-image', foreign: true });
    // The picture is delivered, and charged, during this reply.
    mock.state.gems -= 20;
    hold.open();
    await waitFor(() => hub.ledger.pending === null);
    expect(hub.ledger.spent).toBe(mock.state.replyCost);
    release();
  });

  it('waits for the reading of a reply that ended as it stops, holding the window meanwhile', async () => {
    mock.state.chatFreeLimit = 0;
    const hub = await services(null);
    const { account } = context();
    const fake = new FakeChannel({ scope: 'fake:multi-stop' });
    const { relay, state } = relayOf(hub, fake, MOCK_NPCS.single);
    // A budget: the reply is measured under the window.
    state.update({ billing: { mode: 'paid', budget: 100, spent: 0, setAt: 1 } });
    const before = sends().length;
    const hold = holdReadings(relay, () => sends().length > before);
    const controller = new AbortController();
    let ended = false;
    const done = relay.run(controller.signal).finally(() => {
      ended = true;
    });
    await waitFor(() => fake.listening);
    fake.say('你好');
    await waitFor(() => hold.held === 1);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ended).toBe(false);
    expect(hub.ledger.window.holder).toBe('fake:multi-stop');
    hold.open();
    await done;
    state.close();
    // Booked to its budget before the run ended, and only then the window let go.
    const saved = new RelayState(state.path, 'fake:multi-stop', account, 'qq').data;
    expect(saved.billing.spent).toBe(mock.state.replyCost);
    expect(hub.ledger.pending).toBeNull();
    expect(hub.ledger.spent).toBe(mock.state.replyCost);
    expect(hub.ledger.window.holder).toBe('');
  });

  it('leaves a charge pending when its reading comes back after the run has ended', async () => {
    mock.state.chatFreeLimit = 0;
    const hub = await services(null);
    const fake = new FakeChannel({ scope: 'fake:multi-late' });
    const { relay, state } = relayOf(hub, fake, MOCK_NPCS.single);
    state.update({ billing: { mode: 'paid', budget: 100, spent: 0, setAt: 1 } });
    const before = sends().length;
    const hold = holdReadings(relay, () => sends().length > before);
    await start(relay, fake);
    fake.say('你好');
    await waitFor(() => hold.held === 1);
    // The run ended meanwhile (the wait at shutdown ran out): its state is closed.
    state.close();
    hold.open();
    await waitFor(() => hub.ledger.window.holder === '');
    // Nothing settled: the charge stays for the next run, or another bot's settlement.
    expect(hub.ledger.pending).toMatchObject({
      bot: 'fake:multi-late',
      price: mock.state.replyCost,
    });
    expect(hub.ledger.spent).toBe(0);
  });

  it('owes its budget an answer that came back after the run ended, counted once in the total', async () => {
    mock.state.chatFreeLimit = 0;
    mock.state.reportCharge = true;
    const hub = await services(null);
    const fake = new FakeChannel({ scope: 'fake:multi-closed' });
    const logs: string[] = [];
    const { relay, state } = relayOf(hub, fake, MOCK_NPCS.single, logs);
    state.update({ billing: { mode: 'paid', budget: 100, spent: 0, setAt: 1 } });
    const answers = holdAnswers(relay);
    await start(relay, fake);
    fake.say('你好');
    await waitFor(() => answers.held === 1);
    // The run ended meanwhile (the wait at shutdown ran out): its state is closed.
    state.close();
    answers.open();
    const price = mock.state.replyCost;
    await waitFor(() => hub.ledger.spent === price);
    expect(hub.ledger.takeOwed('fake:multi-closed')).toEqual([
      { bot: 'fake:multi-closed', amount: price, mode: 'paid' },
    ]);
    expect(state.data.billing.spent).toBe(0);
    expect(logs.join('\n')).toContain(`这个 bot 已停止：一条回复花了 ${price} 钻石`);
  });

  it('books what a registered bot spent while it was not running to its budget when it starts', async () => {
    const hub = await services(null);
    // A bot with a budget stopped (a 409, say) while its reply was measured.
    const stopped = new FakeChannel({ scope: 'fake:multi-owed' });
    const owed = relayOf(hub, stopped, MOCK_NPCS.single);
    owed.state.update({ billing: { mode: 'paid', budget: 20, spent: 15, setAt: 1 } });
    hub.ledger.setPending({
      before: mock.state.gems + 5,
      mode: 'paid',
      price: 5,
      at: 1,
      capped: true,
      bot: 'fake:multi-owed',
    });
    // Another bot settles it: in the running total now, owed to the first bot's budget.
    const settler = new FakeChannel({ scope: 'fake:multi-settler' });
    const logs: string[] = [];
    await start(relayOf(hub, settler, MOCK_NPCS.group, logs).relay, settler);
    await waitFor(() => hub.ledger.pending === null);
    expect(hub.ledger.spent).toBe(5);
    expect(logs.join('\n')).toContain('它没有在运行，已计入本机的累计花费，下次启动时计入它的预算');
    expect(owed.state.data.billing.spent).toBe(15);
    // Started again: its budget is spent, and the running total does not count it twice.
    const exhausted = stopped.expect(/预算已用完（已花 20 钻石）/);
    await start(owed.relay, stopped);
    await exhausted();
    expect(owed.state.data.billing.spent).toBe(20);
    expect(owed.state.data.billingPause).toBe('budget');
    expect(hub.ledger.spent).toBe(5);
    expect(hub.ledger.takeOwed('fake:multi-owed')).toEqual([]);
  });

  it("refuses while the computer's ceiling is spent, pausing nothing: the next send checks again", async () => {
    const hub = await services(10);
    // Another bot's image holds the whole ceiling for now: that is said, with nothing to restart.
    const release = hub.ledger.reserve('another bot', 10, 'image:another bot');
    const fake = new FakeChannel({ scope: 'fake:multi-ceiling' });
    const { relay, state } = relayOf(hub, fake, MOCK_NPCS.single);
    state.update({ billing: { mode: 'paid', budget: 100, spent: 0, setAt: 1 } });
    await start(relay, fake);
    const before = sends().length;
    const refused = fake.expect(
      /^本机花费上限剩下的额度正被进行中的图片占用（已花 0\/10 钻石，占用 10）：图片完成后再发。$/,
    );
    fake.say('你好');
    expect((await refused()).text).not.toMatch(/已暂停|重新启动/);
    expect(sends().length).toBe(before);
    // Not this bot's budget: nothing is kept that its owner would have to lift with /budget.
    expect(state.data.billingPause).toBe('');
    release();
    const replied = fake.expect(/今天天气怎么样？/);
    fake.say('今天天气怎么样');
    await replied();
    expect(sends().length).toBe(before + 1);
    // Spent by other bots: the computer's ceiling is used up, said without a pause.
    hub.ledger.book('another bot', 10);
    const reached = fake.expect(
      /^这台电脑设的总花费上限已用完（10\/10 钻石），要花钻石的消息先不发。/,
    );
    fake.say('还能发吗');
    expect((await reached()).text).not.toContain('已暂停');
    expect(sends().length).toBe(before + 1);
    expect(state.data.billingPause).toBe('');
  });

  it('checks an image under the ceiling inside the window: a reply being measured is waited for', async () => {
    const hub = await services(10);
    const config = chatImageStore(mock.gen).config;
    const saved = { ...config };
    Object.assign(config, { freeLeft: 0, coinCost: 6, billingEnabled: true });
    const tasks = () =>
      mock.state.requests.filter((request) => request.path === 'conversation/image/create_task');
    try {
      const fake = new FakeChannel({ scope: 'fake:multi-picture' });
      const { relay } = relayOf(hub, fake, MOCK_NPCS.single);
      await start(relay, fake);
      // Another bot measures a reply priced 6 now: its cost is booked only when it ends.
      const held = hub.ledger.window.tryAcquire('another bot')!;
      hub.ledger.setPending({
        before: mock.state.gems,
        mode: 'open',
        price: 6,
        at: Date.now(),
        capped: true,
        bot: 'another bot',
      });
      const from = tasks().length;
      const refused = fake.expect(/本机上限还可花 4 钻石，不够生成一张图片（6 钻石）/);
      fake.say('/image');
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Waiting for the window: nothing checked, nothing held, nothing asked for.
      expect(hub.ledger.ceilingLeft()).toBe(10);
      expect(fake.sends.some((send) => /图片/.test(send.text))).toBe(false);
      hub.ledger.setPending(null);
      hub.ledger.book('another bot', 6);
      held.release();
      await refused();
      expect(tasks().length).toBe(from);
      expect(hub.ledger.ceilingLeft()).toBe(4);
      expect(hub.ledger.window.holder).toBe('');
    } finally {
      Object.assign(config, saved);
    }
  });

  it('measures capped replies of two bots one at a time: the second one finds the ceiling spent', async () => {
    mock.state.chatFreeLimit = 0;
    mock.state.replyCost = 6;
    const hub = await services(10);
    const measured: string[] = [];
    const setPending = hub.ledger.setPending.bind(hub.ledger);
    hub.ledger.setPending = (pending) => {
      if (pending?.bot) measured.push(pending.bot);
      setPending(pending);
    };
    const lin = new FakeChannel({ scope: 'fake:capped-lin' });
    const fog = new FakeChannel({ scope: 'fake:capped-fog' });
    await start(relayOf(hub, lin, MOCK_NPCS.single).relay, lin);
    await start(relayOf(hub, fog, MOCK_NPCS.group).relay, fog);
    const before = sends().length;
    const short = /本机上限还可花 4 钻石，不够下一条回复（约 6 钻石）/;
    lin.say('你好');
    fog.say('你好');
    const refusedIn = () =>
      [lin, fog].find((fake) => fake.sends.some((send) => short.test(send.text)));
    await waitFor(() => refusedIn() !== undefined && hub.ledger.pending === null);
    const winner = refusedIn() === lin ? fog : lin;
    // One sent and booked by its own measurement; the other never sent.
    expect(sends().length).toBe(before + 1);
    expect(hub.ledger.spent).toBe(6);
    expect(new Set(measured)).toEqual(new Set([winner.scope]));
    expect(hub.ledger.window.holder).toBe('');
  });

  it('starts a crashed bound bot again: its character is free again, the old run writes nothing', async () => {
    const { gateway, account } = context();
    const stopped: string[] = [];
    const hub = new RelayHub(gateway, {
      account,
      log: () => undefined,
      maxSpend: null,
      ledgerBots: [],
      onStopped: (name) => stopped.push(name),
      supervisor: { backoffMs: 5 },
    });
    const channels: FakeChannel[] = [];
    const states: RelayState[] = [];
    const bot: HubBot = {
      name: 'lin',
      run: async (services, signal) => {
        // The first run crashes once it took its character's events; the next one runs.
        const fake = channels.length
          ? new FakeChannel({ scope: 'fake:hub-restart' })
          : new CrashingChannel({ scope: 'fake:hub-restart' });
        channels.push(fake);
        const { relay, state } = relayOf(services, fake, MOCK_NPCS.single, [], { botName: 'lin' });
        states.push(state);
        try {
          await relay.run(signal);
        } finally {
          state.close();
        }
      },
    };
    const inside = hub as unknown as { status: HubStatusFile };
    const controller = new AbortController();
    const running = hub.run([bot], controller.signal);
    await waitFor(() => channels.length === 2 && channels[1].listening);
    // Started again, not stopped as a second bot of its character.
    expect(stopped).toEqual([]);
    expect(inside.status.bots.lin.status).toBe('running');
    const replied = channels[1].expect(/今天天气怎么样？/);
    channels[1].say('今天天气怎么样');
    await replied();
    // What the first run still had to write is dropped: the file is the new run's.
    states[0].data.botUsername = 'stale';
    states[0].save();
    expect(readJsonFile<{ botUsername: string }>(states[1].path)?.botUsername).toBe('');
    controller.abort();
    expect(await running).toBe('aborted');
  });

  it('stops every bot when another Yomi account signs in, one waiting out a pause too', async () => {
    const { gateway, account } = context();
    const hub = new RelayHub(gateway, {
      account,
      log: () => undefined,
      maxSpend: null,
      ledgerBots: [],
      // A crashed bot waits a minute before it starts again.
      supervisor: { backoffMs: 60_000 },
    });
    const lin = new FakeChannel({ scope: 'fake:hub-account' });
    let crashes = 0;
    const bots: HubBot[] = [
      {
        name: 'lin',
        run: async (services, signal) => {
          const { relay, state } = relayOf(services, lin, MOCK_NPCS.single, [], {
            botName: 'lin',
          });
          try {
            await relay.run(signal);
          } finally {
            state.close();
          }
        },
      },
      {
        name: 'crash',
        run: async () => {
          crashes += 1;
          throw new Error('boom');
        },
      },
      {
        name: 'other',
        run: async () => {
          await waitFor(() => lin.listening && crashes === 1);
          throw new RelayStopped('otherAccount', 'another account');
        },
      },
    ];
    const inside = hub as unknown as { status: HubStatusFile };
    const startedAt = Date.now();
    const outcome = await hub.run(bots, new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(RelayStopped);
    expect((outcome as RelayStopped).reason).toBe('otherAccount');
    // Every bot stopped, the one in its pause too (long before its minute was up).
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(crashes).toBe(1);
    expect(Object.values(inside.status.bots).map((bot) => bot.status)).toEqual([
      'stopped',
      'stopped',
      'stopped',
    ]);
    expect(existsSync(hubStatusPath(account))).toBe(false);
  });

  it('runs bots side by side: one that stops leaves the others running', async () => {
    const { gateway, account } = context();
    const lines: string[] = [];
    const stopped: [string, string][] = [];
    const hub = new RelayHub(gateway, {
      account,
      log: (line) => lines.push(line),
      maxSpend: null,
      ledgerBots: [],
      onStopped: (name, error) => stopped.push([name, error?.message ?? '']),
    });
    const lin = new FakeChannel({ scope: 'fake:hub-lin' });
    const twin = new FakeChannel({ scope: 'fake:hub-twin' });
    const gone = new StoppingChannel({ scope: 'fake:hub-gone' });
    const bot = (name: string, fake: FakeChannel, npcId: string): HubBot => ({
      name,
      run: async (services, signal) => {
        const { relay, state } = relayOf(services, fake, npcId, [], { botName: name });
        try {
          await relay.run(signal);
        } finally {
          state.close();
        }
      },
    });
    const controller = new AbortController();
    const listeners = process.listeners('unhandledRejection').length;
    const running = hub.run(
      [
        bot('lin', lin, MOCK_NPCS.single),
        bot('gone', gone, MOCK_NPCS.group),
        // The same character as lin: one of them stops, saying which bot has it.
        bot('twin', twin, MOCK_NPCS.single),
      ],
      controller.signal,
    );
    await waitFor(() => stopped.length === 2);
    expect(stopped).toContainEqual(['gone', StoppingChannel.message]);
    const twinStop = stopped.find(([name]) => name !== 'gone')!;
    expect(twinStop[1]).toMatch(/已经绑在 bot "(lin|twin)" 上/);
    const survivor = twinStop[0] === 'twin' ? lin : twin;
    // A rejection nobody handled is logged: the process goes on.
    expect(process.listeners('unhandledRejection')).toHaveLength(listeners + 1);
    process.listeners('unhandledRejection').at(-1)!(
      new Error('nobody caught it'),
      Promise.resolve(),
    );
    expect(lines.join('\n')).toContain('relay 出错：Error nobody caught it');
    const status = readJsonFile<HubStatusFile>(hubStatusPath(account))!;
    expect(status.pid).toBe(process.pid);
    expect(status.bots.gone.status).toBe('stopped');
    expect(status.bots[twinStop[0] === 'twin' ? 'lin' : 'twin'].status).toBe('running');
    // The one left still answers.
    await waitFor(() => survivor.listening);
    const replied = survivor.expect(/今天天气怎么样？/);
    survivor.say('今天天气怎么样');
    await replied();
    controller.abort();
    expect(await running).toBe('aborted');
    expect(process.listeners('unhandledRejection')).toHaveLength(listeners);
    expect(existsSync(hubStatusPath(account))).toBe(false);
    expect(existsSync(ledgerPath(account))).toBe(true);
  });
});

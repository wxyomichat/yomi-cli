import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ConsumptionMode, sendMessage } from '../src/chat/api.js';
import { main } from '../src/cli.js';
import { createContext } from '../src/commands/context.js';
import type { Gateway } from '../src/core/api.js';
import { type MockServer, MOCK_NPCS, startMockServer } from '../src/mock/server.js';
import { ImFeed } from '../src/relay/hub/feed.js';
import {
  type Lease,
  Ledger,
  type LedgerStore,
  SpendWindow,
  stateLedgerStore,
} from '../src/relay/hub/ledger.js';
import { PolicyService } from '../src/relay/hub/policy.js';
import { SessionGate, type SessionListener } from '../src/relay/hub/session.js';
import type { ChannelKind } from '../src/relay/channels/types.js';
import { DEFAULT_POLICY, type RelayPolicy } from '../src/relay/policy.js';
import { Relay, type RelayOptions, type RelayServices } from '../src/relay/relay.js';
import {
  type Allowance,
  type PendingCharge,
  RelayState,
  relayStatePath,
} from '../src/relay/state.js';
import { LOGIN_URL, authorizeLikeTheBrowser } from './helpers/authorize.js';
import { FakeChannel, waitFor } from './helpers/fakeChannel.js';
import { memoryIo } from './helpers/io.js';

/**
 * What the relays of one Yomi sign-in share (src/relay/hub): the spend window and the ledger, the
 * policy per kind of channel, the sign-in and the long connection; then two relays given the same
 * services against the mock gateway, on scripted channels: one capped send measured at a time
 * (the next one waits as its turn, with typing, and can be stopped or give up; refused after the
 * wait, or its channel paused meanwhile, the typing ends with the reason), each paid cost booked
 * once by its own relay, a stopped relay's send holding the window until it ends, nothing waiting
 * without a cap, one sign-out for all of them (a relay started after it pauses too), every event
 * to every relay and each keeping its own.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A ledger store in memory, as a shared ledger keeps it. */
function memoryStore(): LedgerStore {
  let allowance: Allowance = { maxSpend: null, spent: 0, since: 0, unmeasured: 0 };
  let pending: PendingCharge | null = null;
  return {
    allowance: () => allowance,
    setAllowance: (next) => {
      allowance = next;
    },
    pending: () => pending,
    setPending: (next) => {
      pending = next;
    },
  };
}

describe('the spend window', () => {
  it('lets one bot in at a time, first come first served', async () => {
    const window = new SpendWindow(5000);
    const a = window.tryAcquire('a')!;
    expect(window.holder).toBe('a');
    expect(window.tryAcquire('b')).toBeNull();
    const order: string[] = [];
    const b = window.acquire('b').then((lease) => (order.push('b'), lease as Lease));
    const c = window.acquire('c').then((lease) => (order.push('c'), lease as Lease));
    a.release();
    // once is enough: a second release lets nobody else in
    a.release();
    const second = await b;
    expect(window.holder).toBe('b');
    // waiting bots are not overtaken
    expect(window.tryAcquire('d')).toBeNull();
    second.release();
    const third = await c;
    expect(order).toEqual(['b', 'c']);
    expect(window.holder).toBe('c');
    third.release();
    expect(window.holder).toBe('');
    expect(window.tryAcquire('d')?.bot).toBe('d');
  });

  it('gives up after its wait, or when stopped, and then holds nobody up', async () => {
    const window = new SpendWindow(80);
    const held = window.tryAcquire('a')!;
    const controller = new AbortController();
    const stopped = window.acquire('b', controller.signal);
    const late = window.acquire('c');
    expect(await window.acquire('d', AbortSignal.abort())).toBe('aborted');
    controller.abort();
    expect(await stopped).toBe('aborted');
    expect(await late).toBe('busy');
    held.release();
    expect(window.holder).toBe('');
  });
});

describe('the ledger', () => {
  it('keeps the ceiling, its running total, what images may cost and the pending charge', () => {
    const store = memoryStore();
    const ledger = new Ledger(store);
    expect([ledger.maxSpend, ledger.ceilingLeft()]).toEqual([null, Infinity]);
    ledger.useAllowance(50, false);
    expect(store.allowance()).toMatchObject({ maxSpend: 50, spent: 0 });
    expect(ledger.book('a', 7)).toBe(7);
    expect(ledger.book('b', 3)).toBe(10);
    expect([ledger.spent, ledger.ceilingLeft()]).toEqual([10, 40]);
    const first = ledger.reserve('a', 6, 'image-1');
    expect(ledger.ceilingLeft()).toBe(34);
    // one reservation per key: a new one replaces it, and the old one's release does nothing
    const second = ledger.reserve('a', 2, 'image-1');
    first();
    expect(ledger.ceilingLeft()).toBe(38);
    second();
    expect(ledger.ceilingLeft()).toBe(40);
    ledger.countUnmeasured();
    expect(ledger.unmeasured).toBe(1);
    // the same ceiling keeps its total; another one starts it over; none is no limit
    ledger.useAllowance(50, false);
    expect(ledger.spent).toBe(10);
    ledger.useAllowance(60, false);
    expect([ledger.spent, ledger.unmeasured, ledger.ceilingLeft()]).toEqual([0, 0, 60]);
    ledger.useAllowance(null, false);
    ledger.reserve('a', 5, 'image-2');
    expect(ledger.ceilingLeft()).toBe(Infinity);
    const pending: PendingCharge = { before: 100, mode: 'open', price: 5, at: 1, capped: true };
    ledger.setPending(pending);
    expect([ledger.pending, store.pending()]).toEqual([pending, pending]);
  });

  it("is a relay's own state file when the relay is alone, by the state's own rule", () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-relay-ledger-'));
    const path = join(dir, 'state.json');
    const state = new RelayState(path, 'fake:ledger', 'test', 'qq');
    const ledger = new Ledger(stateLedgerStore(state));
    ledger.useAllowance(20, false);
    ledger.book('fake:ledger', 4);
    ledger.setPending({ before: 30, mode: 'paid', price: 2, at: 5, capped: true });
    const again = new RelayState(path, 'fake:ledger', 'test', 'qq');
    expect(again.data.allowance).toMatchObject({ maxSpend: 20, spent: 4 });
    expect(again.data.pending).toEqual({ before: 30, mode: 'paid', price: 2, at: 5, capped: true });
    // the state's own useAllowance agrees: the same ceiling keeps the total
    again.useAllowance(20, false);
    expect(again.data.allowance.spent).toBe(4);
    again.useAllowance(20, true);
    expect(again.data.allowance.spent).toBe(0);
  });
});

describe('the policy service', () => {
  it('asks once per kind at a time, and again only when the answer is too old', async () => {
    const asked: ChannelKind[] = [];
    const answers: ((policy: RelayPolicy) => void)[] = [];
    const service = new PolicyService({} as Gateway, (_gateway, kind = 'telegram') => {
      asked.push(kind);
      return new Promise<RelayPolicy>((resolve) => answers.push(resolve));
    });
    const first = service.read('qq', 60_000);
    // in flight: shared, whatever age the caller takes
    const second = service.read('qq', 0);
    service.read('wechat', 60_000);
    expect(asked).toEqual(['qq', 'wechat']);
    const policy = { ...DEFAULT_POLICY, source: 'server' as const, channel: 'qq' };
    answers[0](policy);
    expect(await first).toBe(policy);
    expect(await second).toBe(policy);
    expect(await service.read('qq', 60_000)).toBe(policy);
    expect(asked).toEqual(['qq', 'wechat']);
    void service.read('qq', 0);
    expect(asked).toEqual(['qq', 'wechat', 'qq']);
  });
});

describe('the session gate', () => {
  function signIn(userId: string) {
    let credential: { userId: string } | null = { userId };
    const gateway = {
      requireCredential: () => credential,
      get credential() {
        return credential;
      },
      reloadCredential: () => 'same',
    } as unknown as Gateway;
    return {
      gateway,
      set: (next: { userId: string } | null) => {
        credential = next;
      },
    };
  }

  function listener(told: string[], name: string, failing = false): SessionListener {
    return {
      signedOut: () => {
        told.push(`${name}:out`);
        if (failing) throw new Error('listener failed');
      },
      resumed: () => {
        told.push(`${name}:back`);
      },
      otherAccount: () => {
        told.push(`${name}:other`);
      },
      failed: () => {
        told.push(`${name}:failed`);
      },
    };
  }

  it('tells every listener once, one failing alone, and looks for the sign-in until it is back', async () => {
    const { gateway, set } = signIn('user-1');
    const logs: string[] = [];
    const gate = new SessionGate(gateway, { log: (line) => logs.push(line), resumeCheckMs: 20 });
    const told: string[] = [];
    gate.subscribe(listener(told, 'a', true));
    const leave = gate.subscribe(listener(told, 'b'));
    set(null);
    await gate.report();
    await gate.report();
    expect(told).toEqual(['a:out', 'a:failed', 'b:out']);
    expect(gate.signedOut).toBe(true);
    expect(logs).toEqual([expect.stringMatching(/^Yomi 登录已失效/)]);
    await sleep(80);
    expect(told).toHaveLength(3);
    set({ userId: 'user-1' });
    await waitFor(() => told.includes('b:back'));
    expect(told.slice(3)).toEqual(['a:back', 'b:back']);
    expect(gate.signedOut).toBe(false);
    expect(logs.at(-1)).toBe('Yomi 登录已恢复');
    // gone listeners hear nothing
    leave();
    gate.otherAccount();
    expect(told.slice(5)).toEqual(['a:other']);
    gate.close();
    await gate.report();
    expect(told).toHaveLength(6);
  });

  it('stops every listener when another account is back instead', async () => {
    const { gateway, set } = signIn('user-1');
    const gate = new SessionGate(gateway, { log: () => undefined, resumeCheckMs: 20 });
    const told: string[] = [];
    gate.subscribe(listener(told, 'a'));
    await gate.report();
    set({ userId: 'user-2' });
    await waitFor(() => told.includes('a:other'));
    gate.close();
    expect(told[0]).toBe('a:out');
    expect(told).not.toContain('a:back');
  });
});

describe('relays sharing one sign-in', () => {
  let mock: MockServer;
  const saved: Record<string, string | undefined> = {};
  const cleanups: (() => Promise<unknown> | void)[] = [];
  const sends = () =>
    mock.state.requests.filter((request) => request.path === 'conversation/send_message');
  const busy = (relay: Relay) => Boolean((relay as unknown as { turn: unknown }).turn);

  async function context() {
    return createContext(memoryIo().io, {}, { client: 'relay-qq', channel: 'cli_relay' });
  }

  /** The shared services, connected; `maxSpend` is the shared ceiling. */
  async function hub(
    maxSpend: number | null,
    waitMs?: number,
    resumeCheckMs = 100,
  ): Promise<RelayServices> {
    const { gateway } = await context();
    const log = () => undefined;
    const session = new SessionGate(gateway, { log, resumeCheckMs });
    const feed = new ImFeed(gateway, session, { log });
    const ledger = new Ledger(memoryStore(), { waitMs });
    ledger.useAllowance(maxSpend, false);
    const sockets = mock.state.sockets;
    feed.start();
    cleanups.push(() => {
      feed.close();
      session.close();
    });
    await waitFor(() => mock.state.sockets > sockets);
    return { feed, session, policy: new PolicyService(gateway), ledger };
  }

  /** A paired relay on `fake` with the shared `services`, listening. */
  async function relay(
    services: RelayServices,
    fake: FakeChannel,
    more: Partial<RelayOptions> = {},
  ) {
    const { gateway, account } = await context();
    const state = new RelayState(
      relayStatePath(account, fake.scope),
      fake.scope,
      account,
      fake.kind,
    );
    state.update({
      owner: { userId: fake.ownerId, chatId: fake.ownerId, name: '', language: '', pairedAt: 1 },
    });
    const engine = new Relay(gateway, fake, state, {
      maxSpend: 50,
      characterId: MOCK_NPCS.single,
      pairing: null,
      replyTimeoutMs: 1500,
      intervalMs: 30,
      staleMs: 10 * 60 * 1000,
      pollTimeoutSeconds: 1,
      drafts: true,
      language: 'zh-Hans',
      log: () => undefined,
      hub: services,
      ...more,
    });
    const controller = new AbortController();
    const done = engine.run(controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    const stop = () => {
      controller.abort();
      return done;
    };
    cleanups.unshift(stop);
    await waitFor(() => fake.listening);
    return { relay: engine, state, stop };
  }

  beforeAll(async () => {
    mock = await startMockServer();
    const values: Record<string, string> = {
      YOMI_API_ORIGIN: mock.origin,
      YOMI_WEB_ORIGIN: mock.origin,
      YOMI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'yomi-relay-hub-')),
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
    mock.state.reportCharge = false;
    mock.state.chatFreeLimit = 1000;
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  afterAll(async () => {
    await mock.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('passes every event of the one connection to every subscriber, one failing alone', async () => {
    const { feed } = await hub(null);
    const { gateway } = await context();
    const seen: string[] = [];
    const kept: string[] = [];
    let failures = 0;
    feed.subscribe({
      stream: (event) => {
        seen.push(event.streamId);
        throw new Error('subscriber failed');
      },
      aside: () => undefined,
      reconnected: () => undefined,
      failed: () => {
        failures += 1;
      },
    });
    feed.subscribe({
      stream: (event) => kept.push(event.streamId),
      aside: () => undefined,
      reconnected: () => undefined,
      failed: () => undefined,
    });
    const answer = await sendMessage(gateway, {
      npcId: MOCK_NPCS.single,
      text: '你好',
      clientRequestId: randomUUID(),
      consumptionMode: ConsumptionMode.allowPaid,
    });
    // three chunks and the completed message
    await waitFor(() => kept.length >= 4);
    expect(seen).toEqual(kept);
    expect(new Set(kept)).toEqual(new Set([answer.streamId]));
    expect(failures).toBe(seen.length);
  });

  it('measures one capped send at a time: the next waits as its turn, with typing', async () => {
    const services = await hub(50);
    const a = new FakeChannel({ scope: 'fake:hub-a' });
    const b = new FakeChannel({ scope: 'fake:hub-b' });
    await relay(services, a);
    const second = await relay(services, b);
    const before = sends().length;
    // No charge in the answer: A's cost is read from the balance once its slow reply ends.
    a.say('SLOW 一个很长的故事');
    await waitFor(() => a.presenters[0]?.calls.some((call) => call.startsWith('update')));
    expect(services.ledger.window.holder).toBe('fake:hub-a');
    b.say('你好');
    // typing after a moment; nothing sent for B yet
    await waitFor(() => b.presenters[0]?.calls.includes('start'));
    expect(sends()).toHaveLength(before + 1);
    const told = b.expect(/^上一条回复还没结束/);
    b.say('还在吗');
    await told();
    expect(a.presenters[0].isClosed).toBe(false);
    // A's reply ends and is measured: B's goes, shown by the presenter its typing started
    await waitFor(() => sends().length === before + 2);
    expect(a.presenters[0].isClosed).toBe(true);
    expect(sends().at(-1)!.body.text).toBe('你好');
    await waitFor(() => !busy(second.relay) && b.presenters[0].isClosed);
    expect(b.presenters).toHaveLength(1);
    expect(b.presenters[0].calls.filter((call) => call === 'start')).toHaveLength(1);
    // each relay showed its own reply only (the same character, the same connection)
    expect(a.texts('reply').join('')).toContain('一个很长的故事');
    expect(a.texts('reply').join('')).not.toContain('你好');
    expect(b.texts('reply').join('')).toContain('你好');
    expect(b.texts('reply').join('')).not.toContain('一个很长的故事');
    expect(services.ledger.window.holder).toBe('');
  });

  it('lets go of the window as soon as the server says what a send cost', async () => {
    mock.state.reportCharge = true;
    const services = await hub(50);
    const a = new FakeChannel({ scope: 'fake:hub-c' });
    const b = new FakeChannel({ scope: 'fake:hub-d' });
    await relay(services, a);
    await relay(services, b);
    const before = sends().length;
    a.say('SLOW 一个很长的故事');
    await waitFor(() => a.presenters[0]?.calls.some((call) => call.startsWith('update')));
    expect(services.ledger.window.holder).toBe('');
    b.say('你好');
    await waitFor(() => sends().length === before + 2);
    expect(a.presenters[0].isClosed).toBe(false);
  });

  it('cancels a waiting message with /stop: nothing sent, nothing charged', async () => {
    const services = await hub(50);
    const b = new FakeChannel({ scope: 'fake:hub-e' });
    const { relay: engine, state } = await relay(services, b);
    const held = services.ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    // stopped before typing showed: no presenter at all, the answer said as text
    let cancelled = b.expect(/^已取消：这条消息没有发出，没有扣费。$/);
    b.say('你好');
    b.say('/stop');
    await cancelled();
    expect(b.presenters).toHaveLength(0);
    expect(busy(engine)).toBe(false);
    // stopped while typing showed: the typing ends with the answer
    cancelled = b.expect(/^已取消：这条消息没有发出，没有扣费。$/);
    b.say('再说一次');
    await waitFor(() => b.presenters[0]?.calls.includes('start'));
    b.say('/stop');
    await cancelled();
    expect(b.presenters[0].calls).toEqual(['start', 'stop:已取消：这条消息没有发出，没有扣费。']);
    held.release();
    await sleep(150);
    expect(sends()).toHaveLength(before);
    expect([services.ledger.window.holder, services.ledger.pending, state.data.pending]).toEqual([
      '',
      null,
      null,
    ]);
  });

  it('gives up on a wait that lasts too long: not sent, and the owner is told why', async () => {
    const services = await hub(50, 600);
    const b = new FakeChannel({ scope: 'fake:hub-f' });
    const { relay: engine } = await relay(services, b);
    const held = services.ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    const told = b.expect(/^你的另一个 bot 正在回复，这条消息没有发出，没有扣费。/);
    b.say('你好');
    await told();
    expect(b.presenters[0].calls.at(-1)).toMatch(/^stop:你的另一个 bot 正在回复/);
    expect(busy(engine)).toBe(false);
    expect(sends()).toHaveLength(before);
    held.release();
  });

  it('never waits for the window without a cap', async () => {
    const services = await hub(null);
    const b = new FakeChannel({ scope: 'fake:hub-g' });
    const { relay: engine } = await relay(services, b, { maxSpend: null });
    const held = services.ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    b.say('你好');
    await waitFor(() => sends().length === before + 1 && !busy(engine));
    expect(services.ledger.window.holder).toBe('another bot');
    held.release();
  });

  it('pauses every relay once on a sign-out, a waiting message unsent, and resumes them', async () => {
    const services = await hub(50);
    const a = new FakeChannel({ scope: 'fake:hub-h' });
    const b = new FakeChannel({ scope: 'fake:hub-i' });
    await relay(services, a);
    const { relay: engine } = await relay(services, b);
    const held = services.ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    b.say('你好');
    await waitFor(() => b.presenters[0]?.calls.includes('start'));
    const backA = a.expect(/^Yomi 登录已恢复/);
    const backB = b.expect(/^Yomi 登录已恢复/);
    await services.session.report();
    await services.session.report();
    for (const fake of [a, b])
      expect(fake.texts().filter((text) => /^Yomi 登录已失效/.test(text))).toHaveLength(1);
    expect(b.presenters[0].isClosed).toBe(true);
    expect(busy(engine)).toBe(false);
    await backA();
    await backB();
    held.release();
    await sleep(150);
    expect(sends()).toHaveLength(before);
  });

  it('measures paid replies one at a time: each cost booked once, the total the gems spent', async () => {
    mock.state.chatFreeLimit = 0;
    const services = await hub(50);
    const a = new FakeChannel({ scope: 'fake:hub-j' });
    const b = new FakeChannel({ scope: 'fake:hub-k' });
    const first = await relay(services, a);
    const second = await relay(services, b);
    // Each cost is booked by its own relay, which still holds the window then.
    const booked: [string, number, string][] = [];
    const book = services.ledger.book.bind(services.ledger);
    services.ledger.book = (bot, amount) => {
      booked.push([bot, amount, services.ledger.window.holder]);
      return book(bot, amount);
    };
    const gems = mock.state.gems;
    const before = sends().length;
    // No charge in the answer: each cost is the balance's drop, A's measured before B reads it.
    a.say('SLOW 一个很长的故事');
    await waitFor(() => a.presenters[0]?.calls.some((call) => call.startsWith('update')));
    b.say('你好');
    await waitFor(() => b.presenters[0]?.calls.includes('start'));
    expect(sends()).toHaveLength(before + 1);
    await waitFor(
      () =>
        sends().length === before + 2 &&
        !busy(first.relay) &&
        !busy(second.relay) &&
        a.presenters[0].isClosed &&
        b.presenters[0].isClosed,
    );
    await waitFor(() => services.ledger.spent === gems - mock.state.gems);
    const cost = mock.state.replyCost;
    expect(gems - mock.state.gems).toBe(2 * cost);
    expect(booked).toEqual([
      ['fake:hub-j', cost, 'fake:hub-j'],
      ['fake:hub-k', cost, 'fake:hub-k'],
    ]);
    expect(services.ledger.pending).toBeNull();
    expect(services.ledger.window.holder).toBe('');
  });

  it('ends the typing a wait showed when the message is then refused, with the reason', async () => {
    const services = await hub(50);
    const b = new FakeChannel({ scope: 'fake:hub-l' });
    const { relay: engine } = await relay(services, b);
    const held = services.ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    b.say('你好');
    await waitFor(() => b.presenters[0]?.calls.includes('start'));
    const told = b.expect(/^本机花费上限已用完（50\/50 钻石）/);
    // The other bot's measured cost spends the shared ceiling, then it lets go of the window.
    services.ledger.book('another bot', 50);
    held.release();
    await told();
    expect(b.presenters[0].calls).toEqual([
      'start',
      expect.stringMatching(/^stop:本机花费上限已用完/),
    ]);
    expect(b.presenters[0].isClosed).toBe(true);
    expect(busy(engine)).toBe(false);
    expect(sends()).toHaveLength(before);
    expect(services.ledger.window.holder).toBe('');
  });

  it('does not send a message whose channel paused while it waited', async () => {
    const services = await hub(50);
    const b = new FakeChannel({ scope: 'fake:hub-m' });
    const { relay: engine } = await relay(services, b);
    const held = services.ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    b.say('你好');
    await waitFor(() => b.presenters[0]?.calls.includes('start'));
    const told = b.expect(/暂时不可用，这条消息没有转发（没有扣费）。$/);
    b.host!.pause('unavailable', Date.now() + 60_000);
    held.release();
    await told();
    expect(b.presenters[0].calls.at(-1)).toMatch(/^stop:.*暂时不可用/);
    expect(busy(engine)).toBe(false);
    expect(sends()).toHaveLength(before);
    expect([services.ledger.window.holder, services.ledger.pending]).toEqual(['', null]);
  });

  it('ends a waiting message when its relay stops: nothing sent, the window let go', async () => {
    const services = await hub(50);
    const b = new FakeChannel({ scope: 'fake:hub-n' });
    const { stop } = await relay(services, b);
    const held = services.ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    b.say('你好');
    await waitFor(() => b.presenters[0]?.calls.includes('start'));
    const startedAt = Date.now();
    await stop();
    // The wait was stopped, not timed out.
    expect(Date.now() - startedAt).toBeLessThan(2000);
    held.release();
    await sleep(150);
    expect(sends()).toHaveLength(before);
    expect(services.ledger.window.holder).toBe('');
  });

  it('keeps the window while a stopped send still reads the balance, and leaves others alone', async () => {
    const services = await hub(50);
    const b = new FakeChannel({ scope: 'fake:hub-p' });
    const { relay: engine, stop } = await relay(services, b);
    // A balance read that takes longer than a stop waits for it.
    let answer = (_value: number | null) => {};
    const reading = new Promise<number | null>((resolve) => {
      answer = resolve;
    });
    let reads = 0;
    (engine as unknown as { balance: () => Promise<number | null> }).balance = () => {
      reads += 1;
      return reading;
    };
    const held = services.ledger.window.tryAcquire('another bot')!;
    const before = sends().length;
    b.say('你好');
    await waitFor(() => b.presenters[0]?.calls.includes('start'));
    held.release();
    await waitFor(() => reads === 1);
    await stop();
    // Stopped, but still reading: the window is not let go under it.
    expect(services.ledger.window.holder).toBe('fake:hub-p');
    // Another bot's measurement, as it would be open had the window been let go.
    const theirs: PendingCharge = { before: 100, mode: 'open', price: 5, at: 1, capped: true };
    services.ledger.setPending(theirs);
    answer(500);
    await waitFor(() => services.ledger.window.holder === '');
    expect(services.ledger.pending).toEqual(theirs);
    expect(services.ledger.spent).toBe(0);
    expect(sends()).toHaveLength(before);
  });

  it('pauses a relay that starts after the sign-out, and tells it when the sign-in is back', async () => {
    const services = await hub(50, undefined, 1000);
    await services.session.report();
    const b = new FakeChannel({ scope: 'fake:hub-o' });
    const out = b.expect(/^Yomi 登录已失效/);
    const back = b.expect(/^Yomi 登录已恢复/);
    await relay(services, b);
    await out();
    const before = sends().length;
    const again = b.expect(/^Yomi 登录已失效/);
    b.say('你好');
    await again();
    expect(sends()).toHaveLength(before);
    await back();
    expect(b.texts().filter((text) => /^Yomi 登录已恢复/.test(text))).toHaveLength(1);
  });
});

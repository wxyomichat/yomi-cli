import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type WebSocket as WsSocket, WebSocketServer } from 'ws';

import { type MockQq, startMockQq } from '../src/mock/qq.js';
import {
  QQ_API,
  QqApi,
  qqApiOrigin,
  QqError,
  qqGatewayUrl,
  QqTokens,
} from '../src/relay/channels/qq-api.js';
import {
  C2C_INTENTS,
  probeGateway,
  QqGateway,
  type QqDispatch,
} from '../src/relay/channels/qq-gateway.js';
import { QQ_MARKDOWN } from '../src/relay/channels/qq-render.js';
import { RelayStopped } from '../src/relay/channels/types.js';

/**
 * The QQ client against the mock QQ (src/mock/qq.ts): the access token, REST and its error
 * codes, and the WebSocket gateway (Identify, Resume, heartbeats, op 7 and 9, close codes, the
 * day's session starts). Nothing reaches the network.
 */

let qq: MockQq;
const OWNER = 'OPENID_OWNER_1';

beforeAll(async () => {
  qq = await startMockQq({ heartbeatMs: 80 });
});

afterAll(async () => {
  await qq.shutdown();
});

const apiFor = (mock: MockQq, secret = mock.secret, now?: () => number) => {
  const tokens = new QqTokens({ appId: mock.appId, secret, origin: mock.origin, now });
  return new QqApi(tokens, mock.origin);
};

const tokenCalls = (mock: MockQq) =>
  mock.calls.filter((call) => call.path === '/app/getAppAccessToken').length;

describe('the QQ API client', () => {
  it('accepts only QQ or a loopback mock, and a gateway under qq.com', () => {
    expect(qqApiOrigin(undefined)).toBe(QQ_API);
    expect(qqApiOrigin('http://127.0.0.1:9')).toBe('http://127.0.0.1:9');
    expect(() => qqApiOrigin('https://example.com')).toThrow(/api\.bot\.qq\.com/);
    expect(qqGatewayUrl('wss://api.bot.qq.com/websocket/', QQ_API)).toBe(
      'wss://api.bot.qq.com/websocket/',
    );
    expect(() => qqGatewayUrl('ws://api.bot.qq.com/websocket/', QQ_API)).toThrow();
    expect(() => qqGatewayUrl('wss://qq.com.example.org/', QQ_API)).toThrow();
    expect(() => qqGatewayUrl('ws://127.0.0.1:5/websocket', QQ_API)).toThrow();
    expect(qqGatewayUrl('ws://127.0.0.1:5/websocket', 'http://127.0.0.1:9')).toBe(
      'ws://127.0.0.1:5/websocket',
    );
  });

  it('keeps the token until less than a minute is left, and asks again after a 401', async () => {
    let now = Date.now();
    const api = apiFor(qq, qq.secret, () => now);
    const before = tokenCalls(qq);
    await api.me();
    await api.me();
    expect(tokenCalls(qq) - before).toBe(1);
    // Less than 60 s left (by the client's clock): asked again.
    now += 7200_000 - 30_000;
    await api.me();
    expect(tokenCalls(qq) - before).toBe(2);
    // A 401: a new token, the same call once more.
    qq.failNext('me', { code: 11244, status: 401 });
    await expect(api.me()).resolves.toMatchObject({ username: 'Lin QQ bot' });
    expect(tokenCalls(qq) - before).toBe(3);
    qq.failNext('me', { code: 11244, status: 401 }, 2);
    await expect(api.me()).rejects.toMatchObject({ reason: 'unauthorized', status: 401 });
    // No token is ever in a call record.
    expect(JSON.stringify(qq.calls)).not.toContain(qq.secret);
  });

  it('refuses a wrong AppSecret as unauthorized, and never puts it in an error', async () => {
    const api = apiFor(qq, 'wrong-secret-123');
    const error = await api.tokens.get().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QqError);
    expect(error).toMatchObject({ reason: 'unauthorized', channel: 'qq' });
    expect(String((error as Error).message)).not.toContain('wrong-secret-123');
  });

  it("maps QQ's codes to how the relay handles them", async () => {
    const api = apiFor(qq);
    qq.userSends(OWNER, 'hi');
    const cases: [number, string][] = [
      [40054004, 'blocked'],
      [40034006, 'contentRefused'],
      [40034100, 'rateLimited'],
      [50002, 'rateLimited'],
      [40054006, 'transient'],
      [40054016, 'transient'],
      [40034004, 'transient'],
      [500, 'transient'],
      [40034128, 'expired'],
      [304103, 'expired'],
      [22006, 'rejected'],
      [40054007, 'rejected'],
      [40034105, 'other'],
    ];
    for (const [code, reason] of cases) {
      qq.failNext('messages', { code });
      const error = await api
        .send(OWNER, { msg_type: 0, content: 'x' })
        .catch((caught: unknown) => caught);
      expect(error, String(code)).toMatchObject({
        code,
        reason,
        operation: 'POST /v2/users/{openid}/messages',
      });
    }
    // The operation names the template, never the person's id.
    expect(JSON.stringify(cases)).not.toContain(OWNER);
  });

  it('escapes markdown with full-width look-alikes (off until checked on a real client)', () => {
    expect(QQ_MARKDOWN.escape('# 标题\n*重点* [链接](x) a_b')).toBe(
      '＃ 标题  \n＊重点＊ ［链接］(x) a＿b',
    );
    expect(QQ_MARKDOWN.narration('雨')).toBe('*雨*');
  });
});

/** A gateway on `mock` that records what it gets; stopped after each test. */
const running: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
});

function gateway(
  mock: MockQq | QqApi,
  options: { session?: { sessionId: string; seq: number } | null } = {},
) {
  const controller = new AbortController();
  const events: QqDispatch[] = [];
  const readies: boolean[] = [];
  const logs: string[] = [];
  const api = mock instanceof QqApi ? mock : apiFor(mock);
  const gate = new QqGateway({
    api,
    signal: controller.signal,
    log: (line) => logs.push(line),
    dispatch: (event) => events.push(event),
    ready: (info) => readies.push(info.resumed),
    session: options.session ?? null,
    timings: {
      backoffMinMs: 20,
      backoffMaxMs: 100,
      identifyIntervalMs: 0,
      invalidSessionDelayMs: () => 20,
      resumedTimeoutMs: 1000,
    },
  });
  const done = gate.run().then(
    () => null,
    (error: unknown) => error,
  );
  const stop = async () => {
    controller.abort();
    await done;
  };
  running.push(stop);
  return { gate, events, readies, logs, done, stop, api };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A gateway of the test's own on 127.0.0.1 (`ws`), for behaviour the mock QQ does not script:
 * Hello on connect, then `script` answers each payload. The token and /gateway/bot are stubbed.
 */
async function scriptedGateway(
  script: (socket: WsSocket, payload: { op: number; d?: unknown }) => void,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const seen = { connections: 0, identifies: 0, resumes: 0 };
  server.on('connection', (socket) => {
    seen.connections += 1;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
    socket.on('message', (data) => {
      const payload = JSON.parse(String(data)) as { op: number; d?: unknown };
      if (payload.op === 2) seen.identifies += 1;
      if (payload.op === 6) seen.resumes += 1;
      script(socket, payload);
    });
  });
  const stub: typeof fetch = async (input) => {
    const body = String(input).endsWith('/app/getAppAccessToken')
      ? { access_token: 'token-for-tests', expires_in: 7200 }
      : {
          url: `ws://127.0.0.1:${port}/websocket`,
          session_start_limit: { remaining: 100, reset_after: 1000 },
        };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const origin = 'http://127.0.0.1:9';
  const tokens = new QqTokens({
    appId: '102000001',
    secret: 'secret-for-tests',
    origin,
    fetch: stub,
  });
  const close = () =>
    new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(() => resolve());
    });
  return { api: new QqApi(tokens, origin, stub), seen, close };
}

describe('the QQ gateway', () => {
  it('identifies with the private-chat intent, resumes after a drop and gets what it missed', async () => {
    const identifies = qq.identifies;
    const resumes = qq.resumes;
    const { gate, events, readies } = gateway(qq);
    await qq.waitFor(() => readies.length === 1);
    expect(qq.identifies - identifies).toBe(1);
    expect(C2C_INTENTS).toBe(33554432);
    const first = qq.userSends(OWNER, 'one');
    await qq.waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ t: 'C2C_MESSAGE_CREATE', d: { id: first } });
    expect(events[0].id).toMatch(/^C2C_MESSAGE_CREATE:/);
    qq.drop();
    // Sent while the socket is down: the session keeps it for the Resume.
    const second = qq.userSends(OWNER, 'two');
    await qq.waitFor(() => readies.length === 2);
    expect(readies).toEqual([false, true]);
    expect(qq.resumes - resumes).toBe(1);
    expect(qq.identifies - identifies).toBe(1);
    await qq.waitFor(() => events.length === 2);
    expect((events[1].d as { id: string }).id).toBe(second);
    expect(gate.seq).toBeGreaterThanOrEqual(events[1].s);
    // Op 7: reconnect and Resume.
    qq.reconnect();
    await qq.waitFor(() => readies.length === 3);
    expect(readies[2]).toBe(true);
    // Op 9, not resumable: a new session.
    qq.invalidSession(false);
    await qq.waitFor(() => readies.length === 4);
    expect(readies[3]).toBe(false);
    expect(qq.identifies - identifies).toBe(2);
  });

  it('reconnects when heartbeats are not acknowledged, and resumes with a fresh token', async () => {
    const short = await startMockQq({ heartbeatMs: 60, tokenTtlSeconds: 1 });
    try {
      const { readies } = gateway(short);
      await short.waitFor(() => readies.length === 1);
      short.withholdAck(true);
      // The first token has expired by now: the Resume must carry a new one (else 4004).
      await new Promise((resolve) => setTimeout(resolve, 1100));
      short.withholdAck(false);
      await short.waitFor(() => readies.length >= 2, 5000);
      expect(readies[1]).toBe(true);
      expect(short.resumes).toBeGreaterThanOrEqual(1);
      expect(short.identifies).toBe(1);
    } finally {
      await short.shutdown();
    }
  });

  it('resumes a stored session first, and identifies when it is gone', async () => {
    const { readies, gate, stop } = gateway(qq);
    await qq.waitFor(() => readies.length === 1);
    const session = { sessionId: gate.sessionId, seq: gate.seq };
    await stop();
    const missed = qq.userSends(OWNER, 'while away');
    const identifies = qq.identifies;
    const again = gateway(qq, { session });
    await qq.waitFor(() => again.readies.length === 1);
    expect(again.readies).toEqual([true]);
    expect(qq.identifies).toBe(identifies);
    await qq.waitFor(() => again.events.length === 1);
    expect((again.events[0].d as { id: string }).id).toBe(missed);
    await again.stop();
    const unknown = gateway(qq, { session: { sessionId: 'session_gone', seq: 3 } });
    await qq.waitFor(() => unknown.readies.length === 1);
    expect(unknown.readies).toEqual([false]);
    expect(qq.identifies).toBe(identifies + 1);
  });

  it('stops on codes a restart cannot fix, each with its own reason', async () => {
    for (const [code, reason] of [
      [4914, 'delisted'],
      [4915, 'banned'],
      [4014, 'intents'],
      [4012, 'protocol'],
    ] as const) {
      const { readies, done } = gateway(qq);
      await qq.waitFor(() => readies.length === 1);
      qq.close(code);
      const error = await done;
      expect(error, String(code)).toBeInstanceOf(RelayStopped);
      expect(error).toMatchObject({ reason });
    }
  });

  it('stops when the bot may not receive private chats (4014), without retrying', async () => {
    const closed = await startMockQq({ c2c: false });
    try {
      const { done } = gateway(closed);
      const error = (await done) as RelayStopped;
      expect(error).toBeInstanceOf(RelayStopped);
      expect(error.reason).toBe('intents');
      expect(error.message).toContain('4014');
      expect(closed.calls.filter((call) => call.path === '/gateway/bot')).toHaveLength(1);
      expect(await probeGateway(apiFor(closed))).toBe('intents');
      expect(await probeGateway(apiFor(qq))).toBe('ok');
    } finally {
      await closed.shutdown();
    }
  });

  it('waits for the day’s session starts instead of identifying without them', async () => {
    const rationed = await startMockQq({ sessionLimit: { remaining: 0, resetAfterMs: 400 } });
    try {
      const { readies, logs } = gateway(rationed);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rationed.identifies).toBe(0);
      expect(logs.some((line) => line.includes('QQ 今天的连接次数已用完'))).toBe(true);
      rationed.setSessionLimit(5, 86_400_000);
      await rationed.waitFor(() => readies.length === 1, 3000);
      expect(rationed.identifies).toBe(1);
    } finally {
      await rationed.shutdown();
    }
  });

  it('asks for a new token after 4004 and stops when it is refused again', async () => {
    const mock = await startMockQq();
    try {
      const { readies, done } = gateway(mock);
      await mock.waitFor(() => readies.length === 1);
      mock.resetSecret();
      mock.close(4004);
      const error = (await done) as RelayStopped;
      expect(error).toBeInstanceOf(RelayStopped);
      expect(error.reason).toBe('token');
      expect(error.message).toContain('--set-app');
    } finally {
      await mock.shutdown();
    }
  });

  it('opens no socket when it is stopped while QQ answers /gateway/bot', async () => {
    const first = gateway(qq);
    await qq.waitFor(() => first.readies.length === 1);
    const session = { sessionId: first.gate.sessionId, seq: first.gate.seq };
    await first.stop();
    await qq.waitFor(() => qq.sockets === 0);
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = false;
    const slow: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/gateway/bot')) {
        asked = true;
        await held;
      }
      return fetch(input, init);
    };
    const tokens = new QqTokens({
      appId: qq.appId,
      secret: qq.secret,
      origin: qq.origin,
      fetch: slow,
    });
    const resumes = qq.resumes;
    // A stored session: the Resume path, which asks /gateway/bot and connects at once.
    const { done, stop } = gateway(new QqApi(tokens, qq.origin, slow), { session });
    await qq.waitFor(() => asked);
    const stopping = stop();
    release();
    const ended = await Promise.race([stopping.then(() => true), sleep(1000).then(() => false)]);
    expect(ended).toBe(true);
    expect(await done).toBeNull();
    await sleep(150);
    expect(qq.sockets).toBe(0);
    expect(qq.resumes).toBe(resumes);
  });

  it('backs off when QQ asks to reconnect before any session was established', async () => {
    // Op 7 in answer to every Identify: no session ever starts.
    const fake = await scriptedGateway((socket, payload) => {
      if (payload.op === 2) socket.send(JSON.stringify({ op: 7 }));
    });
    try {
      const { readies } = gateway(fake.api);
      await sleep(500);
      expect(readies).toEqual([]);
      // 20, 40, 80, 100, 100 ms between tries (the test's backoff), not a tight loop.
      expect(fake.seen.connections).toBeGreaterThanOrEqual(2);
      expect(fake.seen.connections).toBeLessThanOrEqual(9);
    } finally {
      await fake.close();
    }
  });

  it('gives up a session QQ never confirms after three Resumes, and identifies', async () => {
    // Every Resume is cut (4009: "reconnect and resume") without RESUMED or op 9.
    const fake = await scriptedGateway((socket, payload) => {
      if (payload.op === 6) socket.close(4009, 'session timed out');
      if (payload.op === 2)
        socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fresh' } }));
    });
    try {
      const { readies, gate } = gateway(fake.api, { session: { sessionId: 'stale', seq: 7 } });
      await qq.waitFor(() => readies.length === 1, 5000);
      expect(readies).toEqual([false]);
      expect(fake.seen.resumes).toBe(3);
      expect(fake.seen.identifies).toBe(1);
      expect(gate.sessionId).toBe('fresh');
    } finally {
      await fake.close();
    }
  });
});

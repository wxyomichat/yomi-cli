import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type WebSocket, WebSocketServer } from 'ws';

/**
 * An in-process stand-in for QQ's bot platform (https://bot.q.qq.com/wiki/develop/api-v2/), for
 * end-to-end tests of `yomi relay --channel qq`. It speaks the real wire format — the access
 * token (`POST /app/getAppAccessToken`), REST with `Authorization: QQBot <token>` and errors as
 * `{ code, message }`, the WebSocket gateway (Hello, Identify, Resume, heartbeats, dispatches with
 * `s`, op 7 and 9, close codes) — and enforces what matters to the relay: token expiry, the
 * private-chat intent (close 4014 without it), friends only (40054004), passive replies within a
 * window and 4 per message (40034128), a `(msg_id, msg_seq)` used once (40054005), active messages
 * the person refused (40034105), markdown it cannot parse (40034011 when told so), the stream's
 * rules (index order, replace may not change what was sent: 40007, `input_state: 10` ends it, each
 * response a new `id`), recall within a time limit (40064004), upload size, and the day's session
 * starts (`session_start_limit`). A session keeps its events while no socket is connected, so a
 * Resume (also from a new process) replays them; messages sent with no session are lost, as on
 * QQ. It listens on 127.0.0.1 only and records no token; nothing reaches the network.
 */

export type MockQqOptions = {
  appId?: string;
  secret?: string;
  botName?: string;
  /** Lifetime of an access token (7200). */
  tokenTtlSeconds?: number;
  /** false: the bot may not receive private chats (Identify with the intent closes 4014). */
  c2c?: boolean;
  /** Passive replies to a message this long after it (300 000). */
  passiveWindowMs?: number;
  heartbeatMs?: number;
  /** Session starts left today and when they come back. */
  sessionLimit?: { remaining: number; resetAfterMs: number };
  /** Recall within this long of sending (120 000). */
  recallWindowMs?: number;
  /** Markdown messages are refused (40034011). */
  markdownBroken?: boolean;
};

/** One request (no Authorization header, no file bytes: `file_data` is replaced by its length). */
export type MockQqCall = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  at: number;
  status: number;
  code: number;
};

/** What the private chat shows of the bot's messages, oldest first. */
export type MockQqMessage = {
  /** The id the send returned (a stream: its first). */
  id: string;
  /** Every id of a stream, in order. */
  ids: string[];
  kind: 'text' | 'markdown' | 'media' | 'stream' | 'typing';
  /** The text shown (a stream: its current content). */
  text: string;
  /** The `msg_id` / `event_id` it answered, '' for an active message. */
  replyTo: string;
  seq: number;
  refIdx: string;
  recalled: boolean;
  /** A stream that got `input_state: 10`. */
  done: boolean;
  at: number;
  /** A media message's picture. */
  bytes?: Buffer;
};

export type MockQqStreamCall = {
  index: number;
  state: number;
  content: string;
  streamMsgId: string;
  seq: number;
  replyTo: string;
};

type Failure = { code: number; status?: number; message?: string };

type Inbound = { openid: string; at: number; replies: number; seqs: Set<number> };

type Session = {
  id: string;
  seq: number;
  /** Every dispatch, for Resume. */
  events: { s: number; payload: Record<string, unknown> }[];
  socket: WebSocket | null;
};

type Client = { ws: WebSocket; session: Session | null; hello: boolean };

export type MockQq = {
  /** `http://127.0.0.1:<port>`, for `YOMI_QQ_API_ORIGIN`. */
  origin: string;
  appId: string;
  secret: string;
  botId: string;
  botName: string;
  calls: MockQqCall[];
  /** Every stream chunk accepted, per person. */
  streams(openid: string): MockQqStreamCall[];
  messages(openid: string): MockQqMessage[];
  /** The person writes to the bot (they become its friend); returns the message id. */
  userSends(
    openid: string,
    text: string,
    options?: { at?: number; quote?: string; lead?: string },
  ): string;
  /** A raw dispatch (`t`, `d`) to the bot's live session. */
  dispatch(type: string, data: Record<string, unknown>): string;
  /** C2C_MSG_REJECT / C2C_MSG_RECEIVE: the person switches active messages off / on. */
  rejectOn(openid: string): void;
  receiveOn(openid: string): string;
  friendAdd(openid: string): string;
  /** The person is not (no longer) a friend: sends answer 40054004. */
  unfriend(openid: string): void;
  /** Active messages to the person answer 40034105 (allowActive undoes it). */
  rejectActive(openid: string): void;
  allowActive(openid: string): void;
  /** Active messages answer 40034100 (the rate limit). */
  limitActive(on: boolean): void;
  /** The next `times` calls of `path` fail with `failure`. */
  failNext(
    path: 'token' | 'me' | 'gateway' | 'messages' | 'stream_messages' | 'files' | 'recall',
    failure: Failure,
    times?: number,
  ): void;
  /** Forgets failures `failNext` set up that no call has used yet (between tests). */
  clearFailures(): void;
  /** Text containing this is refused under the content rules (40034006). */
  refuseContent(substring: string): void;
  /** Recalls answer 40064004 (too late). */
  refuseRecall(on: boolean): void;
  /** Network loss: every socket is cut without a close frame. */
  drop(): void;
  /** Closes every socket with `code`. */
  close(code: number): void;
  /** Heartbeats are no longer acknowledged. */
  withholdAck(on: boolean): void;
  /** Op 7: the client should reconnect and Resume. */
  reconnect(): void;
  /** Op 9: the session is invalid; `resumable` says whether a Resume may work. */
  invalidSession(resumable: boolean): void;
  /** Session starts left today. */
  setSessionLimit(remaining: number, resetAfterMs: number): void;
  /** The AppSecret is reset: tokens issued so far stop working and the old secret is refused. */
  resetSecret(): string;
  identifies: number;
  resumes: number;
  heartbeats: number;
  /** Sockets connected now. */
  readonly sockets: number;
  /** Polls `check` every 10 ms until it returns something truthy. */
  waitFor<T>(check: () => T | undefined | null | false, timeoutMs?: number): Promise<T>;
  shutdown(): Promise<void>;
};

const id = (prefix: string) => prefix + randomBytes(9).toString('hex');

export async function startMockQq(options: MockQqOptions = {}): Promise<MockQq> {
  const appId = options.appId ?? '102000001';
  let secret = options.secret ?? randomBytes(16).toString('hex');
  const botId = id('bot_');
  const botName = options.botName ?? 'Lin QQ bot';
  const tokenTtl = options.tokenTtlSeconds ?? 7200;
  const passiveWindowMs = options.passiveWindowMs ?? 300_000;
  const recallWindowMs = options.recallWindowMs ?? 120_000;
  const heartbeatMs = options.heartbeatMs ?? 41_250;
  let limit = options.sessionLimit ?? { remaining: 1000, resetAfterMs: 86_400_000 };

  const tokens = new Map<string, number>();
  let current = '';
  const calls: MockQqCall[] = [];
  const failures = new Map<string, Failure[]>();
  const refused: string[] = [];
  const friends = new Set<string>();
  const activeRefused = new Set<string>();
  let activeLimited = false;
  let recallRefused = false;
  let ackWithheld = false;
  const inbound = new Map<string, Inbound>();
  const chats = new Map<string, MockQqMessage[]>();
  const streamCalls = new Map<string, MockQqStreamCall[]>();
  const files = new Map<string, Buffer>();
  const sessions = new Map<string, Session>();
  let live: Session | null = null;
  const clients = new Set<Client>();

  const chat = (openid: string) => {
    let list = chats.get(openid);
    if (!list) chats.set(openid, (list = []));
    return list;
  };

  /** A dispatch to the bot's session: sent when its socket is live, kept for Resume anyway. */
  const push = (type: string, data: Record<string, unknown>, eventId = `${type}:${id('')}`) => {
    const session = live;
    if (!session) return eventId;
    session.seq += 1;
    const payload = { op: 0, s: session.seq, t: type, id: eventId, d: data };
    session.events.push({ s: session.seq, payload });
    session.socket?.send(JSON.stringify(payload));
    return eventId;
  };

  const validToken = (header: string | string[] | undefined) => {
    const value = String(header ?? '');
    const match = /^QQBot (\S+)$/.exec(value);
    const expires = match ? tokens.get(match[1]) : undefined;
    return Boolean(expires && expires > Date.now());
  };

  const failureFor = (path: string) => {
    const list = failures.get(path);
    if (!list?.length) return null;
    return list.shift()!;
  };

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const readJson = (request: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = raw ? (JSON.parse(raw) as unknown) : {};
          resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });

  class Refusal extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly status = 400,
    ) {
      super(message);
    }
  }

  const textOf = (body: Record<string, unknown>) => {
    const markdown = body.markdown as { content?: string } | undefined;
    return String(markdown?.content ?? body.content ?? body.content_raw ?? '');
  };

  const checkContent = (text: string) => {
    if (refused.some((part) => text.includes(part)))
      throw new Refusal(40034006, 'message content violates the rules');
  };

  /** A passive reply's context; null for an active message. */
  const passive = (openid: string, body: Record<string, unknown>, counts: boolean) => {
    const key = String(body.msg_id ?? body.event_id ?? '');
    if (!key) {
      if (activeRefused.has(openid)) throw new Refusal(40034105, 'active message not allowed');
      if (activeLimited) throw new Refusal(40034100, 'active message rate limited');
      return null;
    }
    const source = inbound.get(key);
    if (!source || source.openid !== openid) throw new Refusal(40034024, 'msg_id invalid');
    if (Date.now() - source.at > passiveWindowMs)
      throw new Refusal(40034128, 'passive reply time or count exceeded');
    const seq = Number(body.msg_seq ?? 1);
    if (source.seqs.has(seq)) throw new Refusal(40054005, 'message deduplicated');
    if (counts && source.replies >= 4)
      throw new Refusal(40034128, 'passive reply time or count exceeded');
    return { key, source, seq };
  };

  const refIdx = () => 'REFIDX_' + randomBytes(6).toString('hex');

  function sendMessage(openid: string, body: Record<string, unknown>) {
    const type = Number(body.msg_type ?? 0);
    if (type === 2 && options.markdownBroken) throw new Refusal(40034011, 'invalid markdown');
    if (type === 7) {
      const info = String((body.media as { file_info?: string } | undefined)?.file_info ?? '');
      if (!files.has(info)) throw new Refusal(304080, 'invalid file info');
    } else if (type !== 6) checkContent(textOf(body));
    if (type === 7) checkContent(String(body.content ?? ''));
    const context = passive(openid, body, type !== 6);
    if (context) {
      context.source.seqs.add(context.seq);
      if (type !== 6) context.source.replies += 1;
    }
    const message: MockQqMessage = {
      id: id('msg_'),
      ids: [],
      kind: type === 2 ? 'markdown' : type === 7 ? 'media' : type === 6 ? 'typing' : 'text',
      text: type === 7 ? String(body.content ?? '') : textOf(body),
      replyTo: context?.key ?? '',
      seq: context?.seq ?? 0,
      refIdx: refIdx(),
      recalled: false,
      done: true,
      at: Date.now(),
      ...(type === 7
        ? { bytes: files.get(String((body.media as { file_info: string }).file_info)) }
        : {}),
    };
    message.ids.push(message.id);
    chat(openid).push(message);
    return {
      id: message.id,
      timestamp: new Date().toISOString(),
      ext_info: { ref_idx: message.refIdx },
    };
  }

  function streamMessage(openid: string, body: Record<string, unknown>) {
    const content = String(body.content_raw ?? '');
    const index = Number(body.index ?? 0);
    const state = Number(body.input_state ?? 1);
    if (body.content_type === 'markdown' && options.markdownBroken)
      throw new Refusal(40034011, 'invalid markdown');
    checkContent(content);
    const streamMsgId = String(body.stream_msg_id ?? '');
    let message: MockQqMessage | undefined;
    if (!streamMsgId) {
      const context = passive(openid, body, true);
      if (!context) throw new Refusal(40034024, 'stream needs msg_id or event_id');
      context.source.seqs.add(context.seq);
      context.source.replies += 1;
      message = {
        id: id('stream_'),
        ids: [],
        kind: 'stream',
        text: '',
        replyTo: context.key,
        seq: context.seq,
        refIdx: refIdx(),
        recalled: false,
        done: false,
        at: Date.now(),
      };
      message.ids.push(message.id);
      chat(openid).push(message);
      (message as MockQqMessage & { lastIndex: number }).lastIndex = -1;
    } else {
      message = chat(openid).find(
        (item) => item.kind === 'stream' && item.ids.includes(streamMsgId),
      );
      if (!message) throw new Refusal(40061002, 'invalid stream_msg_id');
      if (message.ids.at(-1) !== streamMsgId)
        throw new Refusal(40061001, 'stream_msg_id is not the latest');
      if (message.done) throw new Refusal(40061001, 'stream already ended');
    }
    const state_ = message as MockQqMessage & { lastIndex: number };
    if (index <= state_.lastIndex) throw new Refusal(40061001, 'index out of order');
    if (!content.startsWith(message.text))
      throw new Refusal(40007, 'already-delivered content prefix cannot be modified');
    state_.lastIndex = index;
    message.text = content;
    if (state === 10) message.done = true;
    let list = streamCalls.get(openid);
    if (!list) streamCalls.set(openid, (list = []));
    list.push({
      index,
      state,
      content,
      streamMsgId,
      seq: Number(body.msg_seq ?? 0),
      replyTo: message.replyTo,
    });
    const next = streamMsgId ? id('stream_') : message.id;
    if (streamMsgId) message.ids.push(next);
    return { id: next, timestamp: new Date().toISOString(), ext_info: { ref_idx: message.refIdx } };
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://mock');
    const method = request.method ?? 'GET';
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(request);
    const logged = { ...body };
    if (typeof logged.file_data === 'string') logged.file_data = `<${logged.file_data.length}>`;
    if ('clientSecret' in logged) logged.clientSecret = '***';
    const call: MockQqCall = {
      method,
      path: url.pathname,
      body: logged,
      at: Date.now(),
      status: 200,
      code: 0,
    };
    calls.push(call);
    const answer = (status: number, payload: unknown) => {
      call.status = status;
      const code = (payload as { code?: number }).code;
      if (typeof code === 'number') call.code = code;
      send(response, status, payload);
    };
    const refuse = (failure: Failure) =>
      answer(failure.status ?? (failure.code >= 500 && failure.code < 600 ? failure.code : 400), {
        code: failure.code,
        message: failure.message ?? `error ${failure.code}`,
      });

    if (method === 'POST' && url.pathname === '/app/getAppAccessToken') {
      const failure = failureFor('token');
      if (failure) return refuse(failure);
      if (body.appId !== appId || body.clientSecret !== secret)
        return answer(401, { code: 100016, message: 'invalid appid or secret' });
      const now = Date.now();
      const expires = tokens.get(current) ?? 0;
      // A new token only within the last 60 s; the old one stays valid until it expires.
      if (!current || expires - now < 60_000) {
        current = randomBytes(24).toString('base64url');
        tokens.set(current, now + tokenTtl * 1000);
      }
      return answer(200, {
        access_token: current,
        expires_in: String(Math.round((tokens.get(current)! - now) / 1000)),
      });
    }
    if (!validToken(request.headers.authorization))
      return answer(401, { code: 11244, message: 'token not exist or expire' });

    const match = /^\/v2\/users\/([^/]+)\/(messages|stream_messages|files)(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    try {
      if (method === 'GET' && url.pathname === '/users/@me') {
        const failure = failureFor('me');
        if (failure) return refuse(failure);
        return answer(200, { id: botId, username: botName, avatar: '' });
      }
      if (method === 'GET' && (url.pathname === '/gateway/bot' || url.pathname === '/gateway')) {
        const failure = failureFor('gateway');
        if (failure) return refuse(failure);
        return answer(200, {
          url: `ws://127.0.0.1:${port}/websocket`,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: limit.remaining,
            reset_after: limit.resetAfterMs,
            max_concurrency: 1,
          },
        });
      }
      if (!match) return answer(404, { code: 404, message: 'not found' });
      const openid = decodeURIComponent(match[1]);
      const kind = match[2];
      if (method === 'DELETE' && kind === 'messages' && match[3]) {
        const failure = failureFor('recall');
        if (failure) return refuse(failure);
        const messageId = decodeURIComponent(match[3]);
        const message = chat(openid).find((item) => item.ids.includes(messageId));
        if (!message) throw new Refusal(40061002, 'invalid msgid');
        if (recallRefused || Date.now() - message.at > recallWindowMs)
          throw new Refusal(40064004, 'recall time limit exceeded');
        message.recalled = true;
        return answer(200, {});
      }
      if (method !== 'POST' || match[3]) return answer(404, { code: 404, message: 'not found' });
      const failure = failureFor(kind);
      if (failure) return refuse(failure);
      if (!friends.has(openid)) throw new Refusal(40054004, 'not friends');
      if (kind === 'files') {
        const bytes = Buffer.from(String(body.file_data ?? ''), 'base64');
        if (Number(body.file_type) !== 1) throw new Refusal(850019, 'unsupported file type');
        if (!bytes.length || bytes.length > 5 * 1024 * 1024)
          throw new Refusal(850031, 'file exceeds size limit');
        const info = 'FILEINFO_' + randomBytes(8).toString('hex');
        files.set(info, bytes);
        return answer(200, { file_uuid: id('file_'), file_info: info, ttl: 3600 });
      }
      if (kind === 'stream_messages') return answer(200, streamMessage(openid, body));
      return answer(200, sendMessage(openid, body));
    } catch (error) {
      if (error instanceof Refusal)
        return answer(error.status, { code: error.code, message: error.message });
      return answer(500, { code: 500, message: 'internal error' });
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => send(response, 500, { code: 500, message: 'error' }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://mock').pathname !== '/websocket') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const client: Client = { ws, session: null, hello: true };
      clients.add(client);
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatMs } }));
      ws.on('close', () => {
        clients.delete(client);
        if (client.session?.socket === ws) client.session.socket = null;
      });
      ws.on('message', (raw) => {
        let payload: { op?: number; d?: Record<string, unknown> };
        try {
          payload = JSON.parse(String(raw)) as typeof payload;
        } catch {
          ws.close(4002, 'invalid payload');
          return;
        }
        const data = payload.d ?? {};
        if (payload.op === 1) {
          mock.heartbeats += 1;
          if (!ackWithheld) ws.send(JSON.stringify({ op: 11 }));
          return;
        }
        if (payload.op === 2) {
          if (!validToken(String(data.token ?? ''))) return void ws.close(4004, 'invalid token');
          const intents = Number(data.intents ?? 0);
          if (options.c2c === false && intents & (1 << 25))
            return void ws.close(4014, 'disallowed intents');
          if (limit.remaining <= 0) return void ws.close(4006, 'session start limit');
          limit = { ...limit, remaining: limit.remaining - 1 };
          mock.identifies += 1;
          const session: Session = { id: id('session_'), seq: 0, events: [], socket: ws };
          sessions.set(session.id, session);
          if (live?.socket && live.socket !== ws) live.socket.close(4009, 'session replaced');
          live = session;
          client.session = session;
          session.seq += 1;
          ws.send(
            JSON.stringify({
              op: 0,
              s: session.seq,
              t: 'READY',
              d: {
                version: 1,
                session_id: session.id,
                user: { id: botId, username: botName, bot: true },
                shard: [0, 1],
              },
            }),
          );
          return;
        }
        if (payload.op === 6) {
          if (!validToken(String(data.token ?? ''))) return void ws.close(4004, 'invalid token');
          const session = sessions.get(String(data.session_id ?? ''));
          if (!session) return void ws.send(JSON.stringify({ op: 9, d: false }));
          mock.resumes += 1;
          if (session.socket && session.socket !== ws)
            session.socket.close(4009, 'resumed elsewhere');
          session.socket = ws;
          client.session = session;
          live = session;
          const after = Number(data.seq ?? 0);
          for (const event of session.events)
            if (event.s > after) ws.send(JSON.stringify(event.payload));
          session.seq += 1;
          ws.send(JSON.stringify({ op: 0, s: session.seq, t: 'RESUMED', d: '' }));
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const socketsNow = () => [...clients].map((client) => client.ws);

  const mock: MockQq = {
    origin: `http://127.0.0.1:${port}`,
    appId,
    get secret() {
      return secret;
    },
    botId,
    botName,
    calls,
    streams: (openid) => [...(streamCalls.get(openid) ?? [])],
    messages: (openid) => [...chat(openid)],
    userSends(openid, text, extra = {}) {
      friends.add(openid);
      const messageId = id('ROBOT1.0_');
      const msgIdx = refIdx();
      inbound.set(messageId, { openid, at: Date.now(), replies: 0, seqs: new Set() });
      push('C2C_MESSAGE_CREATE', {
        id: messageId,
        author: { id: openid, user_openid: openid, union_openid: '' },
        content: (extra.lead ?? '') + text,
        timestamp: new Date(extra.at ?? Date.now()).toISOString(),
        message_type: extra.quote ? 103 : 0,
        message_scene: {
          source: 'default',
          ext: [`msg_idx=${msgIdx}`, ...(extra.quote ? [`ref_msg_idx=${extra.quote}`] : [])],
        },
      });
      return messageId;
    },
    dispatch: (type, data) => push(type, data),
    rejectOn(openid) {
      activeRefused.add(openid);
      push('C2C_MSG_REJECT', { openid, timestamp: Math.floor(Date.now() / 1000) });
    },
    receiveOn(openid) {
      activeRefused.delete(openid);
      const eventId = `C2C_MSG_RECEIVE:${id('')}`;
      inbound.set(eventId, { openid, at: Date.now(), replies: 0, seqs: new Set() });
      return push('C2C_MSG_RECEIVE', { openid, timestamp: Math.floor(Date.now() / 1000) }, eventId);
    },
    friendAdd(openid) {
      friends.add(openid);
      const eventId = `FRIEND_ADD:${id('')}`;
      inbound.set(eventId, { openid, at: Date.now(), replies: 0, seqs: new Set() });
      return push('FRIEND_ADD', { openid, timestamp: Math.floor(Date.now() / 1000) }, eventId);
    },
    unfriend: (openid) => void friends.delete(openid),
    rejectActive: (openid) => void activeRefused.add(openid),
    allowActive: (openid) => void activeRefused.delete(openid),
    limitActive(on) {
      activeLimited = on;
    },
    failNext(path, failure, times = 1) {
      const list = failures.get(path) ?? [];
      for (let index = 0; index < times; index++) list.push(failure);
      failures.set(path, list);
    },
    clearFailures: () => failures.clear(),
    refuseContent: (substring) => void refused.push(substring),
    refuseRecall(on) {
      recallRefused = on;
    },
    drop() {
      for (const ws of socketsNow()) ws.terminate();
    },
    close(code) {
      for (const ws of socketsNow()) ws.close(code, 'closed by the mock');
    },
    withholdAck(on) {
      ackWithheld = on;
    },
    reconnect() {
      for (const ws of socketsNow()) ws.send(JSON.stringify({ op: 7 }));
    },
    invalidSession(resumable) {
      if (!resumable && live) {
        sessions.delete(live.id);
        live = null;
      }
      for (const ws of socketsNow()) ws.send(JSON.stringify({ op: 9, d: resumable }));
    },
    setSessionLimit(remaining, resetAfterMs) {
      limit = { remaining, resetAfterMs };
    },
    resetSecret() {
      secret = randomBytes(16).toString('hex');
      tokens.clear();
      current = '';
      return secret;
    },
    identifies: 0,
    resumes: 0,
    heartbeats: 0,
    get sockets() {
      return clients.size;
    },
    async waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 8000): Promise<T> {
      const started = Date.now();
      for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() - started > timeoutMs) throw new Error('mock QQ: timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async shutdown() {
      for (const ws of socketsNow()) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return mock;
}

import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An in-process stand-in for WeChat ClawBot's iLink Bot API (Tencent/openclaw-weixin,
 * docs/protocol.md), for end to end tests of `yomi relay --channel wechat --experimental`. It
 * speaks the documented wire format: JSON POSTs under `/ilink/bot/…` with `Authorization: Bearer
 * <bot_token>`, `AuthorizationType: ilink_bot_token`, the `iLink-App-*` headers and `base_info`;
 * errors in the body (`ret`, `errcode`, `errmsg`), -14 for a stale login. The QR login is driven by
 * the test (scan, digits on the phone, redirect, expiry, confirm with a new bot id); `getupdates`
 * is a long poll with an opaque cursor; `sendmessage` takes only a `context_token` it issued, to
 * that person, within `windowMs`; uploads are decrypted (AES-128-ECB, PKCS#7) and checked against
 * what `getuploadurl` announced. What the server would answer for an expired context is not
 * documented: this mock answers `ret: -2`. One WeChat account may link several ClawBots: each
 * confirmed scan of a new bot id is another ClawBot with its own `bot_token`, `getupdates` stream,
 * cursor and `context_token`s (a token works only for the ClawBot that issued it), and logging one
 * in again replaces only its own token. A scan of a ClawBot this computer already holds (its token
 * in the code's `local_token_list`) answers `binded_redirect`, which names no bot. It listens on
 * 127.0.0.1 only; nothing reaches the network.
 */

type Json = Record<string, unknown>;

export type MockWechatOptions = {
  /** How long an empty getupdates is held (and the `longpolling_timeout_ms` it reports). */
  longPollMs?: number;
  /** How long an unchanged get_qrcode_status is held. */
  qrPollMs?: number;
  /** How long a `context_token` may be answered. */
  windowMs?: number;
  /** Bot messages per `context_token` at most (unlimited by default). */
  maxPerContext?: number;
  /** getuploadurl names only `upload_param` (the client builds the CDN URL), not a full URL. */
  uploadParamOnly?: boolean;
  /**
   * `message_id`s as iLink sends them: uint64 values beyond 2^53, written as bare JSON numbers
   * (consecutive ids round to one JS number unless the client reads them exactly).
   */
  bigIds?: boolean;
};

/** One request, as the test sees it (the bearer token is never kept, only whether it was valid). */
export type MockWechatCall = {
  endpoint: string;
  /** The Host header: which origin was asked (the login host or a redirect). */
  host: string;
  headers: Record<string, string>;
  /** The JSON body (CDN uploads: `{ bytes }`), GET: the query. */
  body: Json;
  /** Authorization carried a token this mock issued. */
  authorized: boolean;
  at: number;
};

/** A message the bot sent. */
export type MockWechatSent = {
  /** The ClawBot (`ilink_bot_id`) that sent it. */
  bot: string;
  client_id: string;
  to_user_id: string;
  context_token: string;
  /** The text item's text, null for a picture. */
  text: string | null;
  /** The decrypted picture, null for text. */
  image: Buffer | null;
  /** The image item's `mid_size`. */
  midSize: number | null;
  at: number;
};

export type MockWechatUpload = {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
  /** The ciphertext's length as POSTed to the CDN (0 until then). */
  received: number;
  plain: Buffer | null;
};

export type MockWechat = {
  /** `http://127.0.0.1:<port>`: the login host, the bot's `baseurl` and (under `/c2c`) the CDN. */
  origin: string;
  /** The same server named `localhost:<port>`: a redirect host that is allowed in tests. */
  altHost: string;
  /** The person who scans unless a test names another (an `ilink_user_id`). */
  owner: string;
  /** The bot id of the newest confirmed login (where `userSends` goes by default). */
  botId: string;
  /** The linked ClawBots, oldest first; `live` while their token works. */
  clawBots(): { botId: string; userId: string; live: boolean }[];
  /** Every request in arrival order. */
  calls: MockWechatCall[];
  /** The `qrcode_img_content` of every code issued, oldest first. */
  qrcodes: string[];
  /** The `local_token_list` of each get_bot_qrcode. */
  localTokens: string[][];
  // The QR flow, step by step (each answers the next get_qrcode_status poll).
  scan(userId?: string): void;
  /** The phone shows `digits`: `need_verifycode` until a poll carries them. */
  askPin(digits: string): void;
  /**
   * The phone confirms: ClawBot `botId` (by default `mock.botId`) is logged in for `userId` with a
   * new token, which replaces only that ClawBot's old one; a new `botId` links another ClawBot.
   * When `botId` names a ClawBot of `userId` whose token is in this code's `local_token_list`, the
   * answer is `binded_redirect` instead (no new token). Without `botId` that ClawBot always gets a
   * new token.
   */
  confirm(options?: { userId?: string; botId?: string; baseurl?: string }): void;
  /** `scaned_but_redirect` to `host` (a bare host, as the server names it). */
  redirectTo(host: string): void;
  expireQr(): void;
  verifyBlocked(): void;
  bindedRedirect(): void;
  /** A status this mock does not otherwise send (e.g. a real-name request). */
  status(value: string): void;
  // Chat.
  /**
   * A message from `from` (the owner by default) to ClawBot `bot` (by default `mock.botId`);
   * returns its `message_id` (with `bigIds`, the wire id is 7300000000000000000 more).
   * `messageType: null` leaves the field out; `token` reuses a `context_token`.
   */
  userSends(
    text: string,
    options?: {
      from?: string;
      bot?: string;
      at?: number;
      group?: string;
      items?: Json[];
      messageType?: number | null;
      token?: string;
    },
  ): number;
  /** The `context_token` the mock gave the message `userSends` returned the id of. */
  contextOf(messageId: number): string;
  /**
   * The next getupdates (of `bot`, or of any ClawBot) answers its previous batch again (same
   * message ids), then goes on.
   */
  replayNextBatch(bot?: string): void;
  /** The next `times` getupdates (of `bot`, or of any ClawBot) answer -14. */
  expireSession(times: number, bot?: string): void;
  /**
   * Every later call with the token of `bot` (or of any ClawBot) answers HTTP 401 until that
   * ClawBot's next confirm.
   */
  revokeTokens(bot?: string): void;
  /** The next call of `endpoint` ('sendmessage', 'cdn', …) gets this answer. */
  failNext(endpoint: string, answer: { status?: number; body?: Json }): void;
  /** What the ClawBots (or only `bot`) sent to `userId` (the owner by default), oldest first. */
  messages(userId?: string, bot?: string): MockWechatSent[];
  texts(userId?: string, bot?: string): string[];
  /** Typing calls: status 1 typing, 2 stopped; `bot` is the ClawBot that called. */
  typing(): { user: string; status: number; at: number; bot: string }[];
  uploads: MockWechatUpload[];
  /** Polls `check` every 10 ms until it returns something other than undefined/null/false. */
  waitFor<T>(check: () => T | undefined | null | false, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
};

const STALE = -14;
/** Added to the ids of `bigIds`: past 2^62, where doubles are 1024 apart. */
const BIG_ID_BASE = 7_300_000_000_000_000_000n;

type Waiter = () => void;
/** A `context_token`: issued by ClawBot `bot` for a message from `user`. */
type Context = { user: string; bot: string; issuedAt: number; sent: number };
type Inbox = { seq: number; message: Json };
/** A ClawBot: its token ('' when none works), its messages and its long poll. */
type ClawBot = {
  id: string;
  user: string;
  token: string;
  linked: boolean;
  inbox: Inbox[];
  /** The latest batch getupdates gave and the cursor it ended at (for replayNextBatch). */
  lastBatch: Json[];
  lastCursor: number;
  replay: boolean;
  expiring: number;
  waiters: Waiter[];
};
type QrEvent = Json & { status: string };

export async function startMockWechat(options: MockWechatOptions = {}): Promise<MockWechat> {
  const longPollMs = options.longPollMs ?? 400;
  const qrPollMs = options.qrPollMs ?? 150;
  const windowMs = options.windowMs ?? 24 * 3_600_000;
  const maxPerContext = options.maxPerContext ?? Infinity;

  const calls: MockWechatCall[] = [];
  const qrcodes: string[] = [];
  const localTokens: string[][] = [];
  const sent: MockWechatSent[] = [];
  const typing: { user: string; status: number; at: number; bot: string }[] = [];
  const uploads: MockWechatUpload[] = [];
  /** Every ClawBot by id, in the order they were linked (or first written to). */
  const clawBots = new Map<string, ClawBot>();
  /** The working tokens and their ClawBots. */
  const tokens = new Map<string, ClawBot>();
  const contexts = new Map<string, Context>();
  const tickets = new Map<string, { user: string; bot: string }>();
  const byParam = new Map<string, MockWechatUpload>();
  const downloads = new Map<string, MockWechatUpload>();
  const failures = new Map<string, { status?: number; body?: Json }>();
  const tokenOf = new Map<number, string>();
  /** replayNextBatch / expireSession without a bot: the next getupdates of any ClawBot. */
  let replayAny = false;
  let expiringAny = 0;
  /** One sequence for every ClawBot, so no cursor ever hides a newer message. */
  let seq = 0;
  let messageId = 7_000_000;
  let qrWaiters: Waiter[] = [];
  /** The code being scanned, its `local_token_list`, and what its next polls answer. */
  let current = '';
  let currentTokens: string[] = [];
  let qrEvents: QrEvent[] = [];
  let pin = '';
  const owner = 'o9cq8_owner@im.wechat';
  let botId = 'b1f2_bot@im.bot';

  const clawBot = (id: string) => {
    let bot = clawBots.get(id);
    if (!bot) {
      bot = {
        id,
        user: '',
        token: '',
        linked: false,
        inbox: [],
        lastBatch: [],
        lastCursor: 0,
        replay: false,
        expiring: 0,
        waiters: [],
      };
      clawBots.set(id, bot);
    }
    return bot;
  };
  /** The ClawBot's token stops working. */
  const revoke = (bot: ClawBot) => {
    tokens.delete(bot.token);
    bot.token = '';
  };

  const wake = (waiters: Waiter[]) => {
    for (const waiter of waiters) waiter();
  };
  const pushQr = (event: QrEvent) => {
    qrEvents.push(event);
    const waiters = qrWaiters;
    qrWaiters = [];
    wake(waiters);
  };
  const hex = (bytes = 8) => randomBytes(bytes).toString('hex');

  /** Waits for `ready()` or `ms`, or the client going away; true when ready. */
  const hold = (
    response: ServerResponse,
    ms: number,
    ready: () => boolean,
    list: () => Waiter[],
    set: (waiters: Waiter[]) => void,
  ) =>
    new Promise<boolean>((resolve) => {
      if (ready()) return resolve(true);
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set(list().filter((waiter) => waiter !== wakeUp));
        resolve(value);
      };
      const wakeUp = () => finish(ready());
      const timer = setTimeout(() => finish(ready()), ms);
      set([...list(), wakeUp]);
      // The response closes before it is written only when the client went away.
      response.once('close', () => finish(false));
    });

  const ok = (body: Json = {}) => ({ ret: 0, ...body });
  const refuse = (ret: number, errmsg: string) => ({ ret, errcode: ret, errmsg });

  /** The endpoints a bot token opens, each for the ClawBot the token belongs to. */
  const routes: Record<
    string,
    (body: Json, response: ServerResponse, bot: ClawBot) => Promise<Json> | Json
  > = {
    getupdates: async (body, response, bot) => {
      if (bot.expiring > 0 || expiringAny > 0) {
        if (bot.expiring > 0) bot.expiring -= 1;
        else expiringAny -= 1;
        return refuse(STALE, 'session timeout');
      }
      if (bot.replay || replayAny) {
        if (bot.replay) bot.replay = false;
        else replayAny = false;
        return ok({
          msgs: bot.lastBatch,
          get_updates_buf: cursorOf(bot.lastCursor),
          longpolling_timeout_ms: longPollMs,
        });
      }
      const after = readCursor(body.get_updates_buf);
      const fresh = () => bot.inbox.some((item) => item.seq > after);
      await hold(
        response,
        longPollMs,
        fresh,
        () => bot.waiters,
        (waiters) => {
          bot.waiters = waiters;
        },
      );
      const batch = bot.inbox.filter((item) => item.seq > after);
      const last = batch.at(-1)?.seq ?? Math.max(after, 0);
      if (batch.length) {
        bot.lastBatch = batch.map((item) => item.message);
        bot.lastCursor = last;
      }
      return ok({
        msgs: batch.map((item) => item.message),
        get_updates_buf: cursorOf(last),
        longpolling_timeout_ms: longPollMs,
      });
    },
    sendmessage: (body, _response, bot) => {
      const msg = (body.msg ?? {}) as Json;
      const token = String(msg.context_token ?? '');
      const to = String(msg.to_user_id ?? '');
      const context = contexts.get(token);
      if (
        !context ||
        context.user !== to ||
        context.bot !== bot.id ||
        Date.now() - context.issuedAt >= windowMs ||
        context.sent >= maxPerContext
      )
        return refuse(-2, 'context token invalid or expired');
      if (msg.message_type !== 2 || msg.message_state !== 2 || msg.from_user_id !== '')
        return refuse(-1, 'bad message');
      if (typeof msg.client_id !== 'string' || !msg.client_id) return refuse(-1, 'no client_id');
      const items = Array.isArray(msg.item_list) ? (msg.item_list as Json[]) : [];
      if (items.length !== 1) return refuse(-1, 'one item per message');
      const item = items[0];
      let text: string | null = null;
      let image: Buffer | null = null;
      let midSize: number | null = null;
      if (item.type === 1) {
        text = String((item.text_item as Json | undefined)?.text ?? '');
      } else if (item.type === 2) {
        const imageItem = (item.image_item ?? {}) as Json;
        const media = (imageItem.media ?? {}) as Json;
        const upload = downloads.get(String(media.encrypt_query_param ?? ''));
        if (!upload || !upload.plain) return refuse(-1, 'unknown media');
        // aes_key: base64 of the key's 32 hex characters, as the plugin writes it.
        const key = Buffer.from(String(media.aes_key ?? ''), 'base64').toString('utf8');
        if (key !== upload.aeskey || media.encrypt_type !== 1) return refuse(-1, 'bad media key');
        midSize = Number(imageItem.mid_size);
        if (midSize !== upload.filesize) return refuse(-1, 'mid_size is not the ciphertext size');
        image = upload.plain;
      } else return refuse(-1, 'unsupported item');
      context.sent += 1;
      sent.push({
        bot: bot.id,
        client_id: msg.client_id,
        to_user_id: to,
        context_token: token,
        text,
        image,
        midSize,
        at: Date.now(),
      });
      return ok();
    },
    getconfig: (body, _response, bot) => {
      const user = String(body.ilink_user_id ?? '');
      if (!user) return refuse(-1, 'no user');
      const ticket = 'tk_' + hex();
      tickets.set(ticket, { user, bot: bot.id });
      return ok({ typing_ticket: ticket });
    },
    sendtyping: (body, _response, bot) => {
      const user = String(body.ilink_user_id ?? '');
      const ticket = tickets.get(String(body.typing_ticket ?? ''));
      if (ticket?.user !== user || ticket.bot !== bot.id) return refuse(-1, 'bad typing ticket');
      typing.push({ user, status: Number(body.status), at: Date.now(), bot: bot.id });
      return ok();
    },
    getuploadurl: (body) => {
      const upload: MockWechatUpload = {
        filekey: String(body.filekey ?? ''),
        media_type: Number(body.media_type),
        to_user_id: String(body.to_user_id ?? ''),
        rawsize: Number(body.rawsize),
        rawfilemd5: String(body.rawfilemd5 ?? ''),
        filesize: Number(body.filesize),
        no_need_thumb: body.no_need_thumb === true,
        aeskey: String(body.aeskey ?? ''),
        received: 0,
        plain: null,
      };
      if (!/^[0-9a-f]{32}$/.test(upload.filekey) || !/^[0-9a-f]{32}$/.test(upload.aeskey))
        return refuse(-1, 'bad filekey or aeskey');
      uploads.push(upload);
      const param = 'up_' + hex();
      byParam.set(param, upload);
      if (options.uploadParamOnly) return ok({ upload_param: param });
      return ok({
        upload_full_url: `${origin}/c2c/upload?encrypted_query_param=${param}&filekey=${upload.filekey}`,
      });
    },
    'msg/notifystart': () => ok(),
    'msg/notifystop': () => ok(),
  };

  const handleQrcode = (body: Json) => {
    const list = Array.isArray(body.local_token_list) ? (body.local_token_list as string[]) : [];
    localTokens.push(list);
    currentTokens = list;
    current = 'qr_' + hex();
    qrEvents = [];
    pin = '';
    const image = `https://liteapp.weixin.qq.com/q/${hex(4)}?qrcode=${current}&bot_type=3`;
    qrcodes.push(image);
    return ok({ qrcode: current, qrcode_img_content: image });
  };

  const handleStatus = async (url: URL, response: ServerResponse): Promise<Json> => {
    const qrcode = url.searchParams.get('qrcode') ?? '';
    if (qrcode !== current) return ok({ status: 'expired' });
    const digits = url.searchParams.get('verify_code');
    if (digits !== null && pin) {
      if (digits === pin) {
        pin = '';
        return ok({ status: 'scaned' });
      }
      return ok({ status: 'need_verifycode' });
    }
    await hold(
      response,
      qrPollMs,
      () => qrEvents.length > 0,
      () => qrWaiters,
      (waiters) => {
        qrWaiters = waiters;
      },
    );
    const event = qrEvents.shift();
    if (!event) return ok({ status: pin ? 'need_verifycode' : 'wait' });
    return ok(event);
  };

  const handleCdn = async (url: URL, bytes: Buffer, request: IncomingMessage) => {
    const upload = byParam.get(url.searchParams.get('encrypted_query_param') ?? '');
    if (!upload || url.searchParams.get('filekey') !== upload.filekey)
      return { status: 400, error: 'unknown upload' };
    if (request.headers['content-type'] !== 'application/octet-stream')
      return { status: 400, error: 'content type' };
    upload.received = bytes.length;
    if (bytes.length !== upload.filesize) return { status: 400, error: 'filesize mismatch' };
    let plain: Buffer;
    try {
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
      plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
    } catch {
      return { status: 400, error: 'decrypt failed' };
    }
    if (
      plain.length !== upload.rawsize ||
      createHash('md5').update(plain).digest('hex') !== upload.rawfilemd5
    )
      return { status: 400, error: 'plaintext mismatch' };
    upload.plain = plain;
    const param = 'dl_' + hex();
    downloads.set(param, upload);
    return { status: 200, param };
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://mock');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === 'string' && name !== 'authorization') headers[name] = value;
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const holder = tokens.get(bearer);
    const authorized = holder !== undefined;
    const send = (status: number, body: Json, extra: Record<string, string> = {}) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json', ...extra });
      const text = JSON.stringify(body);
      // uint64 ids as bare numbers, the way JSON.stringify cannot write them.
      response.end(
        options.bigIds ? text.replace(/"message_id":"([0-9]+)"/g, '"message_id":$1') : text,
      );
    };
    const record = (endpoint: string, body: Json) =>
      calls.push({
        endpoint,
        host: request.headers.host ?? '',
        headers,
        body,
        authorized,
        at: Date.now(),
      });

    if (url.pathname === '/c2c/upload' && request.method === 'POST') {
      record('cdn', { bytes: bytes.length });
      const failure = failures.get('cdn');
      if (failure) {
        failures.delete('cdn');
        response.writeHead(failure.status ?? 500, { 'x-error-message': 'mock failure' });
        return void response.end();
      }
      const result = await handleCdn(url, bytes, request);
      if (result.status !== 200) {
        response.writeHead(result.status, { 'x-error-message': result.error ?? '' });
        return void response.end();
      }
      response.writeHead(200, { 'x-encrypted-param': result.param ?? '' });
      return void response.end();
    }
    if (!url.pathname.startsWith('/ilink/bot/')) return send(404, refuse(-1, 'not found'));
    const endpoint = url.pathname.slice('/ilink/bot/'.length);
    if (request.method === 'GET' && endpoint === 'get_qrcode_status') {
      record(endpoint, Object.fromEntries(url.searchParams));
      return send(200, await handleStatus(url, response));
    }
    if (request.method !== 'POST') return send(405, refuse(-1, 'method'));
    let body: Json;
    try {
      body = JSON.parse(bytes.toString('utf8') || '{}') as Json;
    } catch {
      return send(400, refuse(-1, 'bad json'));
    }
    record(endpoint, body);
    if (endpoint === 'get_bot_qrcode') {
      if (url.searchParams.get('bot_type') !== '3') return send(400, refuse(-1, 'bot_type'));
      return send(200, handleQrcode(body));
    }
    const route = routes[endpoint];
    if (!route) return send(404, refuse(-1, 'not found'));
    const failure = failures.get(endpoint);
    if (failure) {
      failures.delete(endpoint);
      return send(failure.status ?? 200, failure.body ?? refuse(-1, 'mock failure'));
    }
    if (!holder || request.headers.authorizationtype !== 'ilink_bot_token')
      return send(401, refuse(-1, 'unauthorized'));
    send(200, await route(body, response, holder));
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  const sentTo = (userId: string, bot?: string) =>
    sent.filter((message) => message.to_user_id === userId && (!bot || message.bot === bot));

  const mock: MockWechat = {
    origin,
    altHost: `localhost:${port}`,
    owner,
    get botId() {
      return botId;
    },
    clawBots: () =>
      [...clawBots.values()]
        .filter((bot) => bot.linked)
        .map((bot) => ({ botId: bot.id, userId: bot.user, live: bot.token !== '' })),
    calls,
    qrcodes,
    localTokens,
    uploads,
    scan: () => pushQr({ status: 'scaned' }),
    askPin: (digits) => {
      pin = digits;
      pushQr({ status: 'need_verifycode' });
    },
    confirm: (confirmation = {}) => {
      const user = confirmation.userId ?? owner;
      const named = confirmation.botId ? clawBots.get(confirmation.botId) : undefined;
      // A ClawBot this computer already holds: WeChat says so, without naming it.
      if (named?.token && named.user === user && currentTokens.includes(named.token))
        return pushQr({ status: 'binded_redirect' });
      if (confirmation.botId) botId = confirmation.botId;
      const bot = clawBot(botId);
      revoke(bot);
      bot.token = 'tok_' + hex(16);
      bot.user = user;
      bot.linked = true;
      tokens.set(bot.token, bot);
      pushQr({
        status: 'confirmed',
        bot_token: bot.token,
        ilink_bot_id: bot.id,
        baseurl: confirmation.baseurl ?? origin,
        ilink_user_id: user,
      });
    },
    redirectTo: (host) => pushQr({ status: 'scaned_but_redirect', redirect_host: host }),
    expireQr: () => pushQr({ status: 'expired' }),
    verifyBlocked: () => pushQr({ status: 'verify_code_blocked' }),
    bindedRedirect: () => pushQr({ status: 'binded_redirect' }),
    status: (value) => pushQr({ status: value }),
    userSends: (text, sendOptions = {}) => {
      seq += 1;
      messageId += 1;
      const bot = clawBot(sendOptions.bot ?? botId);
      const token = sendOptions.token ?? 'ctx_' + hex(12);
      const from = sendOptions.from ?? owner;
      const at = sendOptions.at ?? Date.now();
      contexts.set(token, { user: from, bot: bot.id, issuedAt: at, sent: 0 });
      tokenOf.set(messageId, token);
      bot.inbox.push({
        seq,
        message: {
          seq,
          message_id: options.bigIds ? String(BIG_ID_BASE + BigInt(messageId)) : messageId,
          from_user_id: from,
          to_user_id: bot.id,
          create_time_ms: at,
          ...(sendOptions.messageType === null
            ? {}
            : { message_type: sendOptions.messageType ?? 1 }),
          message_state: 2,
          context_token: token,
          ...(sendOptions.group ? { group_id: sendOptions.group } : {}),
          item_list: sendOptions.items ?? [{ type: 1, text_item: { text } }],
        },
      });
      const waiters = bot.waiters;
      bot.waiters = [];
      wake(waiters);
      return messageId;
    },
    contextOf: (id) => tokenOf.get(id) ?? '',
    replayNextBatch: (bot) => {
      if (bot) clawBot(bot).replay = true;
      else replayAny = true;
    },
    expireSession: (times, bot) => {
      if (bot) clawBot(bot).expiring = times;
      else expiringAny = times;
    },
    revokeTokens: (bot) => {
      for (const each of bot ? [clawBot(bot)] : clawBots.values()) revoke(each);
    },
    failNext: (endpoint, answer) => failures.set(endpoint, answer),
    messages: (userId = owner, bot) => sentTo(userId, bot),
    texts: (userId = owner, bot) =>
      sentTo(userId, bot)
        .filter((message) => message.text !== null)
        .map((message) => message.text as string),
    typing: () => typing,
    async waitFor(check, timeoutMs = 8000) {
      const started = Date.now();
      for (;;) {
        const value = check();
        if (value !== undefined && value !== null && value !== false) return value;
        if (Date.now() - started > timeoutMs) throw new Error('mock wechat: timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: async () => {
      for (const bot of clawBots.values()) {
        wake(bot.waiters);
        bot.waiters = [];
      }
      wake(qrWaiters);
      qrWaiters = [];
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return mock;
}

/** The opaque cursor: base64 of the last sequence number handed out. */
function cursorOf(seq: number): string {
  return Buffer.from(`c${seq}`, 'utf8').toString('base64');
}

function readCursor(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const match = /^c([0-9]+)$/.exec(Buffer.from(value, 'base64').toString('utf8'));
  return match ? Number(match[1]) : 0;
}

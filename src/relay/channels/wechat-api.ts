import { randomBytes } from 'node:crypto';

import { tr } from '../../core/i18n.js';
import { redact } from '../../core/redact.js';
import { VERSION } from '../../core/version.js';
import { ChannelError, type ChannelErrorReason } from './types.js';

/**
 * WeChat ClawBot's iLink Bot API, as Tencent's MIT-licensed plugin documents and speaks it
 * (github.com/Tencent/openclaw-weixin, docs/protocol.md, plugin 2.4.10): JSON POSTs over HTTPS
 * with the bot token as a bearer, a QR login, `getupdates` long polling with an opaque cursor,
 * `sendmessage` answering an inbound `context_token`, typing tickets, and AES-128-ECB uploads to
 * the CDN. Errors come in the body (`ret`, `errcode`), so every call checks both; -14 means the
 * login went stale.
 *
 * Every host taken from a response (`baseurl`, `redirect_host`, `upload_full_url`) is accepted
 * only as https on a qq.com host, so a response can never send the bot token or a QR code
 * elsewhere; `YOMI_WECHAT_API_ORIGIN` points at a loopback mock in tests, and only then are
 * loopback hosts accepted. No URL, token, context token, ticket or key ever reaches an error or a
 * log line: errors carry the endpoint, iLink's code and its (redacted) message.
 */

/** The login host; bot calls go to the `baseurl` the login returned. */
export const WECHAT_API = 'https://ilinkai.weixin.qq.com';
/** Where uploads go when the server names no full URL. */
export const WECHAT_CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
/**
 * The plugin version whose protocol this implements: `channel_version` leads with it (the server
 * reads the first three numbers) and `iLink-App-ClientVersion` encodes it.
 */
export const WECHAT_PROTOCOL_VERSION = '2.4.10';
/** iLink's code for a stale bot token (the plugin pauses the account for an hour). */
export const STALE_TOKEN = -14;

/** `0x00MMNNPP` of the protocol version as a decimal string: 2.4.10 → "132106". */
export function clientVersion(version = WECHAT_PROTOCOL_VERSION): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number(part) || 0);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

/**
 * What every bot call says about its client: the protocol version first (another host's version
 * goes in the suffix, as the protocol asks), and this CLI as `Name/Version` (a bare name would be
 * dropped and reported as OpenClaw).
 */
export const baseInfo = () => ({
  channel_version: `${WECHAT_PROTOCOL_VERSION}/yomi-cli-${VERSION}`,
  bot_agent: `yomi-cli/${VERSION}`,
});

/** Base64 of a random uint32 in decimal, fresh per request. */
export const wechatUin = () =>
  Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * The login origin: iLink's, or (tests) a loopback http(s) origin from `YOMI_WECHAT_API_ORIGIN`.
 * Anything else is refused, so a setting can never send the bot token elsewhere.
 */
export function wechatOrigin(value: string | undefined): string {
  if (!value) return WECHAT_API;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    url = new URL('invalid://');
  }
  if (url.origin === WECHAT_API) return WECHAT_API;
  if (!LOOPBACK.includes(url.hostname) || (url.protocol !== 'http:' && url.protocol !== 'https:'))
    throw new Error(
      tr(
        '微信 iLink 地址只能是 https://ilinkai.weixin.qq.com 或本机测试地址',
        'The WeChat iLink address can only be https://ilinkai.weixin.qq.com or a local test address',
        'La dirección de WeChat iLink solo puede ser https://ilinkai.weixin.qq.com o una dirección de prueba local',
        'O endereço do WeChat iLink só pode ser https://ilinkai.weixin.qq.com ou um endereço de teste local',
      ),
    );
  return url.origin;
}

/** True when `origin` is a loopback test origin (then loopback hosts in responses are accepted). */
export const isLoopbackOrigin = (origin: string) => LOOPBACK.includes(new URL(origin).hostname);

/** A host or URL from a response that is not one this client may talk to. */
export class UntrustedHost extends Error {
  constructor(readonly field: string) {
    super(
      tr(
        `微信返回的 ${field} 不是微信的地址，已停止（凭证没有发出）`,
        `WeChat returned a ${field} that is not a WeChat address; stopped (no credentials were sent)`,
        `WeChat devolvió un ${field} que no es una dirección de WeChat; se detuvo (no se enviaron credenciales)`,
        `O WeChat retornou um ${field} que não é um endereço do WeChat; parado (nenhuma credencial foi enviada)`,
      ),
    );
    this.name = 'UntrustedHost';
  }
}

/**
 * A URL the server named (`baseurl`, `upload_full_url`) or a host (`redirect_host`, written
 * `https://<host>`): https on qq.com (iLink is ilinkai.weixin.qq.com, the CDN
 * novac2c.cdn.weixin.qq.com), or loopback when testing against a loopback mock. Returns the URL
 * as given (a bare host as its origin); throws `UntrustedHost` naming the field.
 */
export function trustedUrl(value: unknown, field: string, loopback: boolean): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new UntrustedHost(field);
  let url: URL;
  try {
    // A bare host (redirect_host, sometimes baseurl): https, or http on a loopback mock.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) url = new URL(text);
    else {
      const host = new URL(`https://${text}`);
      url = loopback && LOOPBACK.includes(host.hostname) ? new URL(`http://${text}`) : host;
    }
  } catch {
    throw new UntrustedHost(field);
  }
  const host = url.hostname.toLowerCase();
  const local = loopback && LOOPBACK.includes(host) && /^https?:$/.test(url.protocol);
  const tencent = url.protocol === 'https:' && (host === 'qq.com' || host.endsWith('.qq.com'));
  if ((!local && !tencent) || url.username || url.password) throw new UntrustedHost(field);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? url.toString() : url.origin;
}

// --- Errors -------------------------------------------------------------------------------------

function reasonOf(status: number, code: number): ChannelErrorReason {
  if (code === STALE_TOKEN) return 'expired';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rateLimited';
  if (status === 0 || status >= 500) return 'transient';
  return 'other';
}

/** A failed iLink call: the endpoint, iLink's `ret`/`errcode` (or the HTTP status), its message. */
export class WechatError extends ChannelError {
  constructor(
    endpoint: string,
    /** iLink's non-zero `errcode` or `ret`; else the HTTP status; 0 for the network. */
    code: number,
    description: string,
    /** The HTTP status (200 when iLink refused in the body), 0 for the network. */
    readonly status: number,
  ) {
    super('wechat', endpoint, code, redact(description).slice(0, 200), reasonOf(status, code));
    this.name = 'WechatError';
  }

  /** -14: the bot token is stale (the login ended or is paused). */
  get sessionExpired(): boolean {
    return this.code === STALE_TOKEN;
  }

  /** HTTP 401/403: the token is refused outright. */
  get refused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

// --- Wire types ---------------------------------------------------------------------------------

export type WechatItem = {
  type?: number;
  text_item?: { text?: string };
  image_item?: Record<string, unknown>;
};

/** One `msgs` entry of getupdates (fields the relay reads). */
export type WechatMessage = {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  /** 1 user, 2 bot. */
  message_type?: number;
  /** 0 new, 1 generating, 2 finished. */
  message_state?: number;
  item_list?: WechatItem[];
  context_token?: string;
};

export type WechatUpdates = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};

export type WechatOutgoing = {
  to_user_id: string;
  client_id: string;
  context_token: string;
  item_list: WechatItem[];
};

export type UploadUrl = { upload_full_url?: string; upload_param?: string };

export type QrCode = { qrcode: string; qrcode_img_content: string };

export type QrStatus = {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
  /** The poll itself failed (network, timeout, 5xx): counted as `wait`. */
  failed?: boolean;
};

type Json = Record<string, unknown>;

/** The default getupdates hold; the server may name another (`longpolling_timeout_ms`). */
export const LONG_POLL_MS = 35_000;
/** The longest hold believed from the server, so a dead connection is noticed within minutes. */
export const LONG_POLL_MAX_MS = 120_000;
/** How much longer than the server's hold the client waits before calling a poll empty. */
const LONG_POLL_SLACK_MS = 15_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
/** get_qrcode_status holds about 35 s. */
const QR_POLL_TIMEOUT_MS = 45_000;

type CallOptions = { signal?: AbortSignal; timeoutMs: number };

/** Ends when the timeout passes or `signal` aborts; `timedOut` tells which. */
function deadline(options: CallOptions) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    done() {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** iLink's uint64 ids: past 2^53 a JS number would round two messages to one id. */
const ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);
const ID_VALUE = /^\s*:\s*(-?[0-9]+)(?![0-9.eE])/;

/**
 * JSON.parse that keeps iLink's uint64 ids (`message_id`, `msg_id`, `svr_id`) exact, as strings,
 * the way the plugin reads `getupdates`: rounded, two different messages could share an id and the
 * second be dropped as a replay. Only object keys are followed by ':', so text inside a string value
 * is never touched.
 */
export function parseIlinkJson(text: string): unknown {
  const parts: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const start = index + 1;
    index = start;
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    const key = text.slice(start, index);
    index += 1;
    if (!ID_FIELDS.has(key)) continue;
    const match = ID_VALUE.exec(text.slice(index, index + 80));
    if (!match) continue;
    const digits = index + match[0].length - match[1].length;
    parts.push(text.slice(copied, digits), `"${match[1]}"`);
    index = digits + match[1].length;
    copied = index;
  }
  parts.push(text.slice(copied));
  return JSON.parse(parts.join(''));
}

/** -14 in either `ret` or `errcode` (the plugin checks both). */
export function isStaleToken(answer: { ret?: unknown; errcode?: unknown }): boolean {
  return answer.ret === STALE_TOKEN || answer.errcode === STALE_TOKEN;
}

/** What iLink calls an error in a body: a non-zero `ret` or `errcode`. */
function bodyError(endpoint: string, body: Json): WechatError | null {
  const ret = typeof body.ret === 'number' ? body.ret : 0;
  const errcode = typeof body.errcode === 'number' ? body.errcode : 0;
  if (!ret && !errcode) return null;
  const message = typeof body.errmsg === 'string' ? body.errmsg : '';
  return new WechatError(endpoint, isStaleToken(body) ? STALE_TOKEN : errcode || ret, message, 200);
}

/** Headers every iLink call carries; `token` only on bot calls. */
function headers(token: string | null, json: boolean): Record<string, string> {
  const result: Record<string, string> = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': clientVersion(),
  };
  if (json) {
    result['Content-Type'] = 'application/json';
    result.AuthorizationType = 'ilink_bot_token';
    result['X-WECHAT-UIN'] = wechatUin();
  }
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function readJson(endpoint: string, response: Response): Promise<Json> {
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as Json;
      if (typeof parsed.errmsg === 'string') message = parsed.errmsg;
    } catch {
      // Not JSON: the text itself (cut and redacted by WechatError).
    }
    throw new WechatError(endpoint, response.status, message, response.status);
  }
  try {
    const parsed = parseIlinkJson(text);
    if (parsed && typeof parsed === 'object') return parsed as Json;
  } catch {
    // below
  }
  throw new WechatError(endpoint, response.status, 'not JSON', response.status);
}

/** A network failure or timeout as a WechatError (code 0, transient). */
function networkError(endpoint: string, error: unknown, timedOut: boolean): WechatError {
  const message = timedOut ? 'timeout' : error instanceof Error ? error.name : 'network';
  return new WechatError(endpoint, 0, message, 0);
}

// --- The login (no token) -----------------------------------------------------------------------

/** The QR login's two calls, on the login origin and then on whatever host the server redirects to. */
export class WechatLoginApi {
  constructor(
    /** `wechatOrigin(...)`: iLink's login host or a loopback mock. */
    readonly origin: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** `get_bot_qrcode?bot_type=3` with the tokens this computer holds (so a re-scan can be known). */
  async qrCode(localTokens: string[], signal?: AbortSignal): Promise<QrCode> {
    const endpoint = 'get_bot_qrcode';
    const timer = deadline({ signal, timeoutMs: API_TIMEOUT_MS });
    try {
      const response = await this.fetcher(`${this.origin}/ilink/bot/get_bot_qrcode?bot_type=3`, {
        method: 'POST',
        headers: headers(null, true),
        body: JSON.stringify({ local_token_list: localTokens }),
        signal: timer.signal,
      });
      const body = await readJson(endpoint, response);
      const failure = bodyError(endpoint, body);
      if (failure) throw failure;
      if (typeof body.qrcode !== 'string' || typeof body.qrcode_img_content !== 'string')
        throw new WechatError(endpoint, 0, 'no QR code in the answer', 200);
      return { qrcode: body.qrcode, qrcode_img_content: body.qrcode_img_content };
    } catch (error) {
      if (error instanceof WechatError) throw error;
      throw networkError(endpoint, error, timer.timedOut);
    } finally {
      timer.done();
    }
  }

  /**
   * `get_qrcode_status` on `origin` (iLink's, or the redirect host's): a long poll of about 35 s.
   * Any failure of the request (timeout, network, an HTTP error, a refusal in the body) is `wait`,
   * as the protocol says the client treats it; `failed` makes the caller pause before the next.
   */
  async qrStatus(
    origin: string,
    qrcode: string,
    verifyCode: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<QrStatus> {
    const endpoint = 'get_qrcode_status';
    const query = `qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`;
    const timer = deadline({
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? QR_POLL_TIMEOUT_MS,
    });
    try {
      const response = await this.fetcher(`${origin}/ilink/bot/get_qrcode_status?${query}`, {
        method: 'GET',
        headers: headers(null, false),
        signal: timer.signal,
      });
      const body = await readJson(endpoint, response);
      const failure = bodyError(endpoint, body);
      if (failure) throw failure;
      const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');
      return {
        status: text('status') || 'wait',
        bot_token: text('bot_token'),
        ilink_bot_id: text('ilink_bot_id'),
        baseurl: text('baseurl'),
        ilink_user_id: text('ilink_user_id'),
        redirect_host: text('redirect_host'),
      };
    } catch {
      return { status: 'wait', failed: !timer.timedOut };
    } finally {
      timer.done();
    }
  }
}

// --- The bot ------------------------------------------------------------------------------------

export type WechatApiOptions = {
  /** The `baseurl` of the login, already checked with `trustedUrl`. */
  baseUrl: string;
  botToken: string;
  /** Where uploads go without a full URL: WECHAT_CDN, or `<mock>/c2c` in tests. */
  cdnBaseUrl: string;
  /** Loopback hosts are accepted in responses (testing against a loopback mock). */
  loopback: boolean;
  fetch?: typeof fetch;
};

export class WechatApi {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: WechatApiOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  get loopback(): boolean {
    return this.options.loopback;
  }

  /** A bot call: POST JSON with `base_info`; a non-zero `ret`/`errcode` throws. */
  private async post(endpoint: string, path: string, body: Json, options: CallOptions) {
    const timer = deadline(options);
    try {
      const response = await this.fetcher(`${this.baseUrl}/ilink/bot/${path}`, {
        method: 'POST',
        headers: headers(this.options.botToken, true),
        body: JSON.stringify({ ...body, base_info: baseInfo() }),
        signal: timer.signal,
      });
      const json = await readJson(endpoint, response);
      const failure = bodyError(endpoint, json);
      if (failure) throw failure;
      return json;
    } catch (error) {
      if (error instanceof WechatError) throw error;
      throw networkError(endpoint, error, timer.timedOut);
    } finally {
      timer.done();
    }
  }

  /**
   * One long poll with the cursor. The server holds it `longpolling_timeout_ms` (35 s unless it
   * said otherwise); a client timeout is an empty batch, not an error. -14 and other refusals
   * come back as the body (`ret`/`errcode`) for the caller to judge; HTTP and network failures
   * throw.
   */
  async getUpdates(cursor: string, holdMs: number, signal: AbortSignal): Promise<WechatUpdates> {
    const endpoint = 'getupdates';
    const timer = deadline({ signal, timeoutMs: holdMs + LONG_POLL_SLACK_MS });
    try {
      const response = await this.fetcher(`${this.baseUrl}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: headers(this.options.botToken, true),
        body: JSON.stringify({ get_updates_buf: cursor, base_info: baseInfo() }),
        signal: timer.signal,
      });
      return (await readJson(endpoint, response)) as WechatUpdates;
    } catch (error) {
      if (error instanceof WechatError) throw error;
      if (timer.timedOut || signal.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor };
      throw networkError(endpoint, error, false);
    } finally {
      timer.done();
    }
  }

  async sendMessage(message: WechatOutgoing, signal?: AbortSignal): Promise<void> {
    await this.post(
      'sendmessage',
      'sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: message.to_user_id,
          client_id: message.client_id,
          message_type: 2,
          message_state: 2,
          context_token: message.context_token,
          item_list: message.item_list,
        },
      },
      { signal, timeoutMs: API_TIMEOUT_MS },
    );
  }

  /** The typing ticket for this person (and their message), when iLink gives one. */
  async getConfig(userId: string, contextToken: string, signal?: AbortSignal): Promise<string> {
    const body = await this.post(
      'getconfig',
      'getconfig',
      { ilink_user_id: userId, ...(contextToken ? { context_token: contextToken } : {}) },
      { signal, timeoutMs: CONFIG_TIMEOUT_MS },
    );
    return typeof body.typing_ticket === 'string' ? body.typing_ticket : '';
  }

  /**
   * `status` 1: typing; 2: stopped. Only the HTTP status counts: the protocol says the client
   * neither parses this answer nor checks a code in it, so an empty body is not a failure.
   */
  async sendTyping(userId: string, ticket: string, status: 1 | 2, signal?: AbortSignal) {
    const endpoint = 'sendtyping';
    const timer = deadline({ signal, timeoutMs: CONFIG_TIMEOUT_MS });
    try {
      const response = await this.fetcher(`${this.baseUrl}/ilink/bot/sendtyping`, {
        method: 'POST',
        headers: headers(this.options.botToken, true),
        body: JSON.stringify({
          ilink_user_id: userId,
          typing_ticket: ticket,
          status,
          base_info: baseInfo(),
        }),
        signal: timer.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new WechatError(endpoint, response.status, text, response.status);
    } catch (error) {
      if (error instanceof WechatError) throw error;
      throw networkError(endpoint, error, timer.timedOut);
    } finally {
      timer.done();
    }
  }

  async getUploadUrl(request: Json, signal?: AbortSignal): Promise<UploadUrl> {
    const body = await this.post('getuploadurl', 'getuploadurl', request, {
      signal,
      timeoutMs: API_TIMEOUT_MS,
    });
    return {
      upload_full_url: typeof body.upload_full_url === 'string' ? body.upload_full_url : '',
      upload_param: typeof body.upload_param === 'string' ? body.upload_param : '',
    };
  }

  /**
   * Where the encrypted file goes: `upload_full_url` (checked like any host from a response), else
   * the plugin's own construction, `<cdn>/upload?encrypted_query_param=<upload_param>&filekey=…`.
   */
  uploadUrl(answer: UploadUrl, filekey: string): string {
    if (answer.upload_full_url?.trim())
      return trustedUrl(answer.upload_full_url, 'upload_full_url', this.options.loopback);
    if (!answer.upload_param)
      throw new WechatError('getuploadurl', 0, 'no upload URL in the answer', 200);
    return `${this.options.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(answer.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  }

  /**
   * POSTs the ciphertext; the answer's `x-encrypted-param` is what the image message names. A 4xx
   * fails at once; anything else is tried up to three times in all.
   */
  async uploadToCdn(url: string, ciphertext: Buffer, signal?: AbortSignal): Promise<string> {
    const endpoint = 'cdn upload';
    let last: WechatError | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const timer = deadline({ signal, timeoutMs: API_TIMEOUT_MS * 2 });
      try {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: timer.signal,
        });
        const message = response.headers.get('x-error-message') ?? '';
        if (response.status >= 400 && response.status < 500) {
          await response.arrayBuffer().catch(() => undefined);
          throw new WechatError(endpoint, response.status, message, response.status);
        }
        await response.arrayBuffer().catch(() => undefined);
        const param = response.headers.get('x-encrypted-param') ?? '';
        if (response.status === 200 && param) return param;
        last = new WechatError(
          endpoint,
          response.status,
          message || 'no x-encrypted-param',
          response.status,
        );
      } catch (error) {
        if (error instanceof WechatError && error.status >= 400 && error.status < 500) throw error;
        last = error instanceof WechatError ? error : networkError(endpoint, error, timer.timedOut);
        if (signal?.aborted) break;
      } finally {
        timer.done();
      }
    }
    throw last ?? new WechatError(endpoint, 0, 'upload failed', 0);
  }

  async notifyStart(signal?: AbortSignal): Promise<void> {
    await this.post('notifystart', 'msg/notifystart', {}, { signal, timeoutMs: CONFIG_TIMEOUT_MS });
  }

  async notifyStop(signal?: AbortSignal): Promise<void> {
    await this.post('notifystop', 'msg/notifystop', {}, { signal, timeoutMs: CONFIG_TIMEOUT_MS });
  }
}

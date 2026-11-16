import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Credential, CredentialStore } from './credentials.js';
import { APP_ID, currentLanguage, deviceMetadata } from './device.js';
import type { Environment } from './env.js';
import { configDir } from './files.js';
import { encodeBody, type Json, object, parseGatewayJson } from './json.js';
import { withFileLock } from './lock.js';
import { redact } from './redact.js';

/**
 * Signed Gateway requests, as the Yomi clients make them: the common query, `x-sign` (SHA-1 of
 * the sorted query, body, timestamp and salt), `X-Token`, `Lane`, and one refresh-and-retry on a
 * stale token. The CLI's own session lives in the credential store and is updated there on
 * refresh.
 */

/** A refusal from the Gateway (`base_resp.status_code` ≠ 0) or a failed request. */
export class ApiError extends Error {
  constructor(
    /** The business code, `401` for a refused token, `-1` for transport failures. */
    public readonly code: number,
    message: string,
    /** The whole response, for refusals that carry more than `base_resp`. */
    public readonly body: Json | null = null,
    public readonly path = '',
    /** The HTTP status when the answer was not 200 (0 when there was no answer). */
    public readonly httpStatus = 0,
  ) {
    super(message || `Gateway error ${code}`);
    this.name = 'ApiError';
  }
  /** The account has to sign in (again). */
  get needsSignIn() {
    return this.code === ApiError.unauthorized || this.code === ApiError.refreshExpired;
  }
  static readonly unauthorized = 401;
  // Account codes, as the app knows them.
  static readonly refreshExpired = 1101010111;
  static readonly authExpired = 1101010121;
  static readonly transport = -1;
}

/**
 * The refresh token itself was refused (expired, revoked, signed out elsewhere): the session is
 * over and only `yomi login` helps. Anything else (network, 5xx, other codes) is transient.
 */
export function sessionEnded(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === ApiError.refreshExpired || error.code === ApiError.unauthorized)
  );
}

export class NotSignedIn extends Error {
  constructor(message = '还没有登录，先运行 yomi login') {
    super(message);
    this.name = 'NotSignedIn';
  }
}

export type RequestOptions = {
  signal?: AbortSignal;
  method?: 'POST' | 'GET';
  query?: Record<string, string>;
  /** False: a body without `base_resp` is the answer itself. */
  requiresBaseResponse?: boolean;
  timeoutMs?: number;
  /** Public routes (sign-in, refresh) go without `X-Token`. */
  anonymous?: boolean;
};

// Same canonical string the gateway checks and the Yomi clients sign; it is in the web's public
// JavaScript too.
const SALT = '417b472b';

export type GatewayOptions = {
  env: Environment;
  idfv: string;
  store?: CredentialStore;
  account?: string;
  credential?: Credential | null;
  fetch?: typeof fetch;
  debug?: (line: string) => void;
  now?: () => number;
  /** Lock file serialising refreshes across processes (`refreshLockPath`). */
  lockPath?: string;
  /** Appended to the User-Agent (e.g. `relay-telegram`), so the server can tell clients apart. */
  client?: string;
  /** Overrides the common query's `channel` (default `cli`). */
  channel?: string;
};

/** Where the refresh lock for `account` lives. */
export function refreshLockPath(account: string, dir = configDir()): string {
  const name = createHash('sha256').update(account).digest('hex').slice(0, 16);
  return join(dir, 'locks', `refresh-${name}.lock`);
}

export class Gateway {
  readonly env: Environment;
  private credentialValue: Credential | null;
  private refreshing: Promise<void> | null = null;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: GatewayOptions) {
    this.env = options.env;
    this.credentialValue = options.credential ?? null;
    this.fetcher = options.fetch ?? fetch;
  }

  get credential(): Credential | null {
    return this.credentialValue;
  }

  /** Uses `credential` for the following requests (after sign-in), without saving it. */
  useCredential(credential: Credential | null) {
    this.credentialValue = credential;
  }

  requireCredential(): Credential {
    if (!this.credentialValue) throw new NotSignedIn();
    return this.credentialValue;
  }

  private debug(line: string) {
    this.options.debug?.(redact(line));
  }

  /** The device metadata with this client's channel and User-Agent suffix. */
  private metadata() {
    const metadata = deviceMetadata(this.options.idfv);
    if (this.options.channel) metadata.channel = this.options.channel;
    if (this.options.client)
      metadata.os_version = `${metadata.os_version} ${this.options.client}`.slice(0, 160);
    return metadata;
  }

  /** The common query for this session, sorted as the signature wants it. */
  commonQuery(now: number, extra: Record<string, string> = {}): [string, string][] {
    const credential = this.credentialValue;
    const parameters: Record<string, string> = {
      ...extra,
      ...this.metadata(),
      sys_language: currentLanguage(),
      app_id: String(APP_ID),
      user_id: credential?.userId ?? '0',
      device_id: credential?.deviceId ?? '0',
      client_sys_ts: String(now),
    };
    return Object.entries(parameters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The request as the Gateway expects it. Exported for tests. */
  buildRequest(path: string, body: unknown, options: RequestOptions = {}) {
    const now = this.options.now?.() ?? Date.now();
    const method = options.method ?? 'POST';
    const items = this.commonQuery(now, options.query);
    const payload = method === 'GET' ? '' : encodeBody(body ?? {});
    const timestamp = String(now);
    const canonical =
      items.map(([key, value]) => key + '=' + value).join('&') +
      payload +
      'x-timestamp=' +
      timestamp +
      'salt=' +
      SALT;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-timestamp': timestamp,
      'x-sign': createHash('sha1').update(canonical).digest('hex'),
      'User-Agent': this.metadata().os_version,
    };
    const credential = this.credentialValue;
    if (credential?.authToken && !options.anonymous) headers['X-Token'] = credential.authToken;
    if (this.env.lane) headers.Lane = this.env.lane;
    const route = path.startsWith('/') ? path : '/ember/api/v1/' + path;
    const query = new URLSearchParams(items).toString();
    return {
      url: this.env.apiOrigin + route + '?' + query,
      init: {
        method,
        headers,
        body: method === 'GET' ? undefined : payload,
        redirect: 'error' as const,
      },
    };
  }

  private async send(path: string, body: unknown, options: RequestOptions): Promise<Json> {
    const { url, init } = this.buildRequest(path, body, options);
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 20_000);
    let response: Response;
    let raw: string;
    const started = Date.now();
    try {
      response = await this.fetcher(url, { ...init, signal: controller.signal });
      raw = await response.text();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      this.debug(`${init.method} ${path} → transport error ${String(error)}`);
      throw new ApiError(ApiError.transport, '网络请求失败', null, path);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
    this.debug(`${init.method} ${path} → HTTP ${response.status} (${Date.now() - started} ms)`);
    let result: Json | null = null;
    try {
      result = raw ? object(parseGatewayJson(raw)) : null;
    } catch {
      result = null;
    }
    if (!response.ok) {
      if (result) readBase(result, false, path, response.status);
      if (response.status === 401)
        throw new ApiError(ApiError.unauthorized, '', result, path, response.status);
      throw new ApiError(
        ApiError.transport,
        `HTTP ${response.status}`,
        result,
        path,
        response.status,
      );
    }
    if (!result) throw new ApiError(ApiError.transport, '回包不是 JSON', null, path);
    readBase(result, options.requiresBaseResponse ?? true, path);
    return result;
  }

  /**
   * Trades the refresh token for a new pair once, however many requests found the token stale.
   * Across processes (a running `yomi relay` and a `yomi create`) the trade happens under a lock
   * file, and a pair another process stored meanwhile is adopted instead of trading again. Only a
   * refused session (`sessionEnded`) signs the CLI out, and only if the store still holds the pair
   * that was refused; a network or server failure keeps the credential.
   */
  refresh(): Promise<void> {
    const current = this.credentialValue;
    if (!current) return Promise.reject(new NotSignedIn());
    this.refreshing ??= this.refreshOnce(current).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshOnce(current: Credential): Promise<void> {
    if (this.adoptStored(current)) return;
    const { lockPath } = this.options;
    if (lockPath) await withFileLock(lockPath, () => this.trade(current));
    else await this.trade(current);
  }

  /** True when the store holds a newer pair for the same account, now in use. */
  /** Adopts a pair of the same account that is newer than ours (another process refreshed). */
  private adoptStored(current: Credential): boolean {
    const { store, account } = this.options;
    const stored = store && account ? store.get(account) : null;
    if (
      !stored ||
      stored.userId !== current.userId ||
      stored.authToken === current.authToken ||
      // An older pair (ours could not be saved) is never taken back.
      stored.refreshedAt < current.refreshedAt
    )
      return false;
    this.credentialValue = stored;
    return true;
  }

  private async trade(current: Credential): Promise<void> {
    if (this.adoptStored(current)) return;
    const { store, account } = this.options;
    let result: Json;
    try {
      result = await this.send(
        'account/refresh_auth_token',
        { refresh_token: current.refreshToken },
        { anonymous: true },
      );
    } catch (error) {
      if (!sessionEnded(error)) throw error;
      // Someone may have refreshed (or signed in again) while this request was out.
      if (this.adoptStored(current)) return;
      this.credentialValue = null;
      const stored = store && account ? store.get(account) : null;
      if (store && account && (!stored || stored.refreshToken === current.refreshToken))
        store.delete(account);
      throw new NotSignedIn('登录已失效，请重新运行 yomi login');
    }
    const data = object(result.data ?? result);
    const authToken = data.auth_token;
    const refreshToken = data.refresh_token;
    if (typeof authToken !== 'string' || typeof refreshToken !== 'string' || !authToken)
      throw new ApiError(
        ApiError.transport,
        '刷新会话的回包缺少令牌',
        null,
        'account/refresh_auth_token',
      );
    const next = { ...current, authToken, refreshToken, refreshedAt: Date.now() };
    this.credentialValue = next;
    if (!store || !account) return;
    const stored = store.get(account);
    if (!stored) {
      // `yomi logout` emptied the store while this refresh was out: stay signed out.
      this.credentialValue = null;
      throw new NotSignedIn('已退出登录，请重新运行 yomi login');
    }
    // Written back only over the pair this refresh started from: never over another account's
    // or a newer `yomi login`.
    if (stored.userId !== current.userId || stored.refreshToken !== current.refreshToken) return;
    try {
      store.set(account, next);
    } catch (error) {
      // The new pair still works in this process; the store keeps the one it had.
      this.debug(`保存刷新后的会话失败：${error instanceof Error ? error.message : 'error'}`);
    }
  }

  /**
   * Picks up what the store holds now (another process refreshed, or `yomi login` / `logout` ran):
   * `same` when nothing changed, `updated` for a newer pair of the same account, `signedOut` when
   * the store is empty, `otherAccount` when a different account signed in (not adopted).
   */
  reloadCredential(): 'same' | 'updated' | 'signedOut' | 'otherAccount' {
    const { store, account } = this.options;
    if (!store || !account) return 'same';
    const stored = store.get(account);
    const current = this.credentialValue;
    if (!stored) {
      if (!current) return 'same';
      this.credentialValue = null;
      return 'signedOut';
    }
    if (current && stored.userId !== current.userId) return 'otherAccount';
    if (
      current &&
      stored.authToken === current.authToken &&
      stored.refreshToken === current.refreshToken
    )
      return 'same';
    this.credentialValue = stored;
    return 'updated';
  }

  /**
   * Calls a Gateway route (`path` relative to `/ember/api/v1/`, or absolute) and returns the whole
   * response object, `base_resp` checked. A stale token is refreshed and the call retried once.
   */
  async request(path: string, body: unknown = {}, options: RequestOptions = {}): Promise<Json> {
    try {
      return await this.send(path, body, options);
    } catch (error) {
      const stale =
        error instanceof ApiError &&
        !options.anonymous &&
        (error.code === ApiError.unauthorized || error.code === ApiError.authExpired) &&
        this.credentialValue;
      if (!stale) throw error;
      await this.refresh();
      return this.send(path, body, options);
    }
  }

  /** `request` returning `data` (most responses wrap their answer in it). */
  async requestData(path: string, body: unknown = {}, options: RequestOptions = {}) {
    const result = await this.request(path, body, options);
    return result.data === undefined ? result : object(result.data);
  }

  /**
   * The long connection's address, as the Yomi web client builds it: the common query, the user
   * and device, and the refresh token as `token`, as the server's protocol wants it. Never printed
   * or logged.
   */
  connectionURL(): string {
    const credential = this.requireCredential();
    const parameters: Record<string, string> = {
      ...this.metadata(),
      sys_language: currentLanguage(),
      app_id: String(APP_ID),
      user_id: credential.userId,
      device_id: credential.deviceId,
      token: credential.refreshToken,
    };
    const query = new URLSearchParams(
      Object.entries(parameters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toString();
    return this.env.apiOrigin.replace(/^http/, 'ws') + '/connection/ws?' + query;
  }

  /** Headers for the long connection (`Lane`). */
  connectionHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.metadata().os_version,
    };
    if (this.env.lane) headers.Lane = this.env.lane;
    return headers;
  }
}

function readBase(result: Json, required: boolean, path: string, httpStatus = 0) {
  const base = result.base_resp;
  if (base === undefined && !required) return;
  const { status_code: code, status_msg: message } = object(base ?? {});
  const status = typeof code === 'number' ? code : 0;
  if (status !== 0)
    throw new ApiError(
      status,
      typeof message === 'string' && message ? message : '',
      result,
      path,
      httpStatus,
    );
}

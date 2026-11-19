import { tr } from '../../core/i18n.js';
import { redact } from '../../core/redact.js';
import { ChannelError, type ChannelErrorReason } from './types.js';

/**
 * The QQ bot OpenAPI as the relay uses it (https://bot.q.qq.com/wiki/develop/api-v2/): an access
 * token from the AppID and AppSecret, kept in memory only and fetched again shortly before it
 * expires, and the REST calls of a private (C2C) chat: send, stream, upload, recall, the bot's
 * identity and the gateway address. Every failure is a `QqError` (a `ChannelError`) whose reason
 * says how the channel handles it (design §9.3). Nothing here prints or logs the AppSecret or a
 * token: an error carries the path template, QQ's code and its message (redacted, 200 characters).
 */

/** Token endpoint and REST, one origin since 2026-08-10 (QQ's changelog). */
export const QQ_API = 'https://api.bot.qq.com';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

export const isLoopback = (url: URL) => LOOPBACK.includes(url.hostname);

/**
 * QQ's API, or a loopback mock (`YOMI_QQ_API_ORIGIN`, tests only): a setting can never send the
 * AppSecret anywhere else.
 */
export function qqApiOrigin(value: string | undefined): string {
  if (!value) return QQ_API;
  const url = new URL(value);
  if (url.origin === QQ_API) return QQ_API;
  if (!isLoopback(url) || (url.protocol !== 'http:' && url.protocol !== 'https:'))
    throw new Error(
      tr(
        'QQ API 地址只能是 https://api.bot.qq.com 或本机测试地址',
        'The QQ API address can only be https://api.bot.qq.com or a local test address',
        'La dirección de la API de QQ solo puede ser https://api.bot.qq.com o una dirección de prueba local',
        'O endereço da API do QQ só pode ser https://api.bot.qq.com ou um endereço de teste local',
      ),
    );
  return url.origin;
}

/**
 * The gateway address `/gateway/bot` gave: `wss:` on a host under qq.com, or a loopback socket
 * when the API itself is a loopback mock. Anything else is refused (the token would go there).
 */
export function qqGatewayUrl(value: string, apiOrigin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw gatewayRefused();
  }
  const host = url.hostname;
  if (url.protocol === 'wss:' && (host === 'qq.com' || host.endsWith('.qq.com'))) return url.href;
  if (isLoopback(new URL(apiOrigin)) && isLoopback(url) && /^wss?:$/.test(url.protocol))
    return url.href;
  throw gatewayRefused();
}

function gatewayRefused() {
  return new QqError(
    'GET /gateway/bot',
    0,
    tr(
      'QQ 返回的网关地址不是 qq.com 下的 wss 地址，已拒绝连接',
      'The gateway address QQ returned is not a wss address under qq.com; not connecting',
      'La dirección del gateway que devolvió QQ no es una dirección wss de qq.com; no se conecta',
      'O endereço do gateway retornado pelo QQ não é um endereço wss do qq.com; sem conexão',
    ),
    0,
  );
}

/** Codes the channel acts on (official error tables of the send, stream and recall pages). */
export const QQ_CODE = {
  notFriends: 40054004,
  friendCheck: 40054006,
  botOffline: 40054016,
  contentRefused: 40034006,
  activeLimit: 40034100,
  duplicate: 40054005,
  replaceChanged: 40007,
  streamLimit: 50002,
  typeMismatch: 22006,
  recallTooLate: 40064004,
} as const;

/** The passive reply context is used up or expired (msg_id or event_id). */
export const CONTEXT_CODES = new Set([
  40034128, 40034005, 304103, 40034024, 40034025, 40034026, 40034027,
]);
/** Active messages refused by the person (their "allow active messages" switch, or blocked). */
export const ACTIVE_OFF_CODES = new Set([40034105, 40054013]);
/** Markdown that QQ refused, or a type that does not match the content. */
export const MARKDOWN_CODES = new Set([
  40034008, 40034009, 40034010, 40034011, 40034124, 40034127, 22006,
]);
/** Too long (or malformed) text. */
export const TOO_LONG_CODES = new Set([40054007, 40054018]);

/** How the relay handles a QQ code (design §9.3); HTTP status for errors without one. */
export function qqReason(code: number, status: number): ChannelErrorReason {
  if (status === 401) return 'unauthorized';
  if (code === QQ_CODE.notFriends) return 'blocked';
  if (code === QQ_CODE.contentRefused) return 'contentRefused';
  if (code === QQ_CODE.activeLimit || code === QQ_CODE.streamLimit) return 'rateLimited';
  if (CONTEXT_CODES.has(code)) return 'expired';
  if (MARKDOWN_CODES.has(code) || TOO_LONG_CODES.has(code)) return 'rejected';
  // 40034004: rich media transfer failed, "please retry" (the send page's error table).
  if (
    code === QQ_CODE.friendCheck ||
    code === QQ_CODE.botOffline ||
    code === 50055002 ||
    code === 50001 ||
    code === 40034004
  )
    return 'transient';
  // No answer (network, timeout), or a server failure without a code of its own.
  if (status === 0 || status >= 500 || status === 429) return 'transient';
  return 'other';
}

/** A refused or failed QQ call. `status` is the HTTP status (0: no answer). */
export class QqError extends ChannelError {
  constructor(
    operation: string,
    code: number,
    description: string,
    readonly status: number,
    reason: ChannelErrorReason = qqReason(code, status),
  ) {
    super(
      'qq',
      operation,
      code,
      redact(description).slice(0, 200),
      reason,
      code === QQ_CODE.activeLimit ? 600_000 : code === QQ_CODE.streamLimit ? 1000 : 0,
    );
    this.name = 'QqError';
  }
}

/** QQ's code of an error, 0 when it is not a QQ error. */
export const codeOf = (error: unknown): number =>
  error instanceof QqError && typeof error.code === 'number' ? error.code : 0;

const networkFailure = () =>
  tr(
    '网络请求失败',
    'Network request failed',
    'Falló la solicitud de red',
    'Falha na solicitação de rede',
  );
const timedOut = () =>
  tr(
    '请求超时',
    'Request timed out',
    'Se agotó el tiempo de espera de la solicitud',
    'A solicitação excedeu o tempo limite',
  );

type Fetch = typeof fetch;

/** A POST/GET with a deadline; a network failure or timeout is a transient QqError. */
async function timedFetch(
  fetcher: Fetch,
  operation: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        body = { message: raw.slice(0, 200) };
      }
    }
    return { status: response.status, body };
  } catch (error) {
    throw new QqError(
      operation,
      0,
      error instanceof Error && error.name === 'AbortError' ? timedOut() : networkFailure(),
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** QQ's error code in a body: `code`, else `err_code`; 0 when it carries none. */
function bodyCode(body: Record<string, unknown>): number {
  const value = body.code ?? body.err_code;
  const code = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(code) ? code : 0;
}

export type QqTokenOptions = {
  appId: string;
  secret: string;
  origin: string;
  fetch?: Fetch;
  now?: () => number;
};

/**
 * The access token (`POST /app/getAppAccessToken`, `{ appId, clientSecret }` →
 * `{ access_token, expires_in }`, `expires_in` sometimes a string). Asked again when less than
 * 60 s are left: QQ hands out a new one only then, and the old one stays valid for those 60 s.
 * One request at a time; in memory only.
 */
export class QqTokens {
  private token = '';
  private expiresAt = 0;
  private pending: Promise<string> | null = null;
  private readonly fetcher: Fetch;
  private readonly now: () => number;

  constructor(private readonly options: QqTokenOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get appId(): string {
    return this.options.appId;
  }

  async get(): Promise<string> {
    if (this.token && this.expiresAt - this.now() >= 60_000) return this.token;
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** The token was refused (401, gateway 4004): the next get() asks for a new one. */
  invalidate(): void {
    this.token = '';
    this.expiresAt = 0;
  }

  private async fetchToken(): Promise<string> {
    const operation = 'POST /app/getAppAccessToken';
    const { status, body } = await timedFetch(
      this.fetcher,
      operation,
      `${this.options.origin}/app/getAppAccessToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.options.appId, clientSecret: this.options.secret }),
      },
      30_000,
    );
    const token = typeof body.access_token === 'string' ? body.access_token : '';
    const seconds = Number(body.expires_in);
    if (status === 200 && token && Number.isFinite(seconds) && seconds > 0) {
      this.token = token;
      this.expiresAt = this.now() + seconds * 1000;
      return token;
    }
    const code = bodyCode(body);
    const said = typeof body.message === 'string' ? body.message : `HTTP ${status}`;
    // QQ's own words, minus the AppSecret should they ever repeat it (redact() knows field names,
    // not a bare value).
    const secret = this.options.secret;
    const message = secret ? said.split(secret).join('***') : said;
    // A refusal names the AppID or AppSecret; a server failure may pass.
    throw new QqError(
      operation,
      code,
      message,
      status,
      status >= 500 || status === 429 ? 'transient' : 'unauthorized',
    );
  }
}

export type QqSent = { id: string; timestamp?: string; ext_info?: { ref_idx?: string } };
export type QqStreamSent = QqSent & { remain_msg_len?: number };
export type QqUploaded = { file_uuid?: string; file_info: string; ttl?: number };
export type QqGatewayBot = {
  url: string;
  shards?: number;
  session_start_limit?: {
    total?: number;
    remaining?: number;
    reset_after?: number;
    max_concurrency?: number;
  };
};
export type QqMe = { id?: string; username?: string; avatar?: string };

/** Paths with `{openid}` and `{message_id}`: the operation names its template, never an id. */
const PATHS = {
  me: '/users/@me',
  gateway: '/gateway/bot',
  messages: '/v2/users/{openid}/messages',
  stream: '/v2/users/{openid}/stream_messages',
  files: '/v2/users/{openid}/files',
  recall: '/v2/users/{openid}/messages/{message_id}',
} as const;

export class QqApi {
  private readonly fetcher: Fetch;

  constructor(
    readonly tokens: QqTokens,
    readonly origin: string,
    fetcher?: Fetch,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  me(): Promise<QqMe> {
    return this.request<QqMe>('GET', PATHS.me, {});
  }

  gatewayBot(): Promise<QqGatewayBot> {
    return this.request<QqGatewayBot>('GET', PATHS.gateway, {});
  }

  /** A text, markdown, media or input-status message: passive with `msg_id`/`event_id`, else active. */
  send(openid: string, body: Record<string, unknown>): Promise<QqSent> {
    return this.request<QqSent>('POST', PATHS.messages, { openid }, body);
  }

  stream(openid: string, body: Record<string, unknown>): Promise<QqStreamSent> {
    return this.request<QqStreamSent>('POST', PATHS.stream, { openid }, body);
  }

  /** A picture as base64 `file_data` (5 MB at most), not sent yet: its `file_info` is. */
  upload(openid: string, bytes: Buffer, name: string): Promise<QqUploaded> {
    return this.request<QqUploaded>(
      'POST',
      PATHS.files,
      { openid },
      { file_type: 1, file_data: bytes.toString('base64'), srv_send_msg: false, file_name: name },
      60_000,
    );
  }

  async recall(openid: string, messageId: string): Promise<void> {
    await this.request('DELETE', PATHS.recall, { openid, message_id: messageId });
  }

  /**
   * One call with the current token; a 401 asks for a new token and tries once more. A body with
   * a non-zero `code` is an error whatever the HTTP status.
   */
  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    template: string,
    params: Record<string, string>,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    const operation = `${method} ${template}`;
    const path = template.replace(/\{(\w+)\}/g, (_match, name: string) =>
      encodeURIComponent(params[name] ?? ''),
    );
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.get();
      const headers: Record<string, string> = { Authorization: `QQBot ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const answer = await timedFetch(
        this.fetcher,
        operation,
        this.origin + path,
        { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
        timeoutMs,
      );
      const code = bodyCode(answer.body);
      if (answer.status >= 200 && answer.status < 300 && !code) return answer.body as T;
      if (answer.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      const message =
        typeof answer.body.message === 'string' ? answer.body.message : `HTTP ${answer.status}`;
      throw new QqError(operation, code, message, answer.status);
    }
  }
}

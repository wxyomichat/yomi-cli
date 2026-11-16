import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The one-shot callback the web's authorize page posts to (docs/auth-protocol.md):
 * `POST http://127.0.0.1:<port>/callback`, form-encoded, with the `state` the CLI made and either
 * `id_token` (a fresh Firebase ID token of the signed-in account) or `error`.
 *
 * - Listens on 127.0.0.1 only, on a port the system picks; answers loopback peers only, and only
 *   when `Host` names that address and port (DNS rebinding) and `Origin` is the web's origin.
 * - The token comes in the POST body, never a URL: a GET with a query is refused.
 * - `state` is compared in constant time and accepted once; the server closes after the first
 *   valid callback, after too many bad ones, and at the deadline.
 */

export type CallbackResult =
  | { kind: 'token'; idToken: string; email: string; displayName: string }
  | { kind: 'denied'; error: string };

export class CallbackTimeout extends Error {
  constructor() {
    super('等待网页授权超时');
    this.name = 'CallbackTimeout';
  }
}

export class CallbackRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallbackRejected';
  }
}

export type CallbackServer = {
  port: number;
  callbackURL: string;
  result: Promise<CallbackResult>;
  close(): void;
};

const MAX_BODY = 32 * 1024;
const MAX_BAD = 5;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** `XXXX-XXXX` the CLI and the authorize page both show, derived from `state` (SHA-256). */
export function verificationCode(state: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digest = createHash('sha256')
    .update('yomi-cli-auth:' + state)
    .digest();
  let bits = 0n;
  for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let index = 0; index < 8; index++) {
    code += alphabet[Number((bits >> BigInt(35 - index * 5)) & 31n)];
  }
  return code.slice(0, 4) + '-' + code.slice(4);
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A header the caller sent, safe for a terminal: printable ASCII only, cut short. */
function printable(value: string | undefined): string {
  if (value === undefined) return '（未提供）';
  return JSON.stringify(value.slice(0, 80).replace(/[^\x20-\x7e]/g, '?'));
}

function page(title: string, message: string, ok: boolean): string {
  const colour = ok ? '#1f9d55' : '#c53030';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f0f14;color:#eee;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
main{max-width:420px;text-align:center}h1{font-size:22px;color:${colour}}p{color:#bbb}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function reply(response: ServerResponse, status: number, html: string) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    Connection: 'close',
  });
  response.end(html);
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(null));
  });
}

function fields(contentType: string, body: string): Record<string, string> | null {
  if (contentType.startsWith('application/x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(body));
  if (contentType.startsWith('application/json')) {
    try {
      const value = JSON.parse(body) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const result: Record<string, string> = {};
      for (const [key, item] of Object.entries(value))
        if (typeof item === 'string') result[key] = item;
      return result;
    } catch {
      return null;
    }
  }
  return null;
}

export function startCallbackServer(options: {
  state: string;
  /** The web origin the authorize page is served from. */
  expectedOrigin: string;
  timeoutMs: number;
  /** Told why a callback was refused while the wait goes on, so the terminal can say so. */
  onRejected?: (reason: string) => void;
}): Promise<CallbackServer> {
  let settle: { resolve: (r: CallbackResult) => void; reject: (e: Error) => void } | null = null;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Callers await `result`; keep an early rejection from being reported as unhandled.
  result.catch(() => undefined);
  let done = false;
  let bad = 0;
  let port = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const peer = request.socket.remoteAddress ?? '';
    const host = request.headers.host ?? '';
    if (!LOOPBACK.has(peer) || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      reply(response, 403, page('请求被拒绝', '只接受本机发来的授权回调。', false));
      return;
    }
    if (url.pathname !== '/callback') {
      reply(response, 404, page('找不到页面', '这是 Yomi CLI 的本地授权回调。', false));
      return;
    }
    if (request.method !== 'POST' || url.search) {
      reply(response, 405, page('请求被拒绝', '授权信息只能通过网页提交，不能放在地址里。', false));
      return;
    }
    if (done) {
      reply(response, 410, page('授权已完成', '这次授权已经处理过，可以关闭此页。', false));
      return;
    }
    const origin = request.headers.origin;
    const body = await readBody(request);
    const values = body === null ? null : fields(request.headers['content-type'] ?? '', body);
    const state = values?.state ?? '';
    if (origin !== options.expectedOrigin || !values || !sameSecret(state, options.state)) {
      bad += 1;
      options.onRejected?.(
        origin !== options.expectedOrigin
          ? `来源不符：Origin 为 ${printable(origin)}，应为 ${options.expectedOrigin}`
          : !values
            ? '内容格式不对'
            : 'state 与本次登录不符',
      );
      reply(
        response,
        400,
        page('授权请求无效', '请回到终端重新运行 yomi login，再从它打开的页面授权。', false),
      );
      if (bad >= MAX_BAD) finish(new CallbackRejected('收到过多无效的授权回调，已停止等待'));
      return;
    }
    if (values.error) {
      reply(response, 200, page('已取消授权', '终端里的登录已取消，可以关闭此页。', false));
      finish({ kind: 'denied', error: values.error.slice(0, 64) });
      return;
    }
    const idToken = values.id_token ?? '';
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) {
      reply(response, 400, page('授权请求无效', '没有收到有效的登录凭证。', false));
      finish(new CallbackRejected('网页回传的登录凭证格式不正确'));
      return;
    }
    reply(response, 200, page('已授权 Yomi CLI', '可以关闭此页，回到终端继续。', true));
    finish({
      kind: 'token',
      idToken,
      email: (values.email ?? '').slice(0, 320),
      displayName: (values.display_name ?? '').slice(0, 100),
    });
  });

  const timer = setTimeout(() => finish(new CallbackTimeout()), options.timeoutMs);

  function finish(outcome: CallbackResult | Error) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (outcome instanceof Error) settle?.reject(outcome);
    else settle?.resolve(outcome);
    // Let the answer reach the browser, then stop listening.
    setTimeout(() => server.close(), 50).unref();
    server.closeIdleConnections?.();
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        port,
        callbackURL: `http://127.0.0.1:${port}/callback`,
        result,
        close: () => finish(new CallbackRejected('已取消')),
      });
    });
  });
}

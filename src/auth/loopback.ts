import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tr } from '../core/i18n.js';

/**
 * The callback the web's authorize page posts to (docs/auth-protocol.md):
 * `POST http://127.0.0.1:<port>/callback`, form-encoded, with the `state` the CLI made and either
 * `id_token` (a fresh Firebase ID token of the signed-in account) or `error`.
 *
 * - Listens on 127.0.0.1 only, on a port the system picks; answers loopback peers only, and only
 *   when `Host` names that address and port (DNS rebinding) and `Origin` is the web's origin.
 * - The token comes in the POST body, never a URL: a GET with a query is refused.
 * - `state` is compared in constant time. A valid answer (a token or a cancellation) is handed to
 *   the CLI, which holds the callback while the terminal checks it (`resume()` listens again for
 *   the same state when the person turns it down). Bad callbacks never end the wait: they are
 *   refused, so nobody can stop a login (and take over its freed port) by sending them. The
 *   server closes when the CLI is done and at the deadline; the deadline is paused while the
 *   terminal checks an answer.
 * - The email and name the page also posts are not used: what the terminal shows comes from the
 *   server, so a forged callback cannot dress up as the person's account.
 */

export type CallbackResult = { kind: 'token'; idToken: string } | { kind: 'denied'; error: string };

export class CallbackTimeout extends Error {
  constructor() {
    super(
      tr(
        '等待网页授权超时',
        'Timed out waiting for authorization on the web',
        'Se agotó el tiempo de espera de la autorización en la web',
        'O tempo de espera pela autorização na web se esgotou',
      ),
    );
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
  /**
   * The next valid callback, a token or a denial. The server then holds (a further valid
   * callback is told the terminal is busy, and the deadline pauses) until `resume()` or
   * `close()`. Rejects at the deadline or on `close()`.
   */
  next(): Promise<CallbackResult>;
  /** The answer just handed over was turned down: listen again for the same state. */
  resume(): void;
  close(): void;
};

const MAX_BODY = 32 * 1024;
/** Refused callbacks reported one by one; after these, one line says the rest are not. */
const REPORTED = 3;
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
  if (value === undefined)
    return tr('（未提供）', '(not provided)', '(no proporcionado)', '(não informado)');
  return JSON.stringify(value.slice(0, 80).replace(/[^\x20-\x7e]/g, '?'));
}

function page(title: string, message: string, ok: boolean): string {
  const colour = ok ? '#1f9d55' : '#c53030';
  return `<!doctype html><html lang="${tr('zh', 'en', 'es', 'pt')}"><head><meta charset="utf-8">
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
  /** waiting: takes a valid callback · holding: the CLI checks the one it got · closed. */
  let phase: 'waiting' | 'holding' | 'closed' = 'waiting';
  /** The time left on the deadline while it is paused (holding). */
  let left = options.timeoutMs;
  let deadlineAt = 0;
  let timer: NodeJS.Timeout | null = null;
  let pending: { resolve: (r: CallbackResult) => void; reject: (e: Error) => void } | null = null;
  let queued: CallbackResult | null = null;
  let ending: Error | null = null;
  let refused = 0;
  let port = 0;

  const current = () => phase;
  const report = (reason: string) => {
    refused += 1;
    if (refused <= REPORTED) options.onRejected?.(reason);
    else if (refused === REPORTED + 1)
      options.onRejected?.(
        tr(
          '还有更多无效回调，之后不再逐条提示（等待继续，直到超时或 Ctrl+C）',
          'more invalid callbacks; they will no longer be reported one by one (still waiting until the timeout or Ctrl+C)',
          'más callbacks no válidos; ya no se informarán uno por uno (se sigue esperando hasta el límite de tiempo o Ctrl+C)',
          'mais callbacks inválidos; eles não serão mais informados um a um (a espera continua até o tempo limite ou Ctrl+C)',
        ),
      );
  };

  const deliver = (outcome: CallbackResult) => {
    // The deadline waits while the terminal checks this answer.
    phase = 'holding';
    if (timer) clearTimeout(timer);
    timer = null;
    left = Math.max(0, deadlineAt - Date.now());
    if (pending) {
      pending.resolve(outcome);
      pending = null;
    } else queued = outcome;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const peer = request.socket.remoteAddress ?? '';
    const host = request.headers.host ?? '';
    if (!LOOPBACK.has(peer) || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      reply(
        response,
        403,
        page(
          tr('请求被拒绝', 'Request refused', 'Solicitud rechazada', 'Solicitação recusada'),
          tr(
            '只接受本机发来的授权回调。',
            'Only authorization callbacks from this machine are accepted.',
            'Solo se aceptan callbacks de autorización desde este equipo.',
            'Só são aceitos callbacks de autorização vindos desta máquina.',
          ),
          false,
        ),
      );
      return;
    }
    if (url.pathname !== '/callback') {
      reply(
        response,
        404,
        page(
          tr('找不到页面', 'Page not found', 'Página no encontrada', 'Página não encontrada'),
          tr(
            '这是 Yomi CLI 的本地授权回调。',
            'This is the Yomi CLI local authorization callback.',
            'Este es el callback local de autorización de Yomi CLI.',
            'Este é o callback local de autorização do Yomi CLI.',
          ),
          false,
        ),
      );
      return;
    }
    if (request.method !== 'POST' || url.search) {
      reply(
        response,
        405,
        page(
          tr('请求被拒绝', 'Request refused', 'Solicitud rechazada', 'Solicitação recusada'),
          tr(
            '授权信息只能通过网页提交，不能放在地址里。',
            'Authorization details can only be submitted from the web page, not in the address.',
            'Los datos de autorización solo se pueden enviar desde la página web, no en la dirección.',
            'Os dados de autorização só podem ser enviados pela página web, não no endereço.',
          ),
          false,
        ),
      );
      return;
    }
    if (phase === 'closed') {
      reply(
        response,
        410,
        page(
          tr(
            '授权已结束',
            'Authorization has ended',
            'La autorización terminó',
            'A autorização terminou',
          ),
          tr(
            '这次登录已经结束，可以关闭此页。',
            'This sign-in has already ended. You can close this page.',
            'Este inicio de sesión ya terminó. Puedes cerrar esta página.',
            'Este login já terminou. Você pode fechar esta página.',
          ),
          false,
        ),
      );
      return;
    }
    const origin = request.headers.origin;
    const body = await readBody(request);
    const values = body === null ? null : fields(request.headers['content-type'] ?? '', body);
    const state = values?.state ?? '';
    if (origin !== options.expectedOrigin || !values || !sameSecret(state, options.state)) {
      report(
        origin !== options.expectedOrigin
          ? tr(
              `来源不符：Origin 为 ${printable(origin)}，应为 ${options.expectedOrigin}`,
              `origin mismatch: Origin is ${printable(origin)}, expected ${options.expectedOrigin}`,
              `el origen no coincide: Origin es ${printable(origin)}, se esperaba ${options.expectedOrigin}`,
              `a origem não corresponde: Origin é ${printable(origin)}, esperado ${options.expectedOrigin}`,
            )
          : !values
            ? tr(
                '内容格式不对',
                'malformed body',
                'cuerpo con formato incorrecto',
                'conteúdo com formato incorreto',
              )
            : tr(
                'state 与本次登录不符',
                'state does not match this sign-in',
                'state no coincide con este inicio de sesión',
                'state não corresponde a este login',
              ),
      );
      reply(
        response,
        400,
        page(
          tr(
            '授权请求无效',
            'Invalid authorization request',
            'Solicitud de autorización no válida',
            'Solicitação de autorização inválida',
          ),
          tr(
            '请回到终端重新运行 yomi login，再从它打开的页面授权。',
            'Go back to the terminal, run yomi login again, and authorize from the page it opens.',
            'Vuelve a la terminal, ejecuta yomi login de nuevo y autoriza desde la página que abre.',
            'Volte ao terminal, execute yomi login novamente e autorize pela página que ele abrir.',
          ),
          false,
        ),
      );
      return;
    }
    // The phase may have moved on while the body was read.
    if (current() === 'closed') {
      reply(
        response,
        410,
        page(
          tr(
            '授权已结束',
            'Authorization has ended',
            'La autorización terminó',
            'A autorização terminou',
          ),
          tr(
            '这次登录已经结束，可以关闭此页。',
            'This sign-in has already ended. You can close this page.',
            'Este inicio de sesión ya terminó. Puedes cerrar esta página.',
            'Este login já terminou. Você pode fechar esta página.',
          ),
          false,
        ),
      );
      return;
    }
    if (current() === 'holding') {
      reply(
        response,
        409,
        page(
          tr(
            '终端正在确认',
            'Confirming in the terminal',
            'Confirmando en la terminal',
            'Confirmando no terminal',
          ),
          tr(
            '终端正在确认刚收到的一次授权或取消。要放弃这次登录，在终端按 Ctrl+C；如果终端显示的不是你的账号，在终端拒绝后，回到授权页再点一次授权。',
            'The terminal is checking an authorization or cancellation it just received. To abandon this sign-in, press Ctrl+C in the terminal; if the terminal shows an account that is not yours, refuse it there, then come back to the authorization page and click authorize again.',
            'La terminal está revisando una autorización o cancelación que acaba de recibir. Para abandonar este inicio de sesión, presiona Ctrl+C en la terminal; si la terminal muestra una cuenta que no es tuya, recházala ahí y luego vuelve a la página de autorización y haz clic en autorizar otra vez.',
            'O terminal está verificando uma autorização ou cancelamento que acabou de receber. Para abandonar este login, pressione Ctrl+C no terminal; se o terminal mostrar uma conta que não é sua, recuse-a lá, depois volte à página de autorização e clique em autorizar de novo.',
          ),
          false,
        ),
      );
      return;
    }
    if (values.error) {
      reply(
        response,
        200,
        page(
          tr(
            '已取消授权',
            'Authorization cancelled',
            'Autorización cancelada',
            'Autorização cancelada',
          ),
          tr(
            '已告知终端，可以关闭此页。如果终端询问，确认结束这次登录即可。',
            'The terminal has been told; you can close this page. If the terminal asks, confirm ending this sign-in.',
            'Ya se avisó a la terminal; puedes cerrar esta página. Si la terminal pregunta, confirma que quieres terminar este inicio de sesión.',
            'O terminal já foi avisado; você pode fechar esta página. Se o terminal perguntar, confirme o encerramento deste login.',
          ),
          false,
        ),
      );
      deliver({ kind: 'denied', error: values.error.slice(0, 64) });
      return;
    }
    const idToken = values.id_token ?? '';
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) {
      report(
        tr(
          '网页回传的登录凭证格式不正确',
          'the sign-in credentials sent back by the web page are malformed',
          'las credenciales de inicio de sesión que devolvió la página web tienen un formato incorrecto',
          'as credenciais de login enviadas de volta pela página web estão em formato incorreto',
        ),
      );
      reply(
        response,
        400,
        page(
          tr(
            '授权请求无效',
            'Invalid authorization request',
            'Solicitud de autorización no válida',
            'Solicitação de autorização inválida',
          ),
          tr(
            '没有收到有效的登录凭证。',
            'No valid sign-in credentials were received.',
            'No se recibieron credenciales de inicio de sesión válidas.',
            'Nenhuma credencial de login válida foi recebida.',
          ),
          false,
        ),
      );
      return;
    }
    reply(
      response,
      200,
      page(
        tr('已授权 Yomi CLI', 'Yomi CLI authorized', 'Yomi CLI autorizado', 'Yomi CLI autorizado'),
        tr(
          '可以关闭此页，回到终端继续。',
          'You can close this page and continue in the terminal.',
          'Puedes cerrar esta página y continuar en la terminal.',
          'Você pode fechar esta página e continuar no terminal.',
        ),
        true,
      ),
    );
    deliver({ kind: 'token', idToken });
  });

  /** Starts (or restarts, with what is left) the deadline. */
  function arm() {
    deadlineAt = Date.now() + left;
    timer = setTimeout(() => {
      if (phase === 'waiting') finish(new CallbackTimeout());
    }, left);
  }

  function finish(error: Error | null) {
    if (phase === 'closed') return;
    phase = 'closed';
    ending = error;
    if (timer) clearTimeout(timer);
    timer = null;
    if (error && pending) {
      pending.reject(error);
      pending = null;
    }
    // Let the answer reach the browser, then stop listening.
    setTimeout(() => server.close(), 50).unref();
    server.closeIdleConnections?.();
  }

  function next(): Promise<CallbackResult> {
    if (queued) {
      const outcome = queued;
      queued = null;
      return Promise.resolve(outcome);
    }
    if (phase === 'closed')
      return Promise.reject(
        ending ??
          new CallbackRejected(
            tr(
              '这次登录已经结束',
              'This sign-in has already ended',
              'Este inicio de sesión ya terminó',
              'Este login já terminou',
            ),
          ),
      );
    const waiting = new Promise<CallbackResult>((resolve, reject) => {
      pending = { resolve, reject };
    });
    // Callers await it; keep an early rejection from being reported as unhandled.
    waiting.catch(() => undefined);
    return waiting;
  }

  function resume() {
    if (phase !== 'holding') return;
    if (left <= 0) {
      finish(new CallbackTimeout());
      return;
    }
    phase = 'waiting';
    arm();
  }

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      // Nothing listens, so nothing is waited for: no timer is left behind either.
      phase = 'closed';
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      arm();
      resolve({
        port,
        callbackURL: `http://127.0.0.1:${port}/callback`,
        next,
        resume,
        close: () =>
          finish(new CallbackRejected(tr('已取消', 'Cancelled', 'Cancelado', 'Cancelado'))),
      });
    });
  });
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ApiError, type Gateway, NotSignedIn } from '../core/api.js';
import { loopbackHttpAllowed } from '../core/env.js';
import { ask, type Io, paint, say, warn } from '../core/ui.js';
import { UgcFailure, walletBalance } from '../ugc/api.js';

/**
 * What every generation command shares (character images, character video, persona avatars, the
 * relay's chat images): the price shown with the balance before anything is charged, an explicit
 * yes (typed, or `--accept-price` when nobody can type), the balance checked first so a request
 * that cannot be paid is never sent, polling, and downloading results. Nothing here retries a paid
 * call on its own: a request whose outcome is unknown is resent only with its saved request id.
 */

/** Why the server would not generate, in the CLI's words. */
export type GenRefusalKind = 'gems' | 'rejected' | 'unavailable' | 'rateLimited' | 'other';

export class GenRefusal extends Error {
  constructor(
    readonly kind: GenRefusalKind,
    readonly code: string,
    message: string,
  ) {
    super(message || code);
    this.name = 'GenRefusal';
  }
}

/** Not enough gems: the wallet's code, the conversation's, and the legacy ones. */
export const INSUFFICIENT_GEMS = new Set([
  '1503021061',
  '402',
  '40201',
  '1504011011',
  'INSUFFICIENT_BALANCE',
]);

/** Answers that mean the server turned the request away before accepting it (nothing charged). */
const REFUSED: Record<string, GenRefusalKind> = {
  '400': 'rejected',
  '409': 'rejected',
  '429': 'rateLimited',
  RATE_LIMITED: 'rateLimited',
  CONCURRENCY_LIMIT: 'rateLimited',
  AUTH_REQUIRED: 'unavailable',
  INVALID_ARGUMENT: 'rejected',
  CONFLICT: 'rejected',
  QUOTE_EXPIRED: 'rejected',
  CONFIG_CHANGED: 'rejected',
  CONTENT_REJECTED: 'rejected',
  content_blocked: 'rejected',
};

/**
 * A failure of a generation call as a `GenRefusal` only when the server clearly turned it away
 * (a known refusal: not enough gems, invalid, conflicting, rate limited…), so nothing was charged.
 * Everything else, an unrecognised code included, may have been accepted: the error itself comes
 * back and the request stays saved to be resent with the same id. The session's end too.
 */
export function generationRefusal(error: unknown): unknown {
  if (error instanceof NotSignedIn) return error;
  let code = '';
  let message = '';
  if (error instanceof UgcFailure) {
    code = error.code;
    message = error.message;
    // A failure that still carries a task was accepted: its outcome is the task's, not a refusal.
    if (error.body && (error.body.task || error.body.batch)) return error;
  } else if (error instanceof ApiError) {
    if (error.needsSignIn) return error;
    // HTTP 429 was turned away at the door; any other transport failure is unknown.
    if (error.code === ApiError.transport)
      return error.httpStatus === 429 ? new GenRefusal('rateLimited', '429', error.message) : error;
    code = String(error.code);
    message = error.message;
  } else return error;
  if (INSUFFICIENT_GEMS.has(code)) return new GenRefusal('gems', code, message);
  const kind = REFUSED[code];
  return kind ? new GenRefusal(kind, code, message) : error;
}

export { localTestServer, loopbackHttpAllowed } from '../core/env.js';

/** The gem balance, or null when it cannot be read. */
export async function readBalance(gateway: Gateway): Promise<number | null> {
  try {
    return await walletBalance(gateway);
  } catch (error) {
    if (error instanceof NotSignedIn) throw error;
    return null;
  }
}

export type SpendOptions = {
  /** What is about to happen, e.g. 「生成 4 张角色图片」. */
  action: string;
  /** Gems this costs in total (0: free). */
  total: number;
  /** Per-unit price and count, shown as「单价 × 数量」when both are given. */
  unit?: { price: number; count: number; label: string };
  /** `--accept-price`: the person agreed to the shown price without being asked. */
  acceptPrice: boolean;
  /** Lines shown under the price (the struck-through original, a note). */
  notes?: string[];
  /**
   * Resending a saved request whose outcome is unknown: if it was accepted, nothing more is
   * charged, so a low balance does not stop it (the agreement is still asked for).
   */
  replay?: boolean;
};

/**
 * Shows the price and the balance and asks for a typed `yes`. Refuses (false) when the balance is
 * known and too low: nothing must be sent then. A free action is announced and goes ahead.
 */
export async function confirmSpend(
  io: Io,
  gateway: Gateway,
  options: SpendOptions,
): Promise<boolean> {
  if (options.total <= 0) {
    say(io, `${options.action}：免费。`);
    return true;
  }
  const balance = await readBalance(gateway);
  const detail = options.unit
    ? `（${options.unit.price} 钻石/${options.unit.label} × ${options.unit.count}）`
    : '';
  say(io, paint(io, 'yellow', `${options.action}：共 ${options.total} 钻石${detail}。`));
  for (const note of options.notes ?? []) say(io, paint(io, 'dim', note));
  if (balance === null) {
    warn(io, '暂时读不到钻石余额，为避免扣费出错没有继续。请稍后再试。');
    return false;
  }
  say(io, `当前余额 ${balance} 钻石。`);
  if (balance < options.total && options.replay)
    say(
      io,
      paint(
        io,
        'dim',
        '余额低于这个价格：如果上次已经受理，重发不会再扣；如果没有受理，服务端会因余额不足拒绝。',
      ),
    );
  else if (balance < options.total) {
    warn(
      io,
      `钻石不足（还差 ${options.total - balance}），请先在 Yomi App 或网页充值。没有发出请求。`,
    );
    return false;
  }
  if (options.acceptPrice) return true;
  if (!io.interactive) {
    warn(io, '非交互运行时，花钻石需要加 --accept-price 明确同意上面的价格。');
    return false;
  }
  const answer = (await ask(io, '确认按这个价格扣除钻石？输入 yes 继续：')) ?? '';
  return answer.trim().toLowerCase() === 'yes';
}

/** Explains a refusal to the person; true when it was one (and was explained). */
export function explainRefusal(io: Io, error: unknown): boolean {
  if (!(error instanceof GenRefusal)) return false;
  switch (error.kind) {
    case 'gems':
      warn(io, '钻石不足，请先在 Yomi App 或网页充值。这次没有扣费。');
      break;
    case 'rateLimited':
      warn(io, `生成太频繁或同时进行的任务太多，请稍后再试（${error.code}）。`);
      break;
    case 'unavailable':
      warn(io, `这项生成功能暂时不可用（${error.code}）。`);
      break;
    default:
      warn(
        io,
        `服务端拒绝了这次生成（${error.code}${error.message && error.message !== error.code ? `：${error.message}` : ''}）。这次没有扣费。`,
      );
  }
  return true;
}

export type PollOptions<T> = {
  intervalMs: number;
  maxRounds: number;
  /** True when nothing more will change. */
  done: (value: T) => boolean;
  /** Called with every reading (progress lines). */
  onTick?: (value: T, round: number) => void;
  /** Called once, for the first failed reading; polling goes on. */
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Reads until `done` or the rounds run out. A failed reading is reported once and polling goes on;
 * a lost session ends it. Returns the last reading (null when none succeeded) and whether it was
 * done. Stopping never cancels or refunds anything on the server.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  options: PollOptions<T>,
): Promise<{ value: T | null; done: boolean }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let value: T | null = null;
  let reported = false;
  for (let round = 0; round < options.maxRounds; round++) {
    if (options.signal?.aborted) break;
    try {
      value = await read();
      options.onTick?.(value, round);
      if (options.done(value)) return { value, done: true };
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
      if (!reported) options.onError?.(error);
      reported = true;
    }
    await sleep(options.intervalMs);
  }
  return { value, done: false };
}

/** https only (http only on a local test server); never credentials, never redirects. */
export async function download(
  url: string,
  options: { maxBytes: number; fetcher?: typeof fetch },
): Promise<{ bytes: Buffer; mime: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('结果地址不合法');
  }
  if (parsed.protocol !== 'https:' && !loopbackHttpAllowed(parsed))
    throw new Error('结果地址不是 https');
  const response = await (options.fetcher ?? fetch)(url, { redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`下载结果失败（HTTP ${response.status}）`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('结果文件太大');
  }
  // Counted as it arrives: a compressed or chunked answer cannot grow past the cap in memory.
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('结果文件太大');
      }
      chunks.push(Buffer.from(value));
    }
  const bytes = Buffer.concat(chunks);
  return { bytes, mime: response.headers.get('content-type')?.split(';')[0] ?? '' };
}

/** Where downloads go: `--out`, else `./yomi-media`; created when missing. */
export function mediaDir(out: string | undefined): string {
  const dir = resolve(out || 'yomi-media');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveFile(dir: string, name: string, bytes: Buffer): string {
  const path = join(dir, name.replace(/[^A-Za-z0-9._-]/g, '_'));
  writeFileSync(path, bytes);
  return path;
}

/** The file extension for a media type. */
export function extensionOf(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'image/gif') return 'gif';
  return 'bin';
}

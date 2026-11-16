import { randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { dirname } from 'node:path';

import { ensurePrivateDir } from './files.js';
import { tr } from './i18n.js';

/**
 * A lock file shared by every `yomi` process of this user (`gh`-style, no native module): created
 * with `O_EXCL` and holding `{pid, at, token}`. A holder whose process is gone, or that has held
 * the lock longer than `staleMs`, is taken over; only the token that created a lock removes it.
 * Used around the session refresh, so a long-running `yomi relay` and a `yomi create` never trade
 * the same refresh token twice (the loser would otherwise be signed out).
 */

export class LockTimeout extends Error {
  constructor(path: string) {
    super(
      tr(
        `等待锁超时：${path}（另一个 yomi 进程正在使用）`,
        `Timed out waiting for the lock: ${path} (another yomi process is using it)`,
        `Se agotó el tiempo de espera del bloqueo: ${path} (otro proceso de yomi lo está usando)`,
        `Tempo esgotado aguardando o bloqueio: ${path} (outro processo do yomi está usando)`,
      ),
    );
    this.name = 'LockTimeout';
  }
}

type Holder = { pid: number; at: number; token: string };

export type LockOptions = {
  /** Give up waiting after this long (default 45 s). */
  timeoutMs?: number;
  /** A lock older than this is abandoned (default 60 s; a refresh takes at most 20 s). */
  staleMs?: number;
  pollMs?: number;
};

function readHolder(path: string): Holder | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<Holder>;
    if (typeof value.pid !== 'number' || typeof value.at !== 'number') return null;
    return { pid: value.pid, at: value.at, token: String(value.token ?? '') };
  } catch {
    return null;
  }
}

/** True while `pid` runs (EPERM: it runs, as another user). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes the lock only while it still holds `token` (never someone else's fresh lock). */
function removeIfHeldBy(path: string, token: string) {
  if (readHolder(path)?.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * Takes a stale lock away atomically: renamed aside first, so of two waiters only one gets it. If
 * what was renamed is not the stale lock that was judged (someone took over in between), it is
 * put back, unless a newer lock is already there.
 */
function takeOver(path: string, staleToken: string | null) {
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  const moved = readHolder(aside);
  if (staleToken !== null && moved && moved.token !== staleToken) {
    try {
      linkSync(aside, path);
    } catch {
      // A new lock exists already; the moved one is gone with the race.
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // Already gone.
  }
}

/** Held since before this machine booted: its pid may belong to another process now. */
function fromBeforeBoot(at: number): boolean {
  return at < Date.now() - uptime() * 1000;
}

function fileAge(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tries once; true when this call now holds the lock. */
function tryCreate(path: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Runs `run` while holding the lock file at `path`. */
export async function withFileLock<T>(
  path: string,
  run: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const staleMs = options.staleMs ?? 60_000;
  const pollMs = options.pollMs ?? 50;
  const token = randomBytes(12).toString('hex');
  ensurePrivateDir(dirname(path));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreate(path, token)) break;
    const holder = readHolder(path);
    if (holder) {
      if (
        !processAlive(holder.pid) ||
        Date.now() - holder.at > staleMs ||
        fromBeforeBoot(holder.at)
      ) {
        takeOver(path, holder.token);
        continue;
      }
    } else if (fileAge(path) > staleMs) {
      // Unreadable for longer than any writer needs: a crash between create and write.
      takeOver(path, null);
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeout(path);
    await sleep(pollMs + Math.floor(Math.random() * pollMs));
  }
  try {
    return await run();
  } finally {
    removeIfHeldBy(path, token);
  }
}

/** Blocks this thread for `ms` (a synchronous wait between lock attempts). */
function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `withFileLock` for short synchronous work (reading and rewriting a small state file): the same
 * lock file rules, waiting with a blocking pause. `run` must not take the same lock again.
 */
export function withFileLockSync<T>(path: string, run: () => T, options: LockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 15_000;
  const pollMs = options.pollMs ?? 10;
  const token = randomBytes(12).toString('hex');
  ensurePrivateDir(dirname(path));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreate(path, token)) break;
    const holder = readHolder(path);
    const stale = holder
      ? !processAlive(holder.pid) || Date.now() - holder.at > staleMs || fromBeforeBoot(holder.at)
      : fileAge(path) > staleMs;
    if (stale) {
      takeOver(path, holder?.token ?? null);
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeout(path);
    pause(pollMs + Math.floor(Math.random() * pollMs));
  }
  try {
    return run();
  } finally {
    removeIfHeldBy(path, token);
  }
}

/**
 * A lock held for a whole process (one `yomi relay` per bot): taken without waiting, kept until
 * `release()` or exit. Returns null with the holder's pid when another live process has it.
 */
export function acquireProcessLock(path: string): { release: () => void } | { heldBy: number } {
  const token = randomBytes(12).toString('hex');
  ensurePrivateDir(dirname(path));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(path, token)) {
      const release = () => removeIfHeldBy(path, token);
      process.once('exit', release);
      return {
        release: () => {
          process.removeListener('exit', release);
          release();
        },
      };
    }
    const holder = readHolder(path);
    if (holder && processAlive(holder.pid) && !fromBeforeBoot(holder.at))
      return { heldBy: holder.pid };
    if (!holder && fileAge(path) < 5_000) return { heldBy: 0 };
    takeOver(path, holder?.token ?? null);
  }
  return { heldBy: 0 };
}

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireProcessLock } from '../src/core/lock.js';

/**
 * Taking over a stale lock races with another process doing the same: the lock is renamed aside,
 * and what was renamed may already be the other process's new lock, even one it has created and
 * not written yet. Only the stale lock judged may be removed; anything else goes back, or two
 * processes would both hold the lock (two relays of one Yomi environment). `renameSync` is
 * wrapped so a test can play the other process right before the rename.
 */

const race = vi.hoisted(() => ({ before: null as null | ((from: string) => void) }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      const before = race.before;
      race.before = null;
      before?.(String(from));
      real.renameSync(from, to);
    },
  };
});

afterEach(() => {
  race.before = null;
});

/** A pid that is certainly not running: a child that already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

/**
 * The other process: it took the stale lock away and created its own, but has not written it
 * yet (an empty file); `write()` finishes its creation, as tryCreate does.
 */
function createdNotWritten(path: string) {
  fs.unlinkSync(path);
  const fd = fs.openSync(path, 'wx', 0o600);
  return {
    write() {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }));
      fs.closeSync(fd);
    },
  };
}

describe('taking over a stale process lock', () => {
  it("leaves another process's lock that is created but not yet written", async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'yomi-lock-')), 'relay-env.lock');
    writeFileSync(path, JSON.stringify({ pid: await deadPid(), at: Date.now(), token: 'stale' }));
    let other: ReturnType<typeof createdNotWritten> | null = null;
    race.before = (from) => {
      if (from === path) other = createdNotWritten(path);
    };
    const lock = acquireProcessLock(path);
    expect(other).not.toBeNull();
    // Someone is writing the lock right now: not ours to take.
    expect(lock).toEqual({ heldBy: 0 });
    other!.write();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ token: 'other' });
    expect(acquireProcessLock(path)).toEqual({ heldBy: process.pid });
  });

  it('removes an unwritten lock only when it is old, never one being written now', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'yomi-lock-')), 'relay-env.lock');
    // A crash between create and write, long ago.
    writeFileSync(path, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path, old, old);
    let other: ReturnType<typeof createdNotWritten> | null = null;
    race.before = (from) => {
      if (from === path) other = createdNotWritten(path);
    };
    expect(acquireProcessLock(path)).toEqual({ heldBy: 0 });
    other!.write();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ token: 'other' });

    // With nobody racing, the old unwritten lock is taken over.
    writeFileSync(path, '');
    fs.utimesSync(path, old, old);
    const lock = acquireProcessLock(path);
    expect('release' in lock).toBe(true);
    if ('release' in lock) lock.release();
  });
});

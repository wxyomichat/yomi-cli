import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { QQ_API, qqApiOrigin } from './qq-api.js';

/**
 * Step 3's scan in `yomi relay --setup`, this process's side: Tencent's QR connector
 * (`@tencent-connect/qqbot-connector`, closed source, licensed UNLICENSED) runs only in a child
 * process (qq-connect-child.ts), started with this Node and an environment of PATH, LANG, LC_* and
 * TZ only (no Yomi setting, no HOME, nothing else inherited), its stdio connected to nothing but
 * the IPC channel: no Yomi setting or credential is handed to it, and its output never reaches the
 * terminal. That is all it is kept from: it runs as this user, not in a sandbox, so it could read
 * what this user can (the keychain, the config directory) if it set out to. What it says is
 * checked here: a QR link only on https and Tencent's host, an AppID of digits and an AppSecret of
 * the shape QQ gives; anything else ends the scan. It is killed when the scan ends either way
 * (scanned, failed, timed out, given up with a key, Ctrl+C) and when this process exits.
 *
 * The AppID and AppSecret it gives are then checked with QQ like typed ones; nothing of them is
 * ever printed but the AppID.
 */

/** A QQ bot's AppID: 5 to 20 digits. */
export const APP_ID = /^[0-9]{5,20}$/;
/** An AppSecret: 8 to 128 printable characters, no spaces. */
export const APP_SECRET = /^[\x21-\x7e]{8,128}$/;

/** Where a scan's QR link must be: the connector's page on q.qq.com, over https. */
const QR_ORIGIN = 'https://q.qq.com';
/** The longest QR link taken (the connector's are about 100 characters). */
const QR_URL_MAX = 1024;

/** The argument the child is started with (qq-connect-child.ts `CHILD_MARK`). */
const CHILD_MARK = '--yomi-qq-connect';

/**
 * Tests only: the module run as the child instead of the connector's, honoured only while the QQ
 * API is a loopback mock (`YOMI_QQ_API_ORIGIN`), so a test's scan is checked by the mock and never
 * reaches Tencent. Nothing outside this process can set it.
 */
export const QQ_CONNECT_TEST = { child: '' };

/**
 * The child module to run for a scan, or null when there is none to offer: QQ's real API runs
 * Tencent's connector (when this install has it); a loopback mock runs only a test's child, never
 * Tencent's.
 */
export function connectChild(): string | null {
  let origin: string;
  try {
    origin = qqApiOrigin(process.env.YOMI_QQ_API_ORIGIN);
  } catch {
    return null;
  }
  if (origin !== QQ_API) return QQ_CONNECT_TEST.child || null;
  const path = fileURLToPath(new URL('./qq-connect-child.js', import.meta.url));
  return existsSync(path) ? path : null;
}

/** The child's environment: PATH, LANG, LC_* and TZ of this one, nothing else. */
export function childEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (
      value !== undefined &&
      (key === 'PATH' || key === 'LANG' || key === 'TZ' || /^LC_[A-Z]+$/.test(key))
    )
      kept[key] = value;
  return kept;
}

/**
 * A QR link the child gave, if it is one to draw: https on Tencent's host, plain characters, and
 * the link as this process read it (what is drawn or printed). It must read the same to every URL
 * parser, the scanning phone's too: spelled `https://q.qq.com/…` exactly, with no backslash (read
 * as a slash here, not by others) and no `@` (others read what comes before it as a login).
 */
export function trustedScanUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > QR_URL_MAX || !/^[\x21-\x7e]+$/.test(value))
    return null;
  if (!value.startsWith(`${QR_ORIGIN}/`) || /[\\@]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== QR_ORIGIN || url.username || url.password) return null;
  return url.href;
}

/** Why a scan ended without an AppID and AppSecret. */
export type ScanFailure =
  /** The connector could not be loaded (or the child could not start). */
  | 'load'
  /** The connector failed (Tencent's service, the network). */
  | 'service'
  /** No QR code came in time. */
  | 'start'
  /** Not scanned in time. */
  | 'timeout'
  /** The child ended on its own. */
  | 'crash'
  /** The child said something it should not. */
  | 'invalid';

export type ScanEvent =
  | { kind: 'qr'; url: string }
  | { kind: 'credentials'; app: { appId: string; secret: string } }
  | { kind: 'failed'; why: ScanFailure };

const keysOf = (value: object) => Object.keys(value).sort().join(',');

/** A message from the child, checked: null when it is not one it may send. */
export function childMessage(value: unknown): ScanEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type === 'qr' && keysOf(message) === 'type,url') {
    const url = trustedScanUrl(message.url);
    return url ? { kind: 'qr', url } : null;
  }
  if (message.type === 'credentials' && keysOf(message) === 'appId,appSecret,type') {
    const { appId, appSecret } = message;
    if (typeof appId !== 'string' || !APP_ID.test(appId)) return null;
    if (typeof appSecret !== 'string' || !APP_SECRET.test(appSecret)) return null;
    return { kind: 'credentials', app: { appId, secret: appSecret } };
  }
  if (message.type === 'failed' && keysOf(message) === 'reason,type')
    return message.reason === 'load' || message.reason === 'service'
      ? { kind: 'failed', why: message.reason }
      : null;
  return null;
}

/** A scan under way: its events one by one (the last one ends it), and what stops it. */
export type Scan = {
  /** The next event: a QR code (another one after one expired), then the end. */
  next(): Promise<ScanEvent>;
  /** Kills the child (whatever it was doing); no event comes after. */
  stop(): void;
};

/**
 * Starts the child `path` (a scan): its first QR code within `startMs`, scanned within `overallMs`,
 * else it fails. Never throws; every way it ends is an event, and it ends with the child killed.
 */
export function startScan(path: string, timing: { startMs: number; overallMs: number }): Scan {
  const queue: ScanEvent[] = [];
  let waiting: ((event: ScanEvent) => void) | null = null;
  let ended = false;
  let child: ChildProcess | null = null;
  const kill = () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const timers: NodeJS.Timeout[] = [];
  const finish = () => {
    ended = true;
    for (const timer of timers) clearTimeout(timer);
    process.removeListener('exit', kill);
    kill();
  };
  const push = (event: ScanEvent) => {
    if (ended) return;
    if (event.kind !== 'qr') finish();
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(event);
    } else queue.push(event);
  };
  const fail = (why: ScanFailure) => push({ kind: 'failed', why });
  try {
    child = spawn(process.execPath, [path, CHILD_MARK], {
      env: childEnvironment(process.env),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
      // Its own process group: Ctrl+C at the terminal reaches this process only, which ends it.
      detached: true,
      windowsHide: true,
    });
  } catch {
    fail('load');
  }
  if (child) {
    process.on('exit', kill);
    let shown = false;
    child.on('message', (message: unknown) => {
      const event = childMessage(message);
      if (!event) return fail('invalid');
      if (event.kind === 'qr') shown = true;
      push(event);
    });
    child.on('error', () => fail('load'));
    child.on('exit', () => fail('crash'));
    timers.push(
      setTimeout(() => {
        if (!shown) fail('start');
      }, timing.startMs),
      setTimeout(() => fail('timeout'), timing.overallMs),
    );
  }
  return {
    next: () =>
      new Promise<ScanEvent>((resolve) => {
        const event = queue.shift();
        if (event) resolve(event);
        else waiting = resolve;
      }),
    stop: () => {
      if (!ended) finish();
      waiting = null;
    },
  };
}

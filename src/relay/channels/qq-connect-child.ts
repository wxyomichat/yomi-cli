import type { startQrConnect } from '@tencent-connect/qqbot-connector';

/**
 * The child process of step 3's scan in `yomi relay --setup` (qq-connect.ts starts it): Tencent's
 * QR connector (`@tencent-connect/qqbot-connector`, closed source) runs here and nowhere else,
 * started with a minimal environment (no Yomi settings, no HOME) and no terminal: its stdin,
 * stdout and stderr go nowhere, and the parent hears from it only over the IPC channel: the QR
 * code's link and then the AppID and AppSecret QQ gave for the bot scanned (or that it failed).
 * The parent checks every message, draws the code itself, checks the AppID and AppSecret with QQ,
 * and kills this process when the scan ends either way. This module imports nothing of yomi's, so
 * no code of the CLI (and none of its credentials) is loaded in this process; it still runs as the
 * same user, not in a sandbox. When the parent goes away, the IPC channel closes and this process
 * ends.
 */

/** What the child tells the parent (the parent checks each message: qq-connect.ts). */
export type ConnectMessage =
  | { type: 'qr'; url: string }
  | { type: 'credentials'; appId: string; appSecret: string }
  /** 'load': the connector could not be loaded; 'service': it failed (Tencent's service). */
  | { type: 'failed'; reason: 'load' | 'service' };

/** Sends a message to the parent. */
export type ConnectSend = (message: ConnectMessage) => void;

/** The argument the parent starts this module with (nothing else runs it). */
export const CHILD_MARK = '--yomi-qq-connect';

/**
 * Runs the connector (`connect`, its `startQrConnect`) and tells the parent (`send`) what it
 * gives: each QR code's link (a new one after a code expires), then the first bot's AppID and
 * AppSecret, or a failure, and nothing after that. The connector prints nothing
 * (`displayQrCodeToConsole: false`) and is given no `source`, so the scan page names the caller
 * as a third-party bot. Returns what stops it.
 */
export function serveConnect(connect: typeof startQrConnect, send: ConnectSend): () => void {
  let ended = false;
  const stop = connect(
    {
      onQrDisplayed: (url) => {
        if (!ended) send({ type: 'qr', url: String(url) });
      },
      onSuccess: (credentials) => {
        if (ended) return;
        ended = true;
        const first = credentials[0];
        send(
          first
            ? {
                type: 'credentials',
                appId: String(first.appId),
                appSecret: String(first.appSecret),
              }
            : { type: 'failed', reason: 'service' },
        );
      },
      onFailure: () => {
        if (ended) return;
        ended = true;
        send({ type: 'failed', reason: 'service' });
      },
    },
    { displayQrCodeToConsole: false },
  );
  return () => {
    ended = true;
    stop();
  };
}

async function main() {
  const send: ConnectSend = (message) => {
    if (!process.connected) return;
    process.send?.(message, undefined, undefined, (error: Error | null) => {
      if (error) process.exit(1);
    });
  };
  let connector: typeof import('@tencent-connect/qqbot-connector');
  try {
    connector = await import('@tencent-connect/qqbot-connector');
  } catch {
    // The parent ends this process once it has read this.
    send({ type: 'failed', reason: 'load' });
    return;
  }
  // The parent went away while the connector loaded. Otherwise it runs until this process ends
  // (killed by the parent, or the parent gone: below).
  if (!process.connected) process.exit(0);
  serveConnect(connector.startQrConnect, send);
}

// Only as the child the parent started (an import, as in a test, runs nothing). Once the parent is
// gone (the IPC channel closed), this process ends.
if (process.argv[2] === CHILD_MARK && typeof process.send === 'function') {
  process.once('disconnect', () => process.exit(0));
  void main();
}

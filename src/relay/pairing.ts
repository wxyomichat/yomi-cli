import { randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The one-time code that pairs the bot with its owner (as OpenClaw's DM pairing): shown only in
 * the terminal that runs the relay, sent to the bot as `/start <code>` on Telegram (the deep link
 * `t.me/<bot>?start=<code>` does that) or `/pair <code>` (QQ, which has no deep links; Telegram
 * takes it too). 8 characters from 32 (40 bits), 15 minutes. Wrong tries count per sender (a
 * Telegram user id, a QQ openid): after 5 that sender is ignored, but nobody else can use up the
 * owner's code, and only expiry replaces it. Never written to a file or a log.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 8;
const MAX_TRIES = 5;

/** `wrong`: answer once more; `ignored`: this sender has used up their tries, say nothing. */
export type PairingResult = 'ok' | 'wrong' | 'expired' | 'ignored';

export class PairingCode {
  readonly code: string;
  readonly expiresAt: number;
  private tries = new Map<number | string, number>();

  constructor(now = Date.now(), ttlMs = 15 * 60_000) {
    let code = '';
    for (let index = 0; index < LENGTH; index++) code += ALPHABET[randomInt(ALPHABET.length)];
    this.code = code;
    this.expiresAt = now + ttlMs;
  }

  get display(): string {
    return `${this.code.slice(0, 4)}-${this.code.slice(4)}`;
  }

  /** The deep link that opens the bot and sends `/start <code>` (Telegram only). */
  link(username: string): string {
    return `https://t.me/${username}?start=${this.code}`;
  }

  check(input: string, senderId: number | string, now = Date.now()): PairingResult {
    const tries = this.tries.get(senderId) ?? 0;
    if (tries >= MAX_TRIES) return 'ignored';
    if (now > this.expiresAt) return 'expired';
    const given = Buffer.from(
      input
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 32),
    );
    const wanted = Buffer.from(this.code);
    if (given.length === wanted.length && timingSafeEqual(given, wanted)) return 'ok';
    this.tries.set(senderId, tries + 1);
    if (this.tries.size > 1000)
      this.tries.delete(this.tries.keys().next().value as number | string);
    return 'wrong';
  }
}

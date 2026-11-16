import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { configDir, readJsonFile, writeJsonFile } from '../core/files.js';
import { sha256 } from '../core/state.js';

/**
 * What one relay (one environment × one bot) remembers between runs, in `relay/<scope>.json`
 * (0600). No secrets: the bot token and the Yomi session stay in the keychain. Telegram user data
 * is kept to what the relay needs (Bot Developer Terms §4.2): the owner's ids and first name, and
 * a short map from Telegram messages to Yomi message ids for `/report`.
 *
 * Money state is bound to who agreed to it: the budget belongs to the paired Telegram owner and
 * the Yomi account (`bindAccount`, `resetOwner` start it over), and the local ceiling
 * (`--max-spend`) keeps its own running total that nothing from Telegram can reset. A charge the
 * relay could not measure yet (`pending`) survives restarts. Session and server pauses are not
 * stored: they are worked out again on every start. `yomi relay --telegram --forget` deletes it.
 */

export type RelayOwner = {
  userId: number;
  chatId: number;
  name: string;
  language: string;
  pairedAt: number;
};

export type Billing = {
  /** `free`: free replies only. `paid`: may spend gems up to `budget`. */
  mode: 'free' | 'paid';
  /** Gems this budget allows. */
  budget: number;
  /** Gems measured as spent since the budget was set. */
  spent: number;
  setAt: number;
};

/** The local ceiling (`--max-spend`) and what was spent under it; only this computer resets it. */
export type Allowance = { maxSpend: number; spent: number; since: number };

/** A send whose cost is not known yet: the balance before it (`wallet/get_wallet_page`). */
export type PendingCharge = {
  before: number;
  mode: 'free' | 'paid';
  /** The quoted price then (display only), used when the cost cannot be measured. */
  price: number | null;
  at: number;
};

export type BillingPause = '' | 'budget' | 'freeCharged';

export type RelayCharacter = { npcId: string; name: string; group: boolean };

export type RelayStateFile = {
  version: 1;
  /** `accountKey` of the environment (for `--forget`). */
  account: string;
  botId: string;
  botUsername: string;
  /** The Yomi user the money state belongs to. */
  yomiUserId: string;
  owner: RelayOwner | null;
  /** The next `getUpdates` offset and when it was saved (an old one is not reused). */
  offset: number;
  offsetSavedAt: number;
  character: RelayCharacter | null;
  billing: Billing;
  allowance: Allowance;
  pending: PendingCharge | null;
  /** A pause only a new /budget lifts ('' when none). */
  billingPause: BillingPause;
  /** The relay's own AI notice (until the server injects one), per character. */
  noticeAt: Record<string, number>;
  /** Characters whose opening was shown here. */
  greeted: string[];
  /** Telegram message id → Yomi assistant mid, newest last. */
  replies: [number, string][];
};

const MAX_REPLIES = 500;

export const freshBilling = (): Billing => ({ mode: 'free', budget: 0, spent: 0, setAt: 0 });

function empty(botId: string, account: string): RelayStateFile {
  return {
    version: 1,
    account,
    botId,
    botUsername: '',
    yomiUserId: '',
    owner: null,
    offset: 0,
    offsetSavedAt: 0,
    character: null,
    billing: freshBilling(),
    allowance: { maxSpend: 0, spent: 0, since: 0 },
    pending: null,
    billingPause: '',
    noticeAt: {},
    greeted: [],
    replies: [],
  };
}

export function relayStatePath(account: string, botId: string, dir = configDir()): string {
  return join(dir, 'relay', sha256(`${account}|${botId}`).slice(0, 16) + '.json');
}

/** Deletes every relay state file of this environment (`--forget`); returns how many. */
export function forgetRelayStates(account: string, dir = configDir()): number {
  const folder = join(dir, 'relay');
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(folder, name);
    const stored = readJsonFile<Partial<RelayStateFile>>(path);
    // Files from before `account` was stored belong to whichever environment is forgetting.
    if (stored && stored.account && stored.account !== account) continue;
    rmSync(path, { force: true });
    removed += 1;
  }
  return removed;
}

export class RelayState {
  data: RelayStateFile;

  constructor(
    readonly path: string,
    botId: string,
    account = '',
  ) {
    const stored = readJsonFile<RelayStateFile & { paused?: string }>(path);
    if (stored && stored.version === 1 && stored.botId === botId) {
      const { paused, ...rest } = stored;
      this.data = {
        ...empty(botId, account),
        ...rest,
        billing: { ...freshBilling(), ...stored.billing },
        allowance: { ...empty(botId, account).allowance, ...stored.allowance },
        // Older files kept every pause in one field; only the money ones carry over.
        billingPause:
          stored.billingPause ?? (paused === 'budget' || paused === 'freeCharged' ? paused : ''),
      };
      if (account) this.data.account = account;
    } else this.data = empty(botId, account);
  }

  save() {
    writeJsonFile(this.path, this.data);
  }

  update(patch: Partial<RelayStateFile>) {
    Object.assign(this.data, patch);
    this.save();
  }

  /**
   * Ties the money state to the signed-in Yomi user. Another account found the state of the one
   * before: its budget, pending charge, history and character are not this account's. True when
   * it was reset.
   */
  bindAccount(userId: string): boolean {
    const previous = this.data.yomiUserId;
    if (previous && previous !== userId) {
      this.update({
        yomiUserId: userId,
        billing: freshBilling(),
        allowance: { ...this.data.allowance, spent: 0, since: Date.now() },
        pending: null,
        billingPause: '',
        character: null,
        noticeAt: {},
        greeted: [],
        replies: [],
      });
      return true;
    }
    if (previous !== userId) this.update({ yomiUserId: userId });
    return false;
  }

  /** A new pairing: the next person agrees to spending afresh and sees none of the old replies. */
  resetOwner() {
    this.update({ owner: null, billing: freshBilling(), billingPause: '', replies: [] });
  }

  /**
   * The local ceiling for this run. Its running total starts over only when this computer says
   * so: a different `--max-spend`, or `--reset-spend`.
   */
  useAllowance(maxSpend: number, reset: boolean) {
    const allowance = this.data.allowance;
    if (reset || allowance.maxSpend !== maxSpend || allowance.since === 0)
      this.update({ allowance: { maxSpend, spent: 0, since: Date.now() } });
  }

  rememberReply(messageId: number, mid: string) {
    this.data.replies.push([messageId, mid]);
    if (this.data.replies.length > MAX_REPLIES)
      this.data.replies = this.data.replies.slice(-MAX_REPLIES);
    this.save();
  }

  replyMid(messageId: number): string {
    for (let index = this.data.replies.length - 1; index >= 0; index--)
      if (this.data.replies[index][0] === messageId) return this.data.replies[index][1];
    return '';
  }

  get lastReplyMid(): string {
    return this.data.replies.at(-1)?.[1] ?? '';
  }
}

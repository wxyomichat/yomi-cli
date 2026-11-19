import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { configDir, readJsonFile, writeJsonFile } from '../core/files.js';
import { sha256 } from '../core/state.js';
import type { ChannelKind, ChannelStore } from './channels/types.js';

/**
 * What one relay (one environment × one channel scope) remembers between runs, in
 * `relay/<hash>.json` (0600). No secrets: the bot token, the QQ AppSecret, the WeChat login and
 * the Yomi session stay in the keychain. Chat user data is kept to what the relay needs, per
 * channel: Telegram the owner's ids and first name (Bot Developer Terms §4.2); QQ the owner's
 * openid; WeChat the owner's iLink user id, the update cursor and the newest context_token (not a
 * secret on its own: useless without the bot_token in the keychain). Plus a short map from the
 * chat's messages to Yomi message ids for `/report`.
 *
 * Money state is bound to who agreed to it: the budget belongs to the paired owner and the Yomi
 * account (`bindAccount`, `resetOwner` start it over), and the local ceiling (`--max-spend`)
 * keeps its own running total that nothing from the chat can reset. A charge the relay could not
 * measure yet (`pending`) survives restarts. Session and server pauses are not stored: they are
 * worked out again on every start. `yomi relay … --forget` deletes it.
 *
 * A Telegram file has no `kind` and no `channel`, so it is the same file it was before channels.
 */

export type RelayOwner = {
  /** Telegram writes numbers (as it always has), QQ and WeChat strings. */
  userId: number | string;
  chatId: number | string;
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
  /** Absent for Telegram, so its files do not change. */
  kind?: 'qq' | 'wechat';
  /** `accountKey` of the environment (for `--forget`). */
  account: string;
  /** The channel's scope: Telegram's bot id, `qq:<AppID>`, `wx:<owner hash>`. */
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
  /** The chat's message ref (Telegram message id) → Yomi assistant mid, newest last. */
  replies: [number | string, string][];
  /** What a QQ or WeChat channel keeps itself (`channelStore`); absent until it writes something. */
  channel?: Record<string, unknown>;
};

const MAX_REPLIES = 500;

export const freshBilling = (): Billing => ({ mode: 'free', budget: 0, spent: 0, setAt: 0 });

function empty(botId: string, account: string, kind: ChannelKind = 'telegram'): RelayStateFile {
  return {
    version: 1,
    ...(kind === 'telegram' ? {} : { kind }),
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

export function relayStatePath(account: string, scope: string, dir = configDir()): string {
  return join(dir, 'relay', sha256(`${account}|${scope}`).slice(0, 16) + '.json');
}

/**
 * Deletes the relay state files of this environment (`--forget`); returns how many. With `kind`,
 * only that channel's (a file without `kind` is Telegram's), so the other channels keep theirs.
 */
export function forgetRelayStates(account: string, dir = configDir(), kind?: ChannelKind): number {
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
    if (kind && (stored?.kind ?? 'telegram') !== kind) continue;
    rmSync(path, { force: true });
    removed += 1;
  }
  return removed;
}

export class RelayState {
  data: RelayStateFile;

  constructor(
    readonly path: string,
    scope: string,
    account = '',
    kind: ChannelKind = 'telegram',
  ) {
    const stored = readJsonFile<RelayStateFile & { paused?: string }>(path);
    if (
      stored &&
      stored.version === 1 &&
      stored.botId === scope &&
      (stored.kind ?? 'telegram') === kind
    ) {
      const { paused, ...rest } = stored;
      this.data = {
        ...empty(scope, account, kind),
        ...rest,
        billing: { ...freshBilling(), ...stored.billing },
        allowance: { ...empty(scope, account, kind).allowance, ...stored.allowance },
        // Older files kept every pause in one field; only the money ones carry over.
        billingPause:
          stored.billingPause ?? (paused === 'budget' || paused === 'freeCharged' ? paused : ''),
      };
      if (account) this.data.account = account;
    } else this.data = empty(scope, account, kind);
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
   * before: its budget, pending charge, history, character and the messages a channel queued for
   * the owner are not this account's. True when it was reset.
   */
  bindAccount(userId: string): boolean {
    const previous = this.data.yomiUserId;
    if (previous && previous !== userId) {
      // The queue's only account rule: its items carry no account, so they go with the account.
      const channel = this.data.channel ? { ...this.data.channel } : undefined;
      if (channel) delete channel.queue;
      this.update({
        ...(channel ? { channel } : {}),
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

  /** `messageId` as the channel persists it (`RelayChannel.persistId`: Telegram a number). */
  rememberReply(messageId: number | string, mid: string) {
    this.data.replies.push([messageId, mid]);
    if (this.data.replies.length > MAX_REPLIES)
      this.data.replies = this.data.replies.slice(-MAX_REPLIES);
    this.save();
  }

  /** Compared as strings: an inbound ref is a string, a stored Telegram id a number. */
  replyMid(messageId: number | string): string {
    for (let index = this.data.replies.length - 1; index >= 0; index--)
      if (String(this.data.replies[index][0]) === String(messageId))
        return this.data.replies[index][1];
    return '';
  }

  get lastReplyMid(): string {
    return this.data.replies.at(-1)?.[1] ?? '';
  }

  /** The channel's own data (`data.channel`); a write saves the file at once. */
  channelStore(): ChannelStore {
    return {
      get: <T>(key: string) => this.data.channel?.[key] as T | undefined,
      set: (key: string, value: unknown) => {
        const channel = { ...this.data.channel };
        if (value === undefined) delete channel[key];
        else channel[key] = value;
        this.update({ channel });
      },
    };
  }
}

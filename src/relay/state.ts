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
 * The welcome (`bindOwner`, `markWelcomed`) remembers whom this bot welcomed, by a hash of the user
 * id (never the id itself) and the character it was given with, so a re-pairing or re-login by the
 * same owner and a restart never repeat it; `resetOwner` keeps that list.
 *
 * Money state is bound to who agreed to it: the in-chat budget (optional: none by default, and Yomi
 * charges by its normal rules) belongs to the paired owner and the Yomi account (`bindAccount`,
 * `resetOwner` start it over), and the local ceiling (`--max-spend`, optional too) keeps its own
 * running total of everything the relay spent, which nothing from the chat can reset. A charge the
 * relay could not measure yet (`pending`) survives restarts. Session and server pauses are not
 * stored: they are worked out again on every start. `yomi relay … --forget` deletes it.
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

/**
 * The in-chat budget. `open` (the default): no budget, Yomi charges by its normal rules (within
 * `--max-spend` when set). `paid`: may spend gems up to `budget` (`/budget <amount>`). `free`:
 * free replies only (`/budget off`).
 */
export type BillingMode = 'open' | 'paid' | 'free';

export type Billing = {
  mode: BillingMode;
  /** Gems this budget allows (`paid`). */
  budget: number;
  /** Gems measured as spent since the budget was set. */
  spent: number;
  setAt: number;
};

/**
 * The local ceiling (`--max-spend`; null: none) and what the relay spent since `since`, with or
 * without a ceiling: the running total the chat's status shows. `unmeasured`: sends whose cost
 * could not be measured meanwhile (without a cap they go anyway), so the total is a lower bound
 * when it is above 0. Only this computer resets it.
 */
export type Allowance = {
  maxSpend: number | null;
  spent: number;
  since: number;
  unmeasured: number;
};

/** A send whose cost is not known yet: the balance before it (`wallet/get_wallet_page`). */
export type PendingCharge = {
  before: number;
  mode: BillingMode;
  /** The quoted price then (display only), used when the cost cannot be measured. */
  price: number | null;
  at: number;
  /**
   * Replies sent without a cap while an image held this measurement also landed in it: once the
   * image is booked by its task, the rest of the drop is theirs.
   */
  extra?: boolean;
  /**
   * False when a send in it went without a cap (no price bound it): a cost the balance hides is
   * then unmeasured, never the rest of a budget set since. Absent in older files: capped.
   */
  capped?: boolean;
};

export type BillingPause = '' | 'budget' | 'freeCharged';

export type RelayCharacter = { npcId: string; name: string; group: boolean };

/** One welcome this bot gave: to whom (`ownerKey`) and with which character. */
export type WelcomeRecord = { owner: string; npcId: string; at: number };

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
  /**
   * A money pause ('' when none): lifted by a new /budget (or `/budget none`), or by a restart
   * whose limits allow spending again.
   */
  billingPause: BillingPause;
  /** The relay's own AI notice (until the server injects one), per character. */
  noticeAt: Record<string, number>;
  /** Characters whose opening was shown here. */
  greeted: string[];
  /**
   * The owners this bot welcomed, newest last, at most 20. A file from before welcomes starts with
   * its owner then as welcomed (`npcId` its character or '', `at` 0), so an upgrade sends nothing.
   */
  welcomed: WelcomeRecord[];
  /** The bound owner (`ownerKey`) is owed the welcome; '' when nobody is. */
  welcomeDue: string;
  /** The chat's message ref (Telegram message id) → Yomi assistant mid, newest last. */
  replies: [number | string, string][];
  /** What a QQ or WeChat channel keeps itself (`channelStore`); absent until it writes something. */
  channel?: Record<string, unknown>;
};

const MAX_REPLIES = 500;
const MAX_WELCOMED = 20;

/** How an owner is kept in the welcome's records: never the chat user id itself. */
export const ownerKey = (userId: number | string) => sha256(String(userId)).slice(0, 16);

/**
 * Before budgets were optional, `free` with `setAt` 0 was the default nobody chose: it becomes
 * `open`. A `/budget off` (`setAt` set) and a `paid` budget stay as they were. A pause stays too:
 * whether it still holds depends on this run's `--max-spend` (the relay's `prepare`).
 */
function migratedBilling(billing: Billing): Billing {
  return billing.mode === 'free' && !billing.setAt ? { ...billing, mode: 'open' } : billing;
}

/**
 * The local ceiling for a run (null: none) over `allowance`: its running total starts over only
 * when this computer says so, a different `--max-spend` (set, changed or taken away) or
 * `--reset-spend`. Null when it stays as it is.
 */
export function allowanceFor(
  allowance: Allowance,
  maxSpend: number | null,
  reset: boolean,
): Allowance | null {
  if (reset || allowance.maxSpend !== maxSpend || allowance.since === 0)
    return { maxSpend, spent: 0, since: Date.now(), unmeasured: 0 };
  return null;
}

export const freshBilling = (): Billing => ({ mode: 'open', budget: 0, spent: 0, setAt: 0 });

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
    allowance: { maxSpend: null, spent: 0, since: 0, unmeasured: 0 },
    pending: null,
    billingPause: '',
    noticeAt: {},
    greeted: [],
    welcomed: [],
    welcomeDue: '',
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
        billing: migratedBilling({ ...freshBilling(), ...stored.billing }),
        allowance: { ...empty(scope, account, kind).allowance, ...stored.allowance },
        // Older files kept every pause in one field; only the money ones carry over.
        billingPause:
          stored.billingPause ?? (paused === 'budget' || paused === 'freeCharged' ? paused : ''),
        // Before welcomes, today's owner already had their start: they are not owed one.
        welcomed:
          stored.welcomed ??
          (stored.owner
            ? [
                {
                  owner: ownerKey(stored.owner.userId),
                  npcId: stored.character?.npcId ?? '',
                  at: 0,
                },
              ]
            : []),
        welcomeDue: stored.welcomed ? (stored.welcomeDue ?? '') : '',
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
        allowance: { ...this.data.allowance, spent: 0, since: Date.now(), unmeasured: 0 },
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

  /**
   * A new pairing: the next person agrees to spending afresh and sees none of the old replies. Who
   * was welcomed stays: the same owner pairing again is not welcomed twice.
   */
  resetOwner() {
    this.update({
      owner: null,
      billing: freshBilling(),
      billingPause: '',
      replies: [],
      welcomeDue: '',
    });
  }

  /**
   * The bot is bound to `owner` (a pairing in the chat, WeChat's login): owed the welcome unless
   * this bot welcomed them before. The only place that rule lives.
   */
  bindOwner(owner: RelayOwner) {
    const key = ownerKey(owner.userId);
    const welcomed = this.data.welcomed.some((record) => record.owner === key);
    this.update({ owner, welcomeDue: welcomed ? '' : key });
  }

  /** The bound owner is owed the welcome. */
  get welcomeOwed(): boolean {
    const owner = this.data.owner;
    return Boolean(
      owner && this.data.welcomeDue && this.data.welcomeDue === ownerKey(owner.userId),
    );
  }

  /** The bound owner was welcomed with `npcId` (saved before anything is sent: never twice). */
  markWelcomed(npcId: string) {
    const owner = this.data.owner;
    if (!owner) return;
    const key = ownerKey(owner.userId);
    const welcomed = [
      ...this.data.welcomed.filter((record) => record.owner !== key),
      { owner: key, npcId, at: Date.now() },
    ].slice(-MAX_WELCOMED);
    this.update({ welcomed, welcomeDue: '' });
  }

  /** The local ceiling for this run (null: none), by `allowanceFor`'s rule. */
  useAllowance(maxSpend: number | null, reset: boolean) {
    const allowance = allowanceFor(this.data.allowance, maxSpend, reset);
    if (allowance) this.update({ allowance });
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

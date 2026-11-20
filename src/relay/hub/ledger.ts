import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { configDir, readJsonFile, writeJsonFile } from '../../core/files.js';
import { tr } from '../../core/i18n.js';
import { LocalState, sha256 } from '../../core/state.js';
import type { ChannelKind } from '../channels/types.js';
import {
  type Allowance,
  allowanceFor,
  type BillingMode,
  type PendingCharge,
  RelayState,
  relayStatePath,
} from '../state.js';

/**
 * The money of one Yomi sign-in, whatever bots spend it: the local ceiling (`--max-spend`) and the
 * running total of everything spent through the relay, the one charge still to be measured from
 * the balance (`pending`), what images may still cost (`reserve`), and the spend window.
 *
 * The balance is the account's, so a drop measures every send made meanwhile: under a cap
 * (free-only included), where a measurement must be exact, a send holds the window from before its
 * reading until its cost is known, and another bot's waits (`SpendWindow`, first come first served,
 * given up after `SPEND_WAIT_MS`). Without a cap measuring is bookkeeping only and nothing waits
 * for the window.
 *
 * Where it is kept is the store's business (`LedgerStore`): a relay alone keeps it in its own
 * state file (`stateLedgerStore`), as it always has; the bots one process runs (relay/hub) share
 * `relay/ledger-<sha256(account)[0:16]>.json` (`LedgerFile`), made once from their state files
 * (`migrateLedger`). A budget set in a chat (`/budget`) is not here: it belongs to that bot's
 * owner.
 *
 * Shared by several bots (`shared`), a measurement is never another bot's to take or to book:
 * - The pending charge names its bot, and whoever settles it books it to that bot (`bookFor`):
 *   through its running relay; for a registered bot that is not running, in the running total now
 *   and owed to its budget until it starts again (`owed`, `takeOwed`); for a bot no longer
 *   registered, in the running total only.
 * - Only the window's holder settles it: a send without a cap measures by the balance only when
 *   the window is free, and otherwise goes at once, marking the open measurement before it goes
 *   (`markForeign`), and books what the server says it cost, else its quoted price (an estimate).
 *   So does one holding the window while the balance cannot be read and another bot's charge is
 *   still pending: that charge is never joined (its price, cap and mode stay that bot's).
 * - Images are booked by their task, never by the balance, and hold what they may still cost
 *   (`reserve`) until then, every registered bot's from the start of the process whether it runs
 *   or not (relay/hub); under a ceiling one is checked and held inside the window. One asked for
 *   during a measurement marks it, and so does one still held when a measurement starts.
 * - A charge settled for another bot after the balance rose is estimated from that bot's cap
 *   (`leftFor`), never the settling bot's.
 * - A measurement marked so books at most its own quoted price when that is known.
 */

/** How long a send under a cap waits for another bot's measurement before it gives up (not sent). */
export const SPEND_WAIT_MS = 90_000;

/** Where the ledger keeps its figures; every write is kept at once. */
export interface LedgerStore {
  allowance(): Allowance;
  setAllowance(allowance: Allowance): void;
  pending(): PendingCharge | null;
  setPending(pending: PendingCharge | null): void;
  /** No ceiling was set on this computer yet: the first one is taken as is (`useAllowance`). */
  ceilingUnset?(): boolean;
  /** What bots that were not running were found to have spent, for their budgets (shared). */
  owed?(): OwedCharge[];
  setOwed?(owed: OwedCharge[]): void;
}

/**
 * Gems a registered bot spent that another bot's settlement found while it was not running: in
 * the running total already, still to be booked to its own budget when it starts (`takeOwed`).
 */
export type OwedCharge = { bot: string; amount: number; mode: BillingMode };

/** A relay's own state file as its ledger's store (`allowance` and `pending`). */
export function stateLedgerStore(state: RelayState): LedgerStore {
  return {
    allowance: () => state.data.allowance,
    setAllowance: (allowance) => state.update({ allowance }),
    pending: () => state.data.pending,
    setPending: (pending) => state.update({ pending }),
  };
}

/** The window, held: `release` lets the next bot in (more calls do nothing). */
export type Lease = { readonly bot: string; release(): void };

type Waiter = { bot: string; grant: (lease: Lease) => void };

/** One measured send at a time, first come first served. */
export class SpendWindow {
  private current: Lease | null = null;
  private readonly queue: Waiter[] = [];

  constructor(readonly waitMs = SPEND_WAIT_MS) {}

  /** The bot holding the window, '' when it is free. */
  get holder(): string {
    return this.current?.bot ?? '';
  }

  /** The window now, or null when it is held or others are already waiting for it. */
  tryAcquire(bot: string): Lease | null {
    if (this.current || this.queue.length) return null;
    return this.grant(bot);
  }

  /**
   * The window, once the bots before this one let go: 'busy' after `waitMs`, 'aborted' when
   * `signal` aborts first.
   */
  acquire(bot: string, signal?: AbortSignal): Promise<Lease | 'busy' | 'aborted'> {
    const now = this.tryAcquire(bot);
    if (now) return Promise.resolve(now);
    if (signal?.aborted) return Promise.resolve('aborted');
    return new Promise((resolve) => {
      const leave = (result: 'busy' | 'aborted') => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        settle();
        resolve(result);
      };
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => leave('aborted');
      const waiter: Waiter = {
        bot,
        grant: (lease) => {
          settle();
          resolve(lease);
        },
      };
      const timer = setTimeout(() => leave('busy'), this.waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private grant(bot: string): Lease {
    let released = false;
    const lease: Lease = {
      bot,
      release: () => {
        if (released) return;
        released = true;
        if (this.current !== lease) return;
        this.current = null;
        const next = this.queue.shift();
        if (next) next.grant(this.grant(next.bot));
      },
    };
    this.current = lease;
    return lease;
  }
}

/** How a bot books what another bot's settlement found it spent (its relay's own `book`). */
export type Booker = (amount: number, mode: BillingMode) => Promise<void>;

/** Where another bot's settlement went: its relay, its owed amount, or the running total only. */
export type BookedFor = 'booked' | 'owed' | 'total';

export class Ledger {
  readonly window: SpendWindow;
  /** Several bots spend through it (relay/hub): see the rules above. */
  readonly shared: boolean;
  /** What images asked for may still cost, by key, until they are booked or let go. */
  private readonly reserved = new Map<string, { bot: string; amount: number }>();
  /** The running bots' own booking, and what each may still spend, by bot. */
  private readonly bookers = new Map<string, { book: Booker; left: () => number }>();
  /** A send without a measurement went while the window was held and nothing was pending yet. */
  private foreignSoon = false;
  /** Owed amounts, when the store keeps none. */
  private owedHere: OwedCharge[] = [];
  /** Whether a bot is still registered (its owed amounts are kept); every bot when not given. */
  private readonly isBot: (bot: string) => boolean;

  constructor(
    private readonly store: LedgerStore,
    options: { waitMs?: number; shared?: boolean; isBot?: (bot: string) => boolean } = {},
  ) {
    this.window = new SpendWindow(options.waitMs);
    this.shared = Boolean(options.shared);
    this.isBot = options.isBot ?? (() => true);
  }

  /** The local ceiling of this run (`useAllowance`): null, none; 0, free replies only. */
  get maxSpend(): number | null {
    return this.store.allowance().maxSpend;
  }

  /** Gems spent through the relay since the running total started (with or without a ceiling). */
  get spent(): number {
    return this.store.allowance().spent;
  }

  /** Sends whose cost could not be measured meanwhile: `spent` is a lower bound above 0. */
  get unmeasured(): number {
    return this.store.allowance().unmeasured;
  }

  /** What is left under the ceiling, less what images may still cost; Infinity without one. */
  ceilingLeft(): number {
    const ceiling = this.maxSpend;
    if (ceiling === null) return Infinity;
    return ceiling - this.spent - this.held();
  }

  /** What images asked for may still cost, held from the ceiling. */
  held(): number {
    let held = 0;
    for (const { amount } of this.reserved.values()) held += amount;
    return held;
  }

  /**
   * The ceiling for this run (`allowanceFor`: the total starts over only when it changed). A store
   * whose ceiling this computer has not set yet (`ceilingUnset`, a ledger made from older state
   * files) takes the first one as it is, keeping its total.
   */
  useAllowance(maxSpend: number | null, reset: boolean) {
    const current = this.store.allowance();
    if (!reset && this.store.ceilingUnset?.()) {
      this.store.setAllowance({ ...current, maxSpend, since: current.since || Date.now() });
      return;
    }
    const allowance = allowanceFor(current, maxSpend, reset);
    if (allowance) this.store.setAllowance(allowance);
  }

  /** `amount` gems `bot` spent, in the running total; the new total. */
  book(_bot: string, amount: number): number {
    const allowance = this.store.allowance();
    const spent = allowance.spent + amount;
    this.store.setAllowance({ ...allowance, spent });
    return spent;
  }

  /** A send whose cost nothing could measure. */
  countUnmeasured() {
    const allowance = this.store.allowance();
    this.store.setAllowance({ ...allowance, unmeasured: allowance.unmeasured + 1 });
  }

  /**
   * Holds `amount` gems of the ceiling for `bot` under `key` (one per key: a new one replaces it)
   * until the returned function lets go of it. Shared, an image's charge may land in the open
   * measurement: it is marked.
   */
  reserve(bot: string, amount: number, key: string): () => void {
    const entry = { bot, amount: Math.max(0, amount) };
    this.reserved.set(key, entry);
    if (this.shared) this.markForeign();
    return () => {
      if (this.reserved.get(key) === entry) this.reserved.delete(key);
    };
  }

  /** Lets go of what is held under `key`, whoever held it (an image booked or forgotten). */
  unreserve(key: string) {
    this.reserved.delete(key);
  }

  /** Something no measurement covers was spent: the open one (or the next of this window) is marked. */
  markForeign() {
    const pending = this.store.pending();
    if (pending) {
      if (!pending.foreign) this.store.setPending({ ...pending, foreign: true });
    } else if (this.window.holder) this.foreignSoon = true;
  }

  /**
   * Whether the measurement now starting is marked already: something was spent beside it, or an
   * image held from the ceiling (any bot's) may still be charged into it. The mark is taken
   * either way.
   */
  takeForeign(): boolean {
    const foreign = this.foreignSoon || this.imagesOpen();
    this.foreignSoon = false;
    return foreign;
  }

  /** Some image is still held from the ceiling: its charge may land in any measurement. */
  imagesOpen(): boolean {
    return this.reserved.size > 0;
  }

  /**
   * `bot` books what is settled for it while it runs, and says what it may still spend (`left`:
   * its budget's rest under the ceiling; the ceiling's rest when not given); the returned function
   * stops that.
   */
  register(bot: string, booker: Booker, left?: () => number): () => void {
    const entry = { book: booker, left: left ?? (() => this.ceilingLeft()) };
    this.bookers.set(bot, entry);
    return () => {
      if (this.bookers.get(bot) === entry) this.bookers.delete(bot);
    };
  }

  /**
   * What `bot` may still spend: its running relay's word, else what is left under the ceiling
   * (Infinity without one).
   */
  leftFor(bot: string): number {
    return this.bookers.get(bot)?.left() ?? this.ceilingLeft();
  }

  /**
   * `amount` gems `bot` spent, found by another bot's settlement: booked by `bot`'s relay (its
   * budget, its pauses) when it runs ('booked'); else in the running total now and, for a bot
   * still registered, owed to its budget until it starts again ('owed'); else in the running
   * total only ('total'). `except`: a booker that must not take it (a relay that has ended books
   * what came back late as owed, to its next run).
   */
  async bookFor(
    bot: string,
    amount: number,
    mode: BillingMode,
    except?: Booker,
  ): Promise<BookedFor> {
    const booker = this.bookers.get(bot)?.book;
    if (booker && booker !== except) {
      await booker(amount, mode);
      return 'booked';
    }
    if (amount <= 0) return 'total';
    this.book(bot, amount);
    if (!this.isBot(bot)) return 'total';
    const owed = this.owed();
    const same = owed.find((entry) => entry.bot === bot && entry.mode === mode);
    this.setOwed(
      same
        ? owed.map((entry) =>
            entry === same ? { ...entry, amount: entry.amount + amount } : entry,
          )
        : [...owed, { bot, amount, mode }],
    );
    return 'owed';
  }

  /** What `bot` was found to have spent while it was not running (in the total already), taken. */
  takeOwed(bot: string): OwedCharge[] {
    const owed = this.owed();
    const mine = owed.filter((entry) => entry.bot === bot);
    if (mine.length) this.setOwed(owed.filter((entry) => entry.bot !== bot));
    return mine;
  }

  private owed(): OwedCharge[] {
    return this.store.owed?.() ?? this.owedHere;
  }

  private setOwed(owed: OwedCharge[]) {
    if (this.store.setOwed) this.store.setOwed(owed);
    else this.owedHere = owed;
  }

  /** The charge still to be measured from the balance, at most one. */
  get pending(): PendingCharge | null {
    return this.store.pending();
  }

  setPending(pending: PendingCharge | null) {
    this.store.setPending(pending);
  }
}

/** The ledger the bots of one process share (`LedgerFileStore`). */
export type LedgerFile = {
  version: 1;
  account: string;
  /** The Yomi user it counts for: another one starts it over (`bindAccount`). */
  yomiUserId: string;
  allowance: Allowance;
  pending: PendingCharge | null;
  /** What bots not running were found to have spent, still to be booked to their budgets. */
  owed?: OwedCharge[];
  /** Made from older state files: their ceilings were not this computer's choice for all bots. */
  ceilingUnset?: boolean;
};

export function ledgerPath(account: string, dir = configDir()): string {
  return join(dir, 'relay', `ledger-${sha256(account).slice(0, 16)}.json`);
}

const freshAllowance = (): Allowance => ({ maxSpend: null, spent: 0, since: 0, unmeasured: 0 });

/** `relay/ledger-<hash>.json` (0600) as a ledger's store; read once, written on every change. */
export class LedgerFileStore implements LedgerStore {
  private constructor(
    readonly path: string,
    public data: LedgerFile,
  ) {}

  /** The file as it is (empty when there is none or it cannot be read). */
  static open(account: string, dir = configDir()): LedgerFileStore {
    const path = ledgerPath(account, dir);
    const stored = readJsonFile<Partial<LedgerFile>>(path);
    const data: LedgerFile = {
      version: 1,
      account,
      yomiUserId: typeof stored?.yomiUserId === 'string' ? stored.yomiUserId : '',
      allowance: { ...freshAllowance(), ...stored?.allowance },
      pending: stored?.pending ?? null,
      ...(Array.isArray(stored?.owed) && stored.owed.length ? { owed: stored.owed } : {}),
      ...(stored?.ceilingUnset ? { ceilingUnset: true } : {}),
    };
    return new LedgerFileStore(path, data);
  }

  allowance(): Allowance {
    return this.data.allowance;
  }

  setAllowance(allowance: Allowance) {
    this.data.allowance = allowance;
    delete this.data.ceilingUnset;
    this.save();
  }

  pending(): PendingCharge | null {
    return this.data.pending;
  }

  setPending(pending: PendingCharge | null) {
    this.data.pending = pending;
    this.save();
  }

  ceilingUnset(): boolean {
    return Boolean(this.data.ceilingUnset);
  }

  owed(): OwedCharge[] {
    return this.data.owed ?? [];
  }

  setOwed(owed: OwedCharge[]) {
    if (owed.length) this.data.owed = owed;
    else delete this.data.owed;
    this.save();
  }

  /**
   * The signed-in Yomi user: another one than the ledger's starts its total over and drops its
   * pending charge and what bots owe (their gems are not this account's). True when it did.
   */
  bindAccount(userId: string): boolean {
    const previous = this.data.yomiUserId;
    if (previous === userId) return false;
    this.data.yomiUserId = userId;
    if (previous) {
      this.data.allowance = {
        ...this.data.allowance,
        spent: 0,
        since: Date.now(),
        unmeasured: 0,
      };
      this.data.pending = null;
      delete this.data.owed;
    }
    this.save();
    return Boolean(previous);
  }

  save() {
    writeJsonFile(this.path, this.data);
  }
}

/** A bot whose state file a shared ledger is made from (its registry record's names). */
export type LedgerBot = { kind: ChannelKind; scope: string };

/** Where a relay keeps its image request (relay.ts), by its scope, in its `LocalState`. */
export const IMAGE_RECORDS = 'relay-chat-image';

/** A bot's local records (its image request), as its relay keeps them. */
export function botRecords(account: string, scope: string, userId: string, dir = configDir()) {
  return new LocalState(`relay|${account}|${scope}`, userId, dir);
}

/**
 * The shared ledger, made once from the bots' state files when it does not exist yet (design
 * §4.3): their running totals added up (since the earliest), the ceiling left for this computer to
 * set (`ceilingUnset`: the first `--max-spend` is taken without starting the total over), and
 * their pending charges. A bot's charge that measured its kept image (of Yomi user `userId`) is
 * given up: the image is booked by its task alone (its record says so from now on). Of the
 * others, the latest one moves into the ledger as that bot's; any earlier one is booked now, at
 * its quoted price, else the drop to the next one's reading (logged). The charges are taken out of
 * the state files (the only change to them); their totals stay. Only a process holding the
 * environment's lock calls it: no relay of these bots runs meanwhile.
 */
export function migrateLedger(
  account: string,
  userId: string,
  bots: readonly LedgerBot[],
  log: (line: string) => void,
  dir = configDir(),
): LedgerFileStore {
  const store = LedgerFileStore.open(account, dir);
  if (existsSync(store.path)) return store;
  const states: { bot: LedgerBot; state: RelayState }[] = [];
  for (const bot of bots) {
    const path = relayStatePath(account, bot.scope, dir);
    if (existsSync(path))
      states.push({ bot, state: new RelayState(path, bot.scope, account, bot.kind) });
  }
  const allowance = freshAllowance();
  for (const { state } of states) {
    const own = state.data.allowance;
    allowance.spent += own.spent;
    allowance.unmeasured += own.unmeasured;
    if (own.since && (!allowance.since || own.since < allowance.since)) allowance.since = own.since;
  }
  const charged = states.filter(({ state }) => state.data.pending);
  const pendings = charged
    .filter(({ bot, state }) => {
      const records = botRecords(account, bot.scope, userId, dir);
      const image = records.record<{ measured?: boolean }>(IMAGE_RECORDS, bot.scope);
      if (!image || image.measured === false) return true;
      // The image's own measurement: the replies that rode along it are unmeasured.
      if (state.data.pending!.extra) allowance.unmeasured += 1;
      records.setRecord(IMAGE_RECORDS, bot.scope, { ...image, measured: false });
      return false;
    })
    .sort((a, b) => a.state.data.pending!.at - b.state.data.pending!.at);
  const latest = pendings.at(-1);
  pendings.forEach(({ state }, index) => {
    const pending = state.data.pending!;
    if (state === latest?.state) return;
    const next = pendings[index + 1].state.data.pending!;
    const amount = pending.price ?? Math.max(0, pending.before - next.before);
    allowance.spent += amount;
    const billing = state.data.billing;
    if (billing.mode === 'paid' && amount > 0)
      state.update({ billing: { ...billing, spent: billing.spent + amount } });
    log(
      tr(
        `合并花费记录：一条更早的待核对花费按 ${amount} 钻石计入`,
        `Merging the spending records: an earlier cost still to be checked is counted as ${amount} gems`,
        `Al unir los registros de gasto, un costo anterior aún por verificar se cuenta como ${amount} gemas`,
        `Ao juntar os registros de gastos, um custo anterior ainda a conferir foi contado como ${amount} gemas`,
      ),
    );
  });
  store.data = {
    version: 1,
    account,
    yomiUserId: states.find(({ state }) => state.data.yomiUserId)?.state.data.yomiUserId ?? '',
    allowance,
    pending: latest ? { ...latest.state.data.pending!, bot: latest.bot.scope } : null,
    ceilingUnset: true,
  };
  store.save();
  for (const { state } of charged) state.update({ pending: null });
  return store;
}

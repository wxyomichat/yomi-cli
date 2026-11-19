import { type Allowance, allowanceFor, type PendingCharge, type RelayState } from '../state.js';

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
 * state file (`stateLedgerStore`), as it always has. A budget set in a chat (`/budget`) is not
 * here: it belongs to that bot's owner.
 */

/** How long a send under a cap waits for another bot's measurement before it gives up (not sent). */
export const SPEND_WAIT_MS = 90_000;

/** Where the ledger keeps its figures; every write is kept at once. */
export interface LedgerStore {
  allowance(): Allowance;
  setAllowance(allowance: Allowance): void;
  pending(): PendingCharge | null;
  setPending(pending: PendingCharge | null): void;
}

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

export class Ledger {
  readonly window: SpendWindow;
  /** What images asked for may still cost, by key, until they are booked or let go. */
  private readonly reserved = new Map<string, { bot: string; amount: number }>();

  constructor(
    private readonly store: LedgerStore,
    options: { waitMs?: number } = {},
  ) {
    this.window = new SpendWindow(options.waitMs);
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
    let reserved = 0;
    for (const { amount } of this.reserved.values()) reserved += amount;
    return ceiling - this.spent - reserved;
  }

  /** The ceiling for this run (`allowanceFor`: the total starts over only when it changed). */
  useAllowance(maxSpend: number | null, reset: boolean) {
    const allowance = allowanceFor(this.store.allowance(), maxSpend, reset);
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
   * until the returned function lets go of it.
   */
  reserve(bot: string, amount: number, key: string): () => void {
    const entry = { bot, amount: Math.max(0, amount) };
    this.reserved.set(key, entry);
    return () => {
      if (this.reserved.get(key) === entry) this.reserved.delete(key);
    };
  }

  /** The charge still to be measured from the balance, at most one. */
  get pending(): PendingCharge | null {
    return this.store.pending();
  }

  setPending(pending: PendingCharge | null) {
    this.store.setPending(pending);
  }
}

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import type { Gateway } from '../../core/api.js';
import { configDir, writeJsonFile } from '../../core/files.js';
import { tr } from '../../core/i18n.js';
import { sha256 } from '../../core/state.js';
import type { SocketFactory } from '../../im/connection.js';
import { RelayStopped } from '../channels/types.js';
import type { RelayServices } from '../relay.js';
import { ImFeed } from './feed.js';
import {
  botRecords,
  IMAGE_RECORDS,
  Ledger,
  type LedgerBot,
  type LedgerFileStore,
  migrateLedger,
} from './ledger.js';
import { PolicyService } from './policy.js';
import { SessionGate } from './session.js';
import { type BotStatus, Supervisor, type SupervisorOptions } from './supervisor.js';

/**
 * `RelayHub`: every bot of one Yomi account and environment in one process (design §2): one
 * sign-in (`SessionGate`), one long connection whose events go to the bot of their character
 * (`ImFeed`), one policy read per kind of channel (`PolicyService`) and one ledger
 * (`relay/ledger-<hash>.json`: the `--max-spend` ceiling for the whole process and its running
 * total, the one pending charge, what images may still cost, the spend window). Without a cap no
 * bot ever waits for another's measurement; under one, measured sends take turns (hub/ledger.ts).
 * What every registered bot's kept image may still cost is held from the ceiling from the start,
 * whether that bot runs in this process or not.
 *
 * Each bot runs under its own `Supervisor`: one that stops (a 409, refused credentials, a crash
 * loop) stops alone and the others go on; a crash starts it again after a pause. A rejection
 * nobody handled is logged, never the end of the process. Another Yomi account signing in ends
 * every bot (`RelayStopped('otherAccount')`).
 *
 * The hub writes what each bot is doing to `relay/hub-<hash>.status.json` while it runs (`yomi
 * relay --list` reads it when the process that holds the environment's lock wrote it), and
 * removes it at the end. It does not take locks: whoever runs it holds the environment's and each
 * bot's (commands/relay.ts).
 */

/** A bot the hub runs: its registry name, and one run of its relay with the shared services. */
export type HubBot = {
  name: string;
  run: (services: RelayServices, signal: AbortSignal) => Promise<void | 'unavailable'>;
};

export type RelayHubOptions = {
  account: string;
  log: (line: string) => void;
  /** The process-wide ceiling (`--max-spend`): null, none; 0, free replies only. */
  maxSpend: number | null;
  resetSpend?: boolean;
  /** The bots whose state files make the shared ledger the first time (all registered ones). */
  ledgerBots: readonly LedgerBot[];
  /** A background service: with no bot running it stays up until it is stopped. */
  keepAlive?: boolean;
  /** A bot stopped for good: why (null: it could not start, already said). */
  onStopped?: (name: string, error: Error | null) => void;
  createSocket?: SocketFactory;
  resumeCheckMs?: number;
  /** How long a capped send waits for another bot's measurement (90 s). */
  waitMs?: number;
  /** The supervisors' timings (tests). */
  supervisor?: Pick<
    SupervisorOptions,
    'backoffMs' | 'maxBackoffMs' | 'healthyMs' | 'crashWindowMs' | 'maxCrashes'
  >;
  dir?: string;
};

export type HubStatusFile = {
  pid: number;
  startedAt: number;
  bots: Record<string, { status: BotStatus; reason: string; since: number }>;
};

export function hubStatusPath(account: string, dir = configDir()): string {
  return join(dir, 'relay', `hub-${sha256(account).slice(0, 16)}.status.json`);
}

export class RelayHub {
  readonly services: RelayServices;
  readonly store: LedgerFileStore;
  private readonly statusPath: string;
  private readonly status: HubStatusFile = { pid: process.pid, startedAt: 0, bots: {} };

  constructor(
    gateway: Gateway,
    private readonly options: RelayHubOptions,
  ) {
    const log = options.log;
    const onError = (error: unknown) => log(failure(error));
    const session = new SessionGate(gateway, {
      log,
      resumeCheckMs: options.resumeCheckMs,
      onError,
    });
    const feed = new ImFeed(gateway, session, { log, createSocket: options.createSocket, onError });
    const userId = gateway.requireCredential().userId;
    this.store = migrateLedger(options.account, userId, options.ledgerBots, log, options.dir);
    if (this.store.bindAccount(userId))
      log(
        tr(
          '这台电脑上登录的 Yomi 账号和上次不同：relay 的累计花费已重新计算',
          "A different Yomi account is signed in on this machine than last time: the relay's running spending total starts over",
          'En este equipo inició sesión una cuenta de Yomi distinta de la última vez: el total acumulado de gasto del relay empieza de nuevo',
          'Uma conta do Yomi diferente da última vez está conectada nesta máquina: o total acumulado de gastos do relay recomeça',
        ),
      );
    // What a bot no longer registered spent goes in the running total only.
    const registered = new Set(options.ledgerBots.map((bot) => bot.scope));
    const ledger = new Ledger(this.store, {
      waitMs: options.waitMs,
      shared: true,
      isBot: (bot) => registered.has(bot),
    });
    ledger.useAllowance(options.maxSpend, Boolean(options.resetSpend));
    // Every registered bot's kept image may still be charged (on delivery, relay or not): it is
    // held from the ceiling from the start, under the key its relay holds it by (`image:<scope>`),
    // so a bot that runs takes the hold over and lets go of it once the image is booked.
    for (const bot of options.ledgerBots) {
      const image = botRecords(options.account, bot.scope, userId, options.dir).record<{
        price: number;
        worst?: number | null;
      }>(IMAGE_RECORDS, bot.scope);
      if (image) ledger.reserve(bot.scope, image.worst ?? image.price, `image:${bot.scope}`);
    }
    this.services = { feed, session, policy: new PolicyService(gateway), ledger };
    this.statusPath = hubStatusPath(options.account, options.dir);
  }

  /**
   * Runs `bots` until `signal` aborts, or every one has stopped for good (a background service
   * then stays up until it is stopped). 'aborted' or 'ended'; another Yomi account signing in
   * rejects with `RelayStopped('otherAccount')` once every bot has stopped.
   */
  async run(bots: readonly HubBot[], signal: AbortSignal): Promise<'aborted' | 'ended'> {
    const { feed, session } = this.services;
    const all = new AbortController();
    const onAbort = () => all.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let otherAccount: RelayStopped | null = null;
    const onRejection = (reason: unknown) => this.options.log(failure(reason));
    process.on('unhandledRejection', onRejection);
    this.status.startedAt = Date.now();
    this.writeStatus();
    feed.start();
    try {
      await Promise.all(
        bots.map((bot) =>
          new Supervisor(bot.name, (child) => bot.run(this.services, child), {
            ...this.options.supervisor,
            log: this.options.log,
            onStatus: (status, reason) => {
              this.status.bots[bot.name] = { status, reason, since: Date.now() };
              this.writeStatus();
            },
            onStopped: (error) => this.options.onStopped?.(bot.name, error),
            onOtherAccount: (error) => {
              otherAccount ??= error;
              all.abort();
            },
          }).supervise(all.signal),
        ),
      );
      if (otherAccount) throw otherAccount;
      if (!all.signal.aborted && this.options.keepAlive) await aborted(all.signal);
      return signal.aborted ? 'aborted' : 'ended';
    } finally {
      signal.removeEventListener('abort', onAbort);
      feed.close();
      session.close();
      process.removeListener('unhandledRejection', onRejection);
      rmSync(this.statusPath, { force: true });
    }
  }

  private writeStatus() {
    try {
      writeJsonFile(this.statusPath, this.status);
    } catch (error) {
      this.options.log(failure(error));
    }
  }
}

function failure(error: unknown): string {
  const detail = error instanceof Error ? `${error.name} ${error.message}`.slice(0, 200) : 'error';
  return tr(
    `relay 出错：${detail}`,
    `Relay error: ${detail}`,
    `Error del relay: ${detail}`,
    `Erro do relay: ${detail}`,
  );
}

const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

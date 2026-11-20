import { UsageError } from '../../core/env.js';
import { tr } from '../../core/i18n.js';
import { RelayStopped } from '../channels/types.js';

/**
 * One bot of a relay that runs several, kept running on its own: what one bot does never stops
 * another (design §2.5).
 *
 * - Each run gets its own signal under the process's.
 * - A run that ends for a reason a restart cannot fix (`RelayStopped`: Telegram's 409, a refused
 *   token, QQ's close codes, WeChat's ended login; or a `UsageError`: credentials of another bot, a
 *   character another bot has) stops this bot only, and says why.
 * - Anything else that escapes a run is a crash: the run has ended and cleaned up (`Relay.run`'s
 *   own finally), and a new one starts after a pause that doubles from `backoffMs` up to
 *   `maxBackoffMs`. A run that lasted `healthyMs` starts the count over; `maxCrashes` crashes within
 *   `crashWindowMs` stop the bot (`crashed`).
 * - Another Yomi account signed in (`RelayStopped('otherAccount')`) is the process's end, not the
 *   bot's: it is passed on (`onOtherAccount`).
 */

/**
 * One run of the bot: resolves when it ends, rejects with why; 'unavailable' when it could not
 * start (it said why).
 */
export type BotRun = (signal: AbortSignal) => Promise<void | 'unavailable'>;

export type BotStatus = 'starting' | 'running' | 'restarting' | 'stopped';

export type SupervisorOptions = {
  log: (line: string) => void;
  /** The bot's state changed (`reason`: why it stopped or crashed, '' otherwise). */
  onStatus?: (status: BotStatus, reason: string) => void;
  /** The bot stopped for good: why (null: it could not start, already said). */
  onStopped?: (error: Error | null) => void;
  /** Another Yomi account signed in: every bot of the process stops. */
  onOtherAccount?: (error: RelayStopped) => void;
  backoffMs?: number;
  maxBackoffMs?: number;
  healthyMs?: number;
  crashWindowMs?: number;
  maxCrashes?: number;
};

/** A reason the bot stops for good, rather than starting again. */
export function stopsForGood(error: unknown): error is Error {
  return error instanceof RelayStopped || error instanceof UsageError;
}

const message = (error: unknown) =>
  error instanceof Error ? `${error.name} ${error.message}`.slice(0, 200) : String(error);

export class Supervisor {
  constructor(
    readonly name: string,
    private readonly run: BotRun,
    private readonly options: SupervisorOptions,
  ) {}

  /** Runs the bot until `signal` aborts or it stops for good. Never rejects. */
  async supervise(signal: AbortSignal): Promise<void> {
    const backoff = this.options.backoffMs ?? 1000;
    const maxBackoff = this.options.maxBackoffMs ?? 5 * 60 * 1000;
    const healthy = this.options.healthyMs ?? 10 * 60 * 1000;
    const window = this.options.crashWindowMs ?? 60 * 60 * 1000;
    const maxCrashes = this.options.maxCrashes ?? 10;
    let crashes: number[] = [];
    let pause = backoff;
    this.status('starting', '');
    while (!signal.aborted) {
      const child = new AbortController();
      const onAbort = () => child.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const startedAt = Date.now();
      let error: unknown = null;
      try {
        this.status('running', '');
        if ((await this.run(child.signal)) === 'unavailable') {
          this.status('stopped', '');
          this.options.onStopped?.(null);
          return;
        }
      } catch (thrown) {
        error = thrown;
      } finally {
        signal.removeEventListener('abort', onAbort);
        child.abort();
      }
      if (signal.aborted) break;
      if (error instanceof RelayStopped && error.reason === 'otherAccount') {
        this.status('stopped', error.message);
        this.options.onOtherAccount?.(error);
        return;
      }
      if (stopsForGood(error)) {
        this.status('stopped', error.message);
        this.options.onStopped?.(error);
        return;
      }
      // Ended without a reason while the process goes on: started again like a crash.
      const now = Date.now();
      if (now - startedAt >= healthy) {
        crashes = [];
        pause = backoff;
      }
      crashes = [...crashes.filter((at) => now - at < window), now];
      const reason = error ? message(error) : '';
      if (crashes.length >= maxCrashes) {
        const crashed = new Error(crashedText(this.name, reason));
        this.status('stopped', crashed.message);
        this.options.onStopped?.(crashed);
        return;
      }
      this.options.log(
        tr(
          `bot ${this.name} 意外停止${reason ? `（${reason}）` : ''}：${Math.round(pause / 1000)} 秒后重新启动`,
          `The bot ${this.name} stopped unexpectedly${reason ? ` (${reason})` : ''}: starting it again in ${Math.round(pause / 1000)} s`,
          `El bot ${this.name} se detuvo de forma inesperada${reason ? ` (${reason})` : ''}: se reinicia en ${Math.round(pause / 1000)} s`,
          `O bot ${this.name} parou inesperadamente${reason ? ` (${reason})` : ''}: reiniciando em ${Math.round(pause / 1000)} s`,
        ),
      );
      this.status('restarting', reason);
      await sleep(pause, signal);
      pause = Math.min(pause * 2, maxBackoff);
    }
    this.status('stopped', '');
  }

  private status(status: BotStatus, reason: string) {
    this.options.onStatus?.(status, reason);
  }
}

function crashedText(name: string, reason: string): string {
  return tr(
    `bot ${name} 一小时内反复意外停止，不再重新启动${reason ? `（最后一次：${reason}）` : ''}。查看日志后重新启动 relay。`,
    `The bot ${name} kept stopping unexpectedly within an hour, so it is not started again${reason ? ` (last: ${reason})` : ''}. Check the log, then start the relay again.`,
    `El bot ${name} se detuvo de forma inesperada varias veces en una hora, así que no se vuelve a iniciar${reason ? ` (la última: ${reason})` : ''}. Revisa el registro y luego vuelve a iniciar el relay.`,
    `O bot ${name} parou inesperadamente várias vezes em uma hora, então não é iniciado de novo${reason ? ` (a última: ${reason})` : ''}. Confira o log e depois inicie o relay de novo.`,
  );
}

/** Waits `ms`, less when `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

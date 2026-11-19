import type { Gateway } from '../../core/api.js';
import { tr } from '../../core/i18n.js';

/**
 * The Yomi sign-in every bot of a process relays through: signed in, signed out (the bots pause),
 * back (they resume), or another account (they stop). One place notices it and looks for the
 * sign-in to come back, every `resumeCheckMs` (15 s), however many bots listen.
 */

export interface SessionListener {
  /** Signed out: stop what is open and tell the owner. */
  signedOut(): Promise<void> | void;
  /** Signed in again as the same user. */
  resumed(): Promise<void> | void;
  /** Another Yomi account signed in on this machine. */
  otherAccount(): void;
  /** What one of the calls above threw; the other listeners were told all the same. */
  failed(error: unknown): void;
}

export type SessionGateOptions = {
  log: (line: string) => void;
  resumeCheckMs?: number;
  /** What looking for the sign-in threw (it is looked for again all the same). */
  onError?: (error: unknown) => void;
};

export class SessionGate {
  private readonly listeners = new Set<SessionListener>();
  private out = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The user the process was started for: another one is another account. */
  private readonly userId: string;

  constructor(
    private readonly gateway: Gateway,
    private readonly options: SessionGateOptions,
  ) {
    this.userId = gateway.requireCredential().userId;
  }

  get signedOut(): boolean {
    return this.out;
  }

  /** Listeners are told in the order they subscribed; the returned function unsubscribes. */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The sign-in expired (a request said so): every listener pauses, once, until it is back. */
  async report(): Promise<void> {
    if (this.out || this.closed) return;
    this.options.log(
      tr(
        'Yomi 登录已失效，relay 暂停；在这台电脑上运行 yomi login 后自动恢复',
        'Yomi sign-in expired, relay paused; it resumes on its own after you run yomi login on this machine',
        'La sesión de Yomi expiró, relay en pausa; se reanuda solo cuando ejecutes yomi login en este equipo',
        'O login do Yomi expirou, relay pausado; ele volta sozinho depois que você executar yomi login nesta máquina',
      ),
    );
    this.out = true;
    await this.tell((listener) => listener.signedOut());
    if (this.closed) return;
    this.stopTimer();
    this.timer = setInterval(
      () => this.tryResume().catch((error) => this.options.onError?.(error)),
      this.options.resumeCheckMs ?? 15_000,
    );
    this.timer.unref?.();
  }

  /** Another account signed in: every listener stops. */
  otherAccount() {
    for (const listener of [...this.listeners]) {
      try {
        listener.otherAccount();
      } catch (error) {
        listener.failed(error);
      }
    }
  }

  /** Nothing more is noticed or told (the end of the process's relays). */
  close() {
    this.closed = true;
    this.stopTimer();
  }

  private async tryResume() {
    this.gateway.reloadCredential();
    const credential = this.gateway.credential;
    if (!credential) return;
    if (credential.userId !== this.userId) return this.otherAccount();
    this.stopTimer();
    this.out = false;
    this.options.log(
      tr(
        'Yomi 登录已恢复',
        'Yomi sign-in restored',
        'Sesión de Yomi restablecida',
        'Login do Yomi restabelecido',
      ),
    );
    await this.tell((listener) => listener.resumed());
  }

  /** Each listener in turn up to its first wait, then all of them together; one failing is its own. */
  private async tell(call: (listener: SessionListener) => Promise<void> | void) {
    await Promise.all(
      [...this.listeners].map(async (listener) => {
        try {
          await call(listener);
        } catch (error) {
          listener.failed(error);
        }
      }),
    );
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

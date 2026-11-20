import type { ChannelSetup } from '../../src/relay/channels/setup.js';
import {
  type BotIdentity,
  type ChannelKind,
  type InboundEvent,
  RelayStopped,
} from '../../src/relay/channels/types.js';
import { FakeChannel } from './fakeChannel.js';

/**
 * A channel's real `ChannelSetup` with its channel swapped for a `FakeChannel` while a test says
 * so: `yomi relay --channel <kind>` then runs its whole flow (flags, keychain check, sign-in,
 * production, lock, pairing, start-up lines, the relay itself) on a scripted channel, with the
 * setup's own names, texts, service words and lock. Used with `vi.mock` on the channel's module:
 *
 *   const fake = vi.hoisted(() => ({ on: false, opened: [] }));
 *   vi.mock('../src/relay/channels/qq.js', async (importOriginal) => {
 *     const real = await importOriginal<typeof import('../src/relay/channels/qq.js')>();
 *     const { fakeSetup } = await import('./helpers/fakeSetup.js');
 *     return { ...real, qqSetup: fakeSetup(real.qqSetup, fake) };
 *   });
 */

export type FakeSwitch = {
  /** true: open() gives a StoppingChannel; false: everything is the real setup's. */
  on: boolean;
  /** The channels open() gave, in order. */
  opened: FakeChannel[];
  /**
   * Run in place of the real setCredentials (--set-app, --login) while `on`; none: nothing is
   * asked or saved.
   */
  setCredentials?: () => void | Promise<void>;
  /** Run by each StoppingChannel as its relay asks for events (the relay runs), before it stops. */
  whileRunning?: () => void;
  /** Channels whose open() fails (a network error, say). */
  failOpen?: ChannelKind[];
  /**
   * How many channels opened from now on crash (a plain error) as their relay asks for events,
   * rather than stopping; the ones after them stop as usual, their bot's handle `handle`.
   */
  crashes?: number;
  handle?: string;
  /** Whether someone could be asked, by each open() (records it when set). */
  interactive?: boolean[];
  /**
   * open() needs the channel's stored secret, as a real one does: missing, it asks (counted in
   * `asked`, storing what was typed) when someone can answer, else opens nothing.
   */
  needsSecret?: boolean;
  asked?: number;
};

/** Connects, then stops the relay at once (`RelayStopped`) when it asks for events. */
export class StoppingChannel extends FakeChannel {
  static readonly message = 'stopped by the test';
  /** Run as the relay asks for events, before it stops. */
  whileRunning: (() => void) | null = null;

  override async *events(): AsyncIterable<InboundEvent> {
    this.whileRunning?.();
    throw new RelayStopped('conflict', StoppingChannel.message);
  }
}

/** Connects, then crashes (a plain error) when its relay asks for events. */
export class CrashingChannel extends StoppingChannel {
  static readonly crash = 'crashed by the test';

  override async *events(): AsyncIterable<InboundEvent> {
    this.whileRunning?.();
    throw new Error(CrashingChannel.crash);
  }
}

export function fakeSetup(
  real: ChannelSetup,
  fake: FakeSwitch,
  identity: BotIdentity = { id: '42', name: 'Lin bot', handle: '' },
): ChannelSetup {
  const overrides: Partial<ChannelSetup> = {
    // The channel's own credential flag (the command checked which flags the channel takes).
    wantsCredentials: (options) =>
      fake.on ? options.setApp || options.login : real.wantsCredentials(options),
    setCredentials: async (context, options) => {
      if (!fake.on) return real.setCredentials(context, options);
      await fake.setCredentials?.();
      return null;
    },
    open: async (context, options) => {
      if (!fake.on) return real.open(context, options);
      fake.interactive?.push(context.io.interactive);
      if (fake.failOpen?.includes(real.kind)) throw new Error(`${real.kind} could not open`);
      const secretName = real.secretName(context.account);
      if (fake.needsSecret && !context.store.getSecret(secretName)) {
        if (!context.io.interactive) return null;
        fake.asked = (fake.asked ?? 0) + 1;
        context.store.setSecret(secretName, 'typed in');
      }
      const crashing = Boolean(fake.crashes);
      if (crashing) fake.crashes = (fake.crashes ?? 0) - 1;
      const channel = crashing
        ? new CrashingChannel({ kind: real.kind, identity })
        : new StoppingChannel({
            kind: real.kind,
            identity: fake.handle ? { ...identity, handle: fake.handle } : identity,
          });
      channel.whileRunning = fake.whileRunning ?? null;
      fake.opened.push(channel);
      return channel;
    },
    verify: (channel) => (fake.on ? channel.verify() : real.verify(channel)),
  };
  // Everything else (getters included) is read from the real setup.
  return Object.assign(Object.create(real) as ChannelSetup, overrides);
}

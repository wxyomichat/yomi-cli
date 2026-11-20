import type { ChannelSetup, CredentialRequest } from '../../src/relay/channels/setup.js';
import type { BotRecord } from '../../src/relay/registry.js';
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
 * production, locks, pairing, start-up lines, the relay itself) on a scripted channel for a bot
 * registered with `registerFake`, with the setup's own names, texts and service words. Used with
 * `vi.mock` on the channel's module:
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
   * Run in place of the real setCredentials (--set-app, --login) while `on`, with what the command
   * asked for (it may keep a bot with `request.save`); none: nothing is asked or saved.
   */
  setCredentials?: (request: CredentialRequest) => void | Promise<void>;
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
  /** open() needs the bot's stored secret, as a real one does: missing, it opens nothing. */
  needsSecret?: boolean;
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
    setCredentials: async (context, request) => {
      if (!fake.on) return real.setCredentials(context, request);
      let kept: BotRecord | null = null;
      await fake.setCredentials?.({
        ...request,
        save: (bot, state) => (kept = request.save(bot, state)),
      });
      return kept;
    },
    open: async (context, record, options) => {
      if (!fake.on) return real.open(context, record, options);
      fake.interactive?.push(context.io.interactive);
      if (fake.failOpen?.includes(real.kind)) throw new Error(`${real.kind} could not open`);
      if (fake.needsSecret && !context.store.getSecret(record.secretName)) return null;
      const crashing = Boolean(fake.crashes);
      if (crashing) fake.crashes = (fake.crashes ?? 0) - 1;
      const named = fake.handle ? { ...identity, handle: fake.handle } : identity;
      const channel = crashing
        ? new CrashingChannel({ kind: real.kind, identity, scope: record.scope })
        : new StoppingChannel({ kind: real.kind, identity: named, scope: record.scope });
      channel.whileRunning = fake.whileRunning ?? null;
      fake.opened.push(channel);
      return channel;
    },
    verify: (channel) => (fake.on ? channel.verify() : real.verify(channel)),
  };
  // Everything else (getters included) is read from the real setup.
  return Object.assign(Object.create(real) as ChannelSetup, overrides);
}

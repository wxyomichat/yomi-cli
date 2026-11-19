import type { ChannelSetup } from '../../src/relay/channels/setup.js';
import {
  type BotIdentity,
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
};

/** Connects, then stops the relay at once (`RelayStopped`) when it asks for events. */
export class StoppingChannel extends FakeChannel {
  static readonly message = 'stopped by the test';

  override async *events(): AsyncIterable<InboundEvent> {
    throw new RelayStopped('conflict', StoppingChannel.message);
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
      const channel = new StoppingChannel({ kind: real.kind, identity });
      fake.opened.push(channel);
      return channel;
    },
    verify: (channel) => (fake.on ? channel.verify() : real.verify(channel)),
  };
  // Everything else (getters included) is read from the real setup.
  return Object.assign(Object.create(real) as ChannelSetup, overrides);
}

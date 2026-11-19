import { qqSetup } from './qq.js';
import type { ChannelSetup } from './setup.js';
import { telegramSetup } from './telegram.js';
import type { ChannelKind } from './types.js';
import { wechatSetup } from './wechat.js';

/**
 * The relay's channels: `yomi relay --channel <kind>` runs the setup listed here. Adding a
 * channel means a `ChannelKind`, a file exporting its `RelayChannel` and `ChannelSetup`, and a
 * line below.
 */
const SETUPS: Record<ChannelKind, ChannelSetup> = {
  telegram: telegramSetup,
  qq: qqSetup,
  wechat: wechatSetup,
};

export const channelSetup = (kind: ChannelKind): ChannelSetup => SETUPS[kind];

export type { ChannelSetup } from './setup.js';
export { CHANNEL_KINDS, type ChannelKind } from './types.js';

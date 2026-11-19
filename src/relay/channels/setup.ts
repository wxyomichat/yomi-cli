import type { Context } from '../../commands/context.js'; // type-only: no runtime cycle
import type { RelayCommandOptions } from '../../commands/relay.js';
import type { PairingCode } from '../pairing.js';
import type { BotIdentity, ChannelKind, RelayChannel } from './types.js';

/**
 * Who a stored secret belongs to, read offline from the secret alone: what the bot registry
 * (relay/registry.ts) keeps of a bot and checks every run against, so credentials of another bot
 * are never run under this bot's owner, budget and cursor.
 */
export type StoredBot = {
  /** Telegram: the bot id; QQ: the AppID; WeChat: ilink_bot_id ('' in older logins). */
  platformId: string;
  /** The relay state's scope, as the channel names it (`RelayChannel.scope`). */
  scope: string;
  /** The bot's lock, as the channel names it (`RelayChannel.lockName`). */
  lockName: string;
};

/**
 * What `yomi relay --channel <kind>` needs from a channel around the relay itself: its
 * credentials (asked, checked, kept in the keychain), how it is named in the terminal, how its
 * owner pairs, its lock and its background service. commands/relay.ts runs the same flow for
 * every channel (flags, --forget, the service, sign-in, production, the lock, pairing, the run)
 * and asks the channel's setup only for these.
 *
 * Each channel's file exports its setup next to its `RelayChannel` (`telegramSetup` in
 * channels/telegram.ts, `qqSetup` in channels/qq.ts, `wechatSetup` in channels/wechat.ts) and
 * channels/index.ts lists them. Which flags a channel takes is decided once, for all channels,
 * in commands/relay.ts (`channelFlagProblem`, design §6.2), before any of this is asked.
 */
export interface ChannelSetup {
  readonly kind: ChannelKind;
  /** 'yomi relay --telegram' | 'yomi relay --channel qq' | 'yomi relay --channel wechat --experimental' */
  readonly command: string;
  /** 'Telegram', 'QQ', 微信 / WeChat: in the terminal's language. */
  readonly displayName: string;
  /** Off unless `--experimental` is given (WeChat); the start-up says so. */
  readonly experimental: boolean;
  /** Marked "personal use only" in the help, the docs and at start-up (QQ, WeChat). */
  readonly personalUseOnly: boolean;
  /**
   * How messages name the secret, in the terminal's language and as it reads after an article
   * ("the bot token", "el token del bot"): 'bot token' | 'AppSecret' | 'bot_token'.
   */
  readonly secretLabel: string;
  /** The keychain entry: `telegram-bot:<account>` | `qq-bot:<account>` | `wechat-ilink:<account>`. */
  secretName(account: string): string;
  /**
   * True when the options ask to set credentials (`--set-token` / `--set-app` / `--login`). Asked
   * first on every run that is not --forget, --uninstall-service or --service-status, before the
   * keychain check and sign-in: a setup may refuse here (UsageError) what it cannot do at all.
   */
  wantsCredentials(options: RelayCommandOptions): boolean;
  /**
   * Asks for, checks and saves the credentials, then says what to do next. Resolves with the bot
   * as the platform named it when the check asked it (its name and handle for the registry), else
   * null.
   */
  setCredentials(context: Context, options: RelayCommandOptions): Promise<BotIdentity | null>;
  /**
   * Builds the channel from the stored secret, asking for one first when none is stored and the
   * channel can (a terminal, or --token-stdin). null after a warning (missing secret, nobody to
   * ask): a background service ends without failing, as a restart would not fix it.
   */
  open(context: Context, options: RelayCommandOptions): Promise<RelayChannel | null>;
  /**
   * channel.verify() with a refusal of the credentials mapped to a UsageError that says what to
   * do (a background service prints it and ends).
   */
  verify(channel: RelayChannel): Promise<BotIdentity>;
  /** The channel's `lockName` from a stored secret, offline (for --forget); null when unreadable. */
  lockNameOf(secret: string): string | null;
  /** Whose secret it is, offline (the bot registry); null when unreadable. */
  storedBot(secret: string): StoredBot | null;
  /** Shows a new pairing code ('code' pairing): what to send the bot, and where. */
  printPairing?(context: Context, code: PairingCode, identity: BotIdentity): void;
  /** Why a relay without an owner cannot start here, and what to run (a warning line). */
  unpairedHint(): string;
  /**
   * The background service's ExecStart words: `lead` right after 'relay', `trail` after
   * --character (where Telegram's --no-drafts always was).
   */
  serviceArgs(options: RelayCommandOptions): { lead: string[]; trail: string[] };
  /** Printed after --forget: how to make the deleted secret useless where it was issued. */
  forgetHint(): string;
  /** How the terminal names the bot in "Relay running: <label> ⇄ Yomi …" (Telegram `@username`). */
  label(identity: BotIdentity): string;
}

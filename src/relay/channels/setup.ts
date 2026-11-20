import type { Context } from '../../commands/context.js'; // type-only: no runtime cycle
import type { RelayCommandOptions } from '../../commands/relay.js';
import type { PairingCode } from '../pairing.js';
import type { BotRecord } from '../registry.js';
import type { RelayCharacter, RelayState } from '../state.js';
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
 * `yomi relay --bot NAME <flag>`: a command for one registered bot, which the CLI accepts however
 * many bots its channel has (the channel's own command asks which one when it has several).
 */
export const botCommand = (record: Pick<BotRecord, 'name'>, flag: string) =>
  `yomi relay --bot ${record.name} ${flag}`;

/** Credentials a setup asked for and checked, handed to the command to keep (`CredentialRequest.save`). */
export type AcquiredBot = {
  /** What the keychain keeps. */
  secret: string;
  /** Whose they are (`storedBot` of `secret`). */
  stored: StoredBot;
  /** The bot as the platform named it, when it was asked. */
  identity: BotIdentity | null;
  /**
   * WeChat: who scanned (ilink_user_id). One WeChat account has one ClawBot, whose id a new login
   * may change, so a bot here that they own already is this ClawBot (signed in again, not added).
   */
  owner?: string;
};

/**
 * What `setCredentials` is asked for (design §1.2), and how it hands the credentials over: it asks
 * for them, checks them with the platform, and leaves keeping them (keychain, state, registry, all
 * or nothing) to `save`.
 */
export type CredentialRequest = {
  options: RelayCommandOptions;
  /** The bot whose credentials are set again (renew); null: a bot is added. */
  renew: BotRecord | null;
  /**
   * The secrets this concerns: the renewed bot's, else every bot's of the channel (WeChat sends
   * their tokens with a new QR code, so a ClawBot already linked here is not linked twice).
   */
  stored: string[];
  /**
   * The names of the bots this concerns: the renewed one, else every bot of the channel, with or
   * without a stored secret (WeChat names its one bot when a scan to add another is answered that
   * the ClawBot is bound).
   */
  bots: string[];
  /**
   * The character a bot added is to talk as (`--character`, checked before anything is asked);
   * null: none, or a bot is renewed. WeChat names it in how to rebind the scanner's bot instead.
   */
  character: RelayCharacter | null;
  /**
   * Refuses (a UsageError) credentials that may not be used here, as soon as they name their bot
   * and before the platform is asked more: another bot than the renewed one, one registered
   * already.
   */
  check(stored: StoredBot): void;
  /**
   * Keeps them: the keychain, then the bot's state (`state`: WeChat's owner, under the registry's
   * lock), then the registry; nothing of it stays when one fails (it throws). Returns the record.
   */
  save(bot: AcquiredBot, state?: (state: RelayState, record: BotRecord) => void): BotRecord;
  /** Asked as a run starts (no bot yet): the lines about what to run next are left out. */
  atStart: boolean;
};

/**
 * What `yomi relay` needs from a channel around the relay itself: its credentials (asked, checked,
 * handed over to be kept), how it is named in the terminal and how its owner pairs (the background
 * service runs every bot, whatever its channel). commands/relay.ts runs the same flow for every
 * channel (flags, the bots, --forget, the service, sign-in, production, the locks, pairing, the
 * run) and asks the channel's setup only for these; where each bot's secret, state and lock are is
 * its record's (relay/registry.ts).
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
  /** The flag that sets its credentials: '--set-token' | '--set-app' | '--login'. */
  readonly credentialsFlag: string;
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
  /**
   * The channel's keychain entry of before the registry (`telegram-bot:<account>` |
   * `qq-bot:<account>` | `wechat-ilink:<account>`), which a bot taken over keeps; a bot added later
   * has `<it>#<key>`.
   */
  secretName(account: string): string;
  /**
   * Asks for the credentials (`--set-token` / `--set-app` / `--login`, or as a run starts without
   * a bot), checks them, hands them to `request.save`, then says what to do next (after an added
   * bot of a channel that pairs with a code, the command says it: `--bot NAME --pair`). Resolves with the
   * record kept, else null (nothing was saved: cancelled, or WeChat kept the login it had).
   */
  setCredentials(context: Context, request: CredentialRequest): Promise<BotRecord | null>;
  /**
   * Builds the channel of `record` from its stored secret, never asking for one: null after a
   * warning when none is stored (`missingCredentials`; a background service ends without failing,
   * as a restart would not fix it).
   */
  open(
    context: Context,
    record: BotRecord,
    options: RelayCommandOptions,
  ): Promise<RelayChannel | null>;
  /**
   * channel.verify() with a refusal of the credentials mapped to a UsageError that says what to
   * do (a background service prints it and ends).
   */
  verify(channel: RelayChannel): Promise<BotIdentity>;
  /**
   * No credentials stored: what to run (a warning line), for `record` when the bot is registered
   * (`botCommand`), else the channel's command (it has no bot yet).
   */
  missingCredentials(record?: BotRecord): string;
  /** Whose secret it is, offline (the bot registry); null when unreadable. */
  storedBot(secret: string): StoredBot | null;
  /** Shows a new pairing code ('code' pairing): what to send the bot, and where. */
  printPairing?(context: Context, code: PairingCode, identity: BotIdentity): void;
  /**
   * Why a relay without an owner cannot start here, and what to run (a warning line): `record`'s
   * own command when it is given (`botCommand`), else the channel's.
   */
  unpairedHint(record?: BotRecord): string;
  /** Printed after --forget: how to make the deleted secret useless where it was issued. */
  forgetHint(): string;
  /** How the terminal names the bot in "Relay running: <label> ⇄ Yomi …" (Telegram `@username`). */
  label(identity: BotIdentity): string;
}

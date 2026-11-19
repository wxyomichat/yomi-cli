import { UsageError } from '../../core/env.js';
import { tr } from '../../core/i18n.js';
import { sha256 } from '../../core/state.js';
import type { ChannelSetup } from './setup.js';
import { type BotIdentity, channelName } from './types.js';

/**
 * WeChat ClawBot (iLink): experimental, off unless `--experimental` is given, personal use only;
 * QR login in the terminal, the scanner is the owner (design §10). Phase A: a stub, so
 * `--channel wechat` already parses, names its service, its keychain entry and its lock, and
 * `--forget`, `--uninstall-service` and `--service-status` work; running it or `--login` says it
 * is not available yet. Phase C replaces this file with `WechatChannel` and the real
 * `wechatSetup` (`--login` in channels/wechat-login.ts).
 */

/** Until phase C lands: every run that would need the channel ends here, before sign-in. */
function notAvailable(): UsageError {
  return new UsageError(
    tr(
      '微信通道还在开发中，暂时不能使用：先用 Telegram（yomi relay --telegram）。',
      'The WeChat channel is not available yet: use Telegram for now (yomi relay --telegram).',
      'El canal de WeChat todavía no está disponible: por ahora usa Telegram (yomi relay --telegram).',
      'O canal do WeChat ainda não está disponível: por enquanto, use o Telegram (yomi relay --telegram).',
    ),
  );
}

/**
 * The stored secret is `{"botToken","baseUrl","ilinkBotId","ilinkUserId","savedAt"}` (design
 * §5.3); the relay is keyed by the scanner (`ilinkUserId`), not the bot (§5.2).
 */
function ownerOf(secret: string): string | null {
  try {
    const parsed = JSON.parse(secret) as { ilinkUserId?: unknown };
    return typeof parsed.ilinkUserId === 'string' && parsed.ilinkUserId ? parsed.ilinkUserId : null;
  } catch {
    return null;
  }
}

export const wechatSetup: ChannelSetup = {
  kind: 'wechat',
  command: 'yomi relay --channel wechat --experimental',
  get displayName() {
    return channelName('wechat');
  },
  experimental: true,
  personalUseOnly: true,
  secretLabel: 'bot_token',
  secretName: (account: string) => `wechat-ilink:${account}`,

  wantsCredentials() {
    throw notAvailable();
  },
  async setCredentials() {
    throw notAvailable();
  },
  async open() {
    throw notAvailable();
  },
  async verify() {
    throw notAvailable();
  },

  /** `wx-<sha256(ilink_user_id)[0:16]>`: the lock of `WechatChannel.lockName` (scope `wx:<same>`). */
  lockNameOf(secret: string) {
    const owner = ownerOf(secret);
    return owner ? `wx-${sha256(owner).slice(0, 16)}` : null;
  },

  unpairedHint: () =>
    tr(
      '还没有登录微信：在终端里运行 yomi relay --channel wechat --experimental --login，用手机微信扫码。',
      'Not signed in to WeChat yet: run yomi relay --channel wechat --experimental --login in a terminal and scan the QR code with WeChat on your phone.',
      'Todavía no iniciaste sesión en WeChat: ejecuta yomi relay --channel wechat --experimental --login en una terminal y escanea el código QR con WeChat en tu teléfono.',
      'Você ainda não entrou no WeChat: execute yomi relay --channel wechat --experimental --login em um terminal e escaneie o código QR com o WeChat no seu celular.',
    ),

  serviceArgs: () => ({ lead: ['--channel', 'wechat', '--experimental'], trail: [] }),

  forgetHint: () =>
    tr(
      '要让这次登录彻底失效，还要在手机微信里解除 ClawBot 的绑定。',
      'To end this sign-in for good, also unbind ClawBot in WeChat on your phone.',
      'Para terminar este inicio de sesión del todo, desvincula también ClawBot en WeChat en tu teléfono.',
      'Para encerrar este login de vez, desvincule também o ClawBot no WeChat do seu celular.',
    ),

  label: (identity: BotIdentity) => identity.name || identity.id,
};

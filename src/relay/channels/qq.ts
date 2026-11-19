import type { Context } from '../../commands/context.js';
import { UsageError } from '../../core/env.js';
import { tr } from '../../core/i18n.js';
import { paint, say } from '../../core/ui.js';
import type { PairingCode } from '../pairing.js';
import type { ChannelSetup } from './setup.js';
import { type BotIdentity, channelName } from './types.js';

/**
 * QQ: the person's own official bot (q.qq.com), AppID + AppSecret, C2C private chat only,
 * personal use only (design §9). Phase A: a stub, so `--channel qq` already parses, names its
 * service, its keychain entry and its lock, and `--forget`, `--uninstall-service` and
 * `--service-status` work; running it or setting its credentials says it is not available yet.
 * Phase B replaces this file with `QqChannel` and the real `qqSetup` (`--set-app`, `/pair`).
 */

/** Until phase B lands: every run that would need the channel ends here, before sign-in. */
function notAvailable(): UsageError {
  return new UsageError(
    tr(
      'QQ 通道还在开发中，暂时不能使用：先用 Telegram（yomi relay --telegram）。',
      'The QQ channel is not available yet: use Telegram for now (yomi relay --telegram).',
      'El canal de QQ todavía no está disponible: por ahora usa Telegram (yomi relay --telegram).',
      'O canal do QQ ainda não está disponível: por enquanto, use o Telegram (yomi relay --telegram).',
    ),
  );
}

/** The stored secret is `{"appId":"<digits>","secret":"<AppSecret>"}` (design §5.3). */
function appIdOf(secret: string): string | null {
  try {
    const parsed = JSON.parse(secret) as { appId?: unknown };
    return typeof parsed.appId === 'string' && /^[0-9]{5,20}$/.test(parsed.appId)
      ? parsed.appId
      : null;
  } catch {
    return null;
  }
}

export const qqSetup: ChannelSetup = {
  kind: 'qq',
  command: 'yomi relay --channel qq',
  displayName: channelName('qq'),
  experimental: false,
  personalUseOnly: true,
  secretLabel: 'AppSecret',
  secretName: (account: string) => `qq-bot:${account}`,

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

  /** `qq-<AppID>`: the lock of `QqChannel.lockName` (scope `qq:<AppID>`). */
  lockNameOf(secret: string) {
    const appId = appIdOf(secret);
    return appId ? `qq-${appId}` : null;
  },

  printPairing(context: Context, code: PairingCode, identity: BotIdentity) {
    const { io } = context;
    const name = identity.name || identity.id;
    say(io);
    say(
      io,
      tr(
        `在 QQ 里给你的 bot（${name}）发送：`,
        `In QQ, send your bot (${name}):`,
        `En QQ, envía a tu bot (${name}):`,
        `No QQ, envie para o seu bot (${name}):`,
      ),
    );
    say(io, `  ${paint(io, 'bold', `/pair ${code.display}`)}`);
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '配对码 15 分钟内有效、只能用一次，只显示在这个终端里：不要发给别人。',
          'The pairing code is valid for 15 minutes, works once and is shown only in this terminal: do not send it to anyone.',
          'El código de vinculación es válido durante 15 minutos, funciona una sola vez y solo se muestra en esta terminal: no se lo envíes a nadie.',
          'O código de pareamento vale por 15 minutos, funciona uma única vez e só aparece neste terminal: não o envie para ninguém.',
        ),
      ),
    );
    say(io);
  },

  unpairedHint: () =>
    tr(
      '还没有配对：请在终端里运行一次 yomi relay --channel qq，按提示在 QQ 里给 bot 发送 /pair 配对码。',
      'Not paired yet: run yomi relay --channel qq once in a terminal and send /pair with the pairing code to the bot in QQ as prompted.',
      'Todavía no está vinculado: ejecuta yomi relay --channel qq una vez en una terminal y envía /pair con el código de vinculación al bot en QQ según las indicaciones.',
      'Ainda não pareado: execute yomi relay --channel qq uma vez em um terminal e envie /pair com o código de pareamento para o bot no QQ conforme indicado.',
    ),

  serviceArgs: () => ({ lead: ['--channel', 'qq'], trail: [] }),

  forgetHint: () =>
    tr(
      '如果 AppSecret 可能泄露，请在 QQ 开放平台（q.qq.com）的机器人设置里重置它。',
      "If the AppSecret may have leaked, reset it in the bot's settings on the QQ Open Platform (q.qq.com).",
      'Si el AppSecret pudo haberse filtrado, restablécelo en la configuración del bot en la QQ Open Platform (q.qq.com).',
      'Se o AppSecret pode ter vazado, redefina-o nas configurações do bot na QQ Open Platform (q.qq.com).',
    ),

  label: (identity: BotIdentity) => identity.name || identity.id,
};

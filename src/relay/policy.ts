import type { Gateway } from '../core/api.js';
import { tr } from '../core/i18n.js';
import { flag, type Json, optionalObject, text } from '../core/json.js';
import { VERSION } from '../core/version.js';
import { type ChannelKind, channelName } from './channels/types.js';

/**
 * What the server says about relays (`relay/get_policy`). Until the server has the route, every
 * capability is off and the relay assumes none of them: free-only sends nothing (FreeOnly is not
 * known to be honoured), a cap (a budget or `--max-spend`) needs a known price (no server-side
 * cap), the relay shows its own AI notice, and a send is never repeated. Without a cap (the default) none of that holds a
 * message back: Yomi charges by its normal rules.
 */
export type RelayPolicy = {
  /** False: relays are switched off for this account or region; `message` says why. */
  enabled: boolean;
  message: string;
  /** Older CLIs must not relay (protocol changed). */
  minVersion: string;
  /** `consumption_mode` FreeOnly is honoured on ordinary sends (never charged). */
  freeOnly: boolean;
  /** `max_cost_diamonds` is honoured: a reply that would cost more is refused, not charged. */
  spendCap: boolean;
  /** `client_request_id` makes a resend of the same message a no-op (charged once). */
  idempotentSend: boolean;
  /** The server injects the AI notice, the 3-hour reminder, the minors notice, crisis help. */
  complianceNotices: boolean;
  /** Where the policy came from (diagnostics). */
  source: 'server' | 'default';
  /** The channel the server says this policy is for ('' when it did not say). */
  channel: string;
};

export const DEFAULT_POLICY: RelayPolicy = {
  enabled: true,
  message: '',
  minVersion: '',
  freeOnly: false,
  spendCap: false,
  idempotentSend: false,
  complianceNotices: false,
  source: 'default',
  channel: '',
};

export function parsePolicy(result: Json): RelayPolicy {
  const data = optionalObject(result.data ?? result);
  const features = optionalObject(data.features);
  return {
    enabled: data.enabled === undefined ? true : flag(data.enabled),
    message: text(data.message).slice(0, 500),
    minVersion: text(data.min_cli_version),
    freeOnly: flag(features.free_only),
    spendCap: flag(features.spend_cap),
    idempotentSend: flag(features.idempotent_send),
    complianceNotices: flag(features.compliance_notices),
    source: 'server',
    // Read leniently: an echo of another shape must not cost Telegram the rest of its policy.
    channel: typeof data.channel === 'string' ? data.channel.slice(0, 32) : '',
  };
}

/** `relay/get_policy` for one channel; the defaults when the server does not have it (or it fails). */
export async function relayPolicy(
  gateway: Gateway,
  channel: ChannelKind = 'telegram',
  signal?: AbortSignal,
): Promise<RelayPolicy> {
  try {
    const result = await gateway.request(
      'relay/get_policy',
      { client: 'yomi-cli', client_version: VERSION, channel },
      { timeoutMs: 15_000, signal },
    );
    return parsePolicy(result);
  } catch {
    return DEFAULT_POLICY;
  }
}

/** How long a channel gated by `channelPolicy` waits before an owner message asks the server again. */
export const POLICY_REFETCH_MS = 60_000;

export type ChannelPolicy = {
  /** What the relay runs on. */
  policy: RelayPolicy;
  /** The server has not confirmed this channel in production: nothing is relayed until it does. */
  gated: boolean;
  /** One line for the terminal, '' when there is nothing to say. */
  warning: string;
};

/**
 * Whether QQ and WeChat may run on the policy `relayPolicy` returned. A failed read gives the
 * defaults, which say "enabled", so the server could never switch a channel off by not answering.
 * These two therefore relay only on a policy the server actually sent for them (it echoes
 * `channel`). Without one, in production (`requireServerPolicy`) the relay answers every message
 * with the server-off text and relays nothing until a policy for the channel arrives (the core
 * asks again after `POLICY_REFETCH_MS`); in test and custom environments it runs on the defaults
 * with a warning, so development and checks on real accounts are not blocked. Telegram runs on
 * whatever was read, as it always has.
 */
export function channelPolicy(
  policy: RelayPolicy,
  channel: ChannelKind,
  requireServerPolicy: boolean,
): ChannelPolicy {
  if (channel === 'telegram' || (policy.source === 'server' && policy.channel === channel))
    return { policy, gated: false, warning: '' };
  const name = channelName(channel);
  if (!requireServerPolicy)
    return {
      policy,
      gated: false,
      warning: tr(
        `服务端没有确认这个通道（${name}）：这不是正式环境，按${policy.source === 'server' ? '服务端的通用策略' : '默认设置'}运行`,
        `The server did not confirm the ${name} channel; running on ${policy.source === 'server' ? "the server's general policy" : 'the defaults'} because this is not the production environment`,
        `El servidor no confirmó el canal de ${name}; se usa ${policy.source === 'server' ? 'la política general del servidor' : 'la configuración predeterminada'} porque este no es el entorno de producción`,
        `O servidor não confirmou o canal do ${name}; usando ${policy.source === 'server' ? 'a política geral do servidor' : 'os padrões'} porque este não é o ambiente de produção`,
      ),
    };
  return {
    policy: {
      ...policy,
      enabled: false,
      // A server that switched relays off says why itself.
      message:
        !policy.enabled && policy.message
          ? policy.message
          : tr(
              '服务端还没有开放这个通道',
              'the server has not enabled this channel',
              'el servidor todavía no habilitó este canal',
              'o servidor ainda não habilitou este canal',
            ),
    },
    gated: true,
    warning: tr(
      `服务端还没有开放这个通道（${name}）：每条消息都只会收到「服务端已关闭」的答复，不转发、不扣费；服务端开放后自动恢复`,
      `The server has not enabled the ${name} channel: every message is answered that the server switched it off, nothing is relayed or charged; it resumes by itself once the server enables it`,
      `El servidor todavía no habilitó el canal de ${name}: cada mensaje recibe la respuesta de que el servidor lo desactivó, no se transmite ni se cobra nada; se reanuda solo cuando el servidor lo habilite`,
      `O servidor ainda não habilitou o canal do ${name}: cada mensagem recebe a resposta de que o servidor o desativou, nada é encaminhado nem cobrado; ele volta sozinho quando o servidor o habilitar`,
    ),
  };
}

/** -1, 0, 1 for dotted numeric versions (`0.1.0` < `0.10.0`); pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number(part) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

import type { Gateway } from '../core/api.js';
import { flag, type Json, optionalObject, text } from '../core/json.js';
import { VERSION } from '../core/version.js';

/**
 * What the server says about relays (`relay/get_policy`). Until
 * the server has the route, every capability is off and the relay takes the strictest path:
 * messages may be charged, so a budget is needed before the first one; the relay shows its own AI
 * notice; a send is never repeated.
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
  };
}

/** `relay/get_policy`; the defaults when the server does not have it (or it fails). */
export async function relayPolicy(gateway: Gateway): Promise<RelayPolicy> {
  try {
    const result = await gateway.request(
      'relay/get_policy',
      { client: 'yomi-cli', client_version: VERSION, channel: 'telegram' },
      { timeoutMs: 15_000 },
    );
    return parsePolicy(result);
  } catch {
    return DEFAULT_POLICY;
  }
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

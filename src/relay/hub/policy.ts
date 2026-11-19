import type { Gateway } from '../../core/api.js';
import type { ChannelKind } from '../channels/types.js';
import { type RelayPolicy, relayPolicy } from '../policy.js';

/**
 * `relay/get_policy`, per kind of channel, for every bot of a process: one request at a time per
 * kind (bots asking together share it), and the last answer reused while it is young enough for
 * the caller. Each bot decides itself what the answer means for it (`channelPolicy`).
 */
export class PolicyService {
  private readonly answers = new Map<
    ChannelKind,
    { at: number; value: Promise<RelayPolicy>; open: boolean }
  >();

  constructor(
    private readonly gateway: Gateway,
    private readonly fetchPolicy = relayPolicy,
  ) {}

  /**
   * The policy for `kind`: the request in flight, else an answer asked for less than `maxAgeMs`
   * ago, else a new request (0: always a new one unless one is in flight). Never fails: a failed
   * read is the defaults (`relayPolicy`).
   */
  read(kind: ChannelKind, maxAgeMs: number): Promise<RelayPolicy> {
    const last = this.answers.get(kind);
    if (last && (last.open || Date.now() - last.at < maxAgeMs)) return last.value;
    const answer = { at: Date.now(), value: this.fetchPolicy(this.gateway, kind), open: true };
    const done = () => {
      answer.open = false;
    };
    answer.value.then(done, done);
    this.answers.set(kind, answer);
    return answer.value;
  }
}

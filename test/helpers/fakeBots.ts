import { type BotRecord, BotRegistry } from '../../src/relay/registry.js';

/*
 * Kept apart from fakeSetup.ts, which the channels' module mocks import while the registry (which
 * imports the channels) is still loading.
 */

/**
 * The scripted bot of `kind` in the registry of `account` (made once): the scope and lock its
 * fake channel always had (`fake:<kind>`, `fake-<kind>`), a secret name of its own, and the
 * fake identity's id as its platform id. Returns its record.
 */
export function registerFake(account: string, kind: 'qq' | 'wechat'): BotRecord {
  const registry = BotRegistry.open(account);
  const key = `fake-${kind}`;
  const known = registry.list(kind).find((record) => record.key === key);
  if (known) return known;
  registry.commit((file) => {
    file.bots.push({
      key,
      name: kind === 'qq' ? 'qq-42' : 'wechat-1',
      kind,
      character: null,
      platformId: '42',
      label: 'Lin bot',
      scope: `fake:${kind}`,
      secretName: `fake-${kind}:${account}`,
      lockName: `fake-${kind}`,
      ...(kind === 'wechat' ? { experimentalAcceptedAt: Date.now() } : {}),
      createdAt: Date.now(),
      boundAt: 0,
      generation: 0,
    });
  });
  return BotRegistry.open(account)
    .list(kind)
    .find((record) => record.key === key)!;
}

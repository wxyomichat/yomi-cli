/**
 * The docs the CLI's messages point to, by their web address in the public repository. An npm
 * install keeps its copy of `docs/` deep in npm's own folder, so a path such as `docs/relay.md`
 * would name a file the reader does not have where they run `yomi`.
 */
export const DOCS = [
  'auth-protocol.md',
  'generation.md',
  'relay.md',
  'relay-qq.md',
  'relay-wechat.md',
  'security.md',
] as const;

export type DocName = (typeof DOCS)[number];

const BASE = 'https://github.com/wxyomichat/yomi-cli/blob/main/docs/';

/** The web address of `docs/<name>`. */
export function docUrl(name: DocName): string {
  return BASE + name;
}

# Releasing @yomichat/cli

For the maintainer. The CLI is published to the public npm registry as `@yomichat/cli`, and users install it with `npm install -g @yomichat/cli`. This file is not shipped in the package.

## One-time setup

1. Sign in on npmjs.com with the account that will own the package and turn on two-factor authentication for both sign-in and writes (Account → Two-Factor Authentication).
2. Create the organization `yomichat` (avatar menu → Add Organization, free plan for public packages). The `@yomichat` scope belongs to it; only its members can publish under it. Add other maintainers under the organization's Members, also with 2FA.
3. On the machine you publish from, run `npm login` (it opens the browser) and check with `npm whoami`. Never put a token in the repository or in a shell history.

## Each release

1. Start from a clean, up-to-date `main`: `git status` shows nothing, `git pull` is current.
2. Bump the version in `package.json` and `VERSION` in `src/core/version.ts`, following semver. A test checks that the two match, and the other tests read `VERSION`, so nothing else changes. Commit; do not tag yet.
3. `pnpm install --frozen-lockfile && pnpm verify`.
4. `npm pack --dry-run` and read the file list: `dist/` without `dist/mock/` and `*.map`, `docs/` (without this file), `examples/`, `README.md`, `LICENSE`, `package.json`.
5. `npm publish`. The `prepack` script empties and rebuilds `dist/` (it runs pnpm, so pnpm must be on your `PATH`), `publishConfig` makes the scoped package public, and npm asks for the 2FA code. For a pre-release, use `npm publish --tag next` so `latest` does not move (users opt in with `@next`).
6. Only now that the version is on npm, tag the commit with an annotated tag and push both by name:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main vX.Y.Z
   ```

   Naming the tag pushes it whatever kind it is (`--follow-tags` would skip a plain `git tag`). If step 3, 4 or 5 fails, nothing has been tagged: fix it, commit, and go on from step 3.

7. Check what was published:

   ```sh
   npm view @yomichat/cli version dist-tags engines bin
   tmp=$(mktemp -d)
   npm install -g @yomichat/cli@X.Y.Z --prefix "$tmp"
   "$tmp/bin/yomi" --version
   YOMI_LANG=zh "$tmp/bin/yomi" --help
   rm -rf "$tmp"
   ```

## A bad release

A published version number can never be reused, so fix forward with a new patch version. Until it is out:

- Warn everyone who installs the bad version: `npm deprecate @yomichat/cli@X.Y.Z "Broken: <what>. Use <fixed version> or later."` To undo, deprecate it again with an empty message (`""`).
- Point `latest` back at the last good version so new installs skip the bad one: `npm dist-tag add @yomichat/cli@<good version> latest`.
- Prefer deprecation to `npm unpublish`: npm only allows unpublishing under its unpublish policy (for example within 72 hours of publishing), and the version number stays used.

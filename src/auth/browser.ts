import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { Environment } from '../core/env.js';
import { VERSION } from '../core/version.js';
import { type CallbackResult, startCallbackServer, verificationCode } from './loopback.js';
import { codeChallenge, createCodeVerifier } from './pkce.js';

/**
 * The browser half of `yomi login` (docs/auth-protocol.md), like `gh auth login --web`: a
 * fresh `state` and PKCE verifier per login (still valid after a turned-down answer, void once
 * the login ends), the callback on 127.0.0.1, the authorize page of the web
 * (`<web>/cli/auth#port&state&client&version&code_challenge&code_challenge_method`) opened in the
 * browser, and the page's answer. The parameters ride in the fragment: never sent to a server,
 * never in a log or a Referer. The verifier never leaves this process except in the body of
 * `account/exchange_cli_auth_code`.
 */

export type AuthorizeRequest = {
  url: string;
  code: string;
  port: number;
  /**
   * What the exchange of a one-time code needs besides the code. A function rather than fields,
   * so the verifier is not in anything that dumps this object.
   */
  proof(): { state: string; codeVerifier: string };
  /** The page's next answer (see `CallbackServer.next`). */
  next(): Promise<CallbackResult>;
  /** The account just handed over was turned down: wait for the page again. */
  resume(): void;
  cancel(): void;
};

export async function beginBrowserAuthorization(
  env: Environment,
  timeoutMs: number,
  onRejected?: (reason: string) => void,
): Promise<AuthorizeRequest> {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = createCodeVerifier();
  const server = await startCallbackServer({
    state,
    expectedOrigin: env.webOrigin,
    timeoutMs,
    onRejected,
  });
  const query = new URLSearchParams({
    port: String(server.port),
    state,
    client: 'yomi-cli',
    version: VERSION,
    // After the v1 parameters: a page that does not know them yet still reads the rest.
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  return {
    url: `${env.webOrigin}/cli/auth#${query.toString()}`,
    code: verificationCode(state),
    port: server.port,
    proof: () => ({ state, codeVerifier }),
    next: server.next,
    resume: server.resume,
    cancel: server.close,
  };
}

/** Opens `url` in the default browser; false when there is none to open (SSH, CI). */
export function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
        : { file: 'xdg-open', args: [url] };
  return new Promise((resolve) => {
    try {
      const child = spawn(command.file, command.args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { Environment } from '../core/env.js';
import { VERSION } from '../core/version.js';
import { type CallbackResult, startCallbackServer, verificationCode } from './loopback.js';

/**
 * The browser half of `yomi login` (docs/auth-protocol.md), like `gh auth login --web`: a
 * fresh `state` per login (still valid after a turned-down answer, void once the login ends), the callback on 127.0.0.1, the authorize page of the web
 * (`<web>/cli/auth#port&state&client&version`) opened in the browser, and the page's answer. The
 * parameters ride in the fragment: never sent to a server, never in a log or a Referer.
 */

export type AuthorizeRequest = {
  url: string;
  code: string;
  port: number;
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
  });
  return {
    url: `${env.webOrigin}/cli/auth#${query.toString()}`,
    code: verificationCode(state),
    port: server.port,
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

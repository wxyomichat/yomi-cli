import { Gateway } from '../../src/core/api.js';
import { object } from '../../src/core/json.js';
import type { MockServer } from '../../src/mock/server.js';

/**
 * The browser's part of `yomi login` against the mock: what the authorize page at the link the
 * CLI printed does when the person clicks, without a browser. Tests that sign in go through here.
 */

/** The link `yomi login` prints, as the CLI and the page both read it. */
export const LOGIN_URL = /http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/;

/** The authorize page's parameters: they ride in the fragment, which no server sees. */
export function fragmentOf(url: string): URLSearchParams {
  return new URLSearchParams(new URL(url).hash.slice(1));
}

/**
 * What the current page gets when the person clicks "authorize": a one-time code from
 * `account/create_cli_auth_code`, asked with the page's own web session, bound to this link's
 * state, challenge and port.
 */
export async function issueCode(mock: MockServer, url: string): Promise<string> {
  const params = fragmentOf(url);
  const web = mock.webSession;
  const gateway = new Gateway({
    env: { name: 'test', apiOrigin: mock.origin, webOrigin: mock.origin, lane: '', custom: true },
    idfv: 'mock-web-browser',
    credential: {
      version: 1,
      env: 'test',
      apiOrigin: mock.origin,
      userId: web.userId,
      deviceId: web.deviceId,
      authToken: web.authToken,
      refreshToken: web.refreshToken,
      email: '',
      displayName: '',
      createdAt: 0,
      refreshedAt: 0,
    },
  });
  const result = await gateway.request('account/create_cli_auth_code', {
    code_challenge: params.get('code_challenge'),
    code_challenge_method: params.get('code_challenge_method'),
    state: params.get('state'),
    callback_port: Number(params.get('port')),
    client_name: params.get('client'),
    client_version: params.get('version'),
  });
  return String(object(result.data ?? result).code);
}

/**
 * A form POST to the CLI's callback from the web's origin with the link's `state` and `fields`:
 * what the page sends, or what someone who learned the state could send.
 */
export function postCallback(
  mock: MockServer,
  url: string,
  fields: Record<string, string>,
): Promise<Response> {
  const params = fragmentOf(url);
  return fetch(`http://127.0.0.1:${params.get('port')}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: mock.origin },
    body: new URLSearchParams({ state: params.get('state') ?? '', ...fields }).toString(),
  });
}

/**
 * What a browser does on the authorize page: the page reads its parameters from the fragment
 * (never sent to the server) and posts its form, from the web's origin. "authorize" posts a fresh
 * one-time code when the link carries a code challenge, as the current page does; `page: 'old'`
 * is a page from before one-time codes, which ignores the challenge and posts the Firebase-like
 * `id_token` its form carries. "cancel" posts `error=access_denied`.
 */
export async function authorizeLikeTheBrowser(
  mock: MockServer,
  url: string,
  options: { action?: 'authorize' | 'cancel'; page?: 'current' | 'old' } = {},
): Promise<Response> {
  const action = options.action ?? 'authorize';
  const link = new URL(url);
  if (link.search) throw new Error('the authorize link carries a query: ' + url);
  const params = fragmentOf(url);
  const page = await (await fetch(link.origin + link.pathname)).text();
  if (action === 'authorize' && options.page !== 'old' && params.has('code_challenge'))
    return postCallback(mock, url, { code: await issueCode(mock, url) });
  const form = [...page.matchAll(/<form method="POST" data-kind="(\w+)">([\s\S]*?)<\/form>/g)].find(
    (match) => match[1] === action,
  );
  if (!form) throw new Error(`the mock page has no ${action} form`);
  const fields = Object.fromEntries(
    [...form[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  delete fields.state;
  return postCallback(mock, url, fields);
}

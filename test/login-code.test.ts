import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { codeChallenge } from '../src/auth/pkce.js';
import { main } from '../src/cli.js';
import { ApiError, Gateway } from '../src/core/api.js';
import type { Json } from '../src/core/json.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
import {
  authorizeLikeTheBrowser,
  fragmentOf,
  issueCode,
  LOGIN_URL,
  postCallback,
} from './helpers/authorize.js';
import { memoryIo } from './helpers/io.js';

/**
 * `yomi login` with one-time codes and PKCE, end to end against the mock: the authorize page gets
 * a code bound to this login with its own web session, the CLI exchanges it (once) with the
 * verifier only it knows, and every answer of `account/exchange_cli_auth_code` leads where the
 * protocol says. An older page that still posts a Firebase token is taken, with a warning.
 */

let mock: MockServer;
let dir: string;
const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}

async function run(args: string[]) {
  process.exitCode = undefined;
  const terminal = memoryIo();
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
}

/** `yomi login` waiting for the page; `args` are added to the command line. */
async function startLogin(args: string[] = [], options: Parameters<typeof memoryIo>[0] = {}) {
  const terminal = memoryIo(options);
  const pending = main(['login', '--no-browser', '--timeout', '20', ...args], terminal.io);
  const [url] = await terminal.waitFor(LOGIN_URL);
  return { terminal, pending, url };
}

const credentialsFile = () => join(dir, 'credentials.json');
const stored = () => (existsSync(credentialsFile()) ? readFileSync(credentialsFile(), 'utf8') : '');
const exchangeRequests = () =>
  mock.state.requests.filter((request) => request.path === 'account/exchange_cli_auth_code');

/** An anonymous signed gateway to the mock, for calling the exchange directly. */
const anonymous = () =>
  new Gateway({
    env: { name: 'test', apiOrigin: mock.origin, webOrigin: mock.origin, lane: '', custom: true },
    idfv: 'another-install',
  });
const exchangeDirectly = (body: Json) =>
  anonymous().request('account/exchange_cli_auth_code', body, { anonymous: true });
const statusOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 0,
    (error: unknown) => (error instanceof ApiError ? error.code : -2),
  );

beforeAll(async () => {
  mock = await startMockServer();
  dir = mkdtempSync(join(tmpdir(), 'yomi-cli-login-code-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_CONFIG_DIR: dir,
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
});

afterAll(async () => {
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  await run(['logout']);
  mock.state.exchangeRefusal = null;
  mock.state.exchangeDrops = 0;
  mock.state.exchangeUnauthorized = 0;
  mock.state.logoutFailures = 0;
  mock.state.cliAuthCodeTtlMs = 120_000;
});

describe('yomi login with a one-time code', () => {
  it('puts a fresh S256 challenge in the fragment and keeps the verifier to itself', async () => {
    const { terminal, pending, url } = await startLogin(['--debug']);
    const params = fragmentOf(url);
    expect([...params.keys()]).toEqual([
      'port',
      'state',
      'client',
      'version',
      'code_challenge',
      'code_challenge_method',
    ]);
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('code_challenge_method')).toBe('S256');
    const response = await authorizeLikeTheBrowser(mock, url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('已授权 Yomi CLI');
    expect(await pending).toBe(0);
    // The exchange: anonymous, signed with the sign-in's common query, the code sent once.
    const [request] = exchangeRequests();
    expect(request.headers['x-token']).toBeUndefined();
    expect(request.query).toMatchObject({ os: '3', device_id: '0', user_id: '0', app_id: '50010' });
    const verifier = String(request.body.code_verifier);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge(verifier)).toBe(params.get('code_challenge'));
    expect(request.body).toMatchObject({
      state: params.get('state'),
      callback_port: Number(params.get('port')),
      client_version: '0.1.0',
      device_info: { os: 3, idfv: expect.any(String) },
    });
    // The verifier and the code appear nowhere: not on stdout, stderr, the debug log or disk.
    expect(terminal.err).toContain('[debug] POST account/exchange_cli_auth_code');
    for (const secret of [verifier, String(request.body.code)]) {
      expect(terminal.out).not.toContain(secret);
      expect(terminal.err).not.toContain(secret);
      expect(stored()).not.toContain(secret);
    }
    expect(terminal.err).not.toContain('网页还是旧版');
  });

  it('signs in as the web account, stores the session, and outlives a web sign-in elsewhere', async () => {
    const { terminal, pending, url } = await startLogin();
    await authorizeLikeTheBrowser(mock, url);
    expect(await pending).toBe(0);
    // The UID people see in the app, not only the name its owner chose: an exchange answers no
    // email, so this is what tells the account apart from another of the same name.
    expect(terminal.out).toContain(
      `网页授权的是账号「Mock Creator」（user_id ${mock.webSession.userId}，UID 10086）`,
    );
    const session = mock.state.sessions.at(-1)!;
    expect(session.platform).toBe('cli');
    expect(stored()).toContain(session.refreshToken);
    mock.webSignInAgain();
    const whoami = await run(['whoami']);
    expect(whoami.code).toBe(0);
    expect(whoami.out).toContain(`user_id ${mock.webSession.userId}`);
  });

  it('a second sign-in on this machine replaces the first on the server, without a false alarm', async () => {
    const first = await startLogin();
    await authorizeLikeTheBrowser(mock, first.url);
    expect(await first.pending).toBe(0);
    const old = mock.state.sessions.at(-1)!;
    const second = await startLogin();
    await authorizeLikeTheBrowser(mock, second.url);
    expect(await second.pending).toBe(0);
    expect(old.revoked).toBe(true);
    expect(mock.state.sessions.at(-1)?.revoked).toBe(false);
    expect(second.terminal.err).not.toContain('没能在服务端撤销');
    expect((await run(['whoami'])).code).toBe(0);
  });

  it('warns when the session it replaces was rotated elsewhere and so could not be revoked', async () => {
    const first = await startLogin();
    await authorizeLikeTheBrowser(mock, first.url);
    expect(await first.pending).toBe(0);
    const old = mock.state.sessions.at(-1)!;
    // Another process (a `yomi relay`) refreshes the pair but could not store the new one: the
    // store keeps the old pair, and the session lives on under the new one.
    await anonymous().request(
      'account/refresh_auth_token',
      { refresh_token: old.refreshToken },
      { anonymous: true },
    );
    // An older page this time: a Firebase token, which replaces nothing on the server.
    const second = await startLogin();
    await authorizeLikeTheBrowser(mock, second.url, { page: 'old' });
    expect(await second.pending).toBe(0);
    expect(old.revoked).toBe(false);
    expect(second.terminal.err).toContain('被替换的旧 CLI 会话没能在服务端撤销');
    expect(second.terminal.err).toContain('它可能仍然有效');
  });

  it('warns when revoking the session it replaces fails', async () => {
    // An older page's session: a code does not replace it on the server, the CLI revokes it.
    const first = await startLogin();
    await authorizeLikeTheBrowser(mock, first.url, { page: 'old' });
    expect(await first.pending).toBe(0);
    const old = mock.state.sessions.at(-1)!;
    const second = await startLogin();
    mock.state.logoutFailures = 1;
    await authorizeLikeTheBrowser(mock, second.url);
    expect(await second.pending).toBe(0);
    expect(old.revoked).toBe(false);
    expect(second.terminal.err).toContain('被替换的旧 CLI 会话没能在服务端撤销');
    expect((await run(['whoami'])).code).toBe(0);
  });

  it('keeps waiting after a refused code and takes the next one from the page', async () => {
    const { terminal, pending, url } = await startLogin();
    const before = mock.state.sessions.length;
    // Codes nobody issued (someone who learned the state): spent and refused, the wait goes on.
    for (let attempt = 0; attempt < 4; attempt++) {
      const forged = await postCallback(mock, url, { code: 'f'.repeat(42) + attempt });
      expect(forged.status).toBe(400);
      expect(await forged.text()).toContain('再点一次授权');
    }
    const refusals = terminal.err.match(/网页交来的授权码没有生效/g) ?? [];
    expect(refusals).toHaveLength(3);
    expect(terminal.err).toContain('1101010041：code invalid');
    expect(terminal.err).toContain('还有更多换不出会话的回调，之后不再逐条提示');
    expect(mock.state.sessions).toHaveLength(before);
    // The person clicks authorize again: a fresh code for the same login.
    expect((await authorizeLikeTheBrowser(mock, url)).status).toBe(200);
    expect(await pending).toBe(0);
    expect(
      exchangeRequests()
        .slice(-5)
        .map((request) => request.body.state),
    ).toEqual(Array(5).fill(fragmentOf(url).get('state')));
    expect((await run(['whoami'])).code).toBe(0);
  });

  it('never sends a code twice, and the mock refuses one that comes back', async () => {
    const { terminal, pending, url } = await startLogin();
    mock.state.exchangeRefusal = { code: 1101010041, message: 'code invalid' };
    const code = await issueCode(mock, url);
    expect((await postCallback(mock, url, { code })).status).toBe(400);
    const sent = exchangeRequests().length;
    // The same code posted again (a resubmitted form) is not sent again.
    expect((await postCallback(mock, url, { code })).status).toBe(400);
    expect(exchangeRequests()).toHaveLength(sent);
    expect(terminal.err).toContain('网页交来的授权码这次登录已经用过，没有再发送');
    await authorizeLikeTheBrowser(mock, url);
    expect(await pending).toBe(0);
    // Replaying the exchange that worked, verifier and all: the code is gone.
    const used = exchangeRequests().at(-1)!.body;
    expect(await statusOf(exchangeDirectly(used))).toBe(1101010041);
  });

  it('keeps waiting when the server says to slow down', async () => {
    const { terminal, pending, url } = await startLogin();
    mock.state.exchangeRefusal = { code: 1101010181, message: 'operation too frequent' };
    const limited = await authorizeLikeTheBrowser(mock, url);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain('稍等片刻');
    expect(terminal.err).toContain(
      '授权太频繁，服务端暂时不接受（1101010181：operation too frequent）',
    );
    await authorizeLikeTheBrowser(mock, url);
    expect(await pending).toBe(0);
  });

  it('ends the login when the exchange does not get through: the code may be spent', async () => {
    const { terminal, pending, url } = await startLogin();
    mock.state.exchangeDrops = 1;
    const response = await authorizeLikeTheBrowser(mock, url);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('重新运行 yomi login');
    expect(await pending).toBe(1);
    expect(terminal.err).toContain('网页交来的授权码可能已经用掉了：请重新运行 yomi login');
    // The server may have made a session the CLI never heard of; nothing was stored.
    expect(stored()).toBe('');
    expect((await run(['whoami'])).code).toBe(1);
    const state = fragmentOf(url).get('state');
    expect(exchangeRequests().filter((request) => request.body.state === state)).toHaveLength(1);
  });

  it.each([
    [
      1101010091,
      'account banned',
      '这个账号已被封禁，不能登录 Yomi CLI（1101010091：account banned）',
    ],
    [1101010130, 'account not exists', '这个账号不存在或已注销（1101010130：account not exists）'],
    [
      1101010011,
      'callback_port out of range',
      '服务端说换取会话的请求参数不对（1101010011：callback_port out of range）。这是 Yomi CLI 的问题',
    ],
    [1101010020, 'internal error', '服务端出错，没有换出会话（1101010020：internal error）'],
  ])('ends the login on %i', async (code, message, said) => {
    const { terminal, pending, url } = await startLogin();
    const before = mock.state.sessions.length;
    mock.state.exchangeRefusal = { code, message };
    const response = await authorizeLikeTheBrowser(mock, url);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('原因见终端');
    expect(await pending).toBe(1);
    expect(terminal.err).toContain(said);
    expect(mock.state.sessions).toHaveLength(before);
    expect(stored()).toBe('');
  });

  it('ends the login when the gateway turns the exchange away (HTTP 401)', async () => {
    const { terminal, pending, url } = await startLogin();
    mock.state.exchangeUnauthorized = 1;
    const response = await authorizeLikeTheBrowser(mock, url);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('重新运行 yomi login');
    expect(await pending).toBe(1);
    expect(terminal.err).toContain('Yomi 网关拒绝了换取会话的请求');
    expect(terminal.err).toContain('请稍后重新运行 yomi login');
    expect(stored()).toBe('');
  });

  it('keeps waiting when the account is in its deletion cool-down, as before codes', async () => {
    const { terminal, pending, url } = await startLogin();
    const before = mock.state.sessions.length;
    // Anyone whose own account is in its cool-down could post such a code for a link they read:
    // the login goes on, and the port stays taken.
    mock.state.exchangeRefusal = { code: 1101010271, message: 'deactivating' };
    const refused = await authorizeLikeTheBrowser(mock, url);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('终端还在等待');
    expect(terminal.err).toContain('网页授权的账号正在注销冷静期，没有换出会话');
    expect(mock.state.sessions).toHaveLength(before);
    expect((await authorizeLikeTheBrowser(mock, url)).status).toBe(200);
    expect(await pending).toBe(0);
    expect((await run(['whoami'])).code).toBe(0);
  });

  it('still takes a Firebase token from an older page, and says the session is not kept apart', async () => {
    const { terminal, pending, url } = await startLogin(['--debug']);
    const logins = mock.state.logins.length;
    const response = await authorizeLikeTheBrowser(mock, url, { page: 'old' });
    expect(response.status).toBe(200);
    expect(await pending).toBe(0);
    expect(terminal.err).toContain('网页还是旧版');
    expect(mock.state.logins).toHaveLength(logins + 1);
    expect(mock.state.logins.at(-1)).toMatchObject({
      login_type: 3,
      os: 3,
      not_logout_other_device: true,
    });
    // The token is used once: never stored or printed, not even in the debug log.
    const token = String(mock.state.logins.at(-1)!.firebase_token);
    expect(token.split('.')).toHaveLength(3);
    expect(terminal.err).toContain('[debug] POST account/login');
    expect(terminal.out).not.toContain(token);
    expect(terminal.err).not.toContain(token);
    expect(stored()).not.toContain(token);
    expect((await run(['whoami'])).code).toBe(0);
    // What the warning says: a web sign-in elsewhere ends that session.
    mock.webSignInAgain();
    expect((await run(['whoami'])).code).toBe(1);
  });
});

describe("the mock's exchange", () => {
  /** A login the CLI is not part of: a verifier, and a code the page got for it. */
  async function issued(port = 53111) {
    const verifier = 'v'.repeat(43);
    const state = 's'.repeat(43);
    const url =
      `${mock.origin}/cli/auth#port=${port}&state=${state}&client=yomi-cli&version=0.1.0` +
      `&code_challenge=${codeChallenge(verifier)}&code_challenge_method=S256`;
    const code = await issueCode(mock, url);
    const body = {
      code,
      code_verifier: verifier,
      state,
      callback_port: port,
      client_version: '0.1.0',
      device_info: { os: 3, idfv: 'another-install' },
    };
    return body;
  }

  it('spends a code on first sight, even when the verifier is wrong', async () => {
    const body = await issued();
    expect(await statusOf(exchangeDirectly({ ...body, code_verifier: 'w'.repeat(43) }))).toBe(
      1101010041,
    );
    expect(await statusOf(exchangeDirectly(body))).toBe(1101010041);
  });

  it('refuses another state or port, an expired code, and malformed parameters', async () => {
    expect(await statusOf(exchangeDirectly({ ...(await issued()), state: 't'.repeat(43) }))).toBe(
      1101010041,
    );
    expect(await statusOf(exchangeDirectly({ ...(await issued()), callback_port: 53112 }))).toBe(
      1101010041,
    );
    mock.state.cliAuthCodeTtlMs = 0;
    expect(await statusOf(exchangeDirectly(await issued()))).toBe(1101010041);
    mock.state.cliAuthCodeTtlMs = 120_000;
    expect(await statusOf(exchangeDirectly({ ...(await issued()), code_verifier: 'short' }))).toBe(
      1101010011,
    );
    expect(await statusOf(exchangeDirectly(await issued()))).toBe(0);
  });

  it('issues codes to the web session only', async () => {
    const body = await issued();
    const session = await exchangeDirectly(body);
    const cli = new Gateway({
      env: { name: 'test', apiOrigin: mock.origin, webOrigin: mock.origin, lane: '', custom: true },
      idfv: 'another-install',
      credential: {
        version: 1,
        env: 'test',
        apiOrigin: mock.origin,
        userId: mock.webSession.userId,
        deviceId: String(session.device_id),
        authToken: String(session.auth_token),
        refreshToken: String(session.refresh_token),
        email: '',
        displayName: '',
        createdAt: 0,
        refreshedAt: 0,
      },
    });
    const challenge = codeChallenge(body.code_verifier);
    expect(
      await statusOf(
        cli.request('account/create_cli_auth_code', {
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: body.state,
          callback_port: body.callback_port,
        }),
      ),
    ).toBe(1101010011);
  });
});

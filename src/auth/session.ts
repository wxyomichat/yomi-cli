import { ApiError, type Gateway, NotSignedIn, sessionEnded } from '../core/api.js';
import type { Credential } from '../core/credentials.js';
import { OS_WEB } from '../core/device.js';
import { tr } from '../core/i18n.js';
import { flag, id, type Json, object, optionalId, optionalObject, text } from '../core/json.js';
import { VERSION } from '../core/version.js';

/** The account asked to be deleted and is in its cool-down: the CLI does not cancel that. */
export class DeactivationPending extends Error {
  constructor() {
    super(
      tr(
        '这个账号正在注销冷静期，请先在 App 或网页登录处理后再试',
        'This account is in its deletion cool-down period; sign in on the app or the web to deal with it first, then try again',
        'Esta cuenta está en su periodo de espera de eliminación; inicia sesión en la app o en la web para resolverlo primero y luego vuelve a intentarlo',
        'Esta conta está no período de espera da exclusão; entre no app ou na web para resolver isso primeiro e depois tente novamente',
      ),
    );
    this.name = 'DeactivationPending';
  }
}

/** `base_resp.status_code` of `account/exchange_cli_auth_code` (docs/auth-protocol.md). */
export const ExchangeCode = {
  /** Missing or malformed parameters: a bug of the CLI. */
  invalidParams: 1101010011,
  internal: 1101010020,
  /** Unknown, used, expired, or not this login's code (state, port or verifier). */
  codeInvalid: 1101010041,
  banned: 1101010091,
  accountMissing: 1101010130,
  rateLimited: 1101010181,
  deactivationPending: 1101010271,
} as const;

/**
 * `account/exchange_cli_auth_code`: the one-time code the authorize page passed on, with the PKCE
 * verifier only this process knows, for a session of the CLI's own (a session the server keeps
 * apart from the web's and the app's, so signing in there again does not end it). Anonymous, with
 * the same common query as a sign-in (`os` 3, `device_id` 0). Then, as the app does,
 * `account/get_account` must read back the same account.
 *
 * The server spends the code on first sight, whatever the outcome: it is sent once, never again
 * (a failed request may have spent it too). An account in its deletion cool-down is
 * `DeactivationPending`; other refusals are `ApiError`s with the codes in `ExchangeCode`.
 */
export async function exchangeAuthCode(
  gateway: Gateway,
  exchange: { code: string; codeVerifier: string; state: string; port: number; idfv: string },
  signal?: AbortSignal,
): Promise<Credential> {
  try {
    return await startSession(
      gateway,
      'account/exchange_cli_auth_code',
      {
        code: exchange.code,
        code_verifier: exchange.codeVerifier,
        state: exchange.state,
        callback_port: exchange.port,
        client_version: VERSION,
        device_info: { os: OS_WEB, idfv: exchange.idfv },
      },
      signal,
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.path === 'account/exchange_cli_auth_code' &&
      error.code === ExchangeCode.deactivationPending
    )
      throw new DeactivationPending();
    throw error;
  }
}

/**
 * `account/login` with the Firebase ID token an authorize page from before one-time codes passed
 * on (`login_type` 3, as the web signs in, with `os` 3), with `not_logout_other_device` so the
 * CLI's new session never signs the person out of the app or the web. Then, as the app does,
 * `account/get_account` must read back the same account.
 * The token is used once here and dropped.
 */
export function exchangeFirebaseToken(
  gateway: Gateway,
  firebaseToken: string,
  idfv: string,
  signal?: AbortSignal,
): Promise<Credential> {
  return startSession(
    gateway,
    'account/login',
    {
      login_type: 3,
      firebase_token: firebaseToken,
      os: OS_WEB,
      not_logout_other_device: true,
      device_info: { os: OS_WEB, idfv },
    },
    signal,
  );
}

/**
 * A sign-in request (`path`, anonymous) whose answer is a new session, read back with
 * `account/get_account`. A session the server issued is revoked if anything after it fails.
 */
async function startSession(
  gateway: Gateway,
  path: string,
  body: Json,
  signal?: AbortSignal,
): Promise<Credential> {
  gateway.useCredential(null);
  // Cancelled already: nothing is sent. Once sent, the request is never cut off (the server
  // would make a session the CLI never sees and so cannot revoke): it is let finish, and a
  // session it made after a cancellation is revoked below.
  signal?.throwIfAborted();
  const result = await gateway.request(path, body, { anonymous: true });
  const data = object(result.data ?? result);
  const userId = optionalId(data.user_id);
  const deviceId = optionalId(data.device_id);
  const authToken = text(data.auth_token);
  const refreshToken = text(data.refresh_token);
  const issued = Boolean(userId && deviceId && authToken && refreshToken);
  const now = Date.now();
  const credential: Credential = {
    version: 1,
    env: gateway.env.name,
    apiOrigin: gateway.env.apiOrigin,
    userId: issued ? id(userId) : '',
    deviceId: issued ? id(deviceId) : '',
    authToken,
    refreshToken,
    // Only what the server says: the page's own email and name are not taken (a forged callback
    // could claim the person's address while signing the CLI into another account).
    email: text(data.email),
    displayName: '',
    createdAt: now,
    refreshedAt: now,
  };
  if (signal?.aborted) {
    if (issued) await abandon(gateway, credential);
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(tr('已取消', 'Cancelled', 'Cancelado', 'Cancelado'));
  }
  if (flag(data.is_deactivate_calmdown)) {
    // A session the server issued anyway is revoked, not left behind.
    if (issued) await abandon(gateway, credential);
    throw new DeactivationPending();
  }
  if (!issued)
    throw new ApiError(
      ApiError.transport,
      tr(
        '登录回包缺少会话信息',
        'The sign-in response is missing session details',
        'A la respuesta del inicio de sesión le faltan los datos de la sesión',
        'A resposta do login não traz os dados da sessão',
      ),
      null,
      path,
    );
  gateway.useCredential(credential);
  try {
    const account = await gateway.request('account/get_account', {}, { signal });
    const confirmed = object(account.data ?? account);
    if (optionalId(confirmed.user_id) !== credential.userId)
      throw new ApiError(
        ApiError.transport,
        tr(
          '登录后读回的账号不一致',
          'The account read back after sign-in does not match',
          'La cuenta leída después de iniciar sesión no coincide',
          'A conta lida depois do login não corresponde',
        ),
        null,
        'account/get_account',
      );
  } catch (error) {
    // The session exists on the server now: whatever went wrong, it is revoked, not leaked.
    await abandon(gateway, gateway.credential ?? credential);
    throw error;
  }
  return gateway.credential ?? credential;
}

/** Revokes a session that will not be used (best effort) and forgets it. */
async function abandon(gateway: Gateway, credential: Credential) {
  gateway.useCredential(credential);
  await signOut(gateway);
  gateway.useCredential(null);
}

/**
 * `account/logout` with the CLI's refresh token; the local copy goes whatever the server says.
 * The body is read when the request goes: if the auth token was stale, the refresh that comes
 * first may rotate the refresh token, and the old one would revoke nothing.
 */
export async function signOut(gateway: Gateway): Promise<boolean> {
  return (await revokeSession(gateway)) === 'revoked';
}

/**
 * `signOut`, telling a refused refresh token (`ended`) from a network or server problem (`failed`:
 * the session may still be valid). `ended` means the server ended the session (as when a sign-in
 * with a one-time code of the same account on this machine replaced it), or another process
 * rotated the pair and the session lives on under the new one: only the caller can tell which.
 */
export async function revokeSession(gateway: Gateway): Promise<'revoked' | 'ended' | 'failed'> {
  const credential = gateway.credential;
  if (!credential) return 'failed';
  try {
    await gateway.request('account/logout', () => ({
      refresh_token: (gateway.credential ?? credential).refreshToken,
    }));
    return 'revoked';
  } catch (error) {
    return error instanceof NotSignedIn || sessionEnded(error) ? 'ended' : 'failed';
  }
}

export type Profile = {
  userId: string;
  displayId: string;
  name: string;
  gems: number | null;
  isAnonymous: boolean;
};

/** `account/get_account`, then the name and gems from `user/get_my_homepage`, as the web does. */
export async function readProfile(gateway: Gateway, signal?: AbortSignal): Promise<Profile> {
  const account = await gateway.request('account/get_account', {}, { signal });
  const data = object(account.data ?? account);
  const userId = optionalId(data.user_id);
  const profile: Profile = {
    userId,
    displayId: userId,
    name: '',
    gems: null,
    isAnonymous: flag(data.is_anonymous),
  };
  try {
    const home = await gateway.requestData('user/get_my_homepage', {}, { signal });
    const user = optionalObject(home.profile);
    profile.displayId = text(user.unique_id) || userId;
    profile.name = text(user.name);
    const balance = optionalObject(home.wallet_info).gem_balance;
    profile.gems = typeof balance === 'number' ? balance : null;
  } catch (error) {
    // The name is a nicety; the account check above is what matters. A session that ended
    // meanwhile is not.
    if (error instanceof NotSignedIn) throw error;
  }
  return profile;
}

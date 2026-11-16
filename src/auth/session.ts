import { ApiError, type Gateway, NotSignedIn } from '../core/api.js';
import type { Credential } from '../core/credentials.js';
import { OS_WEB } from '../core/device.js';
import { flag, id, object, optionalId, optionalObject, text } from '../core/json.js';

/** The account asked to be deleted and is in its cool-down: the CLI does not cancel that. */
export class DeactivationPending extends Error {
  constructor() {
    super('这个账号正在注销冷静期，请先在 App 或网页登录处理后再试');
    this.name = 'DeactivationPending';
  }
}

/**
 * `account/login` with the Firebase ID token the authorize page passed on (`login_type` 3, as the
 * web signs in, with `os` 3), with `not_logout_other_device` so the CLI's new session never signs
 * the person out of the app or the web. Then, as the app does, `account/get_account` must read
 * back the same account.
 * The token is used once here and dropped.
 */
export async function exchangeFirebaseToken(
  gateway: Gateway,
  firebaseToken: string,
  idfv: string,
  signal?: AbortSignal,
): Promise<Credential> {
  gateway.useCredential(null);
  // Cancelled already: nothing is sent. Once sent, account/login is never cut off (the server
  // would make a session the CLI never sees and so cannot revoke): it is let finish, and a
  // session it made after a cancellation is revoked below.
  signal?.throwIfAborted();
  const result = await gateway.request(
    'account/login',
    {
      login_type: 3,
      firebase_token: firebaseToken,
      os: OS_WEB,
      not_logout_other_device: true,
      device_info: { os: OS_WEB, idfv },
    },
    { anonymous: true },
  );
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
    throw signal.reason instanceof Error ? signal.reason : new Error('已取消');
  }
  if (flag(data.is_deactivate_calmdown)) {
    // A session the server issued anyway is revoked, not left behind.
    if (issued) await abandon(gateway, credential);
    throw new DeactivationPending();
  }
  if (!issued)
    throw new ApiError(ApiError.transport, '登录回包缺少会话信息', null, 'account/login');
  gateway.useCredential(credential);
  try {
    const account = await gateway.request('account/get_account', {}, { signal });
    const confirmed = object(account.data ?? account);
    if (optionalId(confirmed.user_id) !== credential.userId)
      throw new ApiError(ApiError.transport, '登录后读回的账号不一致', null, 'account/get_account');
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
  const credential = gateway.credential;
  if (!credential) return false;
  try {
    await gateway.request('account/logout', () => ({
      refresh_token: (gateway.credential ?? credential).refreshToken,
    }));
    return true;
  } catch {
    return false;
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

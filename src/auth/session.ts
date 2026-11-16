import { ApiError, type Gateway } from '../core/api.js';
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
  profile: { email: string; displayName: string },
): Promise<Credential> {
  gateway.useCredential(null);
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
  if (flag(data.is_deactivate_calmdown)) throw new DeactivationPending();
  const userId = optionalId(data.user_id);
  const deviceId = optionalId(data.device_id);
  const authToken = text(data.auth_token);
  const refreshToken = text(data.refresh_token);
  if (!userId || !deviceId || !authToken || !refreshToken)
    throw new ApiError(ApiError.transport, '登录回包缺少会话信息', null, 'account/login');
  const now = Date.now();
  const credential: Credential = {
    version: 1,
    env: gateway.env.name,
    apiOrigin: gateway.env.apiOrigin,
    userId: id(userId),
    deviceId: id(deviceId),
    authToken,
    refreshToken,
    email: text(data.email) || profile.email,
    displayName: profile.displayName,
    createdAt: now,
    refreshedAt: now,
  };
  gateway.useCredential(credential);
  const account = await gateway.request('account/get_account');
  const confirmed = object(account.data ?? account);
  if (optionalId(confirmed.user_id) !== credential.userId) {
    gateway.useCredential(null);
    throw new ApiError(ApiError.transport, '登录后读回的账号不一致', null, 'account/get_account');
  }
  return credential;
}

/** `account/logout` with the CLI's refresh token; the local copy goes whatever the server says. */
export async function signOut(gateway: Gateway): Promise<boolean> {
  const credential = gateway.credential;
  if (!credential) return false;
  try {
    await gateway.request('account/logout', { refresh_token: credential.refreshToken });
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
export async function readProfile(gateway: Gateway): Promise<Profile> {
  const account = await gateway.request('account/get_account');
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
    const home = await gateway.requestData('user/get_my_homepage', {});
    const user = optionalObject(home.profile);
    profile.displayId = text(user.unique_id) || userId;
    profile.name = text(user.name);
    const balance = optionalObject(home.wallet_info).gem_balance;
    profile.gems = typeof balance === 'number' ? balance : null;
  } catch {
    // The name is a nicety; the account check above is what matters.
  }
  return profile;
}

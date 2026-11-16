import { beginBrowserAuthorization, openBrowser } from '../auth/browser.js';
import { CallbackTimeout } from '../auth/loopback.js';
import { exchangeFirebaseToken, readProfile, signOut } from '../auth/session.js';
import { storeDescription } from '../core/credentials.js';
import { describeEnvironment } from '../core/env.js';
import { paint, say, warn } from '../core/ui.js';
import { type Context, requireSignIn } from './context.js';

export type LoginOptions = { browser: boolean; timeoutSeconds: number };

/**
 * `yomi login`: the web authorizes, the CLI gets its own session. See docs/auth-protocol.md and
 * docs/security.md.
 */
export async function login(context: Context, options: LoginOptions) {
  const { io, env } = context;
  const previous = context.gateway.credential;
  say(io, `登录 Yomi（${describeEnvironment(env)}）`);
  if (previous)
    say(io, paint(io, 'dim', `本机已登录账号 ${previous.userId}，完成授权后会替换它。`));
  const request = await beginBrowserAuthorization(env, options.timeoutSeconds * 1000, (reason) =>
    warn(io, `拒绝了一次授权回调（${reason}），继续等待。`),
  );
  const onSignal = () => request.cancel();
  process.once('SIGINT', onSignal);
  try {
    say(io);
    say(io, `确认码：${paint(io, 'bold', request.code)}`);
    say(io, paint(io, 'dim', '网页上显示的确认码应与此一致；不一致请不要授权。'));
    say(io);
    const opened = options.browser && (await openBrowser(request.url));
    say(
      io,
      opened ? '已在浏览器中打开授权页；如果没有打开，请手动访问：' : '请在浏览器中打开授权页：',
    );
    say(io, `  ${request.url}`);
    say(io);
    say(io, paint(io, 'dim', `等待网页授权（${options.timeoutSeconds} 秒内有效，Ctrl+C 取消）…`));
    let result;
    try {
      result = await request.result;
    } catch (error) {
      if (error instanceof CallbackTimeout)
        throw new Error(`${options.timeoutSeconds} 秒内没有完成授权，请重新运行 yomi login`);
      throw error;
    }
    if (result.kind === 'denied') throw new Error('已在网页上取消授权');
    say(io, '已收到网页授权，正在建立 CLI 会话…');
    const credential = await exchangeFirebaseToken(context.gateway, result.idToken, context.idfv, {
      email: result.email,
      displayName: result.displayName,
    });
    if (previous && previous.refreshToken !== credential.refreshToken) {
      // The replaced CLI session is revoked, not left valid on the server.
      context.gateway.useCredential(previous);
      await signOut(context.gateway);
      context.gateway.useCredential(credential);
    }
    context.store.set(context.account, credential);
    say(
      io,
      paint(
        io,
        'green',
        `✓ 已登录账号 ${credential.userId}${credential.email ? `（${credential.email}）` : ''}`,
      ),
    );
    say(io, paint(io, 'dim', `凭证保存在${storeDescription(context.store.kind)}`));
    if (context.store.kind === 'file' && process.env.YOMI_CREDENTIAL_STORE !== 'file')
      warn(io, '没有可用的系统钥匙串，凭证存于本地文件（仅当前用户可读）。');
  } finally {
    process.removeListener('SIGINT', onSignal);
    request.cancel();
  }
}

export async function logout(context: Context) {
  const { io } = context;
  const credential = context.gateway.credential;
  if (!credential) {
    say(io, `本机没有${describeEnvironment(context.env)}的登录。`);
    return;
  }
  const revoked = await signOut(context.gateway);
  context.store.delete(context.account);
  context.gateway.useCredential(null);
  say(io, `已退出账号 ${credential.userId}，本机凭证已删除。`);
  if (!revoked) warn(io, '服务端注销请求没有成功（网络或会话已失效），本机凭证仍已删除。');
}

export async function whoami(context: Context) {
  const { io } = context;
  const credential = requireSignIn(context);
  const profile = await readProfile(context.gateway);
  say(io, `环境：${describeEnvironment(context.env)}`);
  say(
    io,
    `账号：${profile.name ? `${profile.name} ` : ''}（user_id ${profile.userId}${profile.displayId !== profile.userId ? `，UID ${profile.displayId}` : ''}）`,
  );
  if (credential.email) say(io, `邮箱：${credential.email}`);
  if (profile.gems !== null) say(io, `钻石：${profile.gems}`);
  say(io, `凭证：${storeDescription(context.store.kind)}`);
}

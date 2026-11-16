import { type AuthorizeRequest, beginBrowserAuthorization, openBrowser } from '../auth/browser.js';
import { CallbackTimeout } from '../auth/loopback.js';
import {
  DeactivationPending,
  exchangeFirebaseToken,
  readProfile,
  signOut,
} from '../auth/session.js';
import { ApiError, type Gateway, NotSignedIn, refreshLockPath } from '../core/api.js';
import { type Credential, storeDescription } from '../core/credentials.js';
import { describeEnvironment } from '../core/env.js';
import { tr } from '../core/i18n.js';
import { withFileLock } from '../core/lock.js';
import { askYesOrNo, paint, say, terminalText, warn } from '../core/ui.js';
import { type Context, requireSignIn } from './context.js';

export type LoginOptions = { browser: boolean; timeoutSeconds: number };

/**
 * `yomi login`: the web authorizes, the CLI gets its own session. See docs/auth-protocol.md and
 * docs/security.md.
 */
export async function login(context: Context, options: LoginOptions) {
  const { io, env } = context;
  const previous = context.gateway.credential;
  say(
    io,
    tr(`登录 Yomi（${describeEnvironment(env)}）`, `Sign in to Yomi (${describeEnvironment(env)})`),
  );
  if (previous)
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          `本机已登录账号 ${previous.userId}，完成授权后会替换它。`,
          `Account ${previous.userId} is already signed in on this machine; it will be replaced once you authorize.`,
        ),
      ),
    );
  const request = await beginBrowserAuthorization(env, options.timeoutSeconds * 1000, (reason) =>
    warn(
      io,
      tr(
        `拒绝了一次授权回调（${reason}），继续等待。`,
        `Refused an authorization callback (${reason}); still waiting.`,
      ),
    ),
  );
  // Ctrl+C cancels the login at any step until the new sign-in is saved (a session made
  // meanwhile is revoked first, a question is closed); a second one ends the process at once.
  // Once saved, it only cuts the revocation of the replaced session short.
  const cancelled = new AbortController();
  let saved = false;
  const onSignal = () => {
    if (cancelled.signal.aborted) {
      if (saved)
        warn(
          io,
          tr(
            '已登录；被替换的旧 CLI 会话可能没有撤销（见 docs/security.md 5.1）。',
            'Signed in; the replaced CLI session may not have been revoked (see docs/security.md 5.1).',
          ),
        );
      process.exit(130);
    }
    cancelled.abort();
    request.cancel();
    warn(
      io,
      saved
        ? tr(
            '已登录，正在撤销被替换的旧会话；再按一次 Ctrl+C 立即退出。',
            'Signed in, revoking the replaced session; press Ctrl+C again to exit now.',
          )
        : tr(
            '正在取消登录…（再按一次 Ctrl+C 立即退出）',
            'Cancelling sign-in… (press Ctrl+C again to exit now)',
          ),
    );
  };
  process.on('SIGINT', onSignal);
  const ask = (question: string) => askYesOrNo(io, question, cancelled.signal);
  try {
    if (!io.interactive)
      say(
        io,
        paint(
          io,
          'dim',
          tr(
            '非交互运行（输入或输出不是终端）：第一个有效的网页回答直接生效，不会询问。需要确认账号请直接在终端里运行。',
            'Running non-interactively (input or output is not a terminal): the first valid answer from the web takes effect without asking. To confirm the account, run this directly in a terminal.',
          ),
        ),
      );
    say(io);
    say(
      io,
      tr(
        `确认码：${paint(io, 'bold', request.code)}`,
        `Confirmation code: ${paint(io, 'bold', request.code)}`,
      ),
    );
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '网页上显示的确认码应与此一致；不一致请不要授权。',
          'The confirmation code on the web page should match this one; if it does not, do not authorize.',
        ),
      ),
    );
    say(io);
    const opened = options.browser && (await openBrowser(request.url));
    say(
      io,
      opened
        ? tr(
            '已在浏览器中打开授权页；如果没有打开，请手动访问：',
            'Opened the authorization page in your browser; if it did not open, visit:',
          )
        : tr('请在浏览器中打开授权页：', 'Open the authorization page in your browser:'),
    );
    say(io, `  ${request.url}`);
    say(io);
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          `等待网页授权（${options.timeoutSeconds} 秒内有效，Ctrl+C 取消）…`,
          `Waiting for authorization on the web (valid for ${options.timeoutSeconds} seconds, Ctrl+C to cancel)…`,
        ),
      ),
    );
    const accepted = await acceptedSession(context, request, {
      timeoutSeconds: options.timeoutSeconds,
      ask,
      signal: cancelled.signal,
    });
    const credential = accepted.credential;
    // Stored first, under the refresh lock: the pair it replaces is read in the same step, so a
    // `yomi relay` refreshing meanwhile cannot leave a rotated session behind. If the store
    // refuses it, the new session is revoked and the old sign-in stays.
    let replaced: Credential | null = null;
    try {
      replaced = await withFileLock(refreshLockPath(context.account), async () => {
        const stored = context.store.get(context.account);
        context.store.set(context.account, credential);
        return stored;
      });
    } catch (error) {
      if (!(await signOut(accepted.gateway)))
        warn(
          io,
          tr(
            '新建立的会话没能在服务端撤销，它可能仍然有效（见 docs/security.md 5.1）。',
            'The new session could not be revoked on the server; it may still be valid (see docs/security.md 5.1).',
          ),
        );
      throw error;
    }
    saved = true;
    context.gateway.useCredential(credential);
    const old = replaced ?? previous;
    if (old && old.refreshToken !== credential.refreshToken) {
      // Revoked on its own gateway: a refresh this needs never touches the store.
      const revoked = await signOut(context.gateway.detached(old));
      if (!revoked)
        warn(
          io,
          tr(
            '被替换的旧 CLI 会话没能在服务端撤销（网络问题，或已被别的进程刷新），它可能仍然有效（见 docs/security.md 5.1）。',
            'The replaced CLI session could not be revoked on the server (a network problem, or another process refreshed it); it may still be valid (see docs/security.md 5.1).',
          ),
        );
    }
    say(
      io,
      paint(
        io,
        'green',
        tr(
          `✓ 已登录${describeAccount(credential)}`,
          `✓ Signed in with ${describeAccount(credential)}`,
        ),
      ),
    );
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          `凭证保存在${storeDescription(context.store.kind)}`,
          `Credentials saved in the ${storeDescription(context.store.kind)}`,
        ),
      ),
    );
    if (context.store.kind === 'file' && process.env.YOMI_CREDENTIAL_STORE !== 'file')
      warn(
        io,
        tr(
          '没有可用的系统钥匙串，凭证存于本地文件（仅当前用户可读）。',
          'No system keychain available; credentials are stored in a local file (readable only by the current user).',
        ),
      );
  } finally {
    process.removeListener('SIGINT', onSignal);
    request.cancel();
  }
}

/** The account as the server names it: name, user ID and email (never what the page posted). */
function describeAccount(credential: Credential): string {
  const name = credential.displayName
    ? tr(
        `「${terminalText(credential.displayName)}」`,
        ` "${terminalText(credential.displayName)}"`,
      )
    : '';
  const email = credential.email
    ? tr(`，${terminalText(credential.email)}`, `, ${terminalText(credential.email)}`)
    : '';
  return tr(
    `账号${name}（user_id ${credential.userId}${email}）`,
    `account${name} (user_id ${credential.userId}${email})`,
  );
}

/** A server message fit for the terminal: short, without control characters. */
function cleanReason(message: string): string {
  return message.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, '?');
}

function refusalOf(error: unknown): string {
  if (error instanceof DeactivationPending)
    return tr(
      '这个账号正在注销冷静期（如果是你的账号，请先在 App 或网页处理）',
      'this account is in its deletion cool-down period (if it is yours, deal with it in the app or on the web first)',
    );
  const failure = error as ApiError;
  return failure.message && failure.message !== String(failure.code)
    ? tr(
        `${failure.code}：${cleanReason(failure.message)}`,
        `${failure.code}: ${cleanReason(failure.message)}`,
      )
    : String(failure.code);
}

/** Server refusals reported one by one; after these, one line says the rest are not. */
const REFUSALS_REPORTED = 3;

/**
 * Waits for the page's answer and, for a token, tries the session out on a gateway of its own
 * (nothing stored until the person confirms). In a terminal it asks whether that is their
 * account, and whether a cancellation from the page was theirs. A token turned down, a session
 * the server will not give, or a cancellation that was not theirs is revoked or dropped, and the
 * wait goes on for the real answer on the same port. So a callback forged by someone who learned
 * the state can neither sign the CLI into another account nor end the login and take over the
 * port. Without a terminal there is nobody to ask: the first answer is taken.
 */
async function acceptedSession(
  context: Context,
  request: AuthorizeRequest,
  options: {
    timeoutSeconds: number;
    ask: (question: string) => Promise<boolean | null>;
    signal: AbortSignal;
  },
): Promise<{ credential: Credential; gateway: Gateway }> {
  const { io } = context;
  const { ask, signal } = options;
  let refusals = 0;
  let lastRefusal = '';
  const cancelledError = () => new Error(tr('已取消登录', 'Sign-in cancelled'));
  /** After Ctrl+C: the session being tried out is revoked and the login ends. */
  const stopIfCancelled = async (candidate: Gateway) => {
    if (!signal.aborted) return;
    if (candidate.credential) await signOut(candidate);
    throw cancelledError();
  };
  const waitAgain = () => {
    request.resume();
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '继续等待网页授权（Ctrl+C 取消）…',
          'Still waiting for authorization on the web (Ctrl+C to cancel)…',
        ),
      ),
    );
  };
  for (;;) {
    let result;
    try {
      result = await request.next();
    } catch (error) {
      if (signal.aborted) throw cancelledError();
      if (error instanceof CallbackTimeout)
        throw new Error(
          tr(
            `${options.timeoutSeconds} 秒内没有完成授权，请重新运行 yomi login`,
            `Authorization was not completed within ${options.timeoutSeconds} seconds; run yomi login again`,
          ) +
            (lastRefusal
              ? tr(
                  `（服务端最后一次拒绝：${lastRefusal}）`,
                  ` (the server's last refusal: ${lastRefusal})`,
                )
              : ''),
        );
      throw error;
    }
    if (result.kind === 'denied') {
      if (!io.interactive) {
        warn(
          io,
          tr(
            '如果不是你在网页上点的取消，不要再在网页上授权，重新运行 yomi login。',
            'If it was not you who clicked cancel on the web page, do not authorize there again; run yomi login again.',
          ),
        );
        throw new Error(tr('已在网页上取消授权', 'Authorization was cancelled on the web'));
      }
      const end = await ask(
        tr(
          '网页上取消了这次授权。输入 y 结束登录；如果不是你点的，输入 n 继续等待：',
          'Authorization was cancelled on the web page. Type y to end the sign-in; if it was not you, type n to keep waiting: ',
        ),
      );
      if (signal.aborted) throw cancelledError();
      if (end !== false)
        throw new Error(tr('已在网页上取消授权', 'Authorization was cancelled on the web'));
      warn(
        io,
        tr(
          '没有结束登录。不是你点的取消，说明有别的程序在冒充网页回调：请核对确认码后再在网页上点授权。',
          'Sign-in not ended. Since you did not click cancel, another program is posing as the web callback: check the confirmation code, then click authorize on the web page.',
        ),
      );
      waitAgain();
      continue;
    }
    say(
      io,
      tr(
        '已收到网页授权，正在建立 CLI 会话…',
        'Received authorization from the web, setting up the CLI session…',
      ),
    );
    const candidate = context.gateway.detached(null);
    try {
      await exchangeFirebaseToken(candidate, result.idToken, context.idfv, signal);
    } catch (error) {
      // A session the server issued before failing was already revoked by the exchange.
      await stopIfCancelled(candidate);
      const refused =
        (error instanceof ApiError && error.code !== ApiError.transport) ||
        error instanceof DeactivationPending;
      if (!refused) throw error;
      refusals += 1;
      lastRefusal = refusalOf(error);
      if (refusals <= REFUSALS_REPORTED)
        warn(
          io,
          tr(
            `网页交来的凭证没能换出会话（${lastRefusal}）。`,
            `The credentials from the web could not be exchanged for a session (${lastRefusal}).`,
          ),
        );
      else if (refusals === REFUSALS_REPORTED + 1)
        warn(
          io,
          tr(
            '还有更多换不出会话的回调，之后不再逐条提示。',
            'More callbacks could not be exchanged for a session; they will no longer be reported one by one.',
          ),
        );
      waitAgain();
      continue;
    }
    await stopIfCancelled(candidate);
    let name = '';
    try {
      name = (await readProfile(candidate, signal)).name.slice(0, 100);
    } catch (error) {
      await stopIfCancelled(candidate);
      if (error instanceof NotSignedIn) throw error;
      // The name is a nicety; the user ID identifies the account.
    }
    await stopIfCancelled(candidate);
    // The latest pair: a refresh while reading may have rotated the first one, or the server may
    // have ended the session meanwhile (a web sign-in elsewhere): then there is nothing to keep.
    const current = candidate.credential;
    if (!current)
      throw new NotSignedIn(
        tr(
          '刚建立的 CLI 会话已经失效（可能在别处重新登录了网页），没有登录；请重新运行 yomi login',
          'The CLI session just set up is no longer valid (perhaps someone signed in to the web again elsewhere); not signed in. Run yomi login again',
        ),
      );
    const credential: Credential = { ...current, displayName: terminalText(name) };
    candidate.useCredential(credential);
    say(
      io,
      tr(
        `网页授权的是${describeAccount(credential)}。`,
        `The web authorized ${describeAccount(credential)}.`,
      ),
    );
    if (!io.interactive) {
      warn(
        io,
        tr(
          '没有人确认这个账号（非交互运行）。如果你还没在网页上点授权，就不要再点；如果这不是你的账号，运行 yomi logout，再直接在终端里运行 yomi login。',
          'Nobody confirmed this account (running non-interactively). If you have not clicked authorize on the web page yet, do not; if this is not your account, run yomi logout, then run yomi login directly in a terminal.',
        ),
      );
      return { credential, gateway: candidate };
    }
    const yes = await ask(
      tr(
        '以这个账号登录 Yomi CLI？输入 y 确认，n 拒绝并继续等待：',
        'Sign in to Yomi CLI with this account? Type y to confirm, or n to refuse and keep waiting: ',
      ),
    );
    // Ctrl+C at the question: the session is revoked and the login ends.
    await stopIfCancelled(candidate);
    if (yes === true) return { credential: candidate.credential ?? credential, gateway: candidate };
    const revoked = await signOut(candidate);
    if (yes === null)
      throw new Error(
        tr(
          '输入已结束，没有登录（刚建立的会话已撤销）',
          'Input ended; not signed in (the session just set up was revoked)',
        ),
      );
    warn(
      io,
      (revoked
        ? tr(
            '已拒绝这个账号，刚建立的会话已撤销。',
            'Refused this account; the session just set up was revoked. ',
          )
        : tr(
            '已拒绝这个账号，但撤销刚建立的会话没有成功（网络或会话问题），它在服务端可能仍然有效。',
            'Refused this account, but revoking the session just set up failed (a network or session problem); it may still be valid on the server. ',
          )) +
        tr(
          '如果你没有在网页上点过授权，说明有别的程序抢先回调了：请核对确认码后再在网页上点一次授权。',
          'If you never clicked authorize on the web page, another program called back first: check the confirmation code, then click authorize on the web page once more.',
        ),
    );
    waitAgain();
  }
}

export async function logout(context: Context) {
  const { io } = context;
  const credential = context.gateway.credential;
  if (!credential) {
    say(
      io,
      tr(
        `本机没有${describeEnvironment(context.env)}的登录。`,
        `Not signed in on this machine (${describeEnvironment(context.env)}).`,
      ),
    );
    relayTokenHint(context);
    return;
  }
  const revoked = await signOut(context.gateway);
  context.store.delete(context.account);
  context.gateway.useCredential(null);
  say(
    io,
    tr(
      `已退出账号 ${credential.userId}，本机凭证已删除。`,
      `Signed out of account ${credential.userId}; local credentials deleted.`,
    ),
  );
  if (!revoked)
    warn(
      io,
      tr(
        '服务端注销请求没有成功（网络或会话已失效），本机凭证仍已删除。如果怀疑凭证外泄，请在浏览器重新登录一次 Yomi 网页，让其他网页平台的会话（包括 CLI）失效。',
        'The sign-out request to the server failed (network problem, or the session had already expired); local credentials were deleted anyway. If you suspect the credentials leaked, sign in to the Yomi web page again in your browser so that other web-platform sessions (including the CLI) end.',
      ),
    );
  relayTokenHint(context);
}

/** `yomi logout` leaves the relay's bot token: said when there is one. */
function relayTokenHint(context: Context) {
  let token: string | null = null;
  try {
    token = context.store.getSecret(`telegram-bot:${context.account}`);
  } catch {
    return;
  }
  if (token)
    say(
      context.io,
      paint(
        context.io,
        'dim',
        tr(
          '本机还保存着 relay 的 Telegram bot token，yomi logout 不会删除它：需要时运行 yomi relay --telegram --forget；怀疑外泄就在 @BotFather 对这个 bot 发 /revoke。',
          "This machine still holds the relay's Telegram bot token, and yomi logout does not delete it: run yomi relay --telegram --forget when needed; if you suspect it leaked, send /revoke for this bot to @BotFather.",
        ),
      ),
    );
}

export async function whoami(context: Context) {
  const { io } = context;
  const credential = requireSignIn(context);
  const profile = await readProfile(context.gateway);
  say(
    io,
    tr(
      `环境：${describeEnvironment(context.env)}`,
      `Environment: ${describeEnvironment(context.env)}`,
    ),
  );
  say(
    io,
    tr(
      `账号：${profile.name ? `${terminalText(profile.name)} ` : ''}（user_id ${profile.userId}${profile.displayId !== profile.userId ? `，UID ${profile.displayId}` : ''}）`,
      `Account: ${profile.name ? `${terminalText(profile.name)} ` : ''}(user_id ${profile.userId}${profile.displayId !== profile.userId ? `, UID ${profile.displayId}` : ''})`,
    ),
  );
  if (credential.email)
    say(
      io,
      tr(`邮箱：${terminalText(credential.email)}`, `Email: ${terminalText(credential.email)}`),
    );
  if (profile.gems !== null) say(io, tr(`钻石：${profile.gems}`, `Gems: ${profile.gems}`));
  say(
    io,
    tr(
      `凭证：${storeDescription(context.store.kind)}`,
      `Credentials: ${storeDescription(context.store.kind)}`,
    ),
  );
}

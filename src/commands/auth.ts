import { type AuthorizeRequest, beginBrowserAuthorization, openBrowser } from '../auth/browser.js';
import { CallbackTimeout, type CodeOutcome } from '../auth/loopback.js';
import {
  DeactivationPending,
  exchangeAuthCode,
  ExchangeCode,
  exchangeFirebaseToken,
  type Profile,
  readProfile,
  revokeSession,
  signOut,
} from '../auth/session.js';
import { ApiError, type Gateway, NotSignedIn, refreshLockPath } from '../core/api.js';
import { type Credential, storeDescription } from '../core/credentials.js';
import { docUrl } from '../core/docs.js';
import { describeEnvironment } from '../core/env.js';
import { tr } from '../core/i18n.js';
import { withFileLock } from '../core/lock.js';
import { askYesOrNo, paint, say, terminalText, warn } from '../core/ui.js';
import { type Context, requireSignIn } from './context.js';

export type LoginOptions = { browser: boolean; timeoutSeconds: number };

/** Where a session that may live on is said to be dealt with (its section 5.1). */
const SECURITY = docUrl('security.md');

/**
 * `yomi login`: the web authorizes, the CLI gets its own session. See docs/auth-protocol.md and
 * docs/security.md.
 */
export async function login(context: Context, options: LoginOptions) {
  const { io, env } = context;
  const previous = context.gateway.credential;
  say(
    io,
    tr(
      `登录 Yomi（${describeEnvironment(env)}）`,
      `Sign in to Yomi (${describeEnvironment(env)})`,
      `Iniciar sesión en Yomi (${describeEnvironment(env)})`,
      `Entrar no Yomi (${describeEnvironment(env)})`,
    ),
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
          `La cuenta ${previous.userId} ya tiene una sesión iniciada en este equipo; se reemplazará cuando autorices.`,
          `A conta ${previous.userId} já está conectada nesta máquina; ela será substituída quando você autorizar.`,
        ),
      ),
    );
  const request = await beginBrowserAuthorization(env, options.timeoutSeconds * 1000, (reason) =>
    warn(
      io,
      tr(
        `拒绝了一次授权回调（${reason}），继续等待。`,
        `Refused an authorization callback (${reason}); still waiting.`,
        `Se rechazó un callback de autorización (${reason}); se sigue esperando.`,
        `Um callback de autorização foi recusado (${reason}); a espera continua.`,
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
            `已登录；被替换的旧 CLI 会话可能没有撤销，见 ${SECURITY} 第 5.1 节。`,
            `Signed in; the replaced CLI session may not have been revoked: see ${SECURITY} (section 5.1).`,
            `Sesión iniciada; puede que la sesión de la CLI reemplazada no se haya revocado: consulta ${SECURITY} (sección 5.1).`,
            `Login feito; a sessão da CLI substituída pode não ter sido revogada: veja ${SECURITY} (seção 5.1).`,
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
            'Sesión iniciada, revocando la sesión reemplazada; presiona Ctrl+C otra vez para salir ahora.',
            'Login feito, revogando a sessão substituída; pressione Ctrl+C de novo para sair agora.',
          )
        : tr(
            '正在取消登录…（再按一次 Ctrl+C 立即退出）',
            'Cancelling sign-in… (press Ctrl+C again to exit now)',
            'Cancelando el inicio de sesión… (presiona Ctrl+C otra vez para salir ahora)',
            'Cancelando o login… (pressione Ctrl+C de novo para sair agora)',
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
            'Ejecución no interactiva (la entrada o la salida no es una terminal): la primera respuesta válida de la web se aplica sin preguntar. Para confirmar la cuenta, ejecuta esto directamente en una terminal.',
            'Execução não interativa (a entrada ou a saída não é um terminal): a primeira resposta válida da web vale sem perguntar. Para confirmar a conta, execute isto diretamente em um terminal.',
          ),
        ),
      );
    say(io);
    say(
      io,
      tr(
        `确认码：${paint(io, 'bold', request.code)}`,
        `Confirmation code: ${paint(io, 'bold', request.code)}`,
        `Código de confirmación: ${paint(io, 'bold', request.code)}`,
        `Código de confirmação: ${paint(io, 'bold', request.code)}`,
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
          'El código de confirmación de la página web debe coincidir con este; si no coincide, no autorices.',
          'O código de confirmação na página web deve ser igual a este; se não for, não autorize.',
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
            'Se abrió la página de autorización en tu navegador; si no se abrió, visita:',
            'A página de autorização foi aberta no seu navegador; se ela não abriu, acesse:',
          )
        : tr(
            '请在浏览器中打开授权页：',
            'Open the authorization page in your browser:',
            'Abre la página de autorización en tu navegador:',
            'Abra a página de autorização no seu navegador:',
          ),
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
          `Esperando la autorización en la web (válida durante ${options.timeoutSeconds} segundos, Ctrl+C para cancelar)…`,
          `Aguardando a autorização na web (válida por ${options.timeoutSeconds} segundos, Ctrl+C para cancelar)…`,
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
            `新建立的会话没能在服务端撤销，它可能仍然有效，见 ${SECURITY} 第 5.1 节。`,
            `The new session could not be revoked on the server; it may still be valid: see ${SECURITY} (section 5.1).`,
            `No se pudo revocar la nueva sesión en el servidor; puede que siga siendo válida: consulta ${SECURITY} (sección 5.1).`,
            `Não foi possível revogar a nova sessão no servidor; ela pode continuar válida: veja ${SECURITY} (seção 5.1).`,
          ),
        );
      throw error;
    }
    saved = true;
    context.gateway.useCredential(credential);
    const old = replaced ?? previous;
    if (old && old.refreshToken !== credential.refreshToken) {
      // Revoked on its own gateway: a refresh this needs never touches the store.
      const revoked = await revokeSession(context.gateway.detached(old));
      // A refused refresh token (`ended`) is expected only when the server itself replaced the
      // old session: a one-time code of the same account from this machine. Otherwise (another
      // account, an older page's token) it may be a pair another process rotated without storing
      // it, and that session lives on: said, as for a failure.
      const replacedByServer = accepted.via === 'code' && old.userId === credential.userId;
      if (revoked === 'failed' || (revoked === 'ended' && !replacedByServer))
        warn(
          io,
          tr(
            `被替换的旧 CLI 会话没能在服务端撤销（网络问题，或已被别的进程刷新），它可能仍然有效，见 ${SECURITY} 第 5.1 节。`,
            `The replaced CLI session could not be revoked on the server (a network problem, or another process refreshed it); it may still be valid: see ${SECURITY} (section 5.1).`,
            `No se pudo revocar en el servidor la sesión de la CLI reemplazada (un problema de red, u otro proceso la renovó); puede que siga siendo válida: consulta ${SECURITY} (sección 5.1).`,
            `Não foi possível revogar no servidor a sessão da CLI substituída (um problema de rede, ou outro processo a renovou); ela pode continuar válida: veja ${SECURITY} (seção 5.1).`,
          ),
        );
    }
    say(
      io,
      paint(
        io,
        'green',
        tr(
          `✓ 已登录${describeAccount(credential, accepted.uid)}`,
          `✓ Signed in with ${describeAccount(credential, accepted.uid)}`,
          `✓ Sesión iniciada con ${describeAccount(credential, accepted.uid)}`,
          `✓ Login feito com ${describeAccount(credential, accepted.uid)}`,
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
          `Credenciales guardadas en el ${storeDescription(context.store.kind)}`,
          `Credenciais salvas no ${storeDescription(context.store.kind)}`,
        ),
      ),
    );
    if (context.store.kind === 'file' && process.env.YOMI_CREDENTIAL_STORE !== 'file')
      warn(
        io,
        tr(
          '没有可用的系统钥匙串，凭证存于本地文件（仅当前用户可读）。',
          'No system keychain available; credentials are stored in a local file (readable only by the current user).',
          'No hay un llavero del sistema disponible; las credenciales se guardan en un archivo local (solo el usuario actual puede leerlo).',
          'Nenhum Keychain do sistema disponível; as credenciais ficam em um arquivo local (só o usuário atual pode lê-lo).',
        ),
      );
  } finally {
    process.removeListener('SIGINT', onSignal);
    request.cancel();
  }
}

/**
 * The account as the server names it, never as the page posted it: name, user ID, the UID people
 * see in the app (`uid`, when it differs from the user ID) and the email (an older page's sign-in
 * only). The name is the owner's to choose; the UID is what tells two accounts of the same name
 * apart, as the email did before codes.
 */
function describeAccount(credential: Credential, uid = ''): string {
  const name = credential.displayName
    ? tr(
        `「${terminalText(credential.displayName)}」`,
        ` "${terminalText(credential.displayName)}"`,
        ` "${terminalText(credential.displayName)}"`,
        ` "${terminalText(credential.displayName)}"`,
      )
    : '';
  const shownId =
    uid && uid !== credential.userId
      ? tr(
          `，UID ${terminalText(uid)}`,
          `, UID ${terminalText(uid)}`,
          `, UID ${terminalText(uid)}`,
          `, UID ${terminalText(uid)}`,
        )
      : '';
  const email = credential.email
    ? tr(
        `，${terminalText(credential.email)}`,
        `, ${terminalText(credential.email)}`,
        `, ${terminalText(credential.email)}`,
        `, ${terminalText(credential.email)}`,
      )
    : '';
  return tr(
    `账号${name}（user_id ${credential.userId}${shownId}${email}）`,
    `account${name} (user_id ${credential.userId}${shownId}${email})`,
    `la cuenta${name} (user_id ${credential.userId}${shownId}${email})`,
    `a conta${name} (user_id ${credential.userId}${shownId}${email})`,
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
      'esta cuenta está en su periodo de espera de eliminación (si es tuya, resuélvelo primero en la app o en la web)',
      'esta conta está no período de espera da exclusão (se for sua, resolva isso primeiro no app ou na web)',
    );
  const failure = error as ApiError;
  return failure.message && failure.message !== String(failure.code)
    ? tr(
        `${failure.code}：${cleanReason(failure.message)}`,
        `${failure.code}: ${cleanReason(failure.message)}`,
        `${failure.code}: ${cleanReason(failure.message)}`,
        `${failure.code}: ${cleanReason(failure.message)}`,
      )
    : String(failure.code);
}

function couldNotExchange(refusal: string): string {
  return tr(
    `网页交来的凭证没能换出会话（${refusal}）。`,
    `The credentials from the web could not be exchanged for a session (${refusal}).`,
    `No se pudieron canjear las credenciales de la web por una sesión (${refusal}).`,
    `Não foi possível trocar as credenciais da web por uma sessão (${refusal}).`,
  );
}

/**
 * What a failed exchange means for the login: `end` (the error to end it with) or keep waiting
 * (what to `say`, by default `couldNotExchange`), and the page the browser is left on.
 */
type Verdict = { end?: Error; say?: string; page: CodeOutcome };

/**
 * A one-time code that did not become a session. The code is spent either way, so it is never
 * sent again: a refused code waits for the person to authorize again on the page (a new code for
 * the same login), as does an account in its deletion cool-down (as before codes: anyone with
 * such an account could otherwise end a login whose link they read). A banned or deleted account,
 * a refusal of the request itself and a server failure end the login, as does a request that did
 * not get through or that the gateway turned away (the server may have spent the code without the
 * CLI hearing, or never saw the request: authorizing again would not help).
 */
function codeVerdict(error: unknown): Verdict {
  if (error instanceof DeactivationPending)
    return {
      say: tr(
        `网页授权的账号正在注销冷静期，没有换出会话（如果是你的账号，请先在 App 或网页处理）。终端继续等待：换个账号后回到授权页再点一次授权，或按 Ctrl+C 结束。`,
        `The account the web authorized is in its deletion cool-down period, so no session was set up (if it is yours, deal with it in the app or on the web first). Still waiting: switch accounts and click authorize again on the authorization page, or press Ctrl+C to stop.`,
        `La cuenta que autorizó la web está en su periodo de espera de eliminación, así que no se configuró ninguna sesión (si es tuya, resuélvelo primero en la app o en la web). Se sigue esperando: cambia de cuenta y haz clic en autorizar otra vez en la página de autorización, o presiona Ctrl+C para terminar.`,
        `A conta que a web autorizou está no período de espera da exclusão, então nenhuma sessão foi configurada (se for sua, resolva isso primeiro no app ou na web). A espera continua: troque de conta e clique em autorizar de novo na página de autorização, ou pressione Ctrl+C para encerrar.`,
      ),
      page: 'refused',
    };
  if (!(error instanceof ApiError)) return { end: error as Error, page: 'ended' };
  const refusal = refusalOf(error);
  if (error.path !== 'account/exchange_cli_auth_code')
    // The read-back after the exchange: a refusal there waits, as it always has.
    return error.code === ApiError.transport ? { end: error, page: 'ended' } : { page: 'retry' };
  switch (error.code) {
    case ApiError.unauthorized:
      // An anonymous route the gateway turned away: the request never reached the account
      // service, so a new code from the page would meet the same answer.
      return {
        end: new Error(
          tr(
            `Yomi 网关拒绝了换取会话的请求（${refusal}），没有换出会话：请稍后重新运行 yomi login`,
            `The Yomi gateway turned down the request for the session (${refusal}), so no session was set up: run yomi login again later`,
            `La pasarela de Yomi rechazó la solicitud de la sesión (${refusal}), así que no se configuró ninguna sesión: ejecuta yomi login de nuevo más tarde`,
            `O gateway do Yomi recusou a solicitação da sessão (${refusal}), então nenhuma sessão foi configurada: execute yomi login novamente mais tarde`,
          ),
        ),
        page: 'rerun',
      };
    case ApiError.transport: {
      const reason = cleanReason(error.message);
      return {
        end: new Error(
          tr(
            `换取会话的请求没有完成（${reason}），网页交来的授权码可能已经用掉了：请重新运行 yomi login`,
            `The request for the session did not complete (${reason}), and the authorization code from the web may already be used up: run yomi login again`,
            `La solicitud de la sesión no se completó (${reason}), y puede que el código de autorización de la web ya se haya usado: ejecuta yomi login de nuevo`,
            `A solicitação da sessão não foi concluída (${reason}), e o código de autorização da web pode já ter sido usado: execute yomi login novamente`,
          ),
        ),
        page: 'rerun',
      };
    }
    case ExchangeCode.codeInvalid:
      return {
        say: tr(
          `网页交来的授权码没有生效（无效、已用过或已过期；${refusal}）。终端继续等待：回到授权页再点一次授权。`,
          `The authorization code from the web did not work (invalid, already used or expired; ${refusal}). Still waiting: go back to the authorization page and click authorize again.`,
          `El código de autorización de la web no funcionó (no válido, ya usado o caducado; ${refusal}). Se sigue esperando: vuelve a la página de autorización y haz clic en autorizar otra vez.`,
          `O código de autorização da web não funcionou (inválido, já usado ou expirado; ${refusal}). A espera continua: volte à página de autorização e clique em autorizar de novo.`,
        ),
        page: 'retry',
      };
    case ExchangeCode.rateLimited:
      return {
        say: tr(
          `授权太频繁，服务端暂时不接受（${refusal}）。终端继续等待：稍等片刻，再回到授权页点一次授权。`,
          `Too many authorizations; the server is not taking more for now (${refusal}). Still waiting: wait a little, then go back to the authorization page and click authorize again.`,
          `Demasiadas autorizaciones; el servidor no acepta más por ahora (${refusal}). Se sigue esperando: espera un poco y luego vuelve a la página de autorización y haz clic en autorizar otra vez.`,
          `Autorizações demais; o servidor não está aceitando mais por enquanto (${refusal}). A espera continua: espere um pouco, depois volte à página de autorização e clique em autorizar de novo.`,
        ),
        page: 'later',
      };
    case ExchangeCode.banned:
      return {
        end: new Error(
          tr(
            `这个账号已被封禁，不能登录 Yomi CLI（${refusal}）`,
            `This account is banned and cannot sign in to Yomi CLI (${refusal})`,
            `Esta cuenta está suspendida y no puede iniciar sesión en Yomi CLI (${refusal})`,
            `Esta conta está banida e não pode entrar no Yomi CLI (${refusal})`,
          ),
        ),
        page: 'ended',
      };
    case ExchangeCode.accountMissing:
      return {
        end: new Error(
          tr(
            `这个账号不存在或已注销（${refusal}）`,
            `This account does not exist or has been deleted (${refusal})`,
            `Esta cuenta no existe o se eliminó (${refusal})`,
            `Esta conta não existe ou foi excluída (${refusal})`,
          ),
        ),
        page: 'ended',
      };
    case ExchangeCode.invalidParams:
      return {
        end: new Error(
          tr(
            `服务端说换取会话的请求参数不对（${refusal}）。这是 Yomi CLI 的问题，请连同这行信息反馈。`,
            `The server says the request for the session has invalid parameters (${refusal}). This is a Yomi CLI bug; please report it with this line.`,
            `El servidor dice que la solicitud de la sesión tiene parámetros no válidos (${refusal}). Es un error de Yomi CLI; repórtalo junto con esta línea.`,
            `O servidor diz que a solicitação da sessão tem parâmetros inválidos (${refusal}). É um bug do Yomi CLI; informe-o junto com esta linha.`,
          ),
        ),
        page: 'ended',
      };
    case ExchangeCode.internal:
      return {
        end: new Error(
          tr(
            `服务端出错，没有换出会话（${refusal}）；请稍后重新运行 yomi login`,
            `The server failed and no session was set up (${refusal}); run yomi login again later`,
            `El servidor falló y no se configuró ninguna sesión (${refusal}); ejecuta yomi login de nuevo más tarde`,
            `O servidor falhou e nenhuma sessão foi configurada (${refusal}); execute yomi login novamente mais tarde`,
          ),
        ),
        page: 'ended',
      };
    default:
      // Not in the protocol: the code is spent all the same, so wait for a new one as v1 did.
      return { page: 'retry' };
  }
}

/** A Firebase token (old authorize page) that did not become a session: as before codes. */
function tokenVerdict(error: unknown): Verdict {
  const refused =
    (error instanceof ApiError && error.code !== ApiError.transport) ||
    error instanceof DeactivationPending;
  return refused ? { page: 'retry' } : { end: error as Error, page: 'ended' };
}

/** Server refusals reported one by one; after these, one line says the rest are not. */
const REFUSALS_REPORTED = 3;

/**
 * Waits for the page's answer and, for a one-time code (or, from an older page, a Firebase
 * token), tries the session out on a gateway of its own (nothing stored until the person
 * confirms). In a terminal it asks whether that is their account, and whether a cancellation from
 * the page was theirs. A session turned down, a code or token the server will not take, or a
 * cancellation that was not theirs is revoked or dropped, and the wait goes on for the real answer
 * on the same port. So a callback forged by someone who learned the state can neither sign the CLI
 * into another account nor end the login and take over the port. A banned or deleted account, a
 * refusal of the request (a CLI bug), a server failure and an exchange that did not get through
 * end the login (see `codeVerdict`). Without a terminal there is nobody to ask: the first answer
 * is taken. Also says how the session came (`via`) and the account's UID, for the summary.
 */
async function acceptedSession(
  context: Context,
  request: AuthorizeRequest,
  options: {
    timeoutSeconds: number;
    ask: (question: string) => Promise<boolean | null>;
    signal: AbortSignal;
  },
): Promise<{ credential: Credential; gateway: Gateway; via: 'code' | 'token'; uid: string }> {
  const { io } = context;
  const { ask, signal } = options;
  let refusals = 0;
  let lastRefusal = '';
  /** An authorize page from before one-time codes answered: said once. */
  let oldPage = false;
  /** Codes already sent: the server spent each on first sight, so none is sent again. */
  const spent = new Set<string>();
  const cancelledError = () =>
    new Error(
      tr('已取消登录', 'Sign-in cancelled', 'Inicio de sesión cancelado', 'Login cancelado'),
    );
  /** After Ctrl+C: the session being tried out is revoked and the login ends. */
  const stopIfCancelled = async (candidate: Gateway) => {
    if (!signal.aborted) return;
    if (candidate.credential) await signOut(candidate);
    throw cancelledError();
  };
  /** A callback that did not become a session: said (the first few), and the wait goes on. */
  const refused = (reason: string, message: string) => {
    refusals += 1;
    lastRefusal = reason;
    if (refusals <= REFUSALS_REPORTED) warn(io, message);
    else if (refusals === REFUSALS_REPORTED + 1)
      warn(
        io,
        tr(
          '还有更多换不出会话的回调，之后不再逐条提示。',
          'More callbacks could not be exchanged for a session; they will no longer be reported one by one.',
          'Hay más callbacks que no se pudieron canjear por una sesión; ya no se informarán uno por uno.',
          'Há mais callbacks que não puderam ser trocados por uma sessão; eles não serão mais informados um a um.',
        ),
      );
    waitAgain();
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
          'Todavía esperando la autorización en la web (Ctrl+C para cancelar)…',
          'Ainda aguardando a autorização na web (Ctrl+C para cancelar)…',
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
            `La autorización no se completó en ${options.timeoutSeconds} segundos; ejecuta yomi login de nuevo`,
            `A autorização não foi concluída em ${options.timeoutSeconds} segundos; execute yomi login novamente`,
          ) +
            (lastRefusal
              ? tr(
                  `（服务端最后一次拒绝：${lastRefusal}）`,
                  ` (the server's last refusal: ${lastRefusal})`,
                  ` (último rechazo del servidor: ${lastRefusal})`,
                  ` (última recusa do servidor: ${lastRefusal})`,
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
            'Si no fuiste tú quien hizo clic en cancelar en la página web, no vuelvas a autorizar ahí; ejecuta yomi login de nuevo.',
            'Se não foi você quem clicou em cancelar na página web, não autorize lá novamente; execute yomi login novamente.',
          ),
        );
        throw new Error(
          tr(
            '已在网页上取消授权',
            'Authorization was cancelled on the web',
            'La autorización se canceló en la web',
            'A autorização foi cancelada na web',
          ),
        );
      }
      const end = await ask(
        tr(
          '网页上取消了这次授权。输入 y 结束登录；如果不是你点的，输入 n 继续等待：',
          'Authorization was cancelled on the web page. Type y to end the sign-in; if it was not you, type n to keep waiting: ',
          'La autorización se canceló en la página web. Escribe y para terminar el inicio de sesión; si no fuiste tú, escribe n para seguir esperando: ',
          'A autorização foi cancelada na página web. Digite y para encerrar o login; se não foi você, digite n para continuar aguardando: ',
        ),
      );
      if (signal.aborted) throw cancelledError();
      if (end !== false)
        throw new Error(
          tr(
            '已在网页上取消授权',
            'Authorization was cancelled on the web',
            'La autorización se canceló en la web',
            'A autorização foi cancelada na web',
          ),
        );
      warn(
        io,
        tr(
          '没有结束登录。不是你点的取消，说明有别的程序在冒充网页回调：请核对确认码后再在网页上点授权。',
          'Sign-in not ended. Since you did not click cancel, another program is posing as the web callback: check the confirmation code, then click authorize on the web page.',
          'El inicio de sesión no terminó. Como no hiciste clic en cancelar, otro programa se está haciendo pasar por el callback de la web: verifica el código de confirmación y luego haz clic en autorizar en la página web.',
          'O login não foi encerrado. Como você não clicou em cancelar, outro programa está se passando pelo callback da web: confira o código de confirmação e depois clique em autorizar na página web.',
        ),
      );
      waitAgain();
      continue;
    }
    if (result.kind === 'code' && spent.has(result.code)) {
      result.answer('retry');
      const reason = tr('已用过', 'already used', 'ya usado', 'já usado');
      refused(
        reason,
        tr(
          '网页交来的授权码这次登录已经用过，没有再发送。终端继续等待：回到授权页再点一次授权。',
          'The authorization code from the web was already used in this sign-in and was not sent again. Still waiting: go back to the authorization page and click authorize again.',
          'El código de autorización de la web ya se usó en este inicio de sesión y no se volvió a enviar. Se sigue esperando: vuelve a la página de autorización y haz clic en autorizar otra vez.',
          'O código de autorização da web já foi usado neste login e não foi enviado de novo. A espera continua: volte à página de autorização e clique em autorizar de novo.',
        ),
      );
      continue;
    }
    if (result.kind === 'token' && !oldPage) {
      oldPage = true;
      warn(
        io,
        tr(
          '网页还是旧版（交来的是 Firebase 登录凭证，不是一次性授权码）：这次建立的 CLI 会话仍可能在网页重新登录时被结束，到时再运行 yomi login 即可。',
          'The web page is still the old version (it sent a Firebase sign-in credential, not a one-time code): the CLI session set up now may still be ended when someone signs in to the web again; run yomi login again then.',
          'La página web todavía es la versión anterior (envió una credencial de inicio de sesión de Firebase, no un código de un solo uso): la sesión de la CLI que se configure ahora todavía puede terminar cuando alguien vuelva a iniciar sesión en la web; en ese caso ejecuta yomi login de nuevo.',
          'A página web ainda é a versão antiga (ela enviou uma credencial de login do Firebase, não um código de uso único): a sessão da CLI configurada agora ainda pode ser encerrada quando alguém entrar na web de novo; nesse caso execute yomi login novamente.',
        ),
      );
    }
    say(
      io,
      tr(
        '已收到网页授权，正在建立 CLI 会话…',
        'Received authorization from the web, setting up the CLI session…',
        'Autorización recibida de la web, configurando la sesión de la CLI…',
        'Autorização recebida da web, configurando a sessão da CLI…',
      ),
    );
    const candidate = context.gateway.detached(null);
    try {
      if (result.kind === 'code') {
        // Sent once: the server spends the code on first sight, whatever comes of it.
        const { state, codeVerifier } = request.proof();
        spent.add(result.code);
        await exchangeAuthCode(
          candidate,
          { code: result.code, codeVerifier, state, port: request.port, idfv: context.idfv },
          signal,
        );
      } else await exchangeFirebaseToken(candidate, result.idToken, context.idfv, signal);
    } catch (error) {
      // A session the server issued before failing was already revoked by the exchange.
      await stopIfCancelled(candidate);
      const verdict = result.kind === 'code' ? codeVerdict(error) : tokenVerdict(error);
      if (result.kind === 'code') result.answer(verdict.page);
      if (verdict.end) throw verdict.end;
      const reason = refusalOf(error);
      refused(reason, verdict.say ?? couldNotExchange(reason));
      continue;
    }
    await stopIfCancelled(candidate);
    if (result.kind === 'code') result.answer('accepted');
    const via = result.kind;
    let profile: Profile | null = null;
    try {
      profile = await readProfile(candidate, signal);
    } catch (error) {
      await stopIfCancelled(candidate);
      if (error instanceof NotSignedIn) throw error;
      // The name and UID help the person recognise the account; the user ID identifies it.
    }
    const name = profile?.name.slice(0, 100) ?? '';
    const uid = profile ? profile.displayId.slice(0, 40) : '';
    await stopIfCancelled(candidate);
    // The latest pair: a refresh while reading may have rotated the first one, or the server may
    // have ended the session meanwhile (a web sign-in elsewhere): then there is nothing to keep.
    const current = candidate.credential;
    if (!current)
      throw new NotSignedIn(
        tr(
          '刚建立的 CLI 会话已经失效（可能在别处重新登录了网页），没有登录；请重新运行 yomi login',
          'The CLI session just set up is no longer valid (perhaps someone signed in to the web again elsewhere); not signed in. Run yomi login again',
          'La sesión de la CLI que se acaba de configurar ya no es válida (quizás alguien volvió a iniciar sesión en la web desde otro lugar); no se inició sesión. Ejecuta yomi login de nuevo',
          'A sessão da CLI que acabou de ser configurada não é mais válida (talvez alguém tenha entrado na web de novo em outro lugar); o login não foi feito. Execute yomi login novamente',
        ),
      );
    const credential: Credential = { ...current, displayName: terminalText(name) };
    candidate.useCredential(credential);
    say(
      io,
      tr(
        `网页授权的是${describeAccount(credential, uid)}。`,
        `The web authorized ${describeAccount(credential, uid)}.`,
        `La web autorizó ${describeAccount(credential, uid)}.`,
        `A web autorizou ${describeAccount(credential, uid)}.`,
      ),
    );
    if (!io.interactive) {
      warn(
        io,
        tr(
          '没有人确认这个账号（非交互运行）。如果你还没在网页上点授权，就不要再点；如果这不是你的账号，运行 yomi logout，再直接在终端里运行 yomi login。',
          'Nobody confirmed this account (running non-interactively). If you have not clicked authorize on the web page yet, do not; if this is not your account, run yomi logout, then run yomi login directly in a terminal.',
          'Nadie confirmó esta cuenta (ejecución no interactiva). Si todavía no hiciste clic en autorizar en la página web, no lo hagas; si esta no es tu cuenta, ejecuta yomi logout y luego ejecuta yomi login directamente en una terminal.',
          'Ninguém confirmou esta conta (execução não interativa). Se você ainda não clicou em autorizar na página web, não clique; se esta não é sua conta, execute yomi logout e depois execute yomi login diretamente em um terminal.',
        ),
      );
      return { credential, gateway: candidate, via, uid };
    }
    const yes = await ask(
      tr(
        '以这个账号登录 Yomi CLI？输入 y 确认，n 拒绝并继续等待：',
        'Sign in to Yomi CLI with this account? Type y to confirm, or n to refuse and keep waiting: ',
        '¿Iniciar sesión en Yomi CLI con esta cuenta? Escribe y para confirmar, o n para rechazarla y seguir esperando: ',
        'Entrar no Yomi CLI com esta conta? Digite y para confirmar, ou n para recusar e continuar aguardando: ',
      ),
    );
    // Ctrl+C at the question: the session is revoked and the login ends.
    await stopIfCancelled(candidate);
    if (yes === true)
      return { credential: candidate.credential ?? credential, gateway: candidate, via, uid };
    const revoked = await signOut(candidate);
    if (yes === null)
      throw new Error(
        tr(
          '输入已结束，没有登录（刚建立的会话已撤销）',
          'Input ended; not signed in (the session just set up was revoked)',
          'La entrada terminó; no se inició sesión (la sesión que se acababa de configurar se revocó)',
          'A entrada terminou; o login não foi feito (a sessão que acabou de ser configurada foi revogada)',
        ),
      );
    warn(
      io,
      (revoked
        ? tr(
            '已拒绝这个账号，刚建立的会话已撤销。',
            'Refused this account; the session just set up was revoked. ',
            'Se rechazó esta cuenta; la sesión que se acababa de configurar se revocó. ',
            'Esta conta foi recusada; a sessão que acabou de ser configurada foi revogada. ',
          )
        : tr(
            '已拒绝这个账号，但撤销刚建立的会话没有成功（网络或会话问题），它在服务端可能仍然有效。',
            'Refused this account, but revoking the session just set up failed (a network or session problem); it may still be valid on the server. ',
            'Se rechazó esta cuenta, pero no se pudo revocar la sesión que se acababa de configurar (un problema de red o de sesión); puede que siga siendo válida en el servidor. ',
            'Esta conta foi recusada, mas a revogação da sessão que acabou de ser configurada falhou (um problema de rede ou de sessão); ela pode continuar válida no servidor. ',
          )) +
        tr(
          '如果你没有在网页上点过授权，说明有别的程序抢先回调了：请核对确认码后再在网页上点一次授权。',
          'If you never clicked authorize on the web page, another program called back first: check the confirmation code, then click authorize on the web page once more.',
          'Si nunca hiciste clic en autorizar en la página web, otro programa hizo el callback primero: verifica el código de confirmación y luego haz clic en autorizar en la página web una vez más.',
          'Se você nunca clicou em autorizar na página web, outro programa fez o callback primeiro: confira o código de confirmação e depois clique em autorizar na página web mais uma vez.',
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
        `No hay sesión iniciada en este equipo (${describeEnvironment(context.env)}).`,
        `Não há login feito nesta máquina (${describeEnvironment(context.env)}).`,
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
      `Se cerró la sesión de la cuenta ${credential.userId}; se borraron las credenciales locales.`,
      `Você saiu da conta ${credential.userId}; as credenciais locais foram apagadas.`,
    ),
  );
  if (!revoked)
    warn(
      io,
      tr(
        `服务端注销请求没有成功（网络或会话已失效），本机凭证仍已删除。如果怀疑凭证外泄，见 ${SECURITY} 第 5.1 节。`,
        `The sign-out request to the server failed (network problem, or the session had already expired); local credentials were deleted anyway. If you suspect the credentials leaked, see ${SECURITY} (section 5.1).`,
        `La solicitud de cierre de sesión al servidor falló (problema de red, o la sesión ya había caducado); las credenciales locales se borraron de todos modos. Si sospechas que las credenciales se filtraron, consulta ${SECURITY} (sección 5.1).`,
        `A solicitação de logout ao servidor falhou (problema de rede, ou a sessão já tinha expirado); as credenciais locais foram apagadas mesmo assim. Se você suspeitar que as credenciais vazaram, veja ${SECURITY} (seção 5.1).`,
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
          'Este equipo todavía guarda el token del bot de Telegram del relay, y yomi logout no lo borra: ejecuta yomi relay --telegram --forget cuando lo necesites; si sospechas que se filtró, envía /revoke para este bot a @BotFather.',
          'Esta máquina ainda guarda o token do bot do Telegram do relay, e yomi logout não o apaga: execute yomi relay --telegram --forget quando precisar; se suspeitar que ele vazou, envie /revoke para este bot ao @BotFather.',
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
      `Entorno: ${describeEnvironment(context.env)}`,
      `Ambiente: ${describeEnvironment(context.env)}`,
    ),
  );
  say(
    io,
    tr(
      `账号：${profile.name ? `${terminalText(profile.name)} ` : ''}（user_id ${profile.userId}${profile.displayId !== profile.userId ? `，UID ${profile.displayId}` : ''}）`,
      `Account: ${profile.name ? `${terminalText(profile.name)} ` : ''}(user_id ${profile.userId}${profile.displayId !== profile.userId ? `, UID ${profile.displayId}` : ''})`,
      `Cuenta: ${profile.name ? `${terminalText(profile.name)} ` : ''}(user_id ${profile.userId}${profile.displayId !== profile.userId ? `, UID ${profile.displayId}` : ''})`,
      `Conta: ${profile.name ? `${terminalText(profile.name)} ` : ''}(user_id ${profile.userId}${profile.displayId !== profile.userId ? `, UID ${profile.displayId}` : ''})`,
    ),
  );
  if (credential.email)
    say(
      io,
      tr(
        `邮箱：${terminalText(credential.email)}`,
        `Email: ${terminalText(credential.email)}`,
        `Correo: ${terminalText(credential.email)}`,
        `E-mail: ${terminalText(credential.email)}`,
      ),
    );
  if (profile.gems !== null)
    say(
      io,
      tr(
        `钻石：${profile.gems}`,
        `Gems: ${profile.gems}`,
        `Gemas: ${profile.gems}`,
        `Gemas: ${profile.gems}`,
      ),
    );
  say(
    io,
    tr(
      `凭证：${storeDescription(context.store.kind)}`,
      `Credentials: ${storeDescription(context.store.kind)}`,
      `Credenciales: ${storeDescription(context.store.kind)}`,
      `Credenciais: ${storeDescription(context.store.kind)}`,
    ),
  );
}

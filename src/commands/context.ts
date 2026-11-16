import { Gateway, NotSignedIn, refreshLockPath } from '../core/api.js';
import {
  accountKey,
  type Credential,
  type CredentialStore,
  openCredentialStore,
} from '../core/credentials.js';
import { type Environment, resolveEnvironment } from '../core/env.js';
import { deviceKey } from '../core/files.js';
import { tr } from '../core/i18n.js';
import { LocalState } from '../core/state.js';
import { type Io, paint } from '../core/ui.js';

/** What every command gets: where it talks to, the credential store, the signed client. */
export type Context = {
  io: Io;
  env: Environment;
  store: CredentialStore;
  account: string;
  idfv: string;
  gateway: Gateway;
  debug: boolean;
  fetch: typeof fetch;
};

export type GlobalOptions = { env?: string; lane?: string; debug?: boolean };

export function createContext(
  io: Io,
  options: GlobalOptions,
  overrides: {
    fetch?: typeof fetch;
    store?: CredentialStore;
    /** User-Agent suffix and `channel` for a long-running client (`yomi relay`). */
    client?: string;
    channel?: string;
  } = {},
): Context {
  const env = resolveEnvironment(options);
  const store = overrides.store ?? openCredentialStore();
  const account = accountKey(env);
  const idfv = deviceKey();
  const debug = Boolean(options.debug || process.env.YOMI_DEBUG);
  const fetcher = overrides.fetch ?? fetch;
  const gateway = new Gateway({
    env,
    idfv,
    store,
    account,
    credential: store.get(account),
    fetch: fetcher,
    lockPath: refreshLockPath(account),
    client: overrides.client,
    channel: overrides.channel,
    debug: debug
      ? (line) => io.stderr.write(paint(io, 'dim', `[debug] ${line}`) + '\n')
      : undefined,
  });
  return { io, env, store, account, idfv, gateway, debug, fetch: fetcher };
}

/** The signed-in credential, or a clear "sign in first". */
export function requireSignIn(context: Context): Credential {
  const credential = context.gateway.credential;
  if (!credential)
    throw new NotSignedIn(
      tr(
        `还没有登录${context.env.name === 'prod' ? '' : '测试环境'}，先运行 yomi login${context.env.name === 'test' ? ' --env test' : ''}`,
        `Not signed in${context.env.name === 'prod' ? '' : ' to the test environment'} yet; run yomi login${context.env.name === 'test' ? ' --env test' : ''} first`,
      ),
    );
  return credential;
}

export function localState(context: Context): LocalState {
  const credential = requireSignIn(context);
  return new LocalState(`${context.account}|${context.env.lane}`, credential.userId);
}

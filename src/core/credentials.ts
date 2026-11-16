import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Environment } from './env.js';
import { configDir, readJsonFile, writeJsonFile } from './files.js';

/**
 * A signed-in CLI session: its own Gateway session (`account/login`), never the web's or the
 * app's. Tokens are kept in the system keychain (macOS Keychain through `security`, Linux Secret
 * Service through `secret-tool`); only where neither works, in `credentials.json` (0600, its
 * directory 0700). `YOMI_CREDENTIAL_STORE=file` forces the file (tests, headless machines).
 * Secrets never go on a command line: `security` reads them from stdin (`-i`, hex `-X`) and
 * `secret-tool store` from stdin.
 */
export type Credential = {
  version: 1;
  env: string;
  apiOrigin: string;
  userId: string;
  deviceId: string;
  authToken: string;
  refreshToken: string;
  /** From the Firebase sign-in the web passed on; shown by `whoami`, never sent back. */
  email: string;
  displayName: string;
  createdAt: number;
  refreshedAt: number;
};

export type StoreKind = 'keychain' | 'secret-service' | 'file';

export interface CredentialStore {
  readonly kind: StoreKind;
  get(account: string): Credential | null;
  set(account: string, credential: Credential): void;
  delete(account: string): boolean;
  /** Other secrets (a Telegram bot token), by name, kept apart from the sessions. */
  getSecret(name: string): string | null;
  setSecret(name: string, value: string): void;
  deleteSecret(name: string): boolean;
}

const SERVICE = 'yomi-cli';
/** Absolute, so a `security` earlier in PATH is never run with the secrets. */
const SECURITY = '/usr/bin/security';

/** Other secrets live under their own account names, never an environment's. */
const secretAccount = (name: string) => `secret:${name}`;

/** One credential per environment; an overridden gateway (mock, local) gets its own. */
export function accountKey(env: Environment): string {
  return env.custom ? `${env.name}@${env.apiOrigin}` : env.name;
}

/**
 * JSON with every non-ASCII character escaped (`\\uXXXX`). `security find-generic-password -w`
 * prints a value that is not plain ASCII as hex, so a display name like 林夏 would not read back.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/** What `security -w` printed: the value, or its hex when it was not plain ASCII (older writes). */
export function keychainOutput(stdout: string): string {
  const value = stdout.replace(/\n$/, '');
  if (value.length >= 2 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value)) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'hex'));
      if (decoded.startsWith('{')) return decoded;
    } catch {
      // Not UTF-8: the value itself was hex digits.
    }
  }
  return value;
}

function parse(raw: string | null): Credential | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Credential>;
    if (value.version !== 1 || !value.userId || !value.authToken || !value.refreshToken)
      return null;
    return value as Credential;
  } catch {
    return null;
  }
}

/** `credentials.json`: `{ [account]: Credential }`, 0600. */
export class FileStore implements CredentialStore {
  readonly kind = 'file' as const;
  constructor(private readonly path = join(configDir(), 'credentials.json')) {}
  /** Other secrets sit next to the sessions, in `secrets.json` (0600). */
  private get secretsPath() {
    return join(dirname(this.path), 'secrets.json');
  }
  private secrets(): Record<string, string> {
    return readJsonFile<Record<string, string>>(this.secretsPath) ?? {};
  }
  getSecret(name: string) {
    const value = this.secrets()[name];
    return typeof value === 'string' && value ? value : null;
  }
  setSecret(name: string, value: string) {
    writeJsonFile(this.secretsPath, { ...this.secrets(), [name]: value });
  }
  deleteSecret(name: string) {
    const all = this.secrets();
    if (!(name in all)) return false;
    delete all[name];
    if (Object.keys(all).length === 0) rmSync(this.secretsPath, { force: true });
    else writeJsonFile(this.secretsPath, all);
    return true;
  }
  private all(): Record<string, Credential> {
    return readJsonFile<Record<string, Credential>>(this.path) ?? {};
  }
  get(account: string) {
    return parse(JSON.stringify(this.all()[account] ?? null));
  }
  set(account: string, credential: Credential) {
    writeJsonFile(this.path, { ...this.all(), [account]: credential });
  }
  delete(account: string) {
    const all = this.all();
    if (!(account in all)) return false;
    delete all[account];
    if (Object.keys(all).length === 0) rmSync(this.path, { force: true });
    else writeJsonFile(this.path, all);
    return true;
  }
}

type Run = (
  command: string,
  args: string[],
  input?: string,
) => { status: number | null; stdout: string; stderr: string; error?: Error };

const run: Run = (command, args, input) => {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

const quote = (value: string) => {
  if (/["\\\n]/.test(value)) throw new Error('keychain account contains unsupported characters');
  return `"${value}"`;
};

/** macOS Keychain through `/usr/bin/security`. */
export class KeychainStore implements CredentialStore {
  readonly kind = 'keychain' as const;
  constructor(private readonly exec: Run = run) {}
  private getRaw(account: string): string | null {
    const result = this.exec(SECURITY, [
      'find-generic-password',
      '-a',
      account,
      '-s',
      SERVICE,
      '-w',
    ]);
    if (result.status !== 0) return null;
    return keychainOutput(result.stdout) || null;
  }
  /** Writes through `security -i` (stdin), never argv: the value is hex (`-X`). */
  private setRaw(account: string, value: string) {
    const hex = Buffer.from(value, 'utf8').toString('hex');
    const label = `Yomi CLI (${account})`;
    const command =
      `add-generic-password -U -a ${quote(account)} -s ${quote(SERVICE)} ` +
      `-l ${quote(label)} -X ${hex}\n`;
    const result = this.exec(SECURITY, ['-i'], command);
    if (result.status !== 0 || this.getRaw(account) !== value)
      throw new Error('无法写入系统钥匙串（security add-generic-password 失败）');
  }
  get(account: string) {
    return parse(this.getRaw(account));
  }
  set(account: string, credential: Credential) {
    this.setRaw(account, asciiJson(credential));
  }
  delete(account: string) {
    const result = this.exec(SECURITY, ['delete-generic-password', '-a', account, '-s', SERVICE]);
    return result.status === 0;
  }
  getSecret(name: string) {
    return this.getRaw(secretAccount(name));
  }
  setSecret(name: string, value: string) {
    if (!/^[\x20-\x7e]+$/.test(value)) throw new Error('只能保存可打印 ASCII 字符');
    this.setRaw(secretAccount(name), value);
  }
  deleteSecret(name: string) {
    return this.delete(secretAccount(name));
  }
}

/** Linux Secret Service through `secret-tool` (libsecret). */
export class SecretServiceStore implements CredentialStore {
  readonly kind = 'secret-service' as const;
  constructor(private readonly exec: Run = run) {}
  private getRaw(account: string): string | null {
    const result = this.exec('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    if (result.status !== 0) return null;
    return result.stdout.replace(/\n$/, '') || null;
  }
  private setRaw(account: string, value: string) {
    const result = this.exec(
      'secret-tool',
      ['store', `--label=Yomi CLI (${account})`, 'service', SERVICE, 'account', account],
      value,
    );
    if (result.status !== 0) throw new Error('无法写入 Secret Service（secret-tool store 失败）');
  }
  get(account: string) {
    return parse(this.getRaw(account));
  }
  set(account: string, credential: Credential) {
    this.setRaw(account, asciiJson(credential));
  }
  delete(account: string) {
    return this.exec('secret-tool', ['clear', 'service', SERVICE, 'account', account]).status === 0;
  }
  getSecret(name: string) {
    return this.getRaw(secretAccount(name));
  }
  setSecret(name: string, value: string) {
    this.setRaw(secretAccount(name), value);
  }
  deleteSecret(name: string) {
    return this.delete(secretAccount(name));
  }
}

function available(command: string, args: string[]): boolean {
  const result = run(command, args);
  return !result.error && result.status !== null;
}

/**
 * The keychain where there is one, else the file (with a warning from the caller). A file left
 * over from a machine without a keychain is still read, so moving to a keychain loses nothing.
 */
export function openCredentialStore(environ: NodeJS.ProcessEnv = process.env): CredentialStore {
  const forced = environ.YOMI_CREDENTIAL_STORE;
  if (forced === 'file') return new FileStore(join(configDir(environ), 'credentials.json'));
  if (forced && forced !== 'keychain' && forced !== 'auto')
    throw new Error(`YOMI_CREDENTIAL_STORE 只能是 auto、keychain 或 file`);
  if (process.platform === 'darwin' && existsSync('/usr/bin/security')) return new KeychainStore();
  if (process.platform === 'linux' && available('secret-tool', ['--version']))
    return new SecretServiceStore();
  if (forced === 'keychain') throw new Error('这台机器没有可用的系统钥匙串');
  return new FileStore(join(configDir(environ), 'credentials.json'));
}

export function storeDescription(kind: StoreKind): string {
  if (kind === 'keychain') return 'macOS 钥匙串（服务名 yomi-cli）';
  if (kind === 'secret-service') return '系统 Secret Service（服务名 yomi-cli）';
  return `本地文件 ${join(configDir(), 'credentials.json')}（权限 0600）`;
}

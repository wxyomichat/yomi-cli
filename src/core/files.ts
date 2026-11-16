import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { tr } from './i18n.js';

/**
 * The CLI's directory: `$YOMI_CONFIG_DIR`, else `$XDG_CONFIG_HOME/yomi-cli`, else
 * `~/.config/yomi-cli` (as gh's `~/.config/gh`). Created 0700; every file in it is written 0600.
 * Nothing secret lives here unless the system keychain is unavailable (`credentials.ts`).
 */
export function configDir(environ: NodeJS.ProcessEnv = process.env): string {
  if (environ.YOMI_CONFIG_DIR) return environ.YOMI_CONFIG_DIR;
  const base = environ.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'yomi-cli');
}

export function ensurePrivateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // A directory we do not own keeps its mode; files are still written 0600.
  }
}

/** Writes `content` 0600 through a temporary file, so a crash never leaves half a file. */
export function writePrivateFile(path: string, content: string) {
  ensurePrivateDir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      tr(
        `无法读取 ${path}：内容不是 JSON。确认后可删除该文件重试。`,
        `Cannot read ${path}: it is not JSON. Once you have checked it, you can delete the file and try again.`,
        `No se puede leer ${path}: no es JSON. Después de revisarlo, puedes eliminar el archivo e intentarlo de nuevo.`,
        `Não é possível ler ${path}: não é JSON. Depois de conferir, você pode apagar o arquivo e tentar novamente.`,
      ),
    );
  }
}

export function writeJsonFile(path: string, value: unknown) {
  writePrivateFile(path, JSON.stringify(value, null, 2) + '\n');
}

/**
 * This installation's device key (`idfv` in the common query, `device_info.idfv` at sign-in), as
 * the web keeps one per browser. Random, not secret, kept until the directory is removed.
 */
export function deviceKey(dir = configDir()): string {
  const path = join(dir, 'device.json');
  const stored = readJsonFile<{ idfv?: string }>(path);
  if (stored?.idfv && /^[0-9a-f-]{36}$/.test(stored.idfv)) return stored.idfv;
  const idfv = randomUUID();
  writeJsonFile(path, { idfv });
  return idfv;
}

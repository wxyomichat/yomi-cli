import { tr } from './i18n.js';
import { dropTypeahead, type Io } from './ui.js';

/**
 * Reads what a person types for the CLI: a secret (a Telegram bot token, a QQ AppSecret) without
 * echo, or a visible line (a QQ AppID, the digits a phone shows), at a terminal; or lines of a
 * piped stdin (`--token-stdin`). Never from argv or the environment, where `ps`, shell history
 * and child processes would see it. Ctrl+C and Ctrl+D at the terminal cancel.
 */
export class SecretInputCancelled extends Error {
  constructor() {
    super(tr('已取消输入', 'Input cancelled', 'Entrada cancelada', 'Entrada cancelada'));
    this.name = 'SecretInputCancelled';
  }
}

type RawInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  isRaw?: boolean;
};

const MAX_LENGTH = 4096;

/** A secret: typed without echo, or the first line of a piped stdin. */
export function readSecret(
  io: Io,
  prompt: string,
  options: { fromStdin: boolean },
): Promise<string> {
  return readTyped(io, prompt, options, false);
}

/** A visible line: typed with echo, or the first line of a piped stdin. */
export function readLine(
  io: Io,
  prompt: string,
  options: { fromStdin: boolean } = { fromStdin: false },
): Promise<string> {
  return readTyped(io, prompt, options, true);
}

/** The first `count` lines of stdin, trimmed ('' for a line the input ended before). */
export function readLines(io: Io, count: number): Promise<string[]> {
  return readStdinLines(io.stdin, count);
}

function readTyped(
  io: Io,
  prompt: string,
  options: { fromStdin: boolean },
  echo: boolean,
): Promise<string> {
  const input = io.stdin as RawInput;
  if (!options.fromStdin && input.isTTY && typeof input.setRawMode === 'function') {
    io.stderr.write(prompt);
    return readRaw(io, input, echo);
  }
  if (!options.fromStdin && !io.interactive)
    return Promise.reject(
      new Error(
        tr(
          '没有终端可输入：用 --token-stdin 从标准输入传入',
          'No terminal to type into: pass it on standard input with --token-stdin',
          'No hay terminal donde escribir: pásalo por la entrada estándar con --token-stdin',
          'Não há terminal para digitar: passe pela entrada padrão com --token-stdin',
        ),
      ),
    );
  return readStdinLines(input, 1).then(([line]) => line);
}

/** Keys one by one in raw mode, so Ctrl+C and Ctrl+D cancel; `echo` shows what is typed. */
function readRaw(io: Io, input: RawInput, echo: boolean): Promise<string> {
  const setRaw = input.setRawMode!.bind(input);
  const wasRaw = Boolean(input.isRaw);
  setRaw(true);
  input.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    const finish = (error: Error | null) => {
      input.removeListener('data', onData);
      setRaw(wasRaw);
      input.pause();
      io.stderr.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') return finish(null);
        if (character === '\u0003' || character === '\u0004')
          return finish(new SecretInputCancelled());
        if (character === '\u007f' || character === '\b') {
          if (echo && value) io.stderr.write('\b \b');
          value = value.slice(0, -1);
        } else if (character >= ' ' && value.length < MAX_LENGTH) {
          value += character;
          if (echo) io.stderr.write(character);
        }
      }
    };
    input.on('data', onData);
  });
}

function readStdinLines(input: NodeJS.ReadableStream, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const done = (error: Error | null) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
      if (error) return reject(error);
      const lines = buffered
        .split(/\r?\n/)
        .slice(0, count)
        .map((line) => line.trim());
      while (lines.length < count) lines.push('');
      resolve(lines);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      if (buffered.length > MAX_LENGTH * count)
        done(
          new Error(
            tr('输入过长', 'Input too long', 'Entrada demasiado larga', 'Entrada longa demais'),
          ),
        );
      else if ((buffered.match(/\r?\n/g) ?? []).length >= count) done(null);
    };
    const onEnd = () => done(null);
    const onError = (error: Error) => done(error);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

// -------------------------------------------------------------------------------------------------
// The step-by-step guide's input (`yomi relay --setup`): a single key without echo, a line with
// only its digits shown, a line without echo. Each drops what was typed ahead first, then shows
// its prompt (`before`), then reads: at a terminal in raw mode, so Ctrl+C is a byte that cancels
// (SecretInputCancelled) and Ctrl+D ends the input (InputEnded); elsewhere (a test's in-memory
// terminal) line by line. `signal` cancels a read too (the guide's SIGINT when not in raw mode).

/** The input ended (Ctrl+D at a terminal, or a closed stdin) while a key or a line was read. */
export class InputEnded extends Error {
  constructor() {
    super(tr('输入已结束', 'Input ended', 'La entrada terminó', 'A entrada terminou'));
    this.name = 'InputEnded';
  }
}

export type GuidedRead = {
  /** Cancels the read (SecretInputCancelled). */
  signal?: AbortSignal;
  /** Shows the prompt, once what was typed ahead is dropped and just before reading. */
  before?: () => void;
};

export type KeyRead = GuidedRead & {
  /** Several characters at once (a paste, not a key): told what came, and ignored. */
  onPaste?: (text: string) => void;
  /** This many printable characters at once are a paste (3). */
  pasteChars?: number;
  /**
   * After a paste, what comes before the input was this long quiet is the rest of it (a paste can
   * arrive in several reads), ignored too, never a key (250).
   */
  pasteQuietMs?: number;
};

/**
 * Whether a line looks like a pasted credential (an AppSecret) rather than what a prompt asks for:
 * one word of 16 to 128 printable characters, without `/`, that is not a number and mixes letters
 * and digits or carries a symbol. A link to a character has a `/`; an id or an AppID is a number.
 */
export function looksLikeSecret(text: string): boolean {
  const word = text.trim();
  if (!/^[\x21-\x7e]{16,128}$/.test(word) || word.includes('/') || /^[0-9]+$/.test(word))
    return false;
  return (/[A-Za-z]/.test(word) && /[0-9]/.test(word)) || /[^A-Za-z0-9]/.test(word);
}

/** What a terminal sent, without its escape sequences (arrow keys and the like). */
const withoutEscapes = (text: string) =>
  text.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|O[\s\S]|[\s\S])?/g, '');

const BACKSPACE = new Set(['\u007f', '\b']);

/**
 * Reads until `handle` returns a value: at a terminal in raw mode it gets each chunk as it comes
 * (`raw` true), elsewhere each line. Its errors end the read; so do `signal` (SecretInputCancelled)
 * and the end of the input (InputEnded). Raw mode is put back as it was.
 */
function listen<T>(
  io: Io,
  signal: AbortSignal | undefined,
  handle: (text: string, raw: boolean) => T | undefined,
): Promise<T> {
  const input = io.stdin as RawInput & { readableEnded?: boolean };
  const raw = Boolean(input.isTTY && typeof input.setRawMode === 'function');
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new SecretInputCancelled());
    if (input.readableEnded) return reject(new InputEnded());
    const wasRaw = Boolean(input.isRaw);
    if (raw) input.setRawMode!(true);
    let buffered = '';
    const finish = (error: unknown, value?: T) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      signal?.removeEventListener('abort', onAbort);
      if (raw) input.setRawMode!(wasRaw);
      input.pause();
      if (error) reject(error);
      else resolve(value as T);
    };
    const fed = (text: string) => {
      const value = handle(text, raw);
      if (value === undefined) return false;
      finish(null, value);
      return true;
    };
    const onData = (chunk: Buffer | string) => {
      try {
        const text = chunk.toString();
        if (raw) return void fed(text);
        buffered = (buffered + text).slice(-MAX_LENGTH);
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const line = buffered.slice(0, at).replace(/\r$/, '');
          buffered = buffered.slice(at + 1);
          if (fed(line)) return;
        }
      } catch (error) {
        finish(error);
      }
    };
    const onEnd = () => finish(new InputEnded());
    const onAbort = () => finish(new SecretInputCancelled());
    input.on('data', onData);
    input.once('end', onEnd);
    signal?.addEventListener('abort', onAbort, { once: true });
    input.resume();
  });
}

/** The printable characters of what a terminal sent. */
const printable = (text: string) =>
  [...text].filter((character) => character >= ' ' && character !== '\u007f').join('');

/**
 * One key of `keys` (lower case; Enter is '\r'), not echoed; other keys are ignored. Several
 * printable characters at once are a paste: `onPaste`, then read on, the rest of the paste
 * ignored with it (what comes before the input is quiet for `pasteQuietMs`): a pasted secret with
 * its line break never answers, even in pieces. Elsewhere than at a terminal: a line, its first
 * character (an empty line is Enter; a longer one a paste).
 */
export async function readKey(
  io: Io,
  keys: readonly string[],
  options: KeyRead = {},
): Promise<string> {
  await dropTypeahead(io.stdin);
  options.before?.();
  const paste = options.pasteChars ?? 3;
  const quiet = options.pasteQuietMs ?? 250;
  let quietUntil = 0;
  return listen(io, options.signal, (text, raw) => {
    if (!raw) {
      const line = text.trim();
      if ([...line].length >= paste) {
        options.onPaste?.(line);
        return undefined;
      }
      const key = line ? line[0].toLowerCase() : '\r';
      return keys.includes(key) ? key : undefined;
    }
    const typed = withoutEscapes(text);
    if (typed.includes('\u0003')) throw new SecretInputCancelled();
    if (typed.includes('\u0004')) throw new InputEnded();
    const now = Date.now();
    if (now < quietUntil) {
      quietUntil = now + quiet;
      return undefined;
    }
    if ([...printable(typed)].length >= paste) {
      quietUntil = now + quiet;
      options.onPaste?.(printable(typed));
      return undefined;
    }
    for (const character of typed) {
      const key = character === '\r' || character === '\n' ? '\r' : character.toLowerCase();
      if (keys.includes(key)) return key;
    }
    return undefined;
  });
}

/**
 * A line with only its digits shown (a character's link or id, an AppID, a number of gems): at a
 * terminal its digits echo and everything else shows as `*`; once what came, or the line so far
 * with it, looks like a pasted secret, the rest of the line shows only `*` and what showed of it
 * is masked too (a paste can arrive in several reads); backspace works. Elsewhere a line, not
 * echoed.
 */
export async function readMasked(io: Io, options: GuidedRead = {}): Promise<string> {
  await dropTypeahead(io.stdin);
  options.before?.();
  const input = io.stdin as RawInput;
  if (input.isTTY && typeof input.setRawMode === 'function') io.stdout.write('  › ');
  let value: string[] = [];
  let hidden = false;
  return listen(io, options.signal, (text, raw) => {
    if (!raw) return text.trim();
    const typed = withoutEscapes(text);
    const came = printable(typed);
    if (!hidden && (looksLikeSecret(came) || looksLikeSecret(value.join('') + came))) {
      hidden = true;
      if (value.length) io.stdout.write('\b'.repeat(value.length) + '*'.repeat(value.length));
    }
    for (const character of typed) {
      if (character === '\r' || character === '\n') {
        io.stdout.write('\n');
        return value.join('').trim();
      }
      if (character === '\u0003' || character === '\u0004') {
        io.stdout.write('\n');
        throw character === '\u0003' ? new SecretInputCancelled() : new InputEnded();
      }
      if (BACKSPACE.has(character)) {
        if (value.length) io.stdout.write('\b \b');
        value = value.slice(0, -1);
      } else if (character >= ' ' && value.length < MAX_LENGTH) {
        value.push(character);
        io.stdout.write(!hidden && /[0-9]/.test(character) ? character : '*');
      }
    }
    return undefined;
  });
}

/** A line typed without echo (an AppSecret); elsewhere than at a terminal, a line. */
export async function readHidden(io: Io, options: GuidedRead = {}): Promise<string> {
  await dropTypeahead(io.stdin);
  options.before?.();
  let value: string[] = [];
  return listen(io, options.signal, (text, raw) => {
    if (!raw) return text.trim();
    for (const character of withoutEscapes(text)) {
      if (character === '\r' || character === '\n') {
        io.stdout.write('\n');
        return value.join('').trim();
      }
      if (character === '\u0003' || character === '\u0004') {
        io.stdout.write('\n');
        throw character === '\u0003' ? new SecretInputCancelled() : new InputEnded();
      }
      if (BACKSPACE.has(character)) value = value.slice(0, -1);
      else if (character >= ' ' && value.length < MAX_LENGTH) value.push(character);
    }
    return undefined;
  });
}

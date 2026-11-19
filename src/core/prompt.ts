import { tr } from './i18n.js';
import type { Io } from './ui.js';

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

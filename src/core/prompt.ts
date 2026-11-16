import type { Io } from './ui.js';

/**
 * Reads a secret (a Telegram bot token): typed at a terminal without echo, or the first line of a
 * piped stdin (`--token-stdin`). Never from argv or the environment, where `ps`, shell history and
 * child processes would see it.
 */
export class SecretInputCancelled extends Error {
  constructor() {
    super('已取消输入');
    this.name = 'SecretInputCancelled';
  }
}

type RawInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  isRaw?: boolean;
};

const MAX_LENGTH = 4096;

export function readSecret(
  io: Io,
  prompt: string,
  options: { fromStdin: boolean },
): Promise<string> {
  const input = io.stdin as RawInput;
  if (!options.fromStdin && input.isTTY && typeof input.setRawMode === 'function') {
    io.stderr.write(prompt);
    return readHidden(io, input);
  }
  if (!options.fromStdin && !io.interactive)
    return Promise.reject(new Error('没有终端可输入：用 --token-stdin 从标准输入传入'));
  return readFirstLine(input);
}

function readHidden(io: Io, input: RawInput): Promise<string> {
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
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && value.length < MAX_LENGTH) value += character;
      }
    };
    input.on('data', onData);
  });
}

function readFirstLine(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const done = (error: Error | null) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
      if (error) reject(error);
      else resolve(buffered.split(/\r?\n/)[0].trim());
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      if (buffered.length > MAX_LENGTH) done(new Error('输入过长'));
      else if (/\r?\n/.test(buffered)) done(null);
    };
    const onEnd = () => done(null);
    const onError = (error: Error) => done(error);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

import { PassThrough } from 'node:stream';

import type { Io } from '../../src/core/ui.js';

/** In-memory terminal for running commands in tests. */
export function memoryIo(options: { interactive?: boolean; input?: string[] } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
  });
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8');
  });
  for (const line of options.input ?? []) stdin.write(line + '\n');
  const io: Io = {
    stdin,
    stdout,
    stderr,
    interactive: options.interactive ?? false,
    colour: false,
  };
  return {
    io,
    stdin,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    /** Resolves when stdout contains `pattern`. */
    async waitFor(pattern: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
      const started = Date.now();
      for (;;) {
        const match = out.match(pattern);
        if (match) return match;
        if (Date.now() - started > timeoutMs)
          throw new Error(`timed out waiting for ${pattern}\n${out}\n${err}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

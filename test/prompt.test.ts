import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readLine, readLines, SecretInputCancelled } from '../src/core/prompt.js';
import type { Io } from '../src/core/ui.js';

/**
 * The visible prompts the QQ and WeChat setups use (`--set-app`: AppID; `--login`: the digits a
 * phone shows) and the several lines `--token-stdin` takes for QQ.
 */

const io = (stdin: PassThrough, interactive: boolean): Io => ({
  stdin,
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  interactive,
  colour: false,
});

function terminal() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    },
  });
  const value = io(stdin, true);
  let shown = '';
  value.stderr.on('data', (chunk: Buffer) => (shown += chunk.toString()));
  return { stdin, io: value, shown: () => shown };
}

describe('reading a visible line', () => {
  it('echoes what is typed at a terminal, with backspace, and leaves raw mode', async () => {
    const { stdin, io: typed, shown } = terminal();
    const pending = readLine(typed, 'AppID: ');
    stdin.write('1020x\u007f00001\r');
    await expect(pending).resolves.toBe('102000001');
    expect(shown()).toBe('AppID: 1020x\b \b00001\n');
    expect(stdin.isRaw).toBe(false);
  });

  it('is cancelled by Ctrl+C or Ctrl+D', async () => {
    for (const key of ['\u0003', '\u0004']) {
      const { stdin, io: typed } = terminal();
      const pending = readLine(typed, 'Digits: ');
      stdin.write(`12${key}`);
      await expect(pending).rejects.toBeInstanceOf(SecretInputCancelled);
      expect(stdin.isRaw).toBe(false);
    }
  });

  it('takes the first line of a piped stdin when asked, and refuses without a terminal otherwise', async () => {
    const stdin = new PassThrough();
    const pending = readLine(io(stdin, false), 'AppID: ', { fromStdin: true });
    stdin.write(' 102000001 \nsecret\n');
    await expect(pending).resolves.toBe('102000001');
    await expect(readLine(io(new PassThrough(), false), 'AppID: ')).rejects.toThrow(
      /--token-stdin/,
    );
  });
});

describe('reading several lines of stdin', () => {
  it('takes the first lines, trimmed, across chunks and line endings', async () => {
    const stdin = new PassThrough();
    const pending = readLines(io(stdin, false), 2);
    stdin.write('102000001\r');
    stdin.write('\n  s3cret-value  \r\nignored\n');
    await expect(pending).resolves.toEqual(['102000001', 's3cret-value']);
  });

  it("gives '' for the lines the input ended before", async () => {
    const stdin = new PassThrough();
    const pending = readLines(io(stdin, false), 2);
    stdin.end('102000001');
    await expect(pending).resolves.toEqual(['102000001', '']);
  });

  it('refuses an endless line', async () => {
    const stdin = new PassThrough();
    const pending = readLines(io(stdin, false), 2);
    stdin.write('x'.repeat(10_000));
    await expect(pending).rejects.toThrow();
  });
});

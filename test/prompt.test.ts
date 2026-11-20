import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  InputEnded,
  looksLikeSecret,
  readHidden,
  readKey,
  readLine,
  readLines,
  readMasked,
  SecretInputCancelled,
} from '../src/core/prompt.js';
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
  let printed = '';
  value.stderr.on('data', (chunk: Buffer) => (shown += chunk.toString()));
  value.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  return { stdin, io: value, shown: () => shown, printed: () => printed };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once a guided read shows its prompt (what was typed before it is dropped). */
function prompted() {
  let shown: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    shown = resolve;
  });
  return { before: () => shown(), ready };
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

describe("the guide's prompts at a terminal", () => {
  it('reads one key, not echoed: others are ignored, a paste is told and ignored, Enter is a key', async () => {
    const { stdin, io: typed, shown, printed } = terminal();
    const prompt = prompted();
    const pasted: string[] = [];
    const pending = readKey(typed, ['\r', 'o', 'q'], {
      ...prompt,
      pasteQuietMs: 30,
      onPaste: (text) => pasted.push(text),
    });
    await prompt.ready;
    expect(stdin.isRaw).toBe(true);
    stdin.write('x');
    stdin.write('s3cr3t-Value-0123456789\r');
    stdin.write('\u001b[A');
    await sleep(80);
    stdin.write('O');
    await expect(pending).resolves.toBe('o');
    expect(pasted).toEqual(['s3cr3t-Value-0123456789']);
    expect(stdin.isRaw).toBe(false);
    expect(shown() + printed()).toBe('');
    const enter = prompted();
    const again = readKey(typed, ['\r', 'q'], enter);
    await enter.ready;
    stdin.write('\r');
    await expect(again).resolves.toBe('\r');
  });

  it('takes no key from the rest of a paste that came in several reads', async () => {
    const { stdin, io: typed } = terminal();
    const prompt = prompted();
    let pasted = 0;
    const pending = readKey(typed, ['\r', 'y', 'n', '2'], {
      ...prompt,
      pasteQuietMs: 60,
      onPaste: () => (pasted += 1),
    });
    let answered = '';
    void pending.then((key) => (answered = key));
    await prompt.ready;
    stdin.write('Ab3dEf7hIj9kLm1nOp2qRs4tUv5wXy');
    await sleep(10);
    stdin.write('6z\r');
    await sleep(10);
    stdin.write('y');
    await sleep(10);
    stdin.write('2');
    await sleep(20);
    expect(answered).toBe('');
    await sleep(120);
    stdin.write('n');
    await expect(pending).resolves.toBe('n');
    expect(pasted).toBe(1);
  });

  it('is cancelled by Ctrl+C as a byte, ended by Ctrl+D, and cancelled by its signal', async () => {
    const { stdin, io: typed } = terminal();
    for (const [byte, error] of [
      ['\u0003', SecretInputCancelled],
      ['\u0004', InputEnded],
    ] as const) {
      const prompt = prompted();
      const pending = readKey(typed, ['\r'], prompt);
      await prompt.ready;
      stdin.write(byte);
      await expect(pending).rejects.toBeInstanceOf(error);
      expect(stdin.isRaw).toBe(false);
    }
    const controller = new AbortController();
    const prompt = prompted();
    const pending = readMasked(typed, { ...prompt, signal: controller.signal });
    await prompt.ready;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(SecretInputCancelled);
    expect(stdin.isRaw).toBe(false);
  });

  it('shows only the digits of a masked line, and none of a pasted secret', async () => {
    const { stdin, io: typed, printed } = terminal();
    const prompt = prompted();
    const pending = readMasked(typed, prompt);
    await prompt.ready;
    stdin.write('id=73');
    stdin.write('x\u007f0');
    stdin.write('\r');
    await expect(pending).resolves.toBe('id=730');
    expect(printed()).toBe('  › ***73*\b \b0\n');
    const secret = 'a1b2c3d4e5f6a7b8c9d0';
    const second = prompted();
    const pasted = readMasked(typed, second);
    await second.ready;
    stdin.write(secret);
    stdin.write('\r');
    await expect(pasted).resolves.toBe(secret);
    expect(printed().endsWith(`  › ${'*'.repeat(secret.length)}\n`)).toBe(true);
    const third = prompted();
    const cancelled = readMasked(typed, third);
    await third.ready;
    stdin.write('12\u0003');
    await expect(cancelled).rejects.toBeInstanceOf(SecretInputCancelled);
  });

  it('shows none of a pasted secret that came in several reads', async () => {
    const { stdin, io: typed, printed } = terminal();
    const prompt = prompted();
    const pending = readMasked(typed, prompt);
    await prompt.ready;
    stdin.write('Ab3dEf7hIj9kLm1nOp2q');
    stdin.write('Rs4tUv5wXy6z\r');
    await expect(pending).resolves.toBe('Ab3dEf7hIj9kLm1nOp2qRs4tUv5wXy6z');
    expect(printed()).toBe(`  › ${'*'.repeat(32)}\n`);
    // Smaller pieces: the digits shown before it looked like a secret are masked again.
    const second = prompted();
    const pieces = readMasked(typed, second);
    await second.ready;
    for (const piece of ['Ab3d', 'Ef7hIj9k', 'Lm1nOp2q', 'Rs4t\r']) {
      stdin.write(piece);
      await sleep(5);
    }
    await expect(pieces).resolves.toBe('Ab3dEf7hIj9kLm1nOp2qRs4t');
    const echo = printed().slice(printed().lastIndexOf('  › '));
    expect(echo.startsWith('  › **3*')).toBe(true);
    // Once it looked like a secret (16 characters): back over what showed, all of it masked.
    expect(echo).toContain(`${'\b'.repeat(12)}${'*'.repeat(12)}${'*'.repeat(8)}`);
    expect(echo.slice(echo.lastIndexOf('\b') + 1)).not.toMatch(/[0-9]/);
  });

  it('reads a hidden line without echo; elsewhere than at a terminal, a line', async () => {
    const { stdin, io: typed, shown, printed } = terminal();
    const prompt = prompted();
    const pending = readHidden(typed, prompt);
    await prompt.ready;
    stdin.write('s3cret-value!');
    stdin.write('\u007f?\r');
    await expect(pending).resolves.toBe('s3cret-value?');
    expect(shown()).toBe('');
    expect(printed()).toBe('\n');
    const piped = new PassThrough();
    const plain = prompted();
    const line = readHidden(io(piped, true), plain);
    await plain.ready;
    piped.write('  s3cret-value  \r\n');
    await expect(line).resolves.toBe('s3cret-value');
    const ended = prompted();
    const nothing = readKey(io(piped, true), ['\r'], ended);
    await ended.ready;
    piped.end();
    await expect(nothing).rejects.toBeInstanceOf(InputEnded);
  });

  it('tells a pasted credential from a link, an id or a number', () => {
    expect(looksLikeSecret('a1b2c3d4e5f6a7b8c9d0')).toBe(true);
    expect(looksLikeSecret('Secret_Value-With.Symbols')).toBe(true);
    expect(looksLikeSecret('7300000000000009001')).toBe(false);
    expect(looksLikeSecret('https://www.yomichat.io/character/7300000000000009001')).toBe(false);
    expect(looksLikeSecret('short1a')).toBe(false);
    expect(looksLikeSecret('onlylettersherefortest')).toBe(false);
  });
});

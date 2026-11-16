import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

/**
 * Terminal I/O shared by the commands: colours only on a TTY (and never with `NO_COLOR`),
 * confirmations that need a typed answer, and a test seam (`Io`) so the commands run against
 * in-memory streams.
 */
export type Io = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Whether a person can answer questions (stdin and stdout are terminals, or a test says so). */
  interactive: boolean;
  colour: boolean;
};

export function processIo(): Io {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    interactive,
    colour: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  };
}

const codes = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
  magenta: [35, 39],
} as const;

export type Style = keyof typeof codes;

export function paint(io: Io, style: Style, text: string): string {
  if (!io.colour) return text;
  const [open, close] = codes[style];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

export function say(io: Io, line = '') {
  io.stdout.write(line + '\n');
}

export function warn(io: Io, line: string) {
  io.stderr.write(paint(io, 'yellow', line) + '\n');
}

/** One line of input, `null` at end of input. */
export async function ask(io: Io, question: string): Promise<string | null> {
  const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: false });
  try {
    io.stdout.write(question);
    const answer = await new Promise<string | null>((resolve) => {
      rl.once('line', (line) => resolve(line));
      rl.once('close', () => resolve(null));
    });
    return answer;
  } finally {
    rl.close();
  }
}

/**
 * A question only an explicit answer settles: `y`/`yes` (true) or `n`/`no` (false); anything else
 * asks again. Whatever was typed before the question appeared (an Enter pressed while waiting, a
 * stray `y` without Enter) is dropped first, so it cannot answer it. Null when the input ends or
 * `signal` aborts (Ctrl+C handled by the caller).
 */
export async function askYesOrNo(
  io: Io,
  question: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const ended = await dropTypeahead(io.stdin);
  if (ended || signal?.aborted || io.stdin.readableEnded || io.stdin.destroyed) {
    io.stdout.write(question + '\n');
    return null;
  }
  const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: false });
  const onAbort = () => rl.close();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    io.stdout.write(question);
    return await new Promise<boolean | null>((resolve) => {
      rl.on('line', (line) => {
        const answer = line.trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') resolve(true);
        else if (answer === 'n' || answer === 'no') resolve(false);
        else io.stdout.write(question);
      });
      rl.once('close', () => resolve(null));
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    rl.close();
  }
}

/**
 * Reads and drops whatever input is already waiting; true when the input ended meanwhile. On a
 * terminal it reads raw for that moment, so a line typed without Enter goes too.
 */
async function dropTypeahead(stdin: Readable, ms = 60): Promise<boolean> {
  const tty = stdin as Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
  const raw = Boolean(tty.isTTY && typeof tty.setRawMode === 'function');
  let ended = false;
  const drop = () => undefined;
  const end = () => {
    ended = true;
  };
  stdin.on('data', drop);
  stdin.once('end', end);
  try {
    if (raw) tty.setRawMode!(true);
    stdin.resume();
    await new Promise((resolve) => setTimeout(resolve, ms));
  } finally {
    stdin.removeListener('data', drop);
    stdin.removeListener('end', end);
    stdin.pause();
    if (raw) tty.setRawMode!(false);
  }
  return ended;
}

/**
 * Text from elsewhere (a name, an email) safe to print: control, C1 and bidi characters become
 * `?`, so it cannot fake a line, hide what follows or reorder it.
 */
export function terminalText(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    '?',
  );
}

/**
 * A yes/no that only a typed `y`/`yes` (or the expected word) accepts. Without a person to ask it
 * is a refusal: commands that need consent take an explicit flag instead.
 */
export async function confirm(io: Io, question: string, expected = 'y'): Promise<boolean> {
  if (!io.interactive) return false;
  const answer = (await ask(io, question))?.trim().toLowerCase() ?? '';
  if (expected === 'y') return answer === 'y' || answer === 'yes';
  return answer === expected.toLowerCase();
}

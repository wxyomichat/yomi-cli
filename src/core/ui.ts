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
 * A yes/no that only a typed `y`/`yes` (or the expected word) accepts. Without a person to ask it
 * is a refusal: commands that need consent take an explicit flag instead.
 */
export async function confirm(io: Io, question: string, expected = 'y'): Promise<boolean> {
  if (!io.interactive) return false;
  const answer = (await ask(io, question))?.trim().toLowerCase() ?? '';
  if (expected === 'y') return answer === 'y' || answer === 'yes';
  return answer === expected.toLowerCase();
}

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A stand-in for the child process of the QR scan (src/relay/channels/qq-connect-child.ts), for
 * tests: a module, written to `dir`, that writes down what it was started with (its pid, argv and
 * the names in its environment), then follows `steps` (wait, send a message, or exit), and stays
 * until it is killed or its parent goes. Nothing in it reaches the network.
 */
export type FakeStep = { after?: number; send?: unknown; exit?: number };

export type FakeChild = {
  path: string;
  /** What the child wrote down when it started (throws before it started). */
  record(): { pid: number; argv: string[]; env: string[] };
};

export function fakeConnectChild(dir: string, name: string, steps: FakeStep[]): FakeChild {
  const path = join(dir, `${name}.mjs`);
  const record = join(dir, `${name}.json`);
  writeFileSync(
    path,
    `import { writeFileSync } from 'node:fs';
const steps = ${JSON.stringify(steps)};
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), env: Object.keys(process.env).sort() }));
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 60_000);
for (const step of steps) {
  await new Promise((resolve) => setTimeout(resolve, step.after ?? 0));
  if (step.exit !== undefined) process.exit(step.exit);
  process.send(step.send);
}
`,
  );
  return { path, record: () => JSON.parse(readFileSync(record, 'utf8')) };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether `pid` is gone (killed and reaped) within 3 s. */
export async function processGone(pid: number): Promise<boolean> {
  for (let waited = 0; alive(pid) && waited < 3000; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
}

/** A QR link as Tencent's connector gives it (never opened: the fake child only says it). */
export const SCAN_URL = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=t0k&source=&_wv=2';

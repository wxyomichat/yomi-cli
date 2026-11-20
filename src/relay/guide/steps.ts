import { openBrowser } from '../../auth/browser.js';
import { tr } from '../../core/i18n.js';
import {
  InputEnded,
  looksLikeSecret,
  readHidden,
  readKey,
  readMasked,
  SecretInputCancelled,
} from '../../core/prompt.js';
import { type Io, paint, terminalRows } from '../../core/ui.js';

/**
 * The step engine of `yomi relay --setup` (commands/relay-setup.ts): numbered steps ("Step 3 of
 * 7 · …"), the ones already done shown with a check mark and passed over, and the guide's own
 * prompts. Every prompt drops what was typed ahead, then shows its line on stdout, then reads: a
 * single key without echo (Enter, a letter, a digit), a line with only its digits shown, or a line
 * without echo (the AppSecret). Ctrl+C cancels the guide wherever it is: as a byte in raw mode, as
 * SIGINT otherwise (the guide's own listener, taken away while a login, a change with the
 * background service stopped or a relay run handle SIGINT themselves: `outside`); `q` quits.
 * What was pasted at a prompt that does not take a secret is never shown, and said. What the guide
 * writes in a `region` can be erased from a terminal (a QR code, once scanned or given up).
 */

/** The guide's timings (tests shrink them). */
export const GUIDE_TIMINGS = {
  /** QQ takes one Identify per 5 s and bot: the guide's check and its pairing keep that apart. */
  identifyIntervalMs: 5000,
  /** Not connected this long after "Connecting to QQ": said why, and the wait goes on. */
  notConnectedMs: 30_000,
  /** This many printable characters at once at a key prompt are a paste, not a key. */
  pasteChars: 3,
  /** After a paste at a key prompt, what comes before the input was this long quiet is its rest. */
  pasteQuietMs: 250,
  /** Step 3's scan: no QR code from Tencent's connector this long after it started is a failure. */
  scanStartMs: 20_000,
  /** Step 3's scan: not scanned this long after it started, the AppID and AppSecret are typed. */
  scanMs: 5 * 60_000,
};

/** The guide ends before its last step: Ctrl+C ('interrupt', exit 130) or `q` ('quit', exit 0). */
export class GuideCancelled extends Error {
  constructor(readonly how: 'interrupt' | 'quit') {
    super(how);
    this.name = 'GuideCancelled';
  }
}

/** What a step asks of the engine after it ran: the next step (nothing), the end, or a step again. */
export type StepResult = void | { end: true } | { back: string };

export type GuideStep<S> = {
  /** How `{ back }` names it. */
  id: string;
  title(): string;
  /** Left out, and not counted (decided once, before the first step). */
  skip?(state: S): boolean;
  /** Done already (asked when its turn comes): shown with a check mark, not run. */
  finished?(state: S): boolean;
  run(state: S, ui: GuideUi): Promise<StepResult>;
};

const heading = (step: number, total: number, title: string) =>
  tr(
    `第 ${step} 步，共 ${total} 步 · ${title}`,
    `Step ${step} of ${total} · ${title}`,
    `Paso ${step} de ${total} · ${title}`,
    `Passo ${step} de ${total} · ${title}`,
  );

/**
 * Runs `steps` in order, numbered among those not skipped: 'done' after the last one, 'ended' when
 * a step ended the guide early. Throws what a step throws (`GuideCancelled` among it).
 */
export async function runGuide<S>(
  steps: readonly GuideStep<S>[],
  state: S,
  ui: GuideUi,
): Promise<'done' | 'ended'> {
  const shown = steps.filter((step) => !step.skip?.(state));
  let checked = false;
  for (let index = 0; index < shown.length; ) {
    const step = shown[index];
    const title = heading(index + 1, shown.length, step.title());
    if (step.finished?.(state)) {
      if (!checked) ui.say();
      ui.say(`${paint(ui.io, 'green', '✓')} ${title}`);
      checked = true;
      index += 1;
      continue;
    }
    checked = false;
    ui.say();
    ui.say(paint(ui.io, 'bold', title));
    const result = await step.run(state, ui);
    if (result && 'end' in result) return 'ended';
    if (result && 'back' in result) {
      const at = shown.findIndex((item) => item.id === result.back);
      index = at >= 0 ? at : index + 1;
      continue;
    }
    index += 1;
  }
  return 'done';
}

/** A secret pasted where it does not go: never shown, never kept. */
function pastedText(): string {
  return tr(
    '这像是粘贴了 AppSecret：没有显示，也没有保存。AppSecret 只在 AppSecret 提示里粘贴。',
    'That looks like a pasted AppSecret: it was neither shown nor saved. Paste the AppSecret only at the AppSecret prompt.',
    'Eso parece un AppSecret pegado: no se mostró ni se guardó. Pega el AppSecret solo en la solicitud del AppSecret.',
    'Isso parece um AppSecret colado: ele não foi mostrado nem salvo. Cole o AppSecret só no pedido do AppSecret.',
  );
}

/** Something else pasted at a key prompt (an AppID, a link): not shown, and a key is asked for. */
function pastedKeyText(): string {
  return tr(
    '这像是粘贴的内容，没有显示。这里只按一个键。',
    'That looks like a paste; it was not shown. Press a single key here.',
    'Eso parece algo pegado; no se mostró. Aquí presiona una sola tecla.',
    'Isso parece algo colado; não foi mostrado. Aqui pressione uma única tecla.',
  );
}

/** What the guide wrote since a region began: whole terminal rows, and the line it is on. */
type Written = { rows: number; line: string };

/** Lines the guide wrote that it can take back from the terminal (`GuideUi.region`). */
export type GuideRegion = {
  /** Erases what was written in the region so far (at a terminal); the region goes on. */
  clear(): void;
  /** Erases it, and ends the region. */
  close(): void;
};

/** The guide's terminal: what it says, and its prompts. */
export class GuideUi {
  private readonly controller = new AbortController();
  private listening = false;
  private readonly onSignal = () => this.controller.abort();
  /** What was written since the open region began (null: no region). */
  private written: Written | null = null;
  /** Lines said as notes (and the policy's warning): a run's log says them once. */
  readonly notes = new Set<string>();

  constructor(readonly io: Io) {}

  /** Aborted by Ctrl+C (SIGINT) while the guide listens for it. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Ctrl+C cancels the guide's prompts and waits (never `process.exit`). */
  guard() {
    if (this.listening) return;
    process.on('SIGINT', this.onSignal);
    this.listening = true;
  }

  unguard() {
    if (!this.listening) return;
    process.removeListener('SIGINT', this.onSignal);
    this.listening = false;
  }

  /** Runs `body` with SIGINT left to it: a login, a change with the service stopped, a run. */
  async outside<T>(body: () => Promise<T>): Promise<T> {
    const was = this.listening;
    this.unguard();
    try {
      return await body();
    } finally {
      if (was) this.guard();
    }
  }

  /** Ctrl+C came meanwhile (while something that does not listen for it went on). */
  check() {
    if (this.signal.aborted) throw new GuideCancelled('interrupt');
  }

  /** Writes to stdout, counted while a region is open. */
  write(text: string) {
    this.io.stdout.write(text);
    const written = this.written;
    if (!written) return;
    const parts = (written.line + text).split('\n');
    written.line = parts.pop() ?? '';
    const columns = (this.io.stdout as { columns?: number }).columns;
    for (const part of parts) written.rows += terminalRows(part, columns);
  }

  say(line = '') {
    this.write(`${line}\n`);
  }

  /**
   * From here on, what the guide writes is counted, so it can be erased from a terminal (rows that
   * scrolled out of it are out of reach). Elsewhere (a pipe, a test) nothing is erased.
   */
  region(): GuideRegion {
    this.written = { rows: 0, line: '' };
    const clear = () => {
      const written = this.written;
      if (!written) return;
      this.written = { rows: 0, line: '' };
      if (!(this.io.stdout as { isTTY?: boolean }).isTTY) return;
      const columns = (this.io.stdout as { columns?: number }).columns;
      const up = written.rows + (written.line ? terminalRows(written.line, columns) - 1 : 0);
      if (up || written.line) this.io.stdout.write(`\r${up ? `\u001b[${up}A` : ''}\u001b[J`);
    };
    return {
      clear,
      close: () => {
        clear();
        this.written = null;
      },
    };
  }

  /** Lines of the step, indented. */
  lines(...texts: string[]) {
    for (const text of texts) this.say(`  ${text}`);
  }

  /** A line of what runs underneath (the relay's own log), grey. */
  note(text: string) {
    this.say(paint(this.io, 'dim', `  · ${text}`));
  }

  ok(text: string) {
    this.say(`  ${paint(this.io, 'green', '✓')} ${text}`);
  }

  fail(text: string) {
    this.say(`  ${paint(this.io, 'red', '✗')} ${text}`);
  }

  /** Said of what was pasted at a prompt (never shown): `secret`, it looks like an AppSecret. */
  pasted(secret = true) {
    this.lines(paint(this.io, 'yellow', secret ? pastedText() : pastedKeyText()));
  }

  /** Waits `ms`; Ctrl+C ends the wait and the guide. */
  async sleep(ms: number) {
    await new Promise<void>((resolve) => {
      if (this.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.signal.addEventListener('abort', done, { once: true });
    });
    this.check();
  }

  /**
   * One key of `keys` ('\r' is Enter) after `prompt` on the same line; `echo` shows the key
   * pressed (an answer), else only the line ends.
   */
  async key(prompt: string, keys: readonly string[], echo = false): Promise<string> {
    return (await this.readKey(prompt, keys, echo)) as string;
  }

  /**
   * One key of `keys` after `prompt`, not echoed, unless `until` aborts first (something else
   * happened meanwhile): null then. The line ends either way.
   */
  keyUntil(prompt: string, keys: readonly string[], until: AbortSignal): Promise<string | null> {
    return this.readKey(prompt, keys, false, until);
  }

  private async readKey(
    prompt: string,
    keys: readonly string[],
    echo: boolean,
    until?: AbortSignal,
  ): Promise<string | null> {
    const show = () => this.write(`  ${prompt}`);
    try {
      const key = await readKey(this.io, keys, {
        signal: until ? AbortSignal.any([this.signal, until]) : this.signal,
        pasteChars: GUIDE_TIMINGS.pasteChars,
        pasteQuietMs: GUIDE_TIMINGS.pasteQuietMs,
        before: show,
        onPaste: (text) => {
          this.write('\n');
          this.pasted(looksLikeSecret(text));
          show();
        },
      });
      this.write(echo && key !== '\r' ? `${key}\n` : '\n');
      return key;
    } catch (error) {
      if (until?.aborted && !this.signal.aborted && error instanceof SecretInputCancelled) {
        this.write('\n');
        return null;
      }
      throw cancelled(error);
    }
  }

  /** `question [y/n]`: only y or n answers it. */
  async yesNo(question: string): Promise<boolean> {
    const space = tr('', ' ', ' ', ' ');
    return (await this.key(`${question}${space}[y/n] `, ['y', 'n'], true)) === 'y';
  }

  /** Enter to go on, q to quit. */
  async enterOrQuit(prompt = enterOrQuitText()) {
    if ((await this.key(`${prompt} `, ['\r', 'q'])) === 'q') throw new GuideCancelled('quit');
  }

  /**
   * The end of a step done on the other side (q.qq.com): Enter when it is done, `o` opens `url`
   * in the browser (and asks again), `q` quits.
   */
  async checkpoint(url: string, done = doneText()) {
    const host = new URL(url).host;
    const prompt = [
      tr(`回车：${done}`, `Enter: ${done}`, `Enter: ${done}`, `Enter: ${done}`),
      tr(
        `o：在浏览器里打开 ${host}`,
        `o: open ${host} in the browser`,
        `o: abrir ${host} en el navegador`,
        `o: abrir ${host} no navegador`,
      ),
      tr('q：退出', 'q: quit', 'q: salir', 'q: sair'),
    ].join(' · ');
    for (;;) {
      const key = await this.key(`${prompt} `, ['\r', 'o', 'q']);
      if (key === '\r') return;
      if (key === 'q') throw new GuideCancelled('quit');
      const opened = await openBrowser(url);
      this.check();
      this.lines(
        opened
          ? tr(
              `已在浏览器里打开 ${url}（没打开的话，手动访问这个地址）。`,
              `Opened ${url} in the browser (if it did not open, visit that address yourself).`,
              `Se abrió ${url} en el navegador (si no se abrió, visita esa dirección tú mismo).`,
              `${url} foi aberto no navegador (se não abriu, acesse esse endereço você mesmo).`,
            )
          : tr(
              `在浏览器里打开：${url}`,
              `Open in the browser: ${url}`,
              `Abre en el navegador: ${url}`,
              `Abra no navegador: ${url}`,
            ),
      );
    }
  }

  /**
   * A line with only its digits shown (a link or an id, an AppID, a number) after `prompt`; `q`
   * alone quits. What looks like a pasted secret is said and asked for again (never shown).
   */
  async masked(prompt: string): Promise<string> {
    for (let text = prompt; ; ) {
      let value: string;
      try {
        value = await readMasked(this.io, {
          signal: this.signal,
          before: () => this.lines(text),
        });
      } catch (error) {
        throw cancelled(error);
      }
      if (value.toLowerCase() === 'q') throw new GuideCancelled('quit');
      if (!looksLikeSecret(value)) return value;
      this.pasted();
      text = againText();
    }
  }

  /** A line typed without echo (the AppSecret) after `prompt`. */
  async hidden(prompt: string): Promise<string> {
    try {
      return await readHidden(this.io, { signal: this.signal, before: () => this.lines(prompt) });
    } catch (error) {
      throw cancelled(error);
    }
  }
}

/** Ctrl+C at a prompt (or SIGINT meanwhile) cancels the guide; the input's end quits it. */
function cancelled(error: unknown): unknown {
  if (error instanceof SecretInputCancelled) return new GuideCancelled('interrupt');
  if (error instanceof InputEnded) return new GuideCancelled('quit');
  return error;
}

export const doneText = () => tr('做好了', 'done', 'listo', 'pronto');

export const againText = () =>
  tr('再输一次：', 'Try again:', 'Inténtalo de nuevo:', 'Tente de novo:');

const enterOrQuitText = () =>
  tr(
    '回车：重试 · q：退出',
    'Enter: try again · q: quit',
    'Enter: reintentar · q: salir',
    'Enter: tentar de novo · q: sair',
  );

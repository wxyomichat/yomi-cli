import type { ImParagraph } from '../../src/im/models.js';
import { OutOfContextQueue } from '../../src/relay/channels/queue.js';
import { TextQuestions } from '../../src/relay/channels/text-ask.js';
import { type RawInbound, TextInbound } from '../../src/relay/channels/text-inbound.js';
import {
  type AskRef,
  type BotCommand,
  type BotIdentity,
  type ChannelCaps,
  type ChannelError,
  type ChannelHost,
  type ChannelKind,
  channelName,
  type InboundEvent,
  type OutgoingFile,
  type OutgoingText,
  parseCommand,
  type PresenterRequest,
  type Question,
  type RelayChannel,
  type ReplyContext,
  type ReplyPresenter,
  type Sent,
} from '../../src/relay/channels/types.js';
import { PLAIN, renderReply, TELEGRAM_HTML } from '../../src/relay/render.js';

/**
 * A scriptable `RelayChannel` for tests of the core (and of what QQ and WeChat build on): events
 * are pushed by the test, in text mode as raw messages through a real `TextInbound` and
 * `TextQuestions` on the relay's own state file, as QQ and WeChat take them; everything the
 * relay says is recorded in order, a send can be made to queue instead, and each reply's
 * presenter records what it was asked to do and can hold its `stop()` open.
 */

/** What the channel was asked to show, in order. */
export type FakeSend = {
  kind: 'text' | 'ask' | 'photo' | 'reply' | 'note';
  to: string;
  text: string;
  formatted: boolean;
  context: ReplyContext | null;
  status: 'sent' | 'queued';
};

export type FakeChannelOptions = {
  kind?: ChannelKind;
  scope?: string;
  displayName?: string;
  caps?: Partial<ChannelCaps>;
  identity?: BotIdentity;
  /** Questions as typed codes and raw messages through TextInbound (default: not Telegram). */
  text?: boolean;
  /** Whose messages `say` sends ('owner-1'). */
  ownerId?: string;
};

type Pending = { raw: RawInbound } | { event: InboundEvent };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakePresenter implements ReplyPresenter {
  readonly calls: string[] = [];
  private closed = false;

  constructor(
    private readonly channel: FakeChannel,
    readonly request: PresenterRequest,
    readonly streamRef: string,
  ) {}

  get isClosed() {
    return this.closed;
  }

  start(): void {
    this.calls.push('start');
    this.channel.timeline.push('presenter:start');
  }

  update(paragraphs: readonly ImParagraph[]): void {
    if (!this.closed) this.calls.push(`update:${paragraphs.length}`);
  }

  async finish(paragraphs: readonly ImParagraph[], emptyText: string): Promise<string[]> {
    this.closed = true;
    this.calls.push('finish');
    const { maxText, format } = this.channel.caps;
    const messages = renderReply(paragraphs, this.request.render, maxText, format);
    if (messages.length === 0) messages.push(emptyText);
    return messages.map((text) =>
      this.channel.record('reply', this.request.to, text, true, this.request.context),
    );
  }

  async stop(note = ''): Promise<void> {
    this.closed = true;
    this.calls.push(`stop:${note}`);
    this.channel.timeline.push('presenter:stop');
    if (this.channel.stopDelayMs) await sleep(this.channel.stopDelayMs);
    if (this.channel.stopHold) await this.channel.stopHold;
    this.channel.timeline.push('presenter:stopped');
    if (note) this.channel.record('note', this.request.to, note, false, this.request.context);
  }
}

export class FakeChannel implements RelayChannel {
  readonly kind: ChannelKind;
  readonly scope: string;
  readonly lockName: string;
  readonly displayName: string;
  readonly caps: ChannelCaps;
  readonly textMode: boolean;
  readonly ownerId: string;
  private readonly identity: BotIdentity;

  host: ChannelHost | null = null;
  questions: TextQuestions | null = null;
  queue: OutOfContextQueue | null = null;
  private inbound: TextInbound | null = null;

  /** Everything said, in order. */
  readonly sends: FakeSend[] = [];
  /** Calls and events in order: `event:<kind>`, `flush`, `close`, `presenter:…`, `send`. */
  readonly timeline: string[] = [];
  readonly presenters: FakePresenter[] = [];
  /** The codes of the questions asked in text mode, in order. */
  readonly codes: string[] = [];
  /** Questions asked with buttons, in order. */
  readonly asked: Question[] = [];
  /** What each pressed button's answer was acknowledged with ('' or 'expired'). */
  readonly acks: string[] = [];
  /** How often the owner's queue was delivered. */
  deliveries = 0;
  flushes = 0;
  closes = 0;
  /** True: every send is queued for the owner's next message instead of sent. */
  queueSends = false;
  /** The pictures sent, in order (their bytes and type). */
  readonly photos: OutgoingFile[] = [];
  /** When set, sendPhoto fails with it (nothing is shown). */
  photoError: ChannelError | null = null;
  /** A presenter's stop() waits this long, and for `stopHold` when set. */
  stopDelayMs = 0;
  stopHold: Promise<void> | null = null;
  /** events() is waiting for events; it has ended (the relay's signal, or the relay stopped). */
  listening = false;
  eventsEnded = false;

  private pending: Pending[] = [];
  private pushed = 0;
  private accepted = 0;
  private yielded = 0;
  private refs = 0;
  private keys = 0;
  private wake: (() => void) | null = null;

  constructor(options: FakeChannelOptions = {}) {
    this.kind = options.kind ?? 'qq';
    this.scope = options.scope ?? `fake:${this.kind}`;
    this.lockName = this.scope.replace(/:/g, '-');
    this.displayName = options.displayName ?? channelName(this.kind);
    this.textMode = options.text ?? this.kind !== 'telegram';
    this.caps = {
      maxText: this.kind === 'telegram' ? 3800 : 2000,
      format: this.kind === 'telegram' ? TELEGRAM_HTML : PLAIN,
      maxPhotoBytes: 5 * 1024 * 1024,
      quotes: this.kind === 'telegram',
      pairing: this.kind === 'wechat' ? 'login' : 'code',
      ...options.caps,
    };
    this.identity = options.identity ?? { id: '42', name: '', handle: '' };
    this.ownerId = options.ownerId ?? 'owner-1';
  }

  // ---------------------------------------------------------------------------------------------
  // What the test does

  /** An event as the channel would yield it. */
  push(event: InboundEvent) {
    this.pending.push({ event });
    this.pushed += 1;
    this.wake?.();
  }

  /** A raw message through the text pipeline (text mode). */
  pushRaw(raw: RawInbound) {
    this.pending.push({ raw });
    this.pushed += 1;
    this.wake?.();
  }

  /**
   * A message from the owner (or `from`): raw in text mode, else a message or command event.
   * `key` names it for replay checks (a fresh one by default).
   */
  say(
    text: string,
    options: { key?: string; from?: string; sentAt?: number; replyTo?: string } = {},
  ) {
    const from = options.from ?? this.ownerId;
    const raw: RawInbound = {
      key: options.key ?? `key-${++this.keys}`,
      from: { id: from, name: '', language: '' },
      chatId: from,
      context: { channel: this.kind, receivedAt: Date.now() },
      text: text.trim(),
      sentAt: options.sentAt ?? Date.now(),
      replyTo: options.replyTo ?? '',
    };
    if (this.textMode) return this.pushRaw(raw);
    const { key: _key, ...base } = raw;
    const command = parseCommand(raw.text);
    this.push(
      command
        ? { ...base, rawText: raw.text, kind: 'command', ...command }
        : { ...base, rawText: raw.text, kind: 'message' },
    );
  }

  /** A button pressed by the owner (button mode). */
  press(questionId: string, optionId: string) {
    this.push({
      kind: 'answer',
      from: { id: this.ownerId, name: '', language: '' },
      chatId: this.ownerId,
      context: { channel: this.kind, receivedAt: Date.now() },
      questionId,
      optionId,
      ack: async (result) => {
        this.acks.push(result ?? '');
      },
    });
  }

  /** Holds every presenter's stop() until the returned function is called. */
  holdStops(): () => void {
    let release = () => {};
    this.stopHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** Everything pushed so far was taken and handled (each yielded event flushed after it). */
  idle(timeoutMs = 8000) {
    return waitFor(
      () =>
        this.pending.length === 0 && this.accepted === this.pushed && this.flushes >= this.yielded,
      timeoutMs,
    );
  }

  /** The texts said, in order (optionally of one kind). */
  texts(kind?: FakeSend['kind']): string[] {
    return this.sends.filter((send) => !kind || send.kind === kind).map((send) => send.text);
  }

  /** Waits for one more send matching `pattern` than there is now; call before acting. */
  expect(pattern: RegExp, timeoutMs = 8000) {
    const matching = () => this.sends.filter((send) => pattern.test(send.text));
    const before = matching().length;
    return () =>
      waitFor(() => (matching().length > before ? matching().at(-1) : undefined), timeoutMs);
  }

  record(
    kind: FakeSend['kind'],
    to: string,
    text: string,
    formatted: boolean,
    context: ReplyContext | null,
    status: FakeSend['status'] = 'sent',
  ): string {
    this.sends.push({ kind, to, text, formatted, context, status });
    this.timeline.push(`send:${kind}`);
    return `ref-${++this.refs}`;
  }

  // ---------------------------------------------------------------------------------------------
  // RelayChannel

  async verify(): Promise<BotIdentity> {
    return this.identity;
  }

  async connect(host: ChannelHost): Promise<void> {
    this.host = host;
    this.queue = new OutOfContextQueue(host.store, host.log);
    if (!this.textMode) return;
    this.questions = new TextQuestions(host.store, host.texts);
    this.inbound = new TextInbound(host, this.questions, {
      deliverQueue: async (context) => {
        this.deliveries += 1;
        const items = this.queue!.drain();
        if (items.length)
          this.record(
            'text',
            this.ownerId,
            [host.texts.queuedHeader(items.length), ...items.map((item) => item.text)].join('\n\n'),
            false,
            context,
          );
      },
      reply: async (context, text) => {
        this.record('text', this.ownerId, text, false, context);
      },
    });
  }

  async *events(): AsyncIterable<InboundEvent> {
    const signal = this.host!.signal;
    this.listening = true;
    try {
      while (!signal.aborted) {
        const item = this.pending.shift();
        if (!item) {
          // One abort listener per wait, removed again: a long test waits many times.
          let onAbort = () => {};
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            onAbort = () => resolve();
            signal.addEventListener('abort', onAbort, { once: true });
          });
          signal.removeEventListener('abort', onAbort);
          this.wake = null;
          continue;
        }
        const event = 'raw' in item ? await this.inbound!.accept(item.raw) : item.event;
        this.accepted += 1;
        if (!event) continue;
        this.yielded += 1;
        this.timeline.push(`event:${event.kind}`);
        yield event;
      }
    } finally {
      this.listening = false;
      this.eventsEnded = true;
    }
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.timeline.push('close');
  }

  persistId(id: string): number | string {
    return this.kind === 'telegram' ? Number(id) : id;
  }

  async send(to: string, message: OutgoingText, context: ReplyContext | null): Promise<Sent> {
    const formatted = Boolean(message.formatted);
    if (this.queueSends) {
      this.queue?.push({ text: message.text, at: Date.now() });
      this.record('text', to, message.text, formatted, context, 'queued');
      return { status: 'queued' };
    }
    return { status: 'sent', refs: [this.record('text', to, message.text, formatted, context)] };
  }

  async sendPhoto(
    to: string,
    file: OutgoingFile,
    caption: string,
    context: ReplyContext | null,
  ): Promise<Sent> {
    if (this.photoError) throw this.photoError;
    this.photos.push(file);
    return {
      status: 'sent',
      refs: [this.record('photo', to, `${file.name} ${caption}`, false, context)],
    };
  }

  async typing(): Promise<void> {
    this.timeline.push('typing');
  }

  async setCommands(commands: readonly BotCommand[]): Promise<void> {
    this.timeline.push(`commands:${commands.length}`);
  }

  async ask(to: string, question: Question, context: ReplyContext | null): Promise<AskRef> {
    if (this.questions) {
      const { code, text } = this.questions.open(question);
      this.codes.push(code);
      this.record('ask', to, text, false, context);
      return { questionId: question.id, ref: code };
    }
    this.asked.push(question);
    const labels = question.options.map((option) => `[${option.label}]`).join(' ');
    const ref = this.record('ask', to, `${question.prompt}\n${labels}`, false, context);
    return { questionId: question.id, ref };
  }

  async closeQuestion(ref: AskRef): Promise<void> {
    this.questions?.close(ref.questionId);
    this.timeline.push('closeQuestion');
  }

  presenter(request: PresenterRequest): ReplyPresenter {
    const presenter = new FakePresenter(this, request, `stream-${this.presenters.length + 1}`);
    this.presenters.push(presenter);
    return presenter;
  }

  async flush(): Promise<void> {
    this.flushes += 1;
    this.timeline.push('flush');
  }
}

/** Resolves with the first truthy value of `check`, polled every 20 ms. */
export async function waitFor<T>(check: () => T, timeoutMs = 8000): Promise<NonNullable<T>> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value as NonNullable<T>;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await sleep(20);
  }
}

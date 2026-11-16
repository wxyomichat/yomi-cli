import { createInterface, type Interface } from 'node:readline';

import { describeEnvironment } from '../core/env.js';
import { type Io, paint, say, warn } from '../core/ui.js';
import { PreviewConnection } from '../im/connection.js';
import { type ImParagraph, ParagraphType } from '../im/models.js';
import { type StreamEvent, StreamEventType } from '../im/thrift.js';
import { UgcFailure, walletBalance } from '../ugc/api.js';
import { checkSpec, contentForPreview, resolveCharacter } from '../ugc/character.js';
import {
  closePreview,
  INSUFFICIENT_GEMS,
  listPreviewMessages,
  newerQuota,
  type PreparedPreview,
  preparePreview,
  type PreviewQuota,
  sendPreviewMessage,
} from '../ugc/preview.js';
import type { CharacterSpec } from '../ugc/spec.js';
import { type Context, localState, requireSignIn } from './context.js';
import { confirmDeclaration, confirmProduction } from './declaration.js';

export type PreviewOptions = {
  acceptDeclaration: boolean;
  confirmProd: boolean;
  /** Scripted turns (non-interactive); the session ends after the last reply. */
  messages: string[];
  /** Scripted runs may spend gems only with this flag; interactive runs ask instead. */
  allowPaid: boolean;
  /** How long a reply may take before reading it back over HTTP. */
  replyTimeoutMs: number;
};

const DISCLAIMER =
  'AI 生成的回复，所有角色均已年满 18 岁。AI-generated replies. All characters are 18+.';

function renderParagraphs(io: Io, name: string, paragraphs: ImParagraph[]): string {
  return paragraphs
    .filter((paragraph) => paragraph.text.trim())
    .map((paragraph) =>
      paragraph.type === ParagraphType.narration
        ? paint(io, 'italic', paint(io, 'dim', paragraph.text))
        : `${paint(io, 'magenta', (paragraph.npcName || name) + '：')}${paragraph.text}`,
    )
    .join('\n');
}

function quotaLine(quota: PreviewQuota) {
  return quota.remaining > 0
    ? `剩余 ${quota.remaining} 条免费消息${quota.limit ? `（共 ${quota.limit} 条）` : ''}`
    : `免费消息已用完${quota.limit ? `（共 ${quota.limit} 条）` : ''}，之后的消息将按标准费率消耗钻石`;
}

/** One assistant reply as it streams: the cumulative text, printed as it grows. */
class ReplyPrinter {
  private printed = '';
  private started = false;
  constructor(
    private readonly io: Io,
    private readonly name: string,
  ) {}
  update(text: string) {
    if (!this.started) {
      this.io.stdout.write(paint(this.io, 'magenta', `${this.name}：`));
      this.started = true;
    }
    if (text.startsWith(this.printed)) this.io.stdout.write(text.slice(this.printed.length));
    else this.io.stdout.write('\n' + text);
    this.printed = text;
  }
  finish(text: string) {
    if (text) this.update(text);
    if (this.started) this.io.stdout.write('\n');
  }
  get hasOutput() {
    return this.started;
  }
}

type Turn = {
  streamId: string;
  assistantMid: string;
  printer: ReplyPrinter;
  done: (outcome: 'completed' | 'error', message?: string) => void;
};

export async function preview(context: Context, spec: CharacterSpec, options: PreviewOptions) {
  const { io, gateway } = context;
  const credential = requireSignIn(context);
  checkSpec(spec);
  say(io, `预演角色「${spec.name}」（${describeEnvironment(context.env)}）`);
  if (!(await confirmDeclaration(context, options.acceptDeclaration))) {
    process.exitCode = 1;
    say(io, '没有确认声明，未开始预演。');
    return;
  }
  if (
    !(await confirmProduction(
      context,
      '用草稿角色发预演消息（可能消耗服务端额度和钻石）',
      options.confirmProd,
    ))
  ) {
    process.exitCode = 1;
    return;
  }
  const state = localState(context);
  const character = await resolveCharacter(
    gateway,
    state,
    spec,
    (line) => say(io, paint(io, 'dim', line)),
    context.fetch,
  );
  say(io, paint(io, 'dim', '准备预演会话…'));
  const prepared: PreparedPreview = await preparePreview(
    gateway,
    state,
    spec.source,
    contentForPreview(character, true),
  );
  let quota = prepared.quota;
  let paidAllowed = false;
  const turns = new Map<string, Turn>();
  const early = new Map<string, StreamEvent[]>();

  const connection = new PreviewConnection({
    url: () => gateway.connectionURL(),
    headers: () => gateway.connectionHeaders(),
    userId: credential.userId,
    deviceId: credential.deviceId,
  });
  const handle = (event: StreamEvent) => {
    const turn = turns.get(event.streamId);
    if (!turn) {
      // An event may beat the send's answer: kept until its turn is known.
      const list = early.get(event.streamId) ?? [];
      list.push(event);
      early.set(event.streamId, list.slice(-200));
      return;
    }
    if (event.type === StreamEventType.messageChunk && event.chunk)
      turn.printer.update(event.chunk.text);
    else if (event.type === StreamEventType.messageCompleted && event.message) {
      turn.printer.finish(event.message.content.text);
      turn.done('completed');
    } else if (event.type === StreamEventType.error)
      turn.done('error', event.error?.message || event.error?.code);
  };
  connection.subscribe(handle);
  connection.start();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    connection.stop();
    await closePreview(gateway, prepared.cid);
  };

  say(io);
  say(io, paint(io, 'dim', DISCLAIMER));
  say(io, paint(io, 'cyan', quotaLine(quota)));
  say(io);
  if (prepared.openingStatus === 2) say(io, paint(io, 'dim', '（开场白暂不可用）'));
  else say(io, renderParagraphs(io, spec.name, prepared.openingParagraphs));
  say(io);

  const ready = await connection.ready(10_000);
  if (!ready) warn(io, '长连接暂时没有连上，回复会在生成完成后整段显示。');

  /** Sends one turn and waits for its reply; false when the session should stop. */
  const turn = async (
    text: string,
    ask: (question: string) => Promise<boolean>,
  ): Promise<boolean> => {
    let paid = false;
    if (quota.remaining === 0) {
      if (!paidAllowed) {
        let balance = '';
        try {
          balance = `，当前余额 ${await walletBalance(gateway)} 钻石`;
        } catch {
          balance = '';
        }
        say(io, paint(io, 'yellow', `免费消息已用完：继续发送将按标准费率消耗钻石${balance}。`));
        paidAllowed = await ask('继续并按标准费率扣除钻石？输入 yes 确认：');
        if (!paidAllowed) {
          say(io, '未发送。');
          return false;
        }
      }
      paid = true;
    }
    const printer = new ReplyPrinter(io, spec.name);
    let ack;
    try {
      ack = await sendPreviewMessage(gateway, prepared.cid, text, paid);
    } catch (error) {
      if (error instanceof UgcFailure && INSUFFICIENT_GEMS.has(error.code)) {
        warn(io, '钻石不足，请先在 App 或网页充值。');
        return false;
      }
      if (error instanceof UgcFailure) {
        warn(
          io,
          `发送失败（${error.code}）${error.message !== error.code ? '：' + error.message : ''}`,
        );
        return true;
      }
      throw error;
    }
    quota = newerQuota(quota, ack.quota);
    const outcome = await new Promise<{
      kind: 'completed' | 'error' | 'timeout';
      message?: string;
    }>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), options.replyTimeoutMs);
      turns.set(ack.streamId, {
        streamId: ack.streamId,
        assistantMid: ack.assistantMid,
        printer,
        done: (kind, message) => {
          clearTimeout(timer);
          resolve({ kind, message });
        },
      });
      for (const event of early.get(ack.streamId) ?? []) handle(event);
      early.delete(ack.streamId);
    });
    turns.delete(ack.streamId);
    if (outcome.kind === 'error') {
      if (printer.hasOutput) io.stdout.write('\n');
      warn(io, `预览回复失败，请重试${outcome.message ? `（${outcome.message}）` : ''}`);
    } else if (outcome.kind === 'timeout') {
      // The reply may have finished while the connection was down: read it back.
      const listed = await listPreviewMessages(gateway, prepared.cid).catch(() => null);
      const reply = listed?.messages.find((message) => message.mid === ack.assistantMid);
      if (listed?.quota) quota = newerQuota(quota, listed.quota);
      if (reply) {
        if (printer.hasOutput) io.stdout.write('\n');
        say(
          io,
          reply.paragraphs.length
            ? renderParagraphs(io, spec.name, reply.paragraphs)
            : `${spec.name}：${reply.text}`,
        );
      } else warn(io, '暂时没有收到回复，可以稍后用 /history 查看。');
    }
    say(io, paint(io, 'dim', quotaLine(quota)));
    return true;
  };

  try {
    if (options.messages.length) {
      for (const text of options.messages) {
        say(io, `${paint(io, 'cyan', '你：')}${text}`);
        const goOn = await turn(text, async () => {
          if (!options.allowPaid) warn(io, '非交互运行时，付费消息需要加 --allow-paid 明确同意。');
          return options.allowPaid;
        });
        if (!goOn) break;
      }
      return;
    }
    if (!io.interactive) {
      warn(io, '没有终端可交互：用 --message 传入要发送的消息。');
      return;
    }
    say(
      io,
      paint(io, 'dim', '输入消息回车发送；/quota 查看免费条数，/history 查看记录，/quit 退出。'),
    );
    await repl(io, async (line, ask) => {
      const text = line.trim();
      if (!text) return true;
      if (text === '/quit' || text === '/exit') return false;
      if (text === '/help') {
        say(io, '/quota 免费条数　/history 本次预演记录　/quit 退出');
        return true;
      }
      if (text === '/quota') {
        say(io, quotaLine(quota));
        return true;
      }
      if (text === '/history') {
        const listed = await listPreviewMessages(gateway, prepared.cid);
        for (const message of listed.messages)
          say(
            io,
            message.user
              ? `${paint(io, 'cyan', '你：')}${message.text}`
              : message.paragraphs.length
                ? renderParagraphs(io, spec.name, message.paragraphs)
                : `${spec.name}：${message.text}`,
          );
        if (listed.quota) quota = newerQuota(quota, listed.quota);
        return true;
      }
      await turn(text, ask);
      return true;
    });
  } finally {
    await close();
    say(io, paint(io, 'dim', '预演已结束（临时会话已关闭，不会出现在正式聊天里）。'));
  }
}

/** A prompt loop; `ask` reuses the same reader for yes/no questions. Ctrl+C or EOF ends it. */
async function repl(
  io: Io,
  onLine: (line: string, ask: (question: string) => Promise<boolean>) => Promise<boolean>,
) {
  const rl: Interface = createInterface({ input: io.stdin, output: io.stdout, terminal: true });
  const lines: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let ended = false;
  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else lines.push(line);
  });
  const end = () => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  };
  rl.on('close', end);
  rl.on('SIGINT', () => rl.close());
  const next = (prompt: string) => {
    io.stdout.write(prompt);
    if (lines.length) return Promise.resolve(lines.shift() ?? '');
    if (ended) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      waiting = resolve;
    });
  };
  const ask = async (question: string) => {
    const answer = await next(question);
    return (answer ?? '').trim().toLowerCase() === 'yes';
  };
  try {
    for (;;) {
      const line = await next(paint(io, 'cyan', '你：'));
      if (line === null) break;
      if (!(await onLine(line, ask))) break;
    }
  } finally {
    rl.close();
  }
}

import type { TextQuestions } from './text-ask.js';
import {
  type ChannelHost,
  type InboundAnswer,
  type InboundEvent,
  type InboundUser,
  parseCommand,
  type ReplyContext,
} from './types.js';

/**
 * The way in for channels whose messages are only text (QQ, WeChat), the same for both, in this
 * order: a message seen before (a QQ Resume, a WeChat batch read twice) is dropped before
 * anything else, so it is never relayed or charged twice and answers nothing twice; a stranger's
 * message (or any while unpaired) goes to the core as is; an owner's message first opens the way
 * for what was queued for them, then may answer an open question by its code; anything else is a
 * command or chat.
 */

export type RawInbound = {
  /** The platform's id of this inbound message: QQ `d.id`, WeChat `message_id`. */
  key: string;
  from: InboundUser;
  chatId: string;
  context: ReplyContext;
  /** Trimmed text ('' for non-text). */
  text: string;
  sentAt: number;
  replyTo: string;
};

export type TextInboundHooks = {
  /** Delivers the owner's queue in this context. Called once per new owner message. */
  deliverQueue(context: ReplyContext): Promise<void>;
  /** A plain text in this context (askInvalid / askExpired). */
  reply(context: ReplyContext, text: string): Promise<void>;
};

/** Message keys remembered for spotting a replay. */
const SEEN_MAX = 500;

export class TextInbound {
  private seen = new Set<string>();

  constructor(
    private readonly host: ChannelHost,
    private readonly questions: TextQuestions,
    private readonly hooks: TextInboundHooks,
  ) {}

  /** The event to yield for one inbound message, or null (a replay, an invalid answer). */
  async accept(raw: RawInbound): Promise<InboundEvent | null> {
    if (this.seen.has(raw.key)) return null;
    this.seen.add(raw.key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    const owner = this.host.owner();
    if (!owner || raw.from.id !== owner.userId || raw.chatId !== owner.chatId)
      return this.message(raw);
    // A hook that fails has told what it could (it is the channel's own send): the owner's
    // message still goes on, and a failure here must never end the relay's events.
    await this.hooks.deliverQueue(raw.context).catch(() => undefined);
    const match = this.questions.match(raw.text);
    if (match === 'invalid') {
      await this.hooks.reply(raw.context, this.host.texts.askInvalid).catch(() => undefined);
      return null;
    }
    if (match === null) return this.message(raw);
    // After a restart the core no longer knows the question either: it acks 'expired'.
    const answer: InboundAnswer = {
      kind: 'answer',
      from: raw.from,
      chatId: raw.chatId,
      context: raw.context,
      questionId: match === 'expired' ? '' : match.questionId,
      optionId: match === 'expired' ? '' : match.optionId,
      ack: async (result) => {
        if (result === 'expired') await this.hooks.reply(raw.context, this.host.texts.askExpired);
      },
    };
    return answer;
  }

  private message(raw: RawInbound): InboundEvent {
    const base = {
      from: raw.from,
      chatId: raw.chatId,
      context: raw.context,
      text: raw.text,
      rawText: raw.text,
      sentAt: raw.sentAt,
      replyTo: raw.replyTo,
    };
    const command = parseCommand(raw.text);
    return command ? { ...base, kind: 'command', ...command } : { ...base, kind: 'message' };
  }
}

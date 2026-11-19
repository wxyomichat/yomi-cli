import { randomInt } from 'node:crypto';

import type { RelayTexts } from '../texts.js';
import type { ChannelStore, Question } from './types.js';

/**
 * Questions on channels without buttons (QQ, WeChat): the options are numbered, and the owner
 * answers with a one-time code and a number ("K7Q2 1"). A stray "1" typed as chat can never
 * confirm a budget, and an old prompt cannot be answered after ten minutes. The codes are kept in
 * the channel's store, so an answer that arrives after a restart is still recognised: the relay
 * no longer knows its question and answers "expired", instead of relaying it to the character
 * (and maybe paying for it) as chat. Only codes this channel issued count: a word that merely
 * looks like one ("haha 2") is chat.
 */

export const ASK_TTL_MS = 10 * 60_000;
/** A closed or expired code is still recognised (and answered "expired") this long. */
export const ASK_MEMORY_MS = 60 * 60_000;
/** As PairingCode: no 0/O or 1/I to mix up. */
export const ASK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
/** Remembered codes at most (the oldest go first). */
const MAX_QUESTIONS = 20;
const STORE_KEY = 'questions';

/** One question as the store keeps it: its code, what it answers, when it stops being open. */
type StoredQuestion = {
  code: string;
  questionId: string;
  optionIds: string[];
  expiresAt: number;
  closedAt: number | null;
};

/**
 * "<code> <n>": a code of four letters or digits, then spaces, ':', '#', '-' or a full-width
 * colon (Chinese keyboards type one), then one or two digits, ASCII or full-width.
 */
const ANSWER = /^\s*([A-Za-z2-9]{4})[\s:\uFF1A#-]*([0-9\uFF10-\uFF19]{1,2})\s*$/;

/** Full-width digits as ASCII. */
const asciiDigits = (text: string) =>
  text.replace(/[\uFF10-\uFF19]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));

export type TextAnswer = { questionId: string; optionId: string };

export class TextQuestions {
  constructor(
    private readonly store: ChannelStore,
    private readonly texts: RelayTexts,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registers the question under a fresh code (unique among those remembered); its message. */
  open(question: Question): { code: string; text: string } {
    const remembered = this.remembered();
    const taken = new Set(remembered.map((stored) => stored.code));
    let code = '';
    do {
      code = '';
      for (let index = 0; index < CODE_LENGTH; index++)
        code += ASK_CODE_ALPHABET[randomInt(ASK_CODE_ALPHABET.length)];
    } while (taken.has(code));
    remembered.push({
      code,
      questionId: question.id,
      optionIds: question.options.map((option) => option.id),
      expiresAt: this.now() + ASK_TTL_MS,
      closedAt: null,
    });
    this.save(remembered.slice(-MAX_QUESTIONS));
    const lines = [
      question.prompt,
      ...question.options.map((option, index) => `${index + 1}. ${option.label}`),
      this.texts.askChoose(code),
    ];
    return { code, text: lines.join('\n') };
  }

  /** The question was answered (or is no longer wanted): its code now only says "expired". */
  close(questionId: string): void {
    const remembered = this.remembered();
    const question = remembered.find(
      (stored) => stored.questionId === questionId && stored.closedAt === null,
    );
    if (!question) return;
    question.closedAt = this.now();
    this.save(remembered);
  }

  /**
   * Whether an owner's text answers a question: the choice (the code is closed now), 'invalid' (an
   * open code with a number it has no option for; the code stays open), 'expired' (a code closed
   * or expired less than ASK_MEMORY_MS ago), or null (anything else, which is chat).
   */
  match(text: string): TextAnswer | 'invalid' | 'expired' | null {
    const parts = ANSWER.exec(text);
    if (!parts) return null;
    const code = parts[1].toUpperCase();
    const remembered = this.remembered();
    const question = remembered.find((stored) => stored.code === code);
    if (!question) return null;
    const now = this.now();
    if (question.closedAt !== null || question.expiresAt <= now) return 'expired';
    const choice = Number(asciiDigits(parts[2]));
    if (choice < 1 || choice > question.optionIds.length) return 'invalid';
    question.closedAt = now;
    this.save(remembered);
    return { questionId: question.questionId, optionId: question.optionIds[choice - 1] };
  }

  /** The codes still recognised: open ones, and those closed or expired within ASK_MEMORY_MS. */
  private remembered(): StoredQuestion[] {
    const stored = this.store.get<StoredQuestion[]>(STORE_KEY);
    if (!Array.isArray(stored)) return [];
    const since = this.now() - ASK_MEMORY_MS;
    return stored
      .filter(
        (question) =>
          question &&
          typeof question.code === 'string' &&
          typeof question.questionId === 'string' &&
          Array.isArray(question.optionIds) &&
          typeof question.expiresAt === 'number',
      )
      .map((question) => ({ ...question, optionIds: [...question.optionIds] }))
      .filter((question) => Math.min(question.closedAt ?? Infinity, question.expiresAt) > since);
  }

  private save(questions: StoredQuestion[]) {
    this.store.set(STORE_KEY, questions);
  }
}

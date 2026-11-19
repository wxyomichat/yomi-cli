import { tr } from '../core/i18n.js';
import { type ImParagraph, ParagraphType } from '../im/models.js';

/**
 * A reply as a chat channel writes it. Only reviewed `paragraphs` ever get here: never a chunk's
 * `text` or `thinking_content` (the protocol guarantees review for paragraphs only). Narration is
 * set apart (italic in Telegram HTML); in a group chat (a WorldView character) each line of
 * dialogue carries its speaker as 「名字：台词」, since a private chat has one sender. Text is
 * escaped, never parsed.
 *
 * How a channel writes is a `Formatter`: Telegram's HTML (`parse_mode: HTML`, the default, whose
 * output is what the relay always sent), plain text (QQ until its markdown is checked, WeChat),
 * and QQ markdown (channels/qq-render.ts). The formatter also measures, so a message never passes
 * the channel's limit as that channel counts it.
 */

/** Telegram's limit is 4096 characters after parsing; stay well below it. */
export const MESSAGE_LIMIT = 3800;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type Formatter = {
  name: 'telegram-html' | 'plain' | 'qq-markdown';
  /** Plain text as this format writes it. */
  escape(text: string): string;
  /** Narration around an already escaped body. */
  narration(body: string): string;
  /** A speaker's name before their line, with the separator ("name：" in Chinese). */
  label(name: string): string;
  /**
   * How long a piece counts against the channel's limit: `visible` is the plain text (with the
   * speaker's "name："), `formatted` what is sent.
   */
  measure(visible: string, formatted: string): number;
};

/** Telegram HTML: what Telegram counts is the text after parsing, so tags and entities are free. */
export const TELEGRAM_HTML: Formatter = {
  name: 'telegram-html',
  escape: escapeHtml,
  narration: (body) => `<i>${body}</i>`,
  label: (name) =>
    tr(
      `<b>${escapeHtml(name)}</b>：`,
      `<b>${escapeHtml(name)}</b>: `,
      `<b>${escapeHtml(name)}</b>: `,
      `<b>${escapeHtml(name)}</b>: `,
    ),
  measure: (visible) => visible.length,
};

/** Plain text: nothing is escaped, narration is in brackets (Chinese) or asterisks. */
export const PLAIN: Formatter = {
  name: 'plain',
  escape: (text) => text,
  narration: (body) => tr(`（${body}）`, `*${body}*`, `*${body}*`, `*${body}*`),
  label: (name) => tr(`${name}：`, `${name}: `, `${name}: `, `${name}: `),
  // Everything sent is visible, the markers included.
  measure: (_visible, formatted) => formatted.length,
};

export type RenderOptions = {
  /** The character the chat is with; a paragraph by someone else names its speaker. */
  characterName: string;
  /** A group chat: every line of dialogue names its speaker. */
  group: boolean;
};

type Piece = { text: string; length: number };

function speaker(paragraph: ImParagraph, options: RenderOptions): string {
  if (paragraph.type === ParagraphType.narration || !paragraph.npcName) return '';
  if (options.group || paragraph.npcName !== options.characterName) return paragraph.npcName;
  return '';
}

/**
 * One paragraph as pieces that each measure at most `limit` (unless the 200-character floor
 * applies). It is cut by its visible text first; a piece the formatter still measures over (a
 * format that escapes heavily) is split again at half its text until it fits.
 */
function pieces(
  paragraph: ImParagraph,
  options: RenderOptions,
  limit: number,
  formatter: Formatter,
): Piece[] {
  const text = paragraph.text.trim();
  if (!text) return [];
  const narration = paragraph.type === ParagraphType.narration;
  const name = speaker(paragraph, options);
  const prefix = name ? tr(`${name}：`, `${name}: `, `${name}: `, `${name}: `) : '';
  // What the format adds around a piece: the speaker's label, or narration's markers.
  const overhead = narration
    ? formatter.measure('', formatter.narration(''))
    : name
      ? formatter.measure(prefix, formatter.label(name))
      : 0;
  const room = Math.max(200, limit - overhead);
  const parts: string[] = [];
  let rest = text;
  while (rest.length > room) {
    // Cut at the last line break or space before the limit, else hard.
    const window = rest.slice(0, room);
    const cut = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
      window.lastIndexOf('。'), // i18n-ignore
    );
    const at = cut > room / 2 ? cut + 1 : room;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  parts.push(rest);
  const render = (part: string, first: boolean): Piece => {
    const body = formatter.escape(part);
    if (narration) {
      const formatted = formatter.narration(body);
      return { text: formatted, length: formatter.measure(part, formatted) };
    }
    const label = first && name ? formatter.label(name) : '';
    return {
      text: label + body,
      length: formatter.measure((first ? prefix : '') + part, label + body),
    };
  };
  const most = Math.max(limit, room + overhead);
  const result: Piece[] = [];
  while (parts.length) {
    const part = parts.shift()!;
    const piece = render(part, result.length === 0);
    // Never between the two halves of a surrogate pair.
    let half = Math.ceil(part.length / 2);
    if (/[\uD800-\uDBFF]/.test(part[half - 1])) half += 1;
    if (piece.length > most && half < part.length) {
      parts.unshift(part.slice(0, half), part.slice(half));
      continue;
    }
    result.push(piece);
  }
  return result;
}

/**
 * The reply as one or more messages, each at most `limit` as `formatter` measures it (Telegram
 * HTML: visible characters; the blank line between paragraphs counts too). Empty when no
 * paragraph has text.
 */
export function renderReply(
  paragraphs: readonly ImParagraph[],
  options: RenderOptions,
  limit = MESSAGE_LIMIT,
  formatter: Formatter = TELEGRAM_HTML,
): string[] {
  const messages: string[] = [];
  const separator = formatter.measure('\n\n', '\n\n');
  let current: Piece[] = [];
  let length = 0;
  const flush = () => {
    if (current.length) messages.push(current.map((piece) => piece.text).join('\n\n'));
    current = [];
    length = 0;
  };
  for (const paragraph of paragraphs)
    for (const piece of pieces(paragraph, options, limit, formatter)) {
      if (current.length && length + separator + piece.length > limit) flush();
      current.push(piece);
      length += (current.length > 1 ? separator : 0) + piece.length;
    }
  flush();
  return messages;
}

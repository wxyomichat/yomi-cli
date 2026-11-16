import { type ImParagraph, ParagraphType } from '../im/models.js';

/**
 * A reply as Telegram HTML (`parse_mode: HTML`). Only reviewed `paragraphs` ever get here: never
 * a chunk's `text` or `thinking_content` (the protocol guarantees review for paragraphs only).
 * Narration is italic; in a group chat (a WorldView character) each line of dialogue carries its
 * speaker as 「名字：台词」, since a private chat has one sender. Text is escaped, never parsed.
 */

/** Telegram's limit is 4096 characters after parsing; stay well below it. */
export const MESSAGE_LIMIT = 3800;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type RenderOptions = {
  /** The character the chat is with; a paragraph by someone else names its speaker. */
  characterName: string;
  /** A group chat: every line of dialogue names its speaker. */
  group: boolean;
};

type Piece = { html: string; length: number };

function speaker(paragraph: ImParagraph, options: RenderOptions): string {
  if (paragraph.type === ParagraphType.narration || !paragraph.npcName) return '';
  if (options.group || paragraph.npcName !== options.characterName) return paragraph.npcName;
  return '';
}

/** One paragraph as pieces no longer than `limit` visible characters each. */
function pieces(paragraph: ImParagraph, options: RenderOptions, limit: number): Piece[] {
  const text = paragraph.text.trim();
  if (!text) return [];
  const name = speaker(paragraph, options);
  const prefix = name ? `${name}：` : '';
  const room = Math.max(200, limit - prefix.length);
  const parts: string[] = [];
  let rest = text;
  while (rest.length > room) {
    // Cut at the last line break or space before the limit, else hard.
    const window = rest.slice(0, room);
    const cut = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
      window.lastIndexOf('。'),
    );
    const at = cut > room / 2 ? cut + 1 : room;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  parts.push(rest);
  return parts.map((part, index) => {
    const body = escapeHtml(part);
    if (paragraph.type === ParagraphType.narration)
      return { html: `<i>${body}</i>`, length: part.length };
    const label = index === 0 && name ? `<b>${escapeHtml(name)}</b>：` : '';
    return { html: label + body, length: part.length + (index === 0 ? prefix.length : 0) };
  });
}

/**
 * The reply as one or more messages, each at most `limit` visible characters. Empty when no
 * paragraph has text.
 */
export function renderReply(
  paragraphs: readonly ImParagraph[],
  options: RenderOptions,
  limit = MESSAGE_LIMIT,
): string[] {
  const messages: string[] = [];
  let current: Piece[] = [];
  let length = 0;
  const flush = () => {
    if (current.length) messages.push(current.map((piece) => piece.html).join('\n\n'));
    current = [];
    length = 0;
  };
  for (const paragraph of paragraphs)
    for (const piece of pieces(paragraph, options, limit)) {
      if (current.length && length + 2 + piece.length > limit) flush();
      current.push(piece);
      length += (current.length > 1 ? 2 : 0) + piece.length;
    }
  flush();
  return messages;
}

/** A plain notice (from the server or the relay itself), escaped. */
export function notice(text: string): string {
  return escapeHtml(text);
}

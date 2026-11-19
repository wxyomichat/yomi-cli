import type { CharacterProfile } from './api.js';

/**
 * A character's introduction as plain text, for a channel that shows text only. The profile's
 * `introduction_presentation` says how the app shows it: native text or a plain fallback as it is,
 * a controlled HTML document (`RootHtml`) read down to its words; without one, or when the
 * document has no words, the plain `introduction`.
 */

/** `IntroductionMode`. */
export const IntroductionMode = { nativeText: 1, rootHtml: 2, plainFallback: 3 } as const;

/** The longest introduction sent, in characters (a channel's own limit may be lower). */
export const INTRODUCTION_LIMIT = 1000;

/** Where a sentence of the server's text ends (matched, never printed). */
const SENTENCE_END = /[。！？!?.…]/; // i18n-ignore

/** Longer documents are read up to here only. */
const MAX_HTML = 400_000;

/** Their contents are never text: code, styles, metadata, embedded objects. */
const HIDDEN = [
  'script',
  'style',
  'template',
  'noscript',
  'head',
  'title',
  'svg',
  'iframe',
  'object',
];
/** Where a line ends: block elements, and the document's own `message`/`narration`/`html-box`. */
const BLOCK =
  /<\/?(?:p|div|section|article|header|footer|li|ul|ol|h[1-6]|blockquote|pre|tr|table|hr|message|narration|html-box)\b[^>]*>/gi;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,8}|#x[0-9a-f]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const point =
      name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
    const invalid = point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff);
    return invalid ? '' : String.fromCodePoint(point);
  });
}

/**
 * Readable text of an HTML document: hidden parts and comments dropped, a line per block, tags
 * stripped, entities decoded, white space as a browser collapses it. No markup is kept.
 */
export function htmlToText(html: string): string {
  let text = html.slice(0, MAX_HTML).replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const tag of HIDDEN)
    text = text.replace(
      new RegExp(`<${tag}\\b[^>]*?/>|<${tag}\\b[^>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi'),
      '',
    );
  text = text
    .replace(/\s+/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(BLOCK, '\n')
    .replace(/<\/?[a-z!][^>]*>/gi, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * At most `limit` characters: cut at the last line or sentence end in its second half, else at
 * the limit, and marked with '…'.
 */
export function cutText(text: string, limit: number): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const kept = characters.slice(0, Math.max(1, limit - 1));
  let end = kept.length;
  for (let index = kept.length - 1; index >= Math.floor(kept.length / 2); index--) {
    if (kept[index] === '\n') {
      end = index;
      break;
    }
    if (SENTENCE_END.test(kept[index])) {
      end = index + 1;
      break;
    }
  }
  return kept.slice(0, end).join('').trimEnd() + '…';
}

/** The introduction to send, plain and trimmed, at most `limit` characters; '' when none. */
export function introductionOf(profile: CharacterProfile, limit = INTRODUCTION_LIMIT): string {
  const presentation = profile.introductionPresentation;
  const plain = profile.introduction;
  let chosen = plain;
  if (
    presentation?.mode === IntroductionMode.nativeText ||
    presentation?.mode === IntroductionMode.plainFallback
  )
    chosen = presentation.text.trim() ? presentation.text : plain;
  else if (presentation?.mode === IntroductionMode.rootHtml)
    chosen = htmlToText(presentation.text) || plain;
  return cutText(chosen.replace(/\r\n?/g, '\n').trim(), Math.min(limit, INTRODUCTION_LIMIT));
}

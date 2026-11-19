import { tr } from '../../core/i18n.js';
import type { Formatter } from '../render.js';

/**
 * QQ markdown (`msg_type: 2`, stream `content_type: 'markdown'`), implemented but off: QQ's
 * markdown page documents no backslash escapes, and if QQ does not honour them every escaped "."
 * or "*" would show a backslash with no error to fall back on; a single newline inside a
 * paragraph may also render as a space. Until both are checked by eye on a real QQ client (Q-8),
 * the channel writes plain text (`PLAIN`, `msg_type: 0`) and this formatter is not used.
 *
 * Turning it on is `QQ_MARKDOWN_ENABLED = true` (and, once checked, the escape style and the line
 * break below). A markdown refusal from QQ then falls back to plain text for the rest of the run.
 */

/** Off until Q-8 is checked by eye: plain text (`msg_type: 0`). */
export const QQ_MARKDOWN_ENABLED = false;

/**
 * 'fullwidth': characters markdown would read are replaced by full-width look-alikes (safe whether
 * or not QQ honours backslashes); 'backslash': escaped with a backslash (only if Q-8 shows QQ
 * honours them).
 */
export const QQ_MARKDOWN_ESCAPES: 'fullwidth' | 'backslash' = 'fullwidth';

/** A line break inside a paragraph (CommonMark's hard break; to be confirmed under Q-8). */
export const QQ_MARKDOWN_LINE_BREAK = '  \n';

/** The full-width look-alike of an ASCII character (U+FF01-U+FF5E are ASCII + 0xFEE0). */
const fullWidth = (character: string) => String.fromCharCode(character.charCodeAt(0) + 0xfee0);

/** A line that would start a block: heading, quote, list item, numbered item, rule, fence. */
const BLOCK_START = /^(\s*)(#{1,6}(?=\s|$)|>|[-+*](?=\s)|\d+\.(?=\s)|-{3,}|`{3,}|~{3,})/;

function escapeLine(line: string): string {
  const fullwidth = QQ_MARKDOWN_ESCAPES === 'fullwidth';
  let start = '';
  let rest = line;
  const block = BLOCK_START.exec(line);
  if (block) {
    const marker = block[2];
    start =
      block[1] +
      (fullwidth
        ? marker.replace(/[#\-+.`~>*]/g, fullWidth)
        : /^\d/.test(marker)
          ? marker.replace('.', '\\.')
          : `\\${marker}`);
    rest = line.slice(block[0].length);
  }
  const body = rest.replace(/[*_~[\]<>`]/g, (character) =>
    fullwidth ? fullWidth(character) : `\\${character}`,
  );
  return start + body;
}

/** QQ markdown: escaped text, `*narration*`, `**name**：`; the raw length counts. */
export const QQ_MARKDOWN: Formatter = {
  name: 'qq-markdown',
  escape: (text) => text.split('\n').map(escapeLine).join(QQ_MARKDOWN_LINE_BREAK),
  narration: (body) => `*${body}*`,
  label: (name) => {
    const escaped = escapeLine(name).replace(/\n/g, ' ');
    return tr(`**${escaped}**：`, `**${escaped}**: `, `**${escaped}**: `, `**${escaped}**: `);
  },
  measure: (_visible, formatted) => formatted.length,
};

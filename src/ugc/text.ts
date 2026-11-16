/**
 * Counting text as the app's form does: Unicode code points, so an emoji is one.
 */
export function countText(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

/** The limits the app's form enforces. */
export const LIMITS = {
  name: 50,
  description: 10_000,
  /** The current API takes at most 10,000 for an HTML description too. */
  descriptionHtml: 10_000,
  opening: 10_000,
  background: 10_000,
  exampleDialogue: 10_000,
  authorNote: 20_000,
  tags: 10,
  voices: 4,
} as const;

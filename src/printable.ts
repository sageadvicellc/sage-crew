/**
 * Characters that can move the cursor, clear a line, reorder text, or hide
 * text on a terminal. A printed field from a roles file must hold none.
 *
 * - C0 controls except tab and newline, DEL, and C1 controls.
 * - The Arabic letter mark, and the bidirectional marks, embeddings,
 *   overrides, and isolates.
 * - Zero-width characters: the zero-width space, non-joiner, and joiner,
 *   the word joiner, and the byte-order mark.
 * - The line separator and the paragraph separator.
 * - Variation selectors, in both blocks.
 * - Unicode tag characters.
 *
 * Every range is written as an escape, so this file holds no invisible
 * character itself.
 */
export const CONTROL_CHARACTERS = /[\u{0}-\u{8}\u{b}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}\u{2066}-\u{2069}\u{fe00}-\u{fe0f}\u{feff}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;

const CONTROL_GLOBAL = new RegExp(CONTROL_CHARACTERS.source, 'gu');

/** True when the text holds a control character other than newline and tab. */
export function hasControlCharacter(text: string): boolean {
  return CONTROL_CHARACTERS.test(text);
}

/**
 * Escapes every control character except newline and tab, so printed text
 * shows exactly what it holds. `\r` becomes `\\r`, a code point below 0x100
 * becomes `\\xNN`, one below 0x10000 becomes `\\uNNNN`, and any other
 * becomes `\\u{NNNNN}`.
 */
export function printable(text: string): string {
  return text.replace(CONTROL_GLOBAL, (c) => {
    if (c === '\r') return '\\r';
    const code = c.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    if (code < 0x100) return `\\x${hex.padStart(2, '0')}`;
    return code < 0x10000 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  });
}

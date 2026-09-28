/**
 * Characters that can move the cursor, clear a line, reorder text, or hide
 * text on a terminal. A printed field from a roles file must hold none.
 *
 * - Every control character (Cc) except tab and newline.
 * - Every format character (Cf), such as the soft hyphen, the zero-width
 *   characters, the bidirectional marks, and the invisible operators.
 * - The line separator (Zl) and the paragraph separator (Zp).
 * - Every default-ignorable code point, such as the combining grapheme
 *   joiner and the Mongolian free variation selectors.
 * - Variation selectors, in both blocks.
 * - The Hangul fillers, which show as blank space.
 * - Unicode tag characters, including the unassigned ones in that block.
 *
 * Every range is written as an escape, so this file holds no invisible
 * character itself.
 */
export const CONTROL_CHARACTERS = /(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}\u{115f}\u{1160}\u{3164}\u{ffa0}\u{e0000}-\u{e007f}]/u;

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

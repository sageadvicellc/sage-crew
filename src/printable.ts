/**
 * Control characters that can move the cursor, clear a line, or reorder
 * text on a terminal: C0 except tab and newline, DEL, C1, and the Unicode
 * bidirectional controls. A printed field from a roles file must hold none.
 */
export const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

const CONTROL_GLOBAL = new RegExp(CONTROL_CHARACTERS.source, 'g');

/** True when the text holds a control character other than newline and tab. */
export function hasControlCharacter(text: string): boolean {
  return CONTROL_CHARACTERS.test(text);
}

/**
 * Escapes every control character except newline and tab, so printed text
 * shows exactly what it holds. `\r` becomes `\\r`, a byte below 0x100
 * becomes `\\xNN`, and anything else becomes `\\uNNNN`.
 */
export function printable(text: string): string {
  return text.replace(CONTROL_GLOBAL, (c) => {
    if (c === '\r') return '\\r';
    const code = c.charCodeAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

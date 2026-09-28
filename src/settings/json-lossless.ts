/**
 * Finds what a JSON.parse then JSON.stringify round trip would change in
 * a JSON text that already parses: a repeated key, whose earlier value
 * the parse drops, or a number that a double cannot hold. Returns the
 * reason, or undefined when the round trip keeps every value.
 */
export function roundTripLoss(text: string): string | undefined {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i += 1;
  };
  const readString = (): string => {
    const start = i;
    i += 1; // The opening quote.
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1; // The closing quote.
    return JSON.parse(text.slice(start, i)) as string;
  };
  const readNumber = (): string | undefined => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    const literal = match?.[0] ?? '';
    i += literal.length;
    return numberLoss(literal);
  };
  const value = (): string | undefined => {
    ws();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const keys = new Set<string>();
      ws();
      if (text[i] === '}') {
        i += 1;
        return undefined;
      }
      for (;;) {
        ws();
        const key = readString();
        if (keys.has(key)) return `the settings file repeats the key "${key}" in one object`;
        keys.add(key);
        ws();
        i += 1; // The colon.
        const inner = value();
        if (inner !== undefined) return inner;
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        i += 1; // The closing brace.
        return undefined;
      }
    }
    if (c === '[') {
      i += 1;
      ws();
      if (text[i] === ']') {
        i += 1;
        return undefined;
      }
      for (;;) {
        const inner = value();
        if (inner !== undefined) return inner;
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        i += 1; // The closing bracket.
        return undefined;
      }
    }
    if (c === '"') {
      readString();
      return undefined;
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return readNumber();
    // true, false, or null.
    i += text.startsWith('true', i) || text.startsWith('null', i) ? 4 : 5;
    return undefined;
  };
  return value();
}

/** The most significant digits a double holds exactly. */
const DOUBLE_DIGITS = 17;

function numberLoss(literal: string): string | undefined {
  const parsed = Number(literal);
  const why = `the settings file holds the number ${literal}, which a rewrite would change`;
  if (!Number.isFinite(parsed)) return why;
  if (/^-?\d+$/.test(literal)) return BigInt(literal) === BigInt(parsed) ? undefined : why;
  const digits = literal.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length > DOUBLE_DIGITS ? why : undefined;
}

/** Collects printed lines so a test can assert on them. */
export interface Capture {
  lines: string[];
  write: (line: string) => void;
  text: () => string;
}

export function capture(): Capture {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
    text: () => lines.join('\n'),
  };
}

/** A small valid roles file. Tests change one line of it at a time. */
export const SMALL_TEAM = `version: 1
harness: auto
transport: auto
operator: you
sessions:
  - name: chain
    role: reporting-chain
    reports_to: operator
    kickoff: |
      You carry decisions up.
  - name: boss
    role: lead
    reports_to: chain
    workers: [helper-a, helper-b]
    autocompact: 600k
    kickoff: |
      You lead.
  - name: helper-a
    role: standby
    reports_to: boss
    autocompact: 400k
    kickoff: |
      You help.
  - name: helper-b
    role: standby
    reports_to: boss
    kickoff: |
      You help too.
  - name: watcher
    role: auditor
    reports_to: chain
    clock: 30m
    kickoff: |
      You audit.
`;

/** The 1-based line number of the nth line (default the first) that contains `needle`. */
export function lineOf(text: string, needle: string, nth = 1): number {
  let seen = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] as string).includes(needle)) {
      seen += 1;
      if (seen === nth) return i + 1;
    }
  }
  throw new Error(`fixture has no line ${nth} containing ${needle}`);
}

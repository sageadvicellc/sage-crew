import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Builders for handoff file text. Placeholder values only. */

/** A 40-character commit id. */
export const HEAD_SHA1 = '0123456789abcdef0123456789abcdef01234567';
/** A 64-character commit id. */
export const HEAD_SHA256 = `${HEAD_SHA1}${'89abcdef'.repeat(3)}`;

/** The default `written` time. Teardown tests start their fake clock at this time. */
export const WRITTEN_AT = '2026-01-01T00:00:00Z';

/** A body with the three headings in order. */
export const HANDOFF_BODY = [
  '## Open items',
  '',
  '- None.',
  '',
  '## Live state',
  '',
  '- The branch is pushed.',
  '',
  '## Next step',
  '',
  '- Wait for the next task.',
  '',
].join('\n');

/**
 * The parts of a handoff file. `fields` holds raw YAML values that replace
 * the valid defaults, and `null` leaves a field out. `extra` holds raw lines
 * appended to the front matter, such as a `timed_jobs` list.
 */
export interface HandoffParts {
  fields?: Record<string, string | null>;
  extra?: string[];
  body?: string;
}

/** Builds handoff file text for one session. */
export function handoffText(session: string, parts: HandoffParts = {}): string {
  const defaults: Record<string, string | null> = {
    version: '1',
    session,
    status: 'done',
    writing: 'false',
    push: 'pushed',
    branch: 'feat/example',
    head: HEAD_SHA1,
    written: WRITTEN_AT,
  };
  const merged = { ...defaults, ...parts.fields };
  const lines = ['---'];
  for (const [key, value] of Object.entries(merged)) {
    if (value !== null && value !== undefined) lines.push(`${key}: ${value}`);
  }
  lines.push(...(parts.extra ?? []), '---');
  return `${lines.join('\n')}\n${parts.body ?? HANDOFF_BODY}`;
}

/** Writes `<folder>/<session>.md`, creating the folder when needed, and returns the path. */
export function writeHandoff(folder: string, session: string, parts: HandoffParts = {}): string {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${session}.md`);
  writeFileSync(path, handoffText(session, parts));
  return path;
}

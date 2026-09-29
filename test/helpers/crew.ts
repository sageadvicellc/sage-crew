/** Builders for `crew.yml` text. Placeholder values only. */

export const CREW_FILE = 'crew.yml';
export const GIT_HTTPS = 'https://example.com/owner/my-crew.git';
export const GIT_SSH = 'ssh://git@example.com/owner/my-crew.git';
export const GIT_SCP = 'git@example.com:owner/my-crew.git';

/**
 * The parts of a crew file. Each one is raw YAML text. `undefined` takes the
 * valid default and `null` leaves the part out, so a test changes one part
 * and keeps the rest valid.
 */
export interface CrewParts {
  version?: string | null;
  harness?: string | null;
  /** The lines under `crew:`. */
  crew?: string[] | null;
  require?: string[] | null;
  front?: string | null;
  /** One array of `key: value` lines per role entry. */
  roles?: string[][] | null;
  /** Extra top-level lines, appended last. */
  extra?: string[];
}

export const DEFAULT_ROLES: string[][] = [['role: lead'], ['role: worker', 'lanes: 3'], ['role: reviewer']];

/** Builds `crew.yml` text from parts. */
export function crewYml(parts: CrewParts = {}): string {
  const lines: string[] = [];
  const version = parts.version === undefined ? '1' : parts.version;
  if (version !== null) lines.push(`version: ${version}`);
  const harness = parts.harness === undefined ? 'claude-code' : parts.harness;
  if (harness !== null) lines.push(`harness: ${harness}`);
  const crew = parts.crew === undefined ? ['path: ../example-crew'] : parts.crew;
  if (crew !== null) lines.push('crew:', ...crew.map((line) => `  ${line}`));
  if (parts.require) lines.push('require:', ...parts.require.map((item) => `  - ${item}`));
  const front = parts.front === undefined ? 'lead' : parts.front;
  if (front !== null) lines.push(`front: ${front}`);
  const roles = parts.roles === undefined ? DEFAULT_ROLES : parts.roles;
  if (roles !== null) {
    lines.push('roles:');
    for (const entry of roles) {
      entry.forEach((line, index) => lines.push(`${index === 0 ? '  - ' : '    '}${line}`));
    }
  }
  lines.push(...(parts.extra ?? []));
  return `${lines.join('\n')}\n`;
}

/** A crew file whose one role entry has these lines and whose `front` names `lead`. */
export function crewWithRole(...roleLines: string[]): string {
  return crewYml({ roles: [roleLines], front: 'lead' });
}

/** A YAML double-quoted string, so control and Unicode characters reach the parser intact. */
export function quoted(value: string): string {
  return JSON.stringify(value);
}

/** The 1-based line of the nth line that contains `needle`. */
export function lineContaining(text: string, needle: string, nth = 1): number {
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

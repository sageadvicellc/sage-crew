import { existsSync, realpathSync } from 'node:fs';
import { dirname, basename, join, resolve, sep } from 'node:path';

/** Every variable a harness or the operating system may read as a home. */
export const HOME_VARS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
] as const;

/** Resolves symlinks on the longest existing prefix, so /var and /private/var agree. */
function canonical(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(canonical(parent), basename(abs));
}

function inside(path: string, root: string): boolean {
  const p = canonical(path);
  const r = canonical(root);
  return p === r || p.startsWith(r + sep);
}

/**
 * Throws unless every home variable, and the home the OS reports, sits
 * inside the run's temp home. Pass `homedir` as undefined to skip that check.
 */
export function assertIsolatedHome(
  vars: Readonly<Record<string, string | undefined>>,
  homedir: string | undefined,
  tempHome: string | undefined,
): void {
  if (!tempHome) {
    throw new Error('home guard: no temp home was provided by the global setup');
  }
  for (const name of HOME_VARS) {
    const value = vars[name];
    if (!value) {
      throw new Error(`home guard: ${name} is unset; it must point inside the temp home`);
    }
    if (!inside(value, tempHome)) {
      throw new Error(`home guard: ${name} points outside the temp home`);
    }
  }
  if (homedir !== undefined && !inside(homedir, tempHome)) {
    throw new Error('home guard: os homedir() resolves outside the temp home');
  }
}

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Env } from '../env.ts';
import { applyWorkers, defaultTeam } from './defaults.ts';
import type { HarnessId, RolesConfig } from './schema.ts';
import { formatRolesErrors, validateRoles } from './validate.ts';

/** The roles file `start` reads from the current folder when no --roles is given. */
export const DEFAULT_ROLES_FILE = 'sagespec.yml';

export interface LoadOptions {
  env: Env;
  /** The --roles value. */
  roles?: string;
  /** The --workers value. */
  workers?: number;
  /** The --merge-reporters flag. */
  mergeReporters?: boolean;
  /** The chosen harness, whose bounds apply. */
  harness?: HarnessId;
}

export type LoadResult =
  | { ok: true; config: RolesConfig; source: string; file: string | null; sha256: string | null }
  | { ok: false; code: 2; lines: string[] };

function failure(...lines: string[]): LoadResult {
  return { ok: false, code: 2, lines };
}

/** Finds the roles file, validates it, and applies --workers. Any failure is exit code 2. */
export function loadTeam(options: LoadOptions): LoadResult {
  const { env } = options;
  let file: string | undefined;
  if (options.roles !== undefined) {
    file = isAbsolute(options.roles) ? options.roles : resolve(env.cwd, options.roles);
  } else if (existsSync(join(env.cwd, DEFAULT_ROLES_FILE))) {
    file = join(env.cwd, DEFAULT_ROLES_FILE);
  }

  if (file === undefined) {
    return {
      ok: true,
      config: defaultTeam({
        ...(options.workers === undefined ? {} : { workers: options.workers }),
        mergeReporters: options.mergeReporters === true,
      }),
      source: 'the default team',
      file: null,
      sha256: null,
    };
  }

  if (options.mergeReporters) {
    return failure(`${file}: --merge-reporters applies to the default team only. Join the sessions in the roles file instead.`);
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
    return failure(`${file}: cannot read the roles file (${reason})`);
  }
  const result = validateRoles(text, options.harness ? { harness: options.harness } : {});
  if (!result.ok) {
    return failure(...formatRolesErrors(result.errors, text, file), 'Nothing was started.');
  }
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (options.workers === undefined) return { ok: true, config: result.config, source: file, file, sha256 };
  const applied = applyWorkers(result.config, options.workers);
  if (!applied.ok) return failure(`${file}: ${applied.message}`, 'Nothing was started.');
  return { ok: true, config: applied.config, source: file, file, sha256 };
}

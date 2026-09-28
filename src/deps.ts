import type { Adapter } from './adapters/types.ts';
import type { Env } from './env.ts';
import type { HarnessId, RolesConfig } from './roles/schema.ts';
import type { Runner } from './runner.ts';
import type { TeamSource } from './store/team-json.ts';

/** Success. */
export const EXIT_OK = 0;
/** A runtime failure: a probe, a file, or a process went wrong. */
export const EXIT_RUNTIME = 1;
/** A usage error or a roles-file error. */
export const EXIT_USAGE = 2;

/** Everything a command needs from outside. Tests pass fixtures for each. */
export interface CliDeps {
  env: Env;
  runner: Runner;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Launches a validated team. Tests may pass a stand-in. */
  startTeam?: (config: RolesConfig, deps: CliDeps, source: TeamSource) => Promise<number>;
  /** Adapters that replace the built ones, for tests. */
  adapters?: Partial<Record<HarnessId, Adapter>>;
}

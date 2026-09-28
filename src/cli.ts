#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCommand, USAGE } from './args.ts';
import { envFromProcess, type Env } from './env.ts';
import { loadTeam } from './roles/load.ts';
import type { RolesConfig } from './roles/schema.ts';
import { createRunner, type Runner } from './runner.ts';

/** Success. */
export const EXIT_OK = 0;
/** A runtime failure: a probe, a file, or a process went wrong. */
export const EXIT_RUNTIME = 1;
/** A usage error or a roles-file error. */
export const EXIT_USAGE = 2;

export interface CliDeps {
  env: Env;
  runner: Runner;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * Launches a validated team. Launching arrives in plan step 8. Tests pass
   * a stand-in here.
   */
  startTeam?: (config: RolesConfig, deps: CliDeps) => Promise<number>;
}

/** The launch step until plan step 8 builds it. */
async function startNotBuilt(_config: RolesConfig, deps: CliDeps): Promise<number> {
  deps.err('trellis-crew start: the roles file is valid, but launching sessions is not built yet');
  return EXIT_RUNTIME;
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/** Runs one command line and returns the exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommand(argv);
  if (!parsed.ok) {
    deps.err(`trellis-crew: ${parsed.message}`);
    deps.err(USAGE);
    return EXIT_USAGE;
  }
  const { command } = parsed;
  switch (command.name) {
    case 'help':
      deps.out(USAGE);
      return EXIT_OK;
    case 'version':
      deps.out(packageVersion());
      return EXIT_OK;
    case 'start': {
      const loaded = loadTeam({
        env: deps.env,
        ...(command.roles === undefined ? {} : { roles: command.roles }),
        ...(command.workers === undefined ? {} : { workers: command.workers }),
        mergeReporters: command.mergeReporters,
      });
      if (!loaded.ok) {
        for (const line of loaded.lines) deps.err(line);
        return EXIT_USAGE;
      }
      return (deps.startTeam ?? startNotBuilt)(loaded.config, deps);
    }
    default:
      deps.err(`trellis-crew ${command.name}: not built yet`);
      return EXIT_RUNTIME;
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main(process.argv.slice(2), {
    env: envFromProcess(),
    runner: createRunner(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}

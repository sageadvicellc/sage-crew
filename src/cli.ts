#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCommand, USAGE } from './args.ts';
import { envFromProcess, type Env } from './env.ts';
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

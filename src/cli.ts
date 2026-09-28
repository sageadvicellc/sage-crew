#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCommand, USAGE } from './args.ts';
import { runRespawn } from './commands/respawn.ts';
import { launchTeam, loadForHarness } from './commands/start.ts';
import { runStatus } from './commands/status.ts';
import { runStop } from './commands/stop.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from './deps.ts';
import { envFromProcess } from './env.ts';
import { createRunner } from './runner.ts';

export { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from './deps.ts';

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
      const loaded = loadForHarness(
        {
          env: deps.env,
          ...(command.roles === undefined ? {} : { roles: command.roles }),
          ...(command.workers === undefined ? {} : { workers: command.workers }),
          mergeReporters: command.mergeReporters,
        },
        deps,
      );
      if (!loaded.ok) {
        for (const line of loaded.lines) deps.err(line);
        return EXIT_USAGE;
      }
      const source = {
        file: loaded.file,
        ...(command.workers === undefined ? {} : { workers: command.workers }),
        ...(command.mergeReporters ? { merge_reporters: true } : {}),
      };
      return (deps.startTeam ?? launchTeam)(loaded.config, deps, source);
    }
    case 'status':
      return runStatus(deps);
    case 'stop':
      return runStop(deps);
    case 'respawn':
      return runRespawn(command, deps);
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

#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCommand, USAGE, type Command } from './args.ts';
import { runInstall } from './commands/install.ts';
import { runRespawn } from './commands/respawn.ts';
import { confirmFoundRoles, launchTeam, loadForHarness } from './commands/start.ts';
import { runStatus } from './commands/status.ts';
import { runStop } from './commands/stop.ts';
import { runTeardown } from './commands/teardown.ts';
import { runUpdate } from './commands/update.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from './deps.ts';
import { envFromProcess } from './env.ts';
import { UnsafeFolderError } from './fs-private.ts';
import { createRunner } from './runner.ts';
import { cliVersion } from './versions.ts';

export { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from './deps.ts';

/** Runs one command line and returns the exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommand(argv);
  if (!parsed.ok) {
    deps.err(`trellis-crew: ${parsed.message}`);
    deps.err(USAGE);
    return EXIT_USAGE;
  }
  try {
    return await dispatch(parsed.command, deps);
  } catch (error) {
    // A state folder that is not private stops the command before any write.
    if (!(error instanceof UnsafeFolderError)) throw error;
    deps.err(`trellis-crew: ${error.message}. Nothing was written there.`);
    return EXIT_RUNTIME;
  }
}

async function dispatch(command: Command, deps: CliDeps): Promise<number> {
  switch (command.name) {
    case 'help':
      deps.out(USAGE);
      return EXIT_OK;
    case 'version':
      deps.out(cliVersion());
      return EXIT_OK;
    case 'start': {
      const loaded = loadForHarness(
        {
          env: deps.env,
          ...(command.roles === undefined ? {} : { roles: command.roles }),
          ...(command.workers === undefined ? {} : { workers: command.workers }),
        },
        deps,
      );
      if (!loaded.ok) {
        for (const line of loaded.lines) deps.err(line);
        return EXIT_USAGE;
      }
      if (command.roles === undefined && loaded.file !== null) {
        const stop = await confirmFoundRoles(loaded.file, loaded.config, command.yes, deps);
        if (stop !== undefined) return stop;
      }
      const source = {
        file: loaded.file,
        ...(loaded.sha256 === null ? {} : { sha256: loaded.sha256 }),
        ...(command.workers === undefined ? {} : { workers: command.workers }),
      };
      return (deps.startTeam ?? launchTeam)(loaded.config, deps, source);
    }
    case 'status':
      return runStatus(deps);
    case 'stop':
      return runStop({ forceStop: command.forceStop }, deps);
    case 'teardown':
      return runTeardown(command, deps);
    case 'respawn':
      return runRespawn(command, deps);
    case 'install':
      return runInstall(command, deps);
    case 'update':
      return runUpdate(command, deps);
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

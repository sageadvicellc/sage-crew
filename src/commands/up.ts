import { lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Command, UpHarness } from '../args.ts';
import { EXIT_OK, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { HARNESSES } from '../detect/probe.ts';
import { printable } from '../printable.ts';
import { runInstall, type InstallOptions } from './install.ts';
import { runStart } from './start.ts';

export type UpOptions = Omit<Extract<Command, { name: 'up' }>, 'name'>;

/** The lines install prints when it needs a flag that `up` names differently. */
const UP_HINTS = {
  inboundMissing: 'Run up again with --accept-inbound to set it, or with --skip-inbound to leave it.',
  rolesNoTerminal: 'trellis-crew up asks no question about a roles file. Read it, then run up again with --yes.',
};

/**
 * The install step of `up`, built as if `install --harness <name>
 * --non-interactive` had been given. `up --yes` confirms a roles file
 * only. It never consents to the inbound setting, which changes a user
 * settings file for every session of the harness. Only
 * `--accept-inbound` does that, as `install --yes` does.
 */
export function upInstallOptions(options: UpOptions): InstallOptions {
  return {
    harness: options.harness,
    nonInteractive: true,
    reconfigure: false,
    yes: options.acceptInbound,
    skipInbound: options.skipInbound,
    rolesYes: options.yes,
    hints: UP_HINTS,
    ...(options.roles === undefined ? {} : { roles: options.roles }),
  };
}

/**
 * Checks that a --roles value names a local regular file, and not a
 * folder or a symbolic link. Returns the reason it does not, or undefined.
 */
function rolesFileProblem(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'a symbolic link';
    if (!stat.isFile()) return 'not a regular file';
    return undefined;
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
  }
}

function checkRolesFile(options: UpOptions, deps: CliDeps, nothing: string): boolean {
  if (options.roles === undefined) return true;
  const path = isAbsolute(options.roles) ? options.roles : resolve(deps.env.cwd, options.roles);
  const problem = rolesFileProblem(path);
  if (problem === undefined) return true;
  deps.err(`${printable(path)}: --roles must name a local regular file (${problem}). ${nothing}`);
  return false;
}

function displayName(harness: UpHarness): string {
  return HARNESSES.find((h) => h.id === harness)?.displayName ?? harness;
}

/**
 * Installs the named harness with no question, then starts the team, in
 * one step. It stops at the first step that fails, names that step, and
 * exits with that step's code.
 */
export async function runUp(options: UpOptions, deps: CliDeps): Promise<number> {
  if (!checkRolesFile(options, deps, 'Nothing was installed.')) return EXIT_USAGE;

  deps.out(`Step 1 of 2: install on ${displayName(options.harness)}, with no questions.`);
  const installed = await runInstall(upInstallOptions(options), deps);
  if (installed !== EXIT_OK) {
    deps.err(`trellis-crew up stopped at step 1 of 2, install, with exit code ${installed}. Nothing was started.`);
    return installed;
  }

  // The file is checked again, because the install step took time and the file could have changed.
  if (!checkRolesFile(options, deps, 'Nothing was started.')) return EXIT_USAGE;
  deps.out('Step 2 of 2: start the team.');
  const started = await runStart(
    {
      harness: options.harness,
      yes: options.yes,
      ...(options.roles === undefined ? {} : { roles: options.roles }),
      ...(options.workers === undefined ? {} : { workers: options.workers }),
    },
    deps,
  );
  if (started !== EXIT_OK) deps.err(`trellis-crew up stopped at step 2 of 2, start, with exit code ${started}.`);
  return started;
}

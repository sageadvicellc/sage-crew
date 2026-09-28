import { rmSync } from 'node:fs';
import { adapterFor } from '../adapters/index.ts';
import { EXIT_OK, EXIT_RUNTIME, type CliDeps } from '../deps.ts';
import { terminalAsk } from '../detect/confirm.ts';
import { readTeam, teamJsonPath, type TeamEntry } from '../store/team-json.ts';

/** What stopping one recorded process did. */
export interface StopOutcome {
  line: string;
  /** True for a warning, which goes to standard error. */
  warning: boolean;
  /** True when the process could not be checked, so its record must stay. */
  kept: boolean;
}

export interface StopPidOptions {
  /** --force-stop: signal a pid whose record holds no start time. */
  forceStop?: boolean;
}

function signal(label: string, pid: number, deps: CliDeps): StopOutcome {
  return deps.runner.kill(pid, 'SIGTERM')
    ? { line: `Stopped ${label} (pid ${pid}).`, warning: false, kept: false }
    : { line: `${label} (pid ${pid}) was not running.`, warning: false, kept: false };
}

/**
 * Handles a record with no start time. The pid cannot be checked, so it is
 * signalled only with --force-stop or a yes from a terminal. Otherwise the
 * record is kept.
 */
async function stopUnchecked(label: string, pid: number, options: StopPidOptions, deps: CliDeps): Promise<StopOutcome> {
  if (options.forceStop) return signal(label, pid, deps);
  deps.err(
    `warning: ${label}: the team record holds no start time for pid ${pid}, so the CLI cannot tell whether it is the process it started.`,
  );
  if (deps.env.stdinIsTTY) {
    const answer = (await (deps.ask ?? terminalAsk())(`Signal ${label} (pid ${pid}) anyway? [y/N] `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return signal(label, pid, deps);
  }
  return {
    line: `${label} (pid ${pid}) was not signalled. Check the process, then run the command again with --force-stop to signal it.`,
    warning: true,
    kept: true,
  };
}

/**
 * Ends one recorded process. The pid is checked against the start time in
 * the record first: a pid that now shows another start time was reused, so
 * nothing is signalled. When ps cannot tell, nothing is signalled either,
 * and the record is kept for a later stop. A record with no start time is
 * signalled only with --force-stop or a confirm.
 */
export async function stopPid(
  label: string,
  pid: number,
  started: string | undefined,
  deps: CliDeps,
  options: StopPidOptions = {},
): Promise<StopOutcome> {
  if (started === undefined) return stopUnchecked(label, pid, options, deps);
  const now = deps.runner.startTime(pid);
  if (now.status === 'absent') return { line: `${label} (pid ${pid}) was not running.`, warning: false, kept: false };
  if (now.status === 'unknown') {
    return {
      line: `warning: ${label}: cannot tell whether pid ${pid} is the process the CLI started (${now.reason}), so it was not signalled.`,
      warning: true,
      kept: true,
    };
  }
  if (now.started !== started) {
    return { line: `${label}: pid ${pid} now belongs to another process, so it was not signalled.`, warning: false, kept: false };
  }
  return signal(label, pid, deps);
}

/** Prints a stop outcome on the stream it belongs to. */
export function printStop(outcome: StopOutcome, deps: CliDeps): void {
  (outcome.warning ? deps.err : deps.out)(outcome.line);
}

/** The line for a recorded session that holds no local process. */
export function noProcessLine(harness: Parameters<typeof adapterFor>[0], entry: TeamEntry, deps: CliDeps): string {
  const adapter = adapterFor(harness, deps.adapters);
  return adapter
    ? adapter.noProcessNote(entry)
    : `${entry.name}: no local process was recorded, so it still runs${entry.session_id ? ` as ${entry.session_id}` : ''}.`;
}

/**
 * Ends every process the CLI recorded in team.json, and nothing else: the
 * supervisor first, so it restarts no child, then each session. Then it
 * removes team.json, unless a process could not be checked.
 */
export async function runStop(options: StopPidOptions, deps: CliDeps): Promise<number> {
  const team = readTeam(deps.env);
  if (!team.ok) {
    deps.err(team.message);
    return EXIT_RUNTIME;
  }
  if (!team.record) {
    deps.out('No team is running.');
    return EXIT_OK;
  }
  const { record } = team;
  let kept = 0;
  const stop = async (label: string, pid: number, started: string | undefined): Promise<void> => {
    const outcome = await stopPid(label, pid, started, deps, options);
    printStop(outcome, deps);
    if (outcome.kept) kept += 1;
  };
  if (record.supervisor_pid !== undefined) await stop('the supervisor', record.supervisor_pid, record.supervisor_started);
  for (const entry of record.sessions) {
    if (entry.pid === null) deps.out(noProcessLine(record.harness, entry, deps));
    else await stop(entry.name, entry.pid, entry.started);
  }
  if (kept > 0) {
    deps.err(`Kept the team record ${teamJsonPath(deps.env)}, because ${kept} process(es) could not be checked. Run trellis-crew stop again.`);
    return EXIT_RUNTIME;
  }
  rmSync(teamJsonPath(deps.env), { force: true });
  deps.out(`Removed the team record ${teamJsonPath(deps.env)}.`);
  return EXIT_OK;
}

import { rmSync } from 'node:fs';
import { adapterFor } from '../adapters/index.ts';
import { EXIT_OK, EXIT_RUNTIME, type CliDeps } from '../deps.ts';
import { readTeam, teamJsonPath, type TeamEntry } from '../store/team-json.ts';

/** What stopping one recorded process did. */
export interface StopOutcome {
  line: string;
  /** True for a warning, which goes to standard error. */
  warning: boolean;
  /** True when the process could not be checked, so its record must stay. */
  kept: boolean;
}

/**
 * Ends one recorded process. When the record holds the process's start
 * time, the pid is checked first: a pid that now shows another start time
 * was reused, so nothing is signalled. When ps cannot tell, nothing is
 * signalled either, and the record is kept for a later stop.
 */
export function stopPid(label: string, pid: number, started: string | undefined, deps: CliDeps): StopOutcome {
  if (started !== undefined) {
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
  }
  return deps.runner.kill(pid, 'SIGTERM')
    ? { line: `Stopped ${label} (pid ${pid}).`, warning: false, kept: false }
    : { line: `${label} (pid ${pid}) was not running.`, warning: false, kept: false };
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
export async function runStop(deps: CliDeps): Promise<number> {
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
  const stop = (label: string, pid: number, started: string | undefined): void => {
    const outcome = stopPid(label, pid, started, deps);
    printStop(outcome, deps);
    if (outcome.kept) kept += 1;
  };
  if (record.supervisor_pid !== undefined) stop('the supervisor', record.supervisor_pid, record.supervisor_started);
  for (const entry of record.sessions) {
    if (entry.pid === null) deps.out(noProcessLine(record.harness, entry, deps));
    else stop(entry.name, entry.pid, entry.started);
  }
  if (kept > 0) {
    deps.err(`Kept the team record ${teamJsonPath(deps.env)}, because ${kept} process(es) could not be checked. Run trellis-crew stop again.`);
    return EXIT_RUNTIME;
  }
  rmSync(teamJsonPath(deps.env), { force: true });
  deps.out(`Removed the team record ${teamJsonPath(deps.env)}.`);
  return EXIT_OK;
}

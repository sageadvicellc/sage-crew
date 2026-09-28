import { rmSync } from 'node:fs';
import { adapterFor } from '../adapters/index.ts';
import { EXIT_OK, EXIT_RUNTIME, type CliDeps } from '../deps.ts';
import { readTeam, teamJsonPath, type TeamEntry } from '../store/team-json.ts';

/**
 * Ends one recorded process. Returns the line to print. When the record
 * holds the process's start time and the pid now shows another one, the
 * pid was reused, so nothing is signalled.
 */
export function stopPid(label: string, pid: number, started: string | undefined, deps: CliDeps): string {
  if (started !== undefined) {
    const now = deps.runner.startTime(pid);
    if (now === undefined) return `${label} (pid ${pid}) was not running.`;
    if (now !== started) return `${label}: pid ${pid} now belongs to another process, so it was not signalled.`;
  }
  return deps.runner.kill(pid, 'SIGTERM') ? `Stopped ${label} (pid ${pid}).` : `${label} (pid ${pid}) was not running.`;
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
 * removes team.json.
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
  if (record.supervisor_pid !== undefined) {
    deps.out(stopPid('the supervisor', record.supervisor_pid, record.supervisor_started, deps));
  }
  for (const entry of record.sessions) {
    deps.out(entry.pid === null ? noProcessLine(record.harness, entry, deps) : stopPid(entry.name, entry.pid, entry.started, deps));
  }
  rmSync(teamJsonPath(deps.env), { force: true });
  deps.out(`Removed the team record ${teamJsonPath(deps.env)}.`);
  return EXIT_OK;
}

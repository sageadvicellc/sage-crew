import { adapterFor } from '../adapters/index.ts';
import { EXIT_OK, EXIT_RUNTIME, type CliDeps } from '../deps.ts';
import { findBinary, HARNESSES } from '../detect/probe.ts';
import { printable } from '../printable.ts';
import { readTeam } from '../store/team-json.ts';

/** Lists the team's sessions and their state from team.json. */
export async function runStatus(deps: CliDeps): Promise<number> {
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
  const name = HARNESSES.find((h) => h.id === record.harness)?.displayName ?? record.harness;
  const source = record.roles?.file ?? 'the default team';
  deps.out(`Team on ${name}, from ${source}.`);
  const width = Math.max('supervisor'.length, ...record.sessions.map((s) => s.name.length));
  if (record.supervisor_pid !== undefined) {
    const state = deps.runner.alive(record.supervisor_pid) ? 'running' : 'not running';
    deps.out(`${'supervisor'.padEnd(width)}  pid ${record.supervisor_pid}  ${state}`);
  }
  for (const entry of record.sessions) {
    const state =
      entry.pid === null ? 'unknown, no local process recorded' : deps.runner.alive(entry.pid) ? 'running' : 'not running';
    const error = entry.error === undefined ? '' : `  error: ${printable(entry.error)}`;
    deps.out(`${entry.name.padEnd(width)}  pid ${entry.pid ?? '-'}  session ${entry.session_id ?? '-'}  ${state}${error}`);
  }
  const adapter = adapterFor(record.harness, deps.adapters);
  const info = HARNESSES.find((h) => h.id === record.harness);
  const binaryPath = info ? findBinary(info.binary, deps.env.path) : undefined;
  if (adapter?.statusLines && binaryPath !== undefined) {
    for (const line of await adapter.statusLines({ env: deps.env, runner: deps.runner, binaryPath, out: deps.out })) deps.out(line);
  }
  return EXIT_OK;
}

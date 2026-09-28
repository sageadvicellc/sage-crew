import type { TeamEntry } from '../store/team-json.ts';
import type { AdapterContext, LaunchOutcome } from './types.ts';

/**
 * Sets up a session the CLI cannot start itself. It prints why, the
 * command for the operator to run when one is documented, and the
 * kickoff to send as the first message. It runs nothing and records the
 * session with no pid and no session id.
 */
export function manualLaunch(
  name: string,
  kickoff: string,
  ctx: AdapterContext,
  how: { reason: string; command?: string },
): LaunchOutcome {
  ctx.out(`--- ${name} ---`);
  ctx.out(`Not started: ${how.reason}`);
  if (how.command !== undefined) ctx.out(`Start it in its own terminal with: ${how.command}`);
  ctx.out(`Then send this kickoff as its first message:`);
  for (const line of kickoff.trimEnd().split('\n')) ctx.out(line);
  ctx.out(`--- end of ${name} ---`);
  return { ok: true, entry: { name, pid: null, session_id: null } };
}

/** The stop line for a session the CLI never started. */
export function manualNote(entry: TeamEntry): string {
  return `${entry.name}: the CLI started no process for it, so it still runs if you started it. Stop it in its own terminal.`;
}

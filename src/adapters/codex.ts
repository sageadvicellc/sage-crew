import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { ensurePrivateFolder } from '../fs-private.ts';
import type { Role } from '../roles/schema.ts';
import { packageSkillsDir, roleInstructionsArgs } from './codex-instructions.ts';
import type { SupervisorJob } from './codex-supervisor.ts';
import type { Adapter, AdapterContext, PluginOutcome } from './types.ts';

export { packageSkillsDir };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The folder Codex CLI reads user skills from. */
export function codexSkillsDir(home: string): string {
  return join(home, '.agents', 'skills');
}

/** The supervisor script beside this file: `.ts` when run from source, `.js` when built. */
export function supervisorScriptPath(): string {
  const ext = extname(fileURLToPath(import.meta.url));
  return fileURLToPath(new URL(`./codex-supervisor${ext}`, import.meta.url));
}

/**
 * The arguments for one `codex exec` session. Codex documents no flag to name a session, so the kickoff names it.
 * The role's instructions sit just before the prompt. Throws RoleInstructionsError when the role skill cannot be read.
 *
 * Merge note: trellis-crew#24 moves this function to codex-args.ts `codexExecArgs`. Carry the role
 * instructions over there.
 *
 * Reconciliation rule for that merge. trellis-crew#24's `refusedCodexFlag` refuses every launch flag,
 * and codex-args.ts `execArgsProblem` checks the argv again in the supervisor. As written, both refuse
 * the `-c` this function adds. The merge must allow exactly ONE `-c`, and only when its value starts
 * with `developer_instructions="` and equals `'developer_instructions=' + tomlString(roleText)`,
 * rebuilt fresh from the shipped skill for that session's role. `execArgsProblem` makes that
 * comparison. It must NEVER allow `-c` in general, because `-c sandbox_mode=danger-full-access` is
 * the risk. The merge adds these tests, each of which must be refused: a second `-c`; a `-c` whose key
 * differs; a `-c developer_instructions` whose value differs from the rebuilt one; and a
 * `developer_instructions` value that hides a newline plus `sandbox_mode=`.
 */
export function codexExecArgs(flagArgs: readonly string[], kickoff: string, role: Role): string[] {
  return ['exec', ...flagArgs, ...roleInstructionsArgs(role), kickoff];
}

/**
 * Copies each skill folder into `~/.agents/skills/<skill>/`. It first
 * removes only the folders this package owns, so a stale file goes and
 * every other skill stays.
 */
function copySkills(ctx: AdapterContext): PluginOutcome {
  const source = packageSkillsDir();
  if (!existsSync(source)) return { ok: false, message: `the skill folders are missing from this package: ${source}` };
  const target = codexSkillsDir(ctx.env.home);
  try {
    mkdirSync(target, { recursive: true });
    for (const skill of readdirSync(source, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const dest = join(target, skill.name);
      rmSync(dest, { recursive: true, force: true });
      cpSync(join(source, skill.name), dest, { recursive: true });
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  ctx.out(`Copied the trellis-crew skills into ${target}.`);
  return { ok: true };
}

/**
 * Codex CLI, tier three. Codex documents `codex exec "<prompt>"` and no
 * detach flag, no session-name flag, and no cross-session messaging. So
 * `start` hands every session to one detached supervisor, which starts
 * each `codex exec` process, and the team uses the file mailbox. No launch
 * flag is verified, so every set field warns.
 */
export const codexAdapter: Adapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  flags: {},

  /** Starts one session on its own, for respawn. */
  async launch(name, kickoff, flagArgs, ctx, role) {
    try {
      const { pid } = await ctx.runner.spawnDetached(ctx.binaryPath, codexExecArgs(flagArgs, kickoff, role), {
        env: ctx.env.vars,
        cwd: ctx.env.cwd,
      });
      return { ok: true, entry: { name, pid, session_id: null } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  async launchAll(items, ctx, teamPath) {
    // Every session's arguments are built before the job file is written, so a failed one starts no session.
    // Merge note: trellis-crew#24 gives codex.ts `launchAll` this same shape: build every session's args
    // first, then write the job file inside a try. Keep one copy when the two merge. The `-c` these args
    // hold follows the reconciliation rule at `codexExecArgs` above.
    const sessions: SupervisorJob['sessions'] = [];
    for (const item of items) {
      try {
        sessions.push({ name: item.name, args: codexExecArgs(item.flagArgs, item.kickoff, item.role) });
      } catch (error) {
        return { ok: false, notStarted: true, message: `${item.name}: ${errorMessage(error)}` };
      }
    }
    ctx.out('Role text: each Codex session gets the shipped default skill for its role. Each kickoff still comes from the roles file, or from the default team.');
    const job: SupervisorJob = { binary: ctx.binaryPath, cwd: ctx.env.cwd, teamPath, sessions };
    const jobPath = join(stateDir(ctx.env), 'codex-supervisor.json');
    try {
      ensurePrivateFolder(stateDir(ctx.env));
      writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, 0o600);
    } catch (error) {
      return { ok: false, message: `could not write the supervisor job file ${jobPath}: ${errorMessage(error)}` };
    }
    try {
      const { pid } = await ctx.runner.spawnDetached(process.execPath, [supervisorScriptPath(), jobPath], {
        env: ctx.env.vars,
        cwd: ctx.env.cwd,
      });
      return { ok: true, supervisorPid: pid };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  noProcessNote(entry) {
    return `${entry.name}: the supervisor recorded no process for it. It never started, or the supervisor ended first.`;
  },

  async installPlugin(ctx) {
    return copySkills(ctx);
  },

  async updatePlugin(ctx) {
    // The documented update is a fresh copy of the skill folders.
    return copySkills(ctx);
  },
};

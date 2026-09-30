import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { ensurePrivateFolder } from '../fs-private.ts';
import { agentsSkillsDir, exportSkills, skillCheckReport } from './codex-skills.ts';
import type { SupervisorJob } from './codex-supervisor.ts';
import type { Adapter, AdapterContext, PluginOutcome } from './types.ts';

/** The skill folders this package carries, one per skill. */
export function packageSkillsDir(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

/** The folder Codex CLI reads user skills from. */
export function codexSkillsDir(home: string): string {
  return agentsSkillsDir(home);
}

/** The supervisor script beside this file: `.ts` when run from source, `.js` when built. */
export function supervisorScriptPath(): string {
  const ext = extname(fileURLToPath(import.meta.url));
  return fileURLToPath(new URL(`./codex-supervisor${ext}`, import.meta.url));
}

/** The arguments for one `codex exec` session. Codex documents no flag to name a session, so the kickoff names it. */
export function codexExecArgs(flagArgs: readonly string[], kickoff: string): string[] {
  return ['exec', ...flagArgs, kickoff];
}

/** Exports each approved skill into `~/.agents/skills/<skill>/`. See codex-skills.ts. */
function copySkills(ctx: AdapterContext): PluginOutcome {
  return exportSkills(ctx.env.home, ctx.out);
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
  async launch(name, kickoff, flagArgs, ctx) {
    try {
      const { pid } = await ctx.runner.spawnDetached(ctx.binaryPath, codexExecArgs(flagArgs, kickoff), {
        env: ctx.env.vars,
        cwd: ctx.env.cwd,
      });
      return { ok: true, entry: { name, pid, session_id: null } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  async launchAll(items, ctx, teamPath) {
    const job: SupervisorJob = {
      binary: ctx.binaryPath,
      cwd: ctx.env.cwd,
      teamPath,
      sessions: items.map((item) => ({ name: item.name, args: codexExecArgs(item.flagArgs, item.kickoff) })),
    };
    const dir = stateDir(ctx.env);
    ensurePrivateFolder(dir);
    const jobPath = join(dir, 'codex-supervisor.json');
    writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, 0o600);
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

  checkPlugin(env) {
    return skillCheckReport(env.home);
  },
};

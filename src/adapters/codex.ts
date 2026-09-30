import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { ensurePrivateFolder } from '../fs-private.ts';
import type { SupervisorJob } from './codex-supervisor.ts';
import type { Adapter, AdapterContext, PluginOutcome } from './types.ts';

/** The skill folders this package carries, one per skill. */
export function packageSkillsDir(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
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
 * The sandbox every `codex exec` session runs in. Read from the local
 * `codex exec --help` of codex-cli 0.157.0: `-s, --sandbox <SANDBOX_MODE>`
 * takes read-only, workspace-write, or danger-full-access, and
 * `-c, --config <key=value>` overrides one configuration value, parsed as
 * TOML. So a session can write only its workspace, and its commands get no
 * network access. trellis-crew never passes danger-full-access or
 * `--dangerously-bypass-approvals-and-sandbox`.
 */
export const CODEX_SANDBOX_ARGS: readonly string[] = ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false'];

/**
 * Returns why a launch flag is refused on Codex CLI, or undefined when
 * none is. A flag that sets the sandbox or a configuration value could
 * undo CODEX_SANDBOX_ARGS, so each one is refused, in every spelling that
 * the help lists: the long form, the long form with `=`, and the short
 * form with its value joined on.
 */
export function refusedCodexFlag(flagArgs: readonly string[]): string | undefined {
  const refused = flagArgs.find(
    (arg) =>
      /^--(sandbox|config)(=|$)/.test(arg) ||
      /^-[sc]/.test(arg) ||
      arg.includes('dangerously-bypass-approvals-and-sandbox') ||
      arg.includes('danger-full-access'),
  );
  if (refused === undefined) return undefined;
  return `the launch flag "${refused}" is refused on Codex CLI, because trellis-crew sets the sandbox itself: ${CODEX_SANDBOX_ARGS.join(' ')}`;
}

/**
 * The arguments for one `codex exec` session. Codex documents no flag to
 * name a session, so the kickoff names it. The help shows the prompt as
 * the trailing `[PROMPT]` argument, so the kickoff follows `--`, and a
 * kickoff that starts with `-` is never read as an option. Throws when a
 * launch flag is refused.
 */
export function codexExecArgs(flagArgs: readonly string[], kickoff: string): string[] {
  const refused = refusedCodexFlag(flagArgs);
  if (refused !== undefined) throw new Error(refused);
  return ['exec', ...flagArgs, ...CODEX_SANDBOX_ARGS, '--', kickoff];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * flag is verified, so every set field warns. Every session runs with
 * CODEX_SANDBOX_ARGS, and a flag that could change the sandbox is refused.
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
      return { ok: false, message: errorMessage(error) };
    }
  },

  async launchAll(items, ctx, teamPath) {
    // Every session's flags are checked before the job file is written, so a refused flag starts no session.
    for (const item of items) {
      const refused = refusedCodexFlag(item.flagArgs);
      if (refused !== undefined) return { ok: false, message: `${item.name}: ${refused}` };
    }
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
      return { ok: false, message: errorMessage(error) };
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

import type { Adapter, PluginOutcome } from './types.ts';

/** How long `amp -ox` may take. Amp documents that it returns at once, so this only guards a hang. */
export const AMP_LAUNCH_TIMEOUT_MS = 60_000;
/** How long `amp skill update` may take. */
export const AMP_PLUGIN_TIMEOUT_MS = 300_000;
/** The skill name that `amp skill update` takes. */
export const AMP_SKILL_NAME = 'trellis-crew';

/**
 * The `<source>` that `amp skill add <source> --global` takes. Gap: the spec
 * does not name it. TODO: set it once the maintainer does.
 */
export const AMP_SKILL_SOURCE: string | undefined = undefined;

/**
 * Reads the thread id from `amp -ox` output. Gap: where and in what form
 * Amp prints the new thread's id is not documented, so this reads nothing.
 * TODO: parse it once the format is documented.
 */
export function parseAmpThreadId(_stdout: string): string | null {
  return null;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Amp, tier three. Amp documents `amp -ox "<prompt>"`, which starts a
 * thread on the vendor's servers and returns at once, and `--title` to
 * name it. So the CLI holds no local process for a thread. No command to
 * stop a thread is documented, so stop leaves each one running. The team
 * uses the file mailbox. No launch flag is verified, so every set field
 * warns.
 */
export const ampAdapter: Adapter = {
  id: 'amp',
  displayName: 'Amp',
  flags: {},

  async launch(name, kickoff, flagArgs, ctx) {
    const result = await ctx.runner.run(ctx.binaryPath, ['--title', name, ...flagArgs, '-ox', kickoff], {
      env: ctx.env.vars,
      cwd: ctx.env.cwd,
      timeoutMs: AMP_LAUNCH_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const reason = result.timedOut ? 'timed out' : firstLine(result.stderr) || result.error || `exit code ${String(result.code)}`;
      return { ok: false, message: `amp -ox: ${reason}` };
    }
    return { ok: true, entry: { name, pid: null, session_id: parseAmpThreadId(result.stdout) } };
  },

  noProcessNote(entry) {
    return entry.session_id === null
      ? `${entry.name}: Amp thread still runs, but its id was not recorded. No command to stop a thread is documented.`
      : `${entry.name}: Amp thread ${entry.session_id} still runs. No command to stop a thread is documented.`;
  },

  async installPlugin(): Promise<PluginOutcome> {
    if (AMP_SKILL_SOURCE === undefined) {
      return { ok: false, skipped: true, message: 'the source that amp skill add takes for this plugin is not documented yet.' };
    }
    return { ok: false, message: 'the Amp skill install is not built yet' };
  },

  async updatePlugin(ctx) {
    const result = await ctx.runner.run(ctx.binaryPath, ['skill', 'update', AMP_SKILL_NAME], {
      env: ctx.env.vars,
      cwd: ctx.env.cwd,
      timeoutMs: AMP_PLUGIN_TIMEOUT_MS,
    });
    if (result.code === 0) return { ok: true };
    return { ok: false, message: `amp skill update: ${firstLine(result.stderr) || `exit code ${String(result.code)}`}` };
  },
};

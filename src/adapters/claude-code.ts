import type { Adapter } from './types.ts';

/** How long `claude --bg` may take to return before the launch counts as failed. */
export const CLAUDE_LAUNCH_TIMEOUT_MS = 120_000;

/**
 * Reads the session id from `claude --bg` output. Gap: the documentation
 * does not state the id's format, so this returns null until a build
 * verifies it. TODO: parse the id once its format is documented.
 */
export function parseBgSessionId(_stdout: string): string | null {
  return null;
}

/**
 * Claude Code, tier one. Each session starts with
 * `claude --bg --name <name> [--autocompact v] [--model m] [--effort e] "<kickoff>"`.
 * `--bg` returns at once and cannot be combined with `-p`.
 */
export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  flags: { autocompact: '--autocompact', model: '--model', effort: '--effort' },

  async launch(name, kickoff, flagArgs, ctx) {
    const result = await ctx.runner.run(ctx.binaryPath, ['--bg', '--name', name, ...flagArgs, kickoff], {
      env: ctx.env.vars,
      cwd: ctx.env.cwd,
      timeoutMs: CLAUDE_LAUNCH_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const reason = result.timedOut
        ? 'claude --bg did not return in time'
        : (result.error ?? result.stderr.trim().split('\n')[0] ?? `exit code ${String(result.code)}`);
      return { ok: false, message: reason || `exit code ${String(result.code)}` };
    }
    // Gap: which process id belongs to a --bg session is not documented, so no pid is recorded.
    return { ok: true, entry: { name, pid: null, session_id: parseBgSessionId(result.stdout) } };
  },

  noProcessNote(entry) {
    return `${entry.name}: Claude Code documents no command that stops a background session, so it still runs. Use the commands that claude --bg printed when it started.`;
  },
};

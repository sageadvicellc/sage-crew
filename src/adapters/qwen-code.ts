import { qwenInboundTarget } from '../settings/inbound.ts';
import type { Adapter } from './types.ts';

/** How long `qwen sessions ps` may take. */
export const QWEN_STATUS_TIMEOUT_MS = 20_000;
/** How long `qwen extensions update` may take. */
export const QWEN_PLUGIN_TIMEOUT_MS = 300_000;

/**
 * The repository URL that `qwen extensions install <repository url>` takes.
 * Gap: the spec does not name it. TODO: set it once the maintainer does.
 */
export const QWEN_EXTENSION_REPOSITORY_URL: string | undefined = undefined;

/**
 * The line that names a Qwen Code session. Qwen Code documents no flag to
 * name a session at start, only `/rename <name>` inside a session, so the
 * name goes in the first prompt. Gap: whether a slash command runs inside
 * a `qwen -p` prompt is not documented.
 */
export function qwenNameLine(name: string): string {
  return `Your session name is ${name}. Set it with /rename ${name} before anything else.`;
}

/**
 * Qwen Code, tier one. Qwen Code documents `qwen -p "<text>"` and no detach
 * flag, so the CLI starts each session as its own detached process.
 * Gap: whether a `qwen -p` process stays alive to receive messages is not
 * documented. No launch flag is verified, so every set field warns.
 */
export const qwenCodeAdapter: Adapter = {
  id: 'qwen-code',
  displayName: 'Qwen Code',
  flags: {},

  async launch(name, kickoff, flagArgs, ctx) {
    try {
      const { pid } = await ctx.runner.spawnDetached(ctx.binaryPath, [...flagArgs, '-p', `${qwenNameLine(name)}\n\n${kickoff}`], {
        env: ctx.env.vars,
        cwd: ctx.env.cwd,
      });
      return { ok: true, entry: { name, pid, session_id: null } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  noProcessNote(entry) {
    return `${entry.name}: no local process was recorded, so it may still run. Check qwen sessions ps.`;
  },

  async installPlugin(ctx) {
    if (QWEN_EXTENSION_REPOSITORY_URL === undefined) {
      return {
        ok: false,
        skipped: true,
        message: 'the repository URL that qwen extensions install takes is not documented yet.',
      };
    }
    const result = await ctx.runner.run(ctx.binaryPath, ['extensions', 'install', QWEN_EXTENSION_REPOSITORY_URL], {
      env: ctx.env.vars,
      cwd: ctx.env.cwd,
      timeoutMs: QWEN_PLUGIN_TIMEOUT_MS,
    });
    if (result.code === 0) return { ok: true };
    return { ok: false, message: `qwen extensions install: ${result.stderr.trim().split('\n')[0] || `exit code ${String(result.code)}`}` };
  },

  async updatePlugin(ctx) {
    const result = await ctx.runner.run(ctx.binaryPath, ['extensions', 'update'], {
      env: ctx.env.vars,
      cwd: ctx.env.cwd,
      timeoutMs: QWEN_PLUGIN_TIMEOUT_MS,
    });
    if (result.code === 0) return { ok: true };
    return { ok: false, message: `qwen extensions update: ${result.stderr.trim().split('\n')[0] || `exit code ${String(result.code)}`}` };
  },

  inboundTarget: qwenInboundTarget,

  async statusLines(ctx) {
    const result = await ctx.runner.run(ctx.binaryPath, ['sessions', 'ps'], {
      env: ctx.env.vars,
      cwd: ctx.env.cwd,
      timeoutMs: QWEN_STATUS_TIMEOUT_MS,
    });
    if (result.code !== 0) return ['qwen sessions ps: could not be read.'];
    return ['qwen sessions ps:', ...result.stdout.trimEnd().split('\n')];
  },
};

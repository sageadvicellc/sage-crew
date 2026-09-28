import { manualLaunch, manualNote } from './manual.ts';
import type { Adapter, PluginOutcome } from './types.ts';

/**
 * The `<source>` that `hermes skills install <source>` takes. Gap: the spec
 * does not name it. TODO: set it once the maintainer does.
 */
export const HERMES_SKILL_SOURCE: string | undefined = undefined;

const SOURCE_GAP: PluginOutcome = {
  ok: false,
  skipped: true,
  message: 'the source that hermes skills install takes for this plugin is not documented yet.',
};

/**
 * Hermes Agent, tier two. Each session is its own `hermes chat -p <name>`
 * process, under a profile named after the session. Gaps: Hermes Agent
 * documents no shell-level detach flag and no way to hand a new chat its
 * first prompt, and an interactive chat needs a terminal. So the CLI
 * prints the command and the kickoff for each session and runs nothing.
 * Same-machine messaging is not documented either, so the team uses the
 * file mailbox. No launch flag is verified, so every set field warns.
 */
export const hermesAdapter: Adapter = {
  id: 'hermes',
  displayName: 'Hermes Agent',
  flags: {},

  async launch(name, kickoff, _flagArgs, ctx) {
    return manualLaunch(name, kickoff, ctx, {
      reason: 'Hermes Agent documents no detach flag and no way to give a new chat its first prompt.',
      command: `hermes chat -p ${name}`,
    });
  },

  noProcessNote: manualNote,

  async installPlugin() {
    return HERMES_SKILL_SOURCE === undefined ? SOURCE_GAP : { ok: false, message: 'the Hermes skill install is not built yet' };
  },

  async updatePlugin() {
    // The documented update is `hermes skills install` again, which needs the same source.
    return HERMES_SKILL_SOURCE === undefined ? SOURCE_GAP : { ok: false, message: 'the Hermes skill update is not built yet' };
  },
};

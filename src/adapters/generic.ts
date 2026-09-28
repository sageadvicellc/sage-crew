import type { HarnessId } from '../roles/schema.ts';
import { manualLaunch, manualNote } from './manual.ts';
import type { Adapter, PluginOutcome } from './types.ts';

/**
 * A tier-three harness with no adapter of its own. The CLI knows its
 * binary name and nothing else: no headless command, no launch flag, and
 * no plugin install path is documented for it here. So start prints each
 * session's kickoff and runs nothing, and the team uses the file mailbox.
 * Every set launch field warns.
 */
export function genericAdapter(id: HarnessId, displayName: string): Adapter {
  const pluginGap: PluginOutcome = {
    ok: false,
    skipped: true,
    message: `the plugin install path on ${displayName} is not documented yet.`,
  };
  return {
    id,
    displayName,
    flags: {},

    async launch(name, kickoff, _flagArgs, ctx) {
      return manualLaunch(name, kickoff, ctx, {
        reason: `no headless command for ${displayName} is documented. Start the session yourself.`,
      });
    },

    noProcessNote: manualNote,

    async installPlugin() {
      return pluginGap;
    },

    async updatePlugin() {
      return pluginGap;
    },
  };
}

/** OpenCode, detected by binary name only. */
export const openCodeAdapter: Adapter = genericAdapter('opencode', 'OpenCode');

import type { Env } from '../env.ts';
import type { HarnessId } from '../roles/schema.ts';
import type { Runner } from '../runner.ts';
import type { TeamEntry } from '../store/team-json.ts';

/** The roles-file fields that become launch flags. */
export type LaunchField = 'autocompact' | 'model' | 'effort';
export const LAUNCH_FIELDS: readonly LaunchField[] = ['autocompact', 'model', 'effort'];

export type LaunchValues = Partial<Record<LaunchField, string>>;

export interface AdapterContext {
  env: Env;
  runner: Runner;
  /** The harness binary found on PATH. */
  binaryPath: string;
}

export type LaunchOutcome = { ok: true; entry: TeamEntry } | { ok: false; message: string };

export type PluginOutcome = { ok: true } | { ok: false; message: string };

/** What each harness adapter provides. */
export interface Adapter {
  id: HarnessId;
  displayName: string;
  /** The verified flag for each launch field. A field with no flag is ignored with a warning. */
  flags: Partial<Record<LaunchField, string>>;
  /** Starts one named session with its kickoff as the first prompt. */
  launch(name: string, kickoff: string, flagArgs: readonly string[], ctx: AdapterContext): Promise<LaunchOutcome>;
  /** The line stop prints for a recorded session that holds no local process. */
  noProcessNote(entry: TeamEntry): string;
  /** Installs the plugin the way the harness documents. Unset: not built yet. */
  installPlugin?(ctx: AdapterContext): Promise<PluginOutcome>;
  /** Updates the plugin through the harness. Unset: not built yet. */
  updatePlugin?(ctx: AdapterContext): Promise<PluginOutcome>;
}

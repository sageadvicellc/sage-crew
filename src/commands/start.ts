import { buildLaunchFlags, launchValues } from '../adapters/flags.ts';
import { adapterFor } from '../adapters/index.ts';
import type { Adapter, LaunchValues } from '../adapters/types.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { findBinary, HARNESSES } from '../detect/probe.ts';
import { composeKickoff } from '../kickoff/compose.ts';
import { ensureMailboxFolder, mailboxPath } from '../mailbox/folder.ts';
import { loadTeam, type LoadOptions, type LoadResult } from '../roles/load.ts';
import type { HarnessId, RolesConfig, Session, Transport } from '../roles/schema.ts';
import { readInstallRecord } from '../store/install-yml.ts';
import { readTeam, teamJsonPath, writeTeam, type TeamEntry, type TeamRecord, type TeamSource } from '../store/team-json.ts';
import { resolveTransport } from '../transport.ts';

/**
 * Loads the team, applying the chosen harness's bounds. The harness comes
 * from the roles file when it names one, and from install.yml otherwise.
 */
export function loadForHarness(options: Omit<LoadOptions, 'harness'>, deps: CliDeps): LoadResult {
  const installed = readInstallRecord(deps.env);
  const hint = installed.ok ? installed.record?.harness : undefined;
  const first = loadTeam({ ...options, ...(hint ? { harness: hint } : {}) });
  if (!first.ok || first.config.harness === 'auto' || first.config.harness === hint) return first;
  return loadTeam({ ...options, harness: first.config.harness });
}

export interface LaunchPlan {
  harness: HarnessId;
  adapter: Adapter;
  binaryPath: string;
  transport: Transport;
  mailbox?: string;
}

/** Settles the harness, adapter, binary, transport, and mailbox for a team. Prints why when it cannot. */
export function planLaunch(config: RolesConfig, deps: CliDeps): { ok: true; plan: LaunchPlan } | { ok: false; code: number } {
  const installed = readInstallRecord(deps.env);
  if (!installed.ok) {
    deps.err(installed.message);
    return { ok: false, code: EXIT_RUNTIME };
  }
  const harness = config.harness !== 'auto' ? config.harness : installed.record?.harness;
  if (harness === undefined) {
    deps.err('No harness is chosen yet. Run trellis-crew install first.');
    return { ok: false, code: EXIT_RUNTIME };
  }
  const info = HARNESSES.find((h) => h.id === harness);
  const adapter = adapterFor(harness, deps.adapters);
  if (!info || !adapter) {
    deps.err(`Starting sessions on ${info?.displayName ?? harness} is not built yet.`);
    return { ok: false, code: EXIT_RUNTIME };
  }
  const binaryPath = findBinary(info.binary, deps.env.path);
  if (binaryPath === undefined) {
    deps.err(`${info.displayName} is not on PATH: no ${info.binary} binary was found.`);
    return { ok: false, code: EXIT_RUNTIME };
  }
  const stored = installed.record?.harness === harness ? installed.record.transport : undefined;
  const transport = config.transport !== 'auto' ? config.transport : (stored ?? resolveTransport('auto', info.tier, {}));
  if (transport === 'native' && info.tier !== 1) {
    deps.err(`${info.displayName} has no native peer messaging. Set transport to auto or file-mailbox.`);
    return { ok: false, code: EXIT_USAGE };
  }
  const plan: LaunchPlan = { harness, adapter, binaryPath, transport };
  if (transport === 'file-mailbox') {
    const folder = ensureMailboxFolder(mailboxPath(config, deps.env));
    if (!folder.ok) {
      deps.err(folder.message);
      return { ok: false, code: EXIT_RUNTIME };
    }
    plan.mailbox = folder.path;
  }
  return { ok: true, plan };
}

/** Starts one session and prints its warnings. */
export async function launchSession(
  config: RolesConfig,
  session: Session,
  plan: LaunchPlan,
  deps: CliDeps,
  overrides: LaunchValues = {},
): Promise<{ ok: true; entry: TeamEntry } | { ok: false; message: string }> {
  const { args, warnings } = buildLaunchFlags(session.name, launchValues(session, overrides), plan.adapter);
  for (const warning of warnings) deps.err(warning);
  const kickoff = composeKickoff(config, session, {
    harness: plan.harness,
    transport: plan.transport,
    ...(plan.mailbox === undefined ? {} : { mailboxPath: plan.mailbox }),
  });
  return plan.adapter.launch(session.name, kickoff, args, { env: deps.env, runner: deps.runner, binaryPath: plan.binaryPath });
}

function describeEntry(entry: TeamEntry): string {
  const parts = [entry.pid === null ? undefined : `pid ${entry.pid}`, entry.session_id === null ? undefined : `session ${entry.session_id}`];
  const known = parts.filter((p) => p !== undefined);
  return known.length === 0 ? '' : ` (${known.join(', ')})`;
}

/** Starts every session of a validated team and records each one in team.json. */
export async function launchTeam(config: RolesConfig, deps: CliDeps, source: TeamSource): Promise<number> {
  const existing = readTeam(deps.env);
  if (!existing.ok) {
    deps.err(existing.message);
    return EXIT_RUNTIME;
  }
  if (existing.record) {
    deps.err(`A team record already exists at ${teamJsonPath(deps.env)}. Run trellis-crew stop first.`);
    return EXIT_RUNTIME;
  }
  const planned = planLaunch(config, deps);
  if (!planned.ok) return planned.code;
  const { plan } = planned;

  const record: TeamRecord = { version: 1, harness: plan.harness, transport: plan.transport, roles: source, sessions: [] };
  if (plan.mailbox !== undefined) record.mailbox = plan.mailbox;
  for (const session of config.sessions) {
    const outcome = await launchSession(config, session, plan, deps);
    if (!outcome.ok) {
      writeTeam(deps.env, record);
      deps.err(`${session.name}: could not start: ${outcome.message}`);
      deps.err(
        `Started ${record.sessions.length} of ${config.sessions.length} sessions. Run trellis-crew stop to end the ones that started.`,
      );
      return EXIT_RUNTIME;
    }
    record.sessions.push(outcome.entry);
    writeTeam(deps.env, record);
    deps.out(`Started ${session.name}${describeEntry(outcome.entry)}.`);
  }
  deps.out(`Started ${record.sessions.length} sessions on ${plan.adapter.displayName}. Team record: ${teamJsonPath(deps.env)}`);
  return EXIT_OK;
}

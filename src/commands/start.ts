import { rmSync } from 'node:fs';
import { buildLaunchFlags, launchValues } from '../adapters/flags.ts';
import { adapterFor } from '../adapters/index.ts';
import type { Adapter, AdapterContext, LaunchItem, LaunchValues } from '../adapters/types.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { terminalAsk } from '../detect/confirm.ts';
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

/**
 * Shows a roles file that `start` found in the current folder, with each
 * session's kickoff, and asks before it starts anything. A cloned folder
 * can hold a roles file with another author's prompts, so it never loads
 * silently. `--yes` skips the question. With no terminal and no `--yes`,
 * it refuses. Returns an exit code to stop with, or undefined to go on.
 */
export async function confirmFoundRoles(file: string, config: RolesConfig, yes: boolean, deps: CliDeps): Promise<number | undefined> {
  deps.out(`Roles file found in this folder: ${file}`);
  for (const session of config.sessions) {
    deps.out(`${session.name}:`);
    for (const line of session.kickoff.trimEnd().split('\n')) deps.out(`  ${line}`);
  }
  if (yes) return undefined;
  if (!deps.env.stdinIsTTY) {
    deps.err('No terminal can confirm this roles file. Read it, then run again with --yes, or pass --roles <file>.');
    return EXIT_USAGE;
  }
  const answer = (await (deps.ask ?? terminalAsk())(`Start ${config.sessions.length} sessions from this file? [y/N] `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return undefined;
  deps.err('Nothing was started.');
  return EXIT_RUNTIME;
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

/** Builds one session's flags and kickoff, and prints its warnings. */
export function prepareSession(
  config: RolesConfig,
  session: Session,
  plan: LaunchPlan,
  deps: CliDeps,
  overrides: LaunchValues = {},
): LaunchItem {
  const { args, warnings } = buildLaunchFlags(session.name, launchValues(session, overrides), plan.adapter);
  for (const warning of warnings) deps.err(warning);
  const kickoff = composeKickoff(config, session, {
    harness: plan.harness,
    transport: plan.transport,
    ...(plan.mailbox === undefined ? {} : { mailboxPath: plan.mailbox }),
  });
  return { name: session.name, kickoff, flagArgs: args };
}

function contextFor(plan: LaunchPlan, deps: CliDeps): AdapterContext {
  return { env: deps.env, runner: deps.runner, binaryPath: plan.binaryPath, out: deps.out };
}

/** Starts one session and prints its warnings. */
export async function launchSession(
  config: RolesConfig,
  session: Session,
  plan: LaunchPlan,
  deps: CliDeps,
  overrides: LaunchValues = {},
): Promise<{ ok: true; entry: TeamEntry } | { ok: false; message: string }> {
  const item = prepareSession(config, session, plan, deps, overrides);
  return plan.adapter.launch(item.name, item.kickoff, item.flagArgs, contextFor(plan, deps));
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
  if (plan.adapter.launchAll !== undefined) return launchSupervised(config, plan, record, deps);
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

/**
 * Hands the whole team to the adapter's detached supervisor. team.json is
 * written first with no pids, then again with the supervisor's pid. The
 * supervisor starts no child until the record names it, so its pid writes
 * never race the CLI's writes.
 */
async function launchSupervised(config: RolesConfig, plan: LaunchPlan, record: TeamRecord, deps: CliDeps): Promise<number> {
  const items = config.sessions.map((session) => prepareSession(config, session, plan, deps));
  record.sessions = items.map((item) => ({ name: item.name, pid: null, session_id: null }));
  writeTeam(deps.env, record);
  const outcome = (await plan.adapter.launchAll?.(items, contextFor(plan, deps), teamJsonPath(deps.env))) ?? {
    ok: false as const,
    message: `${plan.adapter.displayName} has no supervisor`,
  };
  if (!outcome.ok) {
    rmSync(teamJsonPath(deps.env), { force: true });
    deps.err(`The supervisor could not start: ${outcome.message}`);
    return EXIT_RUNTIME;
  }
  record.supervisor_pid = outcome.supervisorPid;
  writeTeam(deps.env, record);
  deps.out(
    `Started the supervisor (pid ${outcome.supervisorPid}). It starts ${items.length} sessions on ${plan.adapter.displayName} and records each pid.`,
  );
  deps.out(`Team record: ${teamJsonPath(deps.env)}`);
  return EXIT_OK;
}

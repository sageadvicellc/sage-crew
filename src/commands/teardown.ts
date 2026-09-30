import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { formatCrewError, loadCrewYml } from '../crew/load.ts';
import { pathSafeNameProblem } from '../crew/schema.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { printable } from '../printable.ts';
import { readTeam, teamJsonPath, type TeamRecord } from '../store/team-json.ts';
import { DONE_STATUS, isSettled, loadHandoff, type Handoff, type HandoffLoad, type TimedJob } from '../teardown/handoff.ts';
import { runStop } from './stop.ts';

/** How long teardown waits between two reads of the handoff folder. */
export const POLL_INTERVAL_MS = 5000;

/** The file in the handoff folder that lists every timed job, for the start sequence. */
export const TIMED_JOBS_FILE = 'timed-jobs.yml';

/** The `timed-jobs.yml` format version. */
export const TIMED_JOBS_VERSION = 1;

/** The crew configuration teardown reads when no `--config` is given, in the current folder. */
export const DEFAULT_CONFIG = 'crew.yml';

export interface TeardownOptions {
  config?: string;
  /** Overrides `teardown.timeout`, in whole seconds. */
  timeout?: number;
  dryRun: boolean;
}

/** One timed job with the session it came from. */
export interface CollectedJob extends TimedJob {
  session: string;
}

/** What one session's handoff says, as a printed line and, when it blocks the stop, why. */
interface SessionReport {
  lines: string[];
  warnings: string[];
  blocker: string | undefined;
  /** True when the handoff says that the push failed. */
  pushFailed?: boolean;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

/** The system code of an error in brackets, such as ` (EACCES)`, or nothing. */
function codeText(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}

/** The clock, in milliseconds. */
function clock(deps: CliDeps): number {
  return (deps.now ?? (() => new Date()))().getTime();
}

/** A value as it is echoed in a line, quoted, with control characters escaped. */
function quoted(value: string): string {
  return JSON.stringify(printable(value));
}

/**
 * Checks each part of the handoff folder path below the crew.yml folder
 * with lstat. A symbolic link is refused and never followed, and each part
 * must be a folder. A part that does not exist means the folder does not
 * exist yet, which is not an error: no session has confirmed. Returns why
 * the path is refused, or undefined.
 */
export function handoffFolderProblem(root: string, folder: string): string | undefined {
  let current = root;
  for (const part of folderParts(root, folder)) {
    current = join(current, part);
    const found = partProblem(current);
    if (found === 'missing') return undefined;
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The parts of the handoff folder path below the crew.yml folder. */
function folderParts(root: string, folder: string): string[] {
  return relative(root, folder)
    .split(sep)
    .filter((part) => part !== '' && part !== '.');
}

/** Checks one part with lstat: `missing`, why it is refused, or undefined for a real folder. */
function partProblem(path: string): string | undefined | 'missing' {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return isMissing(error) ? 'missing' : `${path}: cannot check the handoff folder${codeText(error)}`;
  }
  if (stat.isSymbolicLink()) return `${path} is a symbolic link, which is not followed. Use a real folder for the handoff files`;
  if (!stat.isDirectory()) return `${path} is not a folder. The handoff files need a folder there`;
  return undefined;
}

/**
 * Creates each missing part of the handoff folder, one at a time, with
 * mode 0700. The whole path is checked before the first mkdir, and each
 * part is checked with lstat again after it exists, so a link put in the
 * way is refused. Returns why the folder cannot be made, or undefined.
 */
function makeHandoffFolder(root: string, folder: string): string | undefined {
  const problem = handoffFolderProblem(root, folder);
  if (problem !== undefined) return problem;
  let current = root;
  for (const part of folderParts(root, folder)) {
    current = join(current, part);
    if (partProblem(current) === 'missing') {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        // Another writer made it first. The check below decides whether it is safe.
        if (errorCode(error) !== 'EEXIST') return `${current}: cannot create the handoff folder${codeText(error)}`;
      }
    }
    const after = partProblem(current);
    if (after === 'missing') return `${current}: the handoff folder went away while it was made`;
    if (after !== undefined) return after;
  }
  return undefined;
}

interface SessionNames {
  /** The path-safe names, in team order and each once. */
  names: string[];
  skipped: Array<{ name: string; problem: string }>;
  /** Each path-safe name that the team record lists more than once, with its count. */
  duplicates: Array<{ name: string; count: number }>;
}

/**
 * The session names to wait for, in team order and each once. A name that
 * breaks the path-safe name rule is skipped, so no path is ever built from
 * it. A name listed twice is kept once and reported, because one handoff
 * cannot confirm two processes.
 */
function sessionNames(record: TeamRecord): SessionNames {
  const counts = new Map<string, number>();
  for (const entry of record.sessions) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const result: SessionNames = { names: [], skipped: [], duplicates: [] };
  for (const [name, count] of counts) {
    const problem = pathSafeNameProblem(name);
    if (problem !== undefined) {
      result.skipped.push({ name, problem });
      continue;
    }
    result.names.push(name);
    if (count > 1) result.duplicates.push({ name, count });
  }
  return result;
}

function isDone(load: HandoffLoad | undefined): load is { state: 'ok'; handoff: Handoff } {
  return load?.state === 'ok' && load.handoff.status === DONE_STATUS;
}

function isSettledLoad(load: HandoffLoad | undefined): boolean {
  return load?.state === 'ok' && isSettled(load.handoff);
}

type Collected = { ok: true; states: Map<string, HandoffLoad> } | { ok: false; problem: string };

/** Reads every named handoff once, after a check of the folder path. */
function readAll(root: string, folder: string, names: readonly string[], notBefore: number): Collected {
  const problem = handoffFolderProblem(root, folder);
  if (problem !== undefined) return { ok: false, problem };
  const states = new Map<string, HandoffLoad>();
  for (const name of names) states.set(name, loadHandoff(join(folder, `${name}.md`), name, { notBefore }));
  return { ok: true, states };
}

/**
 * Reads `<folder>/<session>.md` for each session that has not settled,
 * then waits one poll interval, until every session settles or the timeout
 * passes. A session settles when its handoff is written at or after
 * `startedAt` and says `status: done` and `writing: false`. A dry run reads
 * once and never waits. The folder path is checked again before each read,
 * so a link put there during the wait is still refused.
 */
async function collect(
  root: string,
  folder: string,
  names: readonly string[],
  startedAt: number,
  timeoutMs: number,
  dryRun: boolean,
  deps: CliDeps,
): Promise<Collected> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deadline = startedAt + timeoutMs;
  const states = new Map<string, HandoffLoad>();
  for (;;) {
    const problem = handoffFolderProblem(root, folder);
    if (problem !== undefined) return { ok: false, problem };
    for (const name of names) {
      if (!isSettledLoad(states.get(name))) states.set(name, loadHandoff(join(folder, `${name}.md`), name, { notBefore: startedAt }));
    }
    if (dryRun || names.every((name) => isSettledLoad(states.get(name)))) return { ok: true, states };
    const left = deadline - clock(deps);
    if (left <= 0) return { ok: true, states };
    await sleep(Math.min(POLL_INTERVAL_MS, left));
  }
}

function pushText(name: string, handoff: Handoff): { text: string; warning?: string } {
  const branch = handoff.branch === null ? undefined : printable(handoff.branch);
  switch (handoff.push) {
    case 'pushed':
      return { text: `Pushed ${branch ?? '(no branch)'} at ${handoff.head ?? '(no head)'}.` };
    case 'nothing-to-push':
      return { text: 'Nothing to push.' };
    case 'failed':
      return {
        text: `The push failed${branch === undefined ? '' : ` on ${branch}`}.`,
        warning: `warning: ${name}: the push failed, so ${branch ?? 'its branch'} can hold commits that are not on the remote.`,
      };
  }
}

/** The report for one session. `waited` names how long a real run waited, and is undefined in a dry run. */
function reportSession(name: string, load: HandoffLoad | undefined, waited: string | undefined): SessionReport {
  const notConfirmed = waited === undefined ? 'not confirmed yet' : `not confirmed by the timeout (${waited})`;
  if (load === undefined || load.state === 'missing') {
    return { lines: [`${name}: ${notConfirmed}. It has no handoff file.`], warnings: [], blocker: 'not confirmed' };
  }
  if (load.state === 'invalid') {
    const lines = load.errors.map((error) => `${name}: the handoff is invalid: ${formatCrewError(error)}`);
    return { lines, warnings: [], blocker: 'handoff invalid' };
  }
  if (load.state === 'stale') {
    const line = `${name}: ${notConfirmed}. Its handoff says it was written at ${printable(load.handoff.written)}, and the file last changed at ${load.changed}. One of them is before this teardown started at ${load.notBefore}, so it is from an earlier run.`;
    return { lines: [line], warnings: [], blocker: 'not confirmed' };
  }
  const { handoff } = load;
  if (handoff.status !== DONE_STATUS) {
    return { lines: [`${name}: ${notConfirmed}. Its handoff says status ${quoted(handoff.status)}.`], warnings: [], blocker: 'not confirmed' };
  }
  const push = pushText(name, handoff);
  const warnings = push.warning === undefined ? [] : [push.warning];
  const pushFailed = handoff.push === 'failed';
  if (handoff.writing) {
    return {
      lines: [`${name}: confirmed, but a write is still in progress (writing: true). ${push.text}`],
      warnings,
      blocker: 'a write is in progress',
      pushFailed,
    };
  }
  return { lines: [`${name}: confirmed. ${push.text}`], warnings, blocker: undefined, pushFailed };
}

/** Every timed job from the confirmed handoffs, in team order and then file order. */
function collectJobs(names: readonly string[], states: Map<string, HandoffLoad>): CollectedJob[] {
  return names.flatMap((name) => {
    const load = states.get(name);
    return isDone(load) ? load.handoff.timed_jobs.map((job) => ({ session: name, schedule: job.schedule, prompt: job.prompt })) : [];
  });
}

function printJobs(jobs: readonly CollectedJob[], deps: CliDeps): void {
  if (jobs.length === 0) {
    deps.out('No timed jobs.');
    return;
  }
  deps.out('Timed jobs to create again at start:');
  for (const job of jobs) deps.out(`  ${job.session}: ${quoted(job.schedule)} ${quoted(job.prompt)}`);
}

/** The text of `timed-jobs.yml`, which a start script reads to create each job again. */
export function timedJobsText(jobs: readonly CollectedJob[]): string {
  return stringify({ version: TIMED_JOBS_VERSION, jobs: jobs.map((job) => ({ session: job.session, schedule: job.schedule, prompt: job.prompt })) });
}

/** Writes `timed-jobs.yml` atomically with mode 0600, creating the folder when no session needed it. */
function writeJobs(root: string, folder: string, jobs: readonly CollectedJob[]): string | undefined {
  const path = join(folder, TIMED_JOBS_FILE);
  const problem = makeHandoffFolder(root, folder);
  if (problem !== undefined) return problem;
  try {
    writeFileAtomic(path, timedJobsText(jobs), 0o600);
    return undefined;
  } catch (error) {
    return `${path}: cannot write the timed jobs file${codeText(error)}`;
  }
}

/** One line that repeats every push warning, so a warning earlier in the run is not missed. */
function pushSummary(failed: readonly string[]): string | undefined {
  if (failed.length === 0) return undefined;
  return `warning: the push failed for ${failed.length} session(s): ${failed.join(', ')}. Their branches can hold commits that are not on the remote.`;
}

function sameTeam(before: TeamRecord, deps: CliDeps): boolean {
  const now = readTeam(deps.env);
  return now.ok && now.record !== undefined && JSON.stringify(now.record) === JSON.stringify(before);
}

/**
 * Waits for every session to confirm a handoff written after this run
 * started, reads every handoff once more, lists the timed jobs, and only
 * then stops the team through the stop command's own code. A session that
 * does not confirm, a stale or invalid handoff, a write in progress, or a
 * name listed twice stops nothing. There is no force: the operator asks
 * again or leaves the session running. A last line repeats every failed
 * push, so a warning earlier in the run is not missed.
 */
export async function runTeardown(options: TeardownOptions, deps: CliDeps): Promise<number> {
  // A handoff written before this moment is from an earlier run.
  const startedAt = clock(deps);
  const configPath = resolve(deps.env.cwd, options.config ?? DEFAULT_CONFIG);
  const loaded = loadCrewYml(configPath);
  if (!loaded.ok) {
    for (const error of loaded.errors) deps.err(formatCrewError(error));
    deps.err('Nothing was stopped.');
    return EXIT_USAGE;
  }
  const teardown = loaded.config.teardown;
  if (teardown === undefined) {
    deps.err(
      `${printable(configPath)}: the teardown block is missing. Add teardown with handoffs, the folder for handoff files, relative to this file. Nothing was stopped.`,
    );
    return EXIT_USAGE;
  }
  const root = dirname(configPath);
  const folder = resolve(root, teardown.handoffs);
  const timeout = options.timeout ?? teardown.timeout;
  const refused = handoffFolderProblem(root, folder);
  if (refused !== undefined) {
    deps.err(`trellis-crew: ${printable(refused)}. Nothing was stopped.`);
    return EXIT_RUNTIME;
  }

  const team = readTeam(deps.env);
  if (!team.ok) {
    deps.err(team.message);
    return EXIT_RUNTIME;
  }
  if (!team.record) {
    deps.out('No team is running.');
    return EXIT_OK;
  }
  const record = team.record;
  const { names, skipped, duplicates } = sessionNames(record);
  for (const { name, problem } of skipped) {
    deps.err(`warning: skipped the session ${quoted(name)}: its name ${problem}, so no handoff path is built from it.`);
  }
  for (const { name, count } of duplicates) {
    deps.err(`warning: the team record lists the session ${quoted(name)} ${count} times, so one handoff cannot confirm each process.`);
  }
  deps.out(
    options.dryRun
      ? `Dry run: one read of ${printable(folder)}. Nothing is written, signalled, or removed.`
      : `Waiting up to ${timeout} s for ${names.length} session(s) to confirm in ${printable(folder)}.`,
  );

  const collected = await collect(root, folder, names, startedAt, timeout * 1000, options.dryRun, deps);
  if (!collected.ok) {
    deps.err(`trellis-crew: ${printable(collected.problem)}. Nothing was stopped.`);
    return EXIT_RUNTIME;
  }
  let states = collected.states;
  const early = [
    ...skipped.map(({ name }) => `${quoted(name)} (skipped: the name is not path-safe)`),
    ...duplicates.map(({ name, count }) => `${name} (listed ${count} times in the team record)`),
  ];
  const changed = new Set<string>();
  if (!options.dryRun && early.length === 0 && names.every((name) => isSettledLoad(states.get(name)))) {
    if (!sameTeam(record, deps)) {
      deps.err(`The team record ${printable(teamJsonPath(deps.env))} changed while teardown waited, so nothing was stopped. Run trellis-crew teardown again.`);
      return EXIT_RUNTIME;
    }
    // A session read once as settled can start a new write after that read.
    // So every handoff is read once more, right before anything is written or stopped.
    const final = readAll(root, folder, names, startedAt);
    if (!final.ok) {
      deps.err(`trellis-crew: ${printable(final.problem)}. Nothing was stopped.`);
      return EXIT_RUNTIME;
    }
    states = final.states;
    for (const name of names) if (!isSettledLoad(states.get(name))) changed.add(name);
  }

  const blockers = [...early];
  const pushFailed: string[] = [];
  for (const name of names) {
    if (changed.has(name)) deps.out(`${name}: changed after it confirmed. The last read before the stop found this:`);
    const report = reportSession(name, states.get(name), options.dryRun ? undefined : `${timeout} s`);
    for (const line of report.lines) deps.out(line);
    for (const warning of report.warnings) deps.err(warning);
    if (report.blocker !== undefined) blockers.push(`${name} (${report.blocker})`);
    if (report.pushFailed) pushFailed.push(name);
  }
  const summary = pushSummary(pushFailed);
  const finish = (code: number): number => {
    if (summary !== undefined) deps.err(summary);
    return code;
  };
  const jobs = collectJobs(names, states);
  printJobs(jobs, deps);
  const jobsPath = join(folder, TIMED_JOBS_FILE);

  if (options.dryRun) {
    if (blockers.length > 0) {
      deps.out(`Dry run: a real run would not stop the team now. Waiting on: ${blockers.join(', ')}.`);
      deps.out(`A real run waits up to ${timeout} s for them, and writes ${printable(jobsPath)} only when every session confirms.`);
    } else {
      deps.out(`Dry run: a real run would stop the team. First it would write ${jobs.length} timed job(s) to ${printable(jobsPath)}.`);
    }
    return finish(EXIT_OK);
  }
  if (blockers.length > 0) {
    deps.err(`Nothing was stopped, and the team record ${printable(teamJsonPath(deps.env))} was kept. Blocked by: ${blockers.join(', ')}.`);
    deps.err('Ask each named session to write its handoff, or leave it running. Then run trellis-crew teardown again.');
    return finish(EXIT_RUNTIME);
  }
  const writeProblem = writeJobs(root, folder, jobs);
  if (writeProblem !== undefined) {
    deps.err(`trellis-crew: ${printable(writeProblem)}. Nothing was stopped.`);
    return finish(EXIT_RUNTIME);
  }
  deps.out(`Wrote ${jobs.length} timed job(s) to ${printable(jobsPath)}.`);
  deps.out('Every session confirmed. Stopping the team.');
  return finish(await runStop({ forceStop: false }, deps));
}

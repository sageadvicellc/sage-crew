import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime, startedOf } from '../runner.ts';
import { readTeamFile, writeTeamFile } from '../store/team-json.ts';

/** What the CLI hands the supervisor: the binary, the folder, the team record, and each session's arguments. */
export interface SupervisorJob {
  binary: string;
  cwd: string;
  teamPath: string;
  sessions: { name: string; args: string[] }[];
  /** Never set. The supervisor reads its own pid, so the job file cannot name the wrong one. */
  supervisorPid?: undefined;
}

export interface SupervisorOptions {
  /** This supervisor's own process id, which the team record must name before any child starts. */
  ownPid: number;
  pollMs?: number;
  /** How long to wait for the team record to name this supervisor. */
  waitMs?: number;
  /** Reports a failed child. Unset: standard error and codex-supervisor.log beside the team record. */
  warn?: (line: string) => void;
}

// Merge note: trellis-crew#24 adds its own `warn` option and `defaultWarn` to
// this file. Keep one copy of each when the two merge, and keep this one's
// no-follow open of codex-supervisor.log.

const LOG_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/**
 * The default report for a failed child. The CLI starts the supervisor with
 * no terminal, so the log file keeps the line. The log is opened with no
 * link followed. A refused or failed write is reported on standard error,
 * and never ends the supervisor.
 */
function defaultWarn(teamPath: string): (line: string) => void {
  const logPath = join(dirname(teamPath), 'codex-supervisor.log');
  return (line) => {
    process.stderr.write(`${line}\n`);
    let fd: number | undefined;
    try {
      fd = openSync(logPath, LOG_FLAGS, 0o600);
      writeSync(fd, `${new Date().toISOString()} ${line}\n`);
    } catch (error) {
      process.stderr.write(`trellis-crew supervisor: could not write ${logPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // A failed close never ends the supervisor.
        }
      }
    }
  };
}

export interface SupervisorHandle {
  /** Ends every child, then the supervisor's work. */
  stop(): void;
  /** Settles when no child runs any more, or when the supervisor gave up waiting. */
  done: Promise<void>;
}

function recordPid(teamPath: string, name: string, pid: number): void {
  const team = readTeamFile(teamPath);
  if (!team.ok || !team.record) return;
  const entry = team.record.sessions.find((s) => s.name === name);
  if (!entry) return;
  entry.pid = pid;
  const started = startedOf(processStartTime(pid));
  if (started !== undefined) entry.started = started;
  writeTeamFile(teamPath, team.record);
}

/** Writes why a child failed onto its team entry, so status prints it. */
function recordError(teamPath: string, name: string, error: string): void {
  const team = readTeamFile(teamPath);
  const entry = team.ok ? team.record?.sessions.find((s) => s.name === name) : undefined;
  if (!team.ok || !team.record || !entry) return;
  entry.error = error;
  writeTeamFile(teamPath, team.record);
}

function namesMe(teamPath: string, ownPid: number): boolean {
  const team = readTeamFile(teamPath);
  return team.ok && team.record?.supervisor_pid === ownPid;
}

/**
 * The detached Codex supervisor. It waits until team.json names it, so the
 * CLI's own write lands first. Then it starts each `codex exec` child and
 * writes the child's pid into team.json. On stop it ends every child.
 *
 * Gap: how to keep a finished `codex exec` alive is not documented. A
 * child that exits stays exited, and the supervisor ends when none runs.
 * TODO: restart a child once the vendor documents how.
 */
export function runSupervisor(job: SupervisorJob, options: SupervisorOptions): SupervisorHandle {
  const pollMs = options.pollMs ?? 200;
  const waitMs = options.waitMs ?? 10_000;
  const children = new Map<string, ChildProcess>();
  let stopping = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const settleWhenEmpty = (): void => {
    if (children.size === 0) finish();
  };

  const warn = options.warn ?? defaultWarn(job.teamPath);
  const fail = (name: string, error: string): void => {
    warn(`trellis-crew supervisor: ${name}: ${error}`);
    recordError(job.teamPath, name, error);
  };
  const startAll = (): void => {
    for (const session of job.sessions) {
      if (stopping) break;
      // Merge note: trellis-crew#24 checks `session.args` again here with codex-args.ts `execArgsProblem`.
      // These args hold one `-c developer_instructions=...`. That check must allow exactly that one `-c`,
      // compared against the value rebuilt fresh from the shipped skill for the session's role, and never
      // `-c` in general. The full rule and the smuggle tests it needs are at codex.ts `codexExecArgs`.
      const child = spawn(job.binary, session.args, { cwd: job.cwd, stdio: 'ignore', env: process.env });
      let failed = false;
      child.once('error', (error) => {
        failed = true;
        if (!stopping) fail(session.name, `could not start: ${error.message}`);
        children.delete(session.name);
        settleWhenEmpty();
      });
      child.once('exit', (code, signal) => {
        // A child that stop ended, or one already reported, is not recorded again.
        if (!stopping && !failed && code !== 0) fail(session.name, code === null ? `ended by signal ${signal ?? 'unknown'}` : `exited with code ${code}`);
        children.delete(session.name);
        settleWhenEmpty();
      });
      // Tracked even with no pid, so the supervisor waits for a failed spawn's 'error' event before it ends.
      children.set(session.name, child);
      if (child.pid !== undefined) recordPid(job.teamPath, session.name, child.pid);
    }
    settleWhenEmpty();
  };

  const started = Date.now();
  const wait = (): void => {
    if (stopping) return finish();
    if (namesMe(job.teamPath, options.ownPid)) return startAll();
    if (Date.now() - started > waitMs) return finish();
    setTimeout(wait, pollMs);
  };
  wait();

  return {
    stop() {
      stopping = true;
      for (const child of children.values()) child.kill('SIGTERM');
      settleWhenEmpty();
    },
    done,
  };
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const jobPath = process.argv[2];
  if (jobPath === undefined) process.exit(2);
  const job = JSON.parse(readFileSync(jobPath, 'utf8')) as SupervisorJob;
  const handle = runSupervisor(job, { ownPid: process.pid });
  process.on('SIGTERM', () => handle.stop());
  process.on('SIGINT', () => handle.stop());
  await handle.done;
  process.exit(0);
}

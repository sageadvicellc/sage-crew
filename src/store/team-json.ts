import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, type Env } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { isHarnessId, TRANSPORTS, type HarnessId, type Transport } from '../roles/schema.ts';
import type { ReadResult } from './install-yml.ts';

/** One session the CLI started. */
export interface TeamEntry {
  name: string;
  /** The local process id, or null when the session holds no local process. */
  pid: number | null;
  /** The harness's own session or thread id, or null when none was read. */
  session_id: string | null;
  /** The process's start time when the CLI recorded the pid, so a reused pid is never signalled. */
  started?: string;
}

/** Where the team's layout came from, so respawn can read it again. */
export interface TeamSource {
  /** The roles file's absolute path, or null for the default team. */
  file: string | null;
  workers?: number;
  merge_reporters?: boolean;
}

/** The team the CLI started, read by status, stop, and respawn. */
export interface TeamRecord {
  version: 1;
  harness: HarnessId;
  transport?: Transport;
  roles?: TeamSource;
  /** The file mailbox folder, for the file-mailbox transport. */
  mailbox?: string;
  /** The detached supervisor's process id, on harnesses that need one. */
  supervisor_pid?: number;
  /** The supervisor's start time when the CLI recorded its pid. */
  supervisor_started?: string;
  sessions: TeamEntry[];
}

export function teamJsonPath(env: Env): string {
  return join(stateDir(env), 'team.json');
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSource(value: unknown): value is TeamSource {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Record<string, unknown>;
  return (
    (source.file === null || typeof source.file === 'string') &&
    (source.workers === undefined || isPid(source.workers)) &&
    (source.merge_reporters === undefined || typeof source.merge_reporters === 'boolean')
  );
}

function isEntry(value: unknown): value is TeamEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    (entry.pid === null || isPid(entry.pid)) &&
    (entry.session_id === null || typeof entry.session_id === 'string') &&
    (entry.started === undefined || typeof entry.started === 'string')
  );
}

/** Reads team.json. A missing file is no team. A damaged file is an error, never a guess. */
export function readTeam(env: Env): ReadResult<TeamRecord> {
  return readTeamFile(teamJsonPath(env));
}

/** Reads a team record from a path. */
export function readTeamFile(path: string): ReadResult<TeamRecord> {
  if (!existsSync(path)) return { ok: true, record: undefined };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, message: `${path}: cannot read or parse the team record` };
  }
  const record = data as Partial<TeamRecord> | null;
  if (
    typeof record !== 'object' ||
    record === null ||
    Array.isArray(record) ||
    record.version !== 1 ||
    typeof record.harness !== 'string' ||
    !isHarnessId(record.harness) ||
    !Array.isArray(record.sessions) ||
    !record.sessions.every(isEntry) ||
    (record.supervisor_pid !== undefined && !isPid(record.supervisor_pid)) ||
    (record.supervisor_started !== undefined && typeof record.supervisor_started !== 'string') ||
    (record.transport !== undefined && (record.transport === ('auto' as string) || !(TRANSPORTS as readonly string[]).includes(record.transport))) ||
    (record.roles !== undefined && !isSource(record.roles)) ||
    (record.mailbox !== undefined && typeof record.mailbox !== 'string')
  ) {
    return { ok: false, message: `${path}: the team record is damaged` };
  }
  const out: TeamRecord = {
    version: 1,
    harness: record.harness,
    sessions: record.sessions.map((s) => ({
      name: s.name,
      pid: s.pid,
      session_id: s.session_id,
      ...(s.started === undefined ? {} : { started: s.started }),
    })),
  };
  if (record.supervisor_started !== undefined) out.supervisor_started = record.supervisor_started;
  if (record.transport !== undefined) out.transport = record.transport;
  if (record.roles !== undefined) out.roles = record.roles;
  if (record.mailbox !== undefined) out.mailbox = record.mailbox;
  if (record.supervisor_pid !== undefined) out.supervisor_pid = record.supervisor_pid;
  return { ok: true, record: out };
}

/** Writes team.json atomically, creating the state folder when needed. */
export function writeTeam(env: Env, record: TeamRecord): void {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  writeTeamFile(teamJsonPath(env), record);
}

/** Writes a team record to a path atomically. */
export function writeTeamFile(path: string, record: TeamRecord): void {
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

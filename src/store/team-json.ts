import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, type Env } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { isHarnessId, type HarnessId } from '../roles/schema.ts';
import type { ReadResult } from './install-yml.ts';

/** One session the CLI started. */
export interface TeamEntry {
  name: string;
  /** The local process id, or null when the session holds no local process. */
  pid: number | null;
  /** The harness's own session or thread id, or null when none was read. */
  session_id: string | null;
}

/** The team the CLI started, read by status, stop, and respawn. */
export interface TeamRecord {
  version: 1;
  harness: HarnessId;
  /** The detached supervisor's process id, on harnesses that need one. */
  supervisor_pid?: number;
  sessions: TeamEntry[];
}

export function teamJsonPath(env: Env): string {
  return join(stateDir(env), 'team.json');
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isEntry(value: unknown): value is TeamEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    (entry.pid === null || isPid(entry.pid)) &&
    (entry.session_id === null || typeof entry.session_id === 'string')
  );
}

/** Reads team.json. A missing file is no team. A damaged file is an error, never a guess. */
export function readTeam(env: Env): ReadResult<TeamRecord> {
  const path = teamJsonPath(env);
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
    (record.supervisor_pid !== undefined && !isPid(record.supervisor_pid))
  ) {
    return { ok: false, message: `${path}: the team record is damaged` };
  }
  const out: TeamRecord = {
    version: 1,
    harness: record.harness,
    sessions: record.sessions.map((s) => ({ name: s.name, pid: s.pid, session_id: s.session_id })),
  };
  if (record.supervisor_pid !== undefined) out.supervisor_pid = record.supervisor_pid;
  return { ok: true, record: out };
}

/** Writes team.json atomically, creating the state folder when needed. */
export function writeTeam(env: Env, record: TeamRecord): void {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  writeFileAtomic(teamJsonPath(env), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

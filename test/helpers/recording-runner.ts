import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { ProcessStart, RunOptions, RunResult, Runner } from '../../src/runner.ts';

/** True for a recorded call to git, which the working-folder check makes. */
export function isGitCall(call: RecordedCall): boolean {
  return basename(call.command) === 'git';
}

export interface RecordedCall {
  kind: 'run' | 'detached' | 'kill';
  command: string;
  args: readonly string[];
}

export type Responder = (command: string, args: readonly string[]) => RunResult | Promise<RunResult>;

/** A Runner that records every call and spawns nothing. */
export interface RecordingRunner extends Runner {
  calls: RecordedCall[];
  /** Process ids that alive() reports as running. */
  living: Set<number>;
  /** The start time startTime() reports for each living pid. */
  starts: Map<number, string>;
  /** Pids whose start time cannot be read, with the reason startTime() reports. */
  unknown: Map<number, string>;
}

const ok: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false };

/**
 * Answers `git rev-parse` with the real git in the call's folder, so the
 * working-folder check reads a real temp repository. Git is not a harness,
 * so this runs no agent session. Every other git call is refused.
 */
function realGit(args: readonly string[], options: RunOptions | undefined): RunResult {
  if (args[0] !== 'rev-parse') return { code: 1, stdout: '', stderr: 'fixture: only git rev-parse is answered\n', timedOut: false };
  try {
    const stdout = execFileSync('git', [...args], { cwd: options?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '', timedOut: false };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    return { code: 1, stdout: '', stderr, timedOut: false };
  }
}

export function recordingRunner(responder: Responder = () => ok): RecordingRunner {
  const calls: RecordedCall[] = [];
  const living = new Set<number>();
  const starts = new Map<number, string>();
  const unknown = new Map<number, string>();
  let nextPid = 40000;
  return {
    calls,
    living,
    starts,
    unknown,
    async run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
      calls.push({ kind: 'run', command, args });
      if (basename(command) === 'git') return realGit(args, options);
      return responder(command, args);
    },
    async spawnDetached(command: string, args: readonly string[]): Promise<{ pid: number }> {
      calls.push({ kind: 'detached', command, args });
      nextPid += 1;
      living.add(nextPid);
      starts.set(nextPid, `fixture-start-${nextPid}`);
      return { pid: nextPid };
    },
    kill(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
      calls.push({ kind: 'kill', command: String(pid), args: [signal] });
      return living.delete(pid);
    },
    alive(pid: number): boolean {
      return living.has(pid);
    },
    startTime(pid: number): ProcessStart {
      const reason = unknown.get(pid);
      if (reason !== undefined) return { status: 'unknown', reason };
      const started = living.has(pid) ? starts.get(pid) : undefined;
      return started === undefined ? { status: 'absent' } : { status: 'running', started };
    },
  };
}

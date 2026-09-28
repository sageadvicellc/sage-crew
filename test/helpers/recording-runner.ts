import type { RunOptions, RunResult, Runner } from '../../src/runner.ts';

export interface RecordedCall {
  kind: 'run' | 'detached' | 'kill';
  command: string;
  args: readonly string[];
}

export type Responder = (command: string, args: readonly string[]) => RunResult | Promise<RunResult>;

/** A Runner that records every call and spawns nothing. */
export interface RecordingRunner extends Runner {
  calls: RecordedCall[];
}

const ok: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false };

export function recordingRunner(responder: Responder = () => ok): RecordingRunner {
  const calls: RecordedCall[] = [];
  let nextPid = 40000;
  return {
    calls,
    async run(command: string, args: readonly string[], _options?: RunOptions): Promise<RunResult> {
      calls.push({ kind: 'run', command, args });
      return responder(command, args);
    },
    async spawnDetached(command: string, args: readonly string[]): Promise<{ pid: number }> {
      calls.push({ kind: 'detached', command, args });
      nextPid += 1;
      return { pid: nextPid };
    },
    kill(pid: number): boolean {
      calls.push({ kind: 'kill', command: String(pid), args: [] });
      return true;
    },
  };
}

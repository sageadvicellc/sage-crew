import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  /** The child's whole environment. PATH lookup uses this PATH. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Kills the child after this many milliseconds. */
  timeoutMs?: number;
  /** Written to the child's standard input, which is then closed. */
  input?: string;
}

export interface RunResult {
  /** The exit code, or null when the process never ran or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not start. */
  error?: string;
}

/** Starts processes. Every module takes a Runner, so tests record calls instead. */
export interface Runner {
  /** Runs a command to completion. Never throws. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Starts a command that outlives the CLI and returns its process id. */
  spawnDetached(command: string, args: readonly string[], options?: RunOptions): Promise<{ pid: number }>;
  /** Sends a signal to a process. Returns false when the process is gone. */
  kill(pid: number, signal?: NodeJS.Signals): boolean;
}

function childEnv(env: RunOptions['env']): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}

export function createRunner(): Runner {
  return {
    run(command, args, options = {}) {
      return new Promise<RunResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (result: RunResult): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(result);
        };
        let child;
        try {
          child = spawn(command, [...args], {
            cwd: options.cwd,
            env: childEnv(options.env),
            stdio: ['pipe', 'pipe', 'pipe'],
            // Its own process group, so a timeout also ends any grandchild.
            detached: true,
          });
        } catch (error) {
          finish({ code: null, stdout, stderr, timedOut, error: String(error) });
          return;
        }
        const started = child;
        if (options.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            timedOut = true;
            killGroup(started.pid);
            started.stdout.destroy();
            started.stderr.destroy();
            finish({ code: null, stdout, stderr, timedOut });
          }, options.timeoutMs);
        }
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', (error) => {
          finish({ code: null, stdout, stderr, timedOut, error: error.message });
        });
        child.on('close', (code) => {
          finish({ code: timedOut ? null : code, stdout, stderr, timedOut });
        });
        child.stdin.on('error', () => {
          // The child may exit before reading its input. That is not a failure here.
        });
        child.stdin.end(options.input ?? '');
      });
    },

    spawnDetached(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: childEnv(options.env),
          detached: true,
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          if (child.pid === undefined) reject(new Error(`${command} started with no process id`));
          else resolve({ pid: child.pid });
        });
      });
    },

    kill(pid, signal = 'SIGTERM') {
      try {
        return process.kill(pid, signal);
      } catch {
        return false;
      }
    },
  };
}

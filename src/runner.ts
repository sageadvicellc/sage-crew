import { spawn, spawnSync } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  /** The child's whole environment. PATH lookup uses this PATH. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Kills the child after this many milliseconds. */
  timeoutMs?: number;
  /** Written to the child's standard input, which is then closed. */
  input?: string;
  /** Also returns standard output as raw bytes, for output that is not UTF-8 text. */
  bytes?: boolean;
  /** With `bytes`, stops reading after this many bytes and ends the command. */
  maxBytes?: number;
}

export interface RunResult {
  /** The exit code, or null when the process never ran or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not start. */
  error?: string;
  /** Standard output as raw bytes. Set only when RunOptions.bytes is true. */
  bytes?: Buffer;
  /** True when the output reached RunOptions.maxBytes, so the command was ended and `bytes` holds only its start. */
  truncated?: boolean;
}

/** Starts processes. Every module takes a Runner, so tests record calls instead. */
export interface Runner {
  /** Runs a command to completion. Never throws. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Starts a command that outlives the CLI and returns its process id. */
  spawnDetached(command: string, args: readonly string[], options?: RunOptions): Promise<{ pid: number }>;
  /** Sends a signal to a process. Returns false when the process is gone. */
  kill(pid: number, signal?: NodeJS.Signals): boolean;
  /** True when a process with this id exists. */
  alive(pid: number): boolean;
  /** The process's start time, whether no such process runs, or why neither could be read. */
  startTime(pid: number): ProcessStart;
}

/**
 * A process's start time as `ps` reports it. `absent` means `ps` exited 1
 * with no output, which is how it reports no such process, and signal 0
 * confirms that no such pid exists. `unknown` is every other failure: the
 * caller must not treat it as absent.
 */
export type ProcessStart =
  | { status: 'running'; started: string }
  | { status: 'absent' }
  | { status: 'unknown'; reason: string };

export interface ProcessStartOptions {
  /** The ps binary. macOS and Linux both carry it at /bin/ps. */
  ps?: string;
  timeoutMs?: number;
}

/**
 * Reads a process's start time with `ps -o lstart=`. The CLI records it
 * next to each pid, so it never signals a process that later took over a
 * reused pid.
 */
export function processStartTime(pid: number, options: ProcessStartOptions = {}): ProcessStart {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'unknown', reason: `${pid} is not a process id` };
  const result = spawnSync(options.ps ?? '/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { LC_ALL: 'C', PATH: '/bin:/usr/bin' },
    timeout: options.timeoutMs ?? 5000,
  });
  if (result.error) {
    const code = 'code' in result.error ? String(result.error.code) : '';
    const reason = code === 'ETIMEDOUT' ? 'ps did not finish in time' : `ps could not run: ${result.error.message}`;
    return { status: 'unknown', reason };
  }
  const text = (result.stdout ?? '').trim();
  if (result.status === 0 && text !== '') return { status: 'running', started: text };
  if (result.status === 1 && text === '') {
    // A ps that rejects -p, as busybox ps does, also exits 1 with no
    // output. So a pid that still exists is unknown, not absent.
    if (processExists(pid)) return { status: 'unknown', reason: `ps reported no such process, but pid ${pid} exists` };
    return { status: 'absent' };
  }
  const exit = result.status === null ? `signal ${String(result.signal)}` : `exit code ${result.status}`;
  return { status: 'unknown', reason: `ps failed: ${exit}${text === '' ? ', no output' : ', unexpected output'}` };
}

/** True when a process with this id exists, checked with signal 0. EPERM means it exists but belongs to another user. */
export function processExists(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** The recorded start time, or undefined, from a ProcessStart. */
export function startedOf(start: ProcessStart): string | undefined {
  return start.status === 'running' ? start.started : undefined;
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
        const chunks: Buffer[] = [];
        let size = 0;
        let timedOut = false;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (result: RunResult): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (!options.bytes) {
            resolve(result);
            return;
          }
          const all = Buffer.concat(chunks);
          const bytes = options.maxBytes !== undefined && all.length > options.maxBytes ? all.subarray(0, options.maxBytes) : all;
          resolve({ ...result, stdout: bytes.toString('utf8'), bytes });
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
        child.stderr.setEncoding('utf8');
        if (options.bytes) {
          child.stdout.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            size += chunk.length;
            if (options.maxBytes !== undefined && size >= options.maxBytes) {
              killGroup(started.pid);
              started.stdout.destroy();
              started.stderr.destroy();
              finish({ code: null, stdout, stderr, timedOut, truncated: true });
            }
          });
        } else {
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
          });
        }
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

    alive: processExists,

    startTime: processStartTime,
  };
}

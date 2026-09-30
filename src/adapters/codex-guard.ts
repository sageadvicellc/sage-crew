import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { findBinary } from '../detect/probe.ts';
import { stateDir, type Env } from '../env.ts';
import { printable } from '../printable.ts';
import type { Runner } from '../runner.ts';

/**
 * The guards for a Codex CLI session. workspace-write lets a session write
 * its working folder and its writable roots. So the working folder must be
 * the top of a git worktree, the one writable root must be a mailbox inside
 * the state folder, and each session gets a short list of environment
 * variables.
 */

const WORKDIR_RULE = 'Codex CLI sessions can write their working folder, so trellis-crew starts them only at the top of a git worktree.';
const GIT_TIMEOUT_MS = 10_000;

type GitTop = { ok: true; top: string } | { ok: false; reason: string };

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Judges a working folder from git's answer. Both sides are compared after realpath. */
function workdirProblem(folder: string, home: string, git: () => GitTop): string | undefined {
  const why = (reason: string) => `${WORKDIR_RULE} ${printable(folder)}: ${reason}.`;
  const realFolder = real(folder);
  if (realFolder === undefined) return why('the folder cannot be read');
  if (realFolder === sep) return why('it is the root folder');
  if (realFolder === (real(home) ?? resolve(home))) return why('it is your home folder');
  const top = git();
  if (!top.ok) return why(`it is not in a git worktree (${top.reason})`);
  if (real(top.top) !== realFolder) return why(`it is not the top of a git worktree. The top is ${printable(top.top)}`);
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Checks the Env's current folder through the injected runner: `git
 * rev-parse --show-toplevel`, run in that folder, must name that same
 * folder. Git is looked up on the Env's PATH, as every binary is. Returns
 * the reason the folder is refused, or undefined.
 */
export async function checkWorkdir(env: Env, runner: Runner): Promise<string | undefined> {
  const git = findBinary('git', env.path);
  let answer: GitTop = { ok: false, reason: 'git is not on PATH' };
  if (git !== undefined) {
    const result = await runner.run(git, ['rev-parse', '--show-toplevel'], { cwd: env.cwd, env: env.vars, timeoutMs: GIT_TIMEOUT_MS });
    answer =
      result.code === 0 && !result.timedOut
        ? { ok: true, top: firstLine(result.stdout) }
        : { ok: false, reason: result.timedOut ? 'git did not answer in time' : firstLine(result.stderr) || `git exited with code ${String(result.code)}` };
  }
  return workdirProblem(env.cwd, env.home, () => answer);
}

/** The same check for the supervisor, which has no runner. It runs git with an argument list and no shell. */
export function checkWorkdirSync(folder: string, home: string): string | undefined {
  return workdirProblem(folder, home, () => {
    try {
      const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: folder,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
      });
      return { ok: true, top: firstLine(out) };
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      return { ok: false, reason: firstLine(stderr) || (error instanceof Error ? error.message : String(error)) };
    }
  });
}

/** The realpath of a path whose last parts may not exist yet: the realpath of its nearest existing parent, with the rest joined on. */
function realOfExisting(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    const found = real(current);
    if (found !== undefined) return join(found, ...rest.reverse());
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    rest.push(basename(current));
    current = parent;
  }
}

function within(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * Returns why a mailbox folder is refused on Codex CLI, or undefined. The
 * mailbox is every session's writable root, so it must sit inside the
 * state folder, after realpath of its existing parent. It must not be the
 * state folder itself, and it must not hold the working folder.
 */
export function codexMailboxProblem(mailbox: string, env: Pick<Env, 'home' | 'cwd'>): string | undefined {
  const state = stateDir(env);
  const why = (reason: string) =>
    `The file mailbox on Codex CLI must be a folder inside ${printable(state)}, because every session can write it. ${printable(mailbox)}: ${reason}.`;
  const box = realOfExisting(mailbox);
  const realState = realOfExisting(state);
  const cwd = realOfExisting(env.cwd);
  if (box === sep) return why('it is the root folder');
  if (box === realOfExisting(env.home)) return why('it is your home folder');
  if (box === realState) return why('it is the state folder itself');
  if (within(realState, box)) return why('it holds the state folder');
  if (box === cwd || within(cwd, box)) return why('it holds the working folder');
  if (!within(box, realState)) return why('it is outside the state folder');
  return undefined;
}

/** The environment variables a Codex child gets. No other variable, and no other CODEX_ variable, passes. */
export const CODEX_CHILD_ENV: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'OPENAI_API_KEY', 'CODEX_HOME',
];

/** Keeps only the listed variables that are set. */
export function codexChildEnv(vars: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CODEX_CHILD_ENV) {
    const value = vars[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
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

/** The git calls the check makes, in the working folder. */
const GIT_TOP = ['rev-parse', '--show-toplevel'];
const GIT_HOOKS = ['config', '--get', 'core.hooksPath'];

/** One git answer: the exit code, or null when git could not run, with its output. */
interface GitAnswer {
  code: number | null;
  stdout: string;
  /** The first line of standard error, or why git could not run. */
  reason: string;
}

type Git = (args: readonly string[]) => GitAnswer;

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Judges a working folder. It must be the top of a git worktree, compared
 * after realpath, and not `/` or the home folder. It must hold no other
 * repository at depth 1 to 3, and its git hooks folder must not sit inside
 * it. The folder's own `.git` is allowed: Codex keeps it read-only.
 */
function workdirProblem(folder: string, home: string, git: Git): string | undefined {
  const why = (reason: string) => `${WORKDIR_RULE} ${printable(folder)}: ${reason}.`;
  const realFolder = real(folder);
  if (realFolder === undefined) return why('the folder cannot be read');
  if (realFolder === sep) return why('it is the root folder');
  if (realFolder === (real(home) ?? resolve(home))) return why('it is your home folder');
  const top = git(GIT_TOP);
  if (top.code !== 0) return why(`it is not in a git worktree (${top.reason || `git exited with code ${String(top.code)}`})`);
  const topPath = firstLine(top.stdout);
  if (real(topPath) !== realFolder) return why(`it is not the top of a git worktree. The top is ${printable(topPath)}`);
  const nested = nestedRepoProblem(realFolder) ?? hooksPathProblem(realFolder, home, git(GIT_HOOKS));
  return nested === undefined ? undefined : why(nested);
}

/**
 * Refuses a git hooks folder inside the working folder, since a session
 * could write a hook there that git later runs. The value resolves as git
 * resolves it: an absolute path as it is, a leading `~/` against the home
 * folder, and any other path against the worktree top. Then the realpath
 * of its deepest existing parent is taken. Exit code 1 means the value is
 * unset, which passes. Any other failure refuses, so the check fails
 * closed. A `~user` form cannot be resolved here, so it refuses too.
 */
function hooksPathProblem(top: string, home: string, answer: GitAnswer): string | undefined {
  if (answer.code === 1) return undefined;
  if (answer.code !== 0) {
    return `git config --get core.hooksPath failed, so the hooks folder cannot be checked (${answer.reason || `exit code ${String(answer.code)}`})`;
  }
  const value = answer.stdout.replace(/\n$/, '');
  let path: string;
  if (value === '~' || value.startsWith('~/')) path = join(home, value.slice(1));
  else if (value.startsWith('~')) return `core.hooksPath is ${printable(value)}, which names another user's home folder, so it cannot be checked`;
  else path = isAbsolute(value) ? value : resolve(top, value);
  const resolved = realOfExisting(path);
  if (resolved !== top && !within(resolved, top)) return undefined;
  return `core.hooksPath is ${printable(value)}, which resolves to ${printable(resolved)}, inside the working folder, so a session could write a git hook`;
}

/** How deep below the working folder the scan for other repositories looks. */
const NESTED_DEPTH = 3;

/**
 * Looks for another git repository below a worktree top, breadth first,
 * at depth 1 to NESTED_DEPTH. A folder that holds a `.git` entry of any
 * kind, a folder or a gitfile, counts. The top's own `.git` is not
 * entered. A symbolic link is never followed. A folder that cannot be
 * read is refused, so the scan fails closed. Returns the reason, which
 * names the first path found relative to the top, or undefined.
 */
function nestedRepoProblem(top: string): string | undefined {
  let level = [''];
  for (let depth = 0; depth <= NESTED_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(join(top, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
        return `a folder below it cannot be read, so it cannot be checked for other git repositories: ${printable(rel || '.')} (${code})`;
      }
      if (depth > 0 && entries.some((entry) => entry.name === '.git')) return `it holds another git repository at ${printable(rel)}`;
      if (depth === NESTED_DEPTH) continue;
      for (const entry of entries) {
        // A Dirent from readdir describes the entry itself, so a link is never a directory here.
        if (!entry.isDirectory() || (depth === 0 && entry.name === '.git')) continue;
        next.push(rel === '' ? entry.name : join(rel, entry.name));
      }
    }
    level = next;
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Checks the Env's current folder through the injected runner. Git is
 * looked up on the Env's PATH, as every binary is. Both git calls run
 * first, in that folder, and then the one judge reads their answers.
 * Returns the reason the folder is refused, or undefined.
 */
export async function checkWorkdir(env: Env, runner: Runner): Promise<string | undefined> {
  const binary = findBinary('git', env.path);
  const answers = new Map<string, GitAnswer>();
  for (const args of [GIT_TOP, GIT_HOOKS]) {
    let answer: GitAnswer = { code: null, stdout: '', reason: 'git is not on PATH' };
    if (binary !== undefined) {
      const result = await runner.run(binary, args, { cwd: env.cwd, env: env.vars, timeoutMs: GIT_TIMEOUT_MS });
      answer = result.timedOut
        ? { code: null, stdout: '', reason: 'git did not answer in time' }
        : { code: result.code, stdout: result.stdout, reason: result.error ?? firstLine(result.stderr) };
    }
    answers.set(args.join(' '), answer);
  }
  return workdirProblem(env.cwd, env.home, (args) => answers.get(args.join(' ')) as GitAnswer);
}

/** The same check for the supervisor, which has no runner. It runs git with an argument list and no shell. */
export function checkWorkdirSync(folder: string, home: string): string | undefined {
  return workdirProblem(folder, home, (args) => {
    try {
      const stdout = execFileSync('git', [...args], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS });
      return { code: 0, stdout, reason: '' };
    } catch (error) {
      const failed = error as { status?: unknown; stderr?: unknown };
      const reason = firstLine(String(failed.stderr ?? '')) || (error instanceof Error ? error.message : String(error));
      return { code: typeof failed.status === 'number' ? failed.status : null, stdout: '', reason };
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

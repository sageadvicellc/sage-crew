import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { expandHome, type Env } from '../env.ts';
import { parentFolderProblem, privateFolderProblem } from '../fs-private.ts';
import type { RolesConfig } from '../roles/schema.ts';

/**
 * The file mailbox folder when the roles file names none. This build
 * carries the file mailbox only, with no MCP mailbox server (plan
 * decision 16). Each session reads and writes its own file in the folder.
 */
export const DEFAULT_MAILBOX = '~/.trellis-crew/mailbox';

/** The mailbox folder for a team: `~` expands to the Env home, and a relative path resolves against the current folder. */
export function mailboxPath(config: Pick<RolesConfig, 'mailbox'>, env: Env): string {
  const expanded = expandHome(config.mailbox ?? DEFAULT_MAILBOX, env);
  return isAbsolute(expanded) ? expanded : resolve(env.cwd, expanded);
}

export type MailboxResult = { ok: true; path: string; created: boolean } | { ok: false; path: string; message: string };

/**
 * Creates the mailbox folder, readable by the operator only. An existing
 * folder is kept only when it is private: a real folder, owned by this
 * user, with no group or other permission bits. The roles file can name
 * any folder, such as one in a shared /tmp, so this is checked. Each
 * parent folder must belong to root or to this user, and must not be
 * writable by other users unless it is sticky.
 */
export function ensureMailboxFolder(
  path: string,
  options: { mkdir?: (path: string) => void; uid?: number } = {},
): MailboxResult {
  const mkdir = options.mkdir ?? ((target: string) => mkdirSync(target, { recursive: true, mode: 0o700 }));
  const uid = options.uid ?? process.getuid?.();
  const check = (): string | undefined => parentFolderProblem(path, uid) ?? privateFolderProblem(path, uid);
  const parents = parentFolderProblem(path, uid);
  if (parents !== undefined) return { ok: false, path, message: `${parents}. The mailbox folder must be private to you` };
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      const problem = check();
      return problem === undefined
        ? { ok: true, path, created: false }
        : { ok: false, path, message: `${problem}. The mailbox folder must be private to you` };
    }
    return { ok: false, path, message: `${path}: a file is in the way of the mailbox folder` };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      return { ok: false, path, message: `${path}: cannot check the mailbox folder` };
    }
  }
  try {
    mkdir(path);
  } catch {
    return { ok: false, path, message: `${path}: cannot create the mailbox folder` };
  }
  // Another writer can put a folder or a symlink there between the check
  // and mkdir, which then succeeds on it. So the new folder and each
  // parent that mkdir created are checked too.
  const problem = check();
  return problem === undefined
    ? { ok: true, path, created: true }
    : { ok: false, path, message: `${problem}. The mailbox folder must be private to you` };
}

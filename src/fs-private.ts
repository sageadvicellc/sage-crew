import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** A folder the CLI writes to is not private to the operator. */
export class UnsafeFolderError extends Error {}

/**
 * Checks that an existing folder is private to the operator: a real
 * folder, not a symlink, owned by this user, and with no group or other
 * permission bits. Returns why it is not, or undefined when it is.
 * `uid` is this user's id. On a platform with no user ids, the owner
 * check is skipped.
 */
export function privateFolderProblem(path: string, uid: number | undefined = process.getuid?.()): string | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return `${path}: cannot check the folder`;
  }
  if (stat.isSymbolicLink()) return `${path} is a symlink. Use a real folder`;
  if (!stat.isDirectory()) return `${path} is not a folder`;
  if (uid !== undefined && stat.uid !== uid) return `${path} belongs to another user`;
  if ((stat.mode & 0o077) !== 0) {
    return `${path} is open to other users (mode ${(stat.mode & 0o777).toString(8)}). Run chmod 700 on it`;
  }
  return undefined;
}

/**
 * Checks every parent folder of a path, from the nearest one that exists
 * up to the root, after resolving symlinks. Each one must belong to root
 * or to this user. It must not be writable by other users, unless the
 * sticky bit is set, as on /tmp. Another user who can write a parent can
 * rename the folder away and put their own in its place. Returns why a
 * parent fails, or undefined when all pass.
 */
export function parentFolderProblem(path: string, uid: number | undefined = process.getuid?.()): string | undefined {
  let nearest = dirname(resolve(path));
  while (!existsSync(nearest) && dirname(nearest) !== nearest) nearest = dirname(nearest);
  let current: string;
  try {
    current = realpathSync(nearest);
  } catch {
    return `${nearest}: cannot check the folder`;
  }
  for (;;) {
    let stat;
    try {
      stat = statSync(current);
    } catch {
      return `${current}: cannot check the folder`;
    }
    if (uid !== undefined && stat.uid !== 0 && stat.uid !== uid) return `${current}, a parent of ${path}, belongs to another user`;
    if ((stat.mode & 0o002) !== 0 && (stat.mode & 0o1000) === 0) {
      return `${current}, a parent of ${path}, can be written by other users. Remove that permission or use another folder`;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Creates a folder private to the operator, or checks an existing one. Throws UnsafeFolderError when it is not private. */
export function ensurePrivateFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const problem = privateFolderProblem(path);
  if (problem !== undefined) throw new UnsafeFolderError(problem);
}

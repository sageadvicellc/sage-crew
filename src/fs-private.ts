import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

/** Most symlinks followed in one path, as the kernel's own loop limit. */
const MAX_LINKS = 40;

/**
 * Walks each part of a folder path with lstat, following each symlink the
 * way the kernel would. Returns why a symlink on the way is unsafe, or
 * undefined. The walk stops at the first part that does not exist.
 */
function symlinkProblem(folder: string, path: string, uid: number | undefined, lstat: (path: string) => Stats): string | undefined {
  let pending = folder.split('/').filter((part) => part !== '');
  let current = '/';
  let links = 0;
  while (pending.length > 0) {
    const next = join(current, pending.shift() as string);
    let stat: Stats;
    try {
      stat = lstat(next);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      return `${next}: cannot check the folder`;
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (uid !== undefined && stat.uid !== 0 && stat.uid !== uid) {
      return `${next}, in the path of ${path}, is a symlink owned by another user. Use a folder path with no such symlink`;
    }
    links += 1;
    if (links > MAX_LINKS) return `${next}: too many symlinks in the path of ${path}`;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return `${next}: cannot read the symlink`;
    }
    pending = [...resolve(current, target).split('/').filter((part) => part !== ''), ...pending];
    current = '/';
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
 *
 * realpath hides the symlinks on the way, so each part of the path is
 * first walked with lstat. A symlink that neither root nor this user owns
 * is refused, because its owner can point it somewhere else at any time.
 */
export function parentFolderProblem(
  path: string,
  uid: number | undefined = process.getuid?.(),
  fs: { lstat?: (path: string) => Stats } = {},
): string | undefined {
  const linkProblem = symlinkProblem(dirname(resolve(path)), path, uid, fs.lstat ?? lstatSync);
  if (linkProblem !== undefined) return linkProblem;
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

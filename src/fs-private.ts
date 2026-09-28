import { lstatSync, mkdirSync } from 'node:fs';

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

/** Creates a folder private to the operator, or checks an existing one. Throws UnsafeFolderError when it is not private. */
export function ensurePrivateFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const problem = privateFolderProblem(path);
  if (problem !== undefined) throw new UnsafeFolderError(problem);
}

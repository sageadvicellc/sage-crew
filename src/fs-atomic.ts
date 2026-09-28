import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Writes a file atomically: a temp file in the same folder, flushed to
 * disk, given `mode`, then renamed over the target. A reader sees the old
 * file or the new one, never half of either.
 */
export function writeFileAtomic(path: string, text: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', mode);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}

import { constants, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { claudeDir, type Env } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { roundTripLoss } from './json-lossless.ts';

/** The value the team needs, so a busy peer queues a message instead of asking a person. */
export const INBOUND_ACCEPT = 'accept';

/** A settings file and the key path that holds its inbound setting. */
export interface InboundTarget {
  settingsPath: string;
  keyPath: readonly string[];
}

/** The Claude Code user settings file: `settings.json` in the configuration folder. */
export function claudeInboundTarget(env: Env): InboundTarget {
  return { settingsPath: join(claudeDir(env), 'settings.json'), keyPath: ['crossSessionInbound'] };
}

/** The Qwen Code user settings file, `~/.qwen/settings.json`, key `agents.crossSessionInbound`. */
export function qwenInboundTarget(env: Env): InboundTarget {
  return { settingsPath: join(env.home, '.qwen', 'settings.json'), keyPath: ['agents', 'crossSessionInbound'] };
}

export interface InboundOptions {
  /** The clock. The backup's date is this day in UTC. */
  now: Date;
  out: (line: string) => void;
  /** The atomic writer. Tests pass a spy here. */
  writeFile?: (path: string, text: string, mode: number) => void;
}

export type InboundResult =
  | { ok: true; changed: boolean; settingsPath: string; backupPath?: string }
  | { ok: false; code: 1; message: string };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The dated backup path beside the settings file, such as `settings.json.2026-03-04.bak`. */
export function backupPathFor(settingsPath: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return join(dirname(settingsPath), `${basename(settingsPath)}.${day}.bak`);
}

function stop(settingsPath: string, reason: string): InboundResult {
  return { ok: false, code: 1, message: `${settingsPath}: ${reason}. Nothing was changed.` };
}

/**
 * Reads the file again and compares it with the text read first. Returns
 * undefined when it is unchanged, or the reason to stop: a change, or the
 * read error with its code.
 */
function changeSince(path: string, text: string): string | undefined {
  let now: string;
  try {
    now = readFileSync(path, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown error';
    return `cannot read the settings file again before the write (${code})`;
  }
  return now === text ? undefined : 'the settings file changed while install ran. Run install again';
}

function indentOf(text: string): string {
  return /^\{\s*\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
}

/**
 * Sets the inbound setting to `accept`. It copies the settings file to a
 * dated backup beside it first, keeps an existing backup from the same
 * day, changes only that one key, and writes atomically with the file's
 * own mode. An unreadable or invalid file stops it before any write.
 */
export function setInboundAccept(target: InboundTarget, options: InboundOptions): InboundResult {
  const { settingsPath, keyPath } = target;
  const write = options.writeFile ?? writeFileAtomic;
  if (!existsSync(dirname(settingsPath))) {
    return stop(settingsPath, 'the configuration folder does not exist');
  }

  let exists = true;
  try {
    lstatSync(settingsPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists = false;
    else return stop(settingsPath, 'cannot read the settings file');
  }

  let text = '{}\n';
  let settings: JsonObject = {};
  let mode = 0o600;
  let writePath = settingsPath;
  if (exists) {
    try {
      writePath = realpathSync(settingsPath);
      text = readFileSync(writePath, 'utf8');
      mode = statSync(writePath).mode & 0o7777;
    } catch {
      return stop(settingsPath, 'cannot read the settings file');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return stop(settingsPath, 'the settings file is not valid JSON');
    }
    if (!isObject(parsed)) return stop(settingsPath, 'the settings file is not a JSON object');
    // The file is rewritten in full, so a value the round trip would change stops it.
    const loss = roundTripLoss(text);
    if (loss !== undefined) return stop(settingsPath, `${loss}. Set ${keyPath.join('.')} by hand`);
    settings = parsed;
  }

  const parents = keyPath.slice(0, -1);
  const leaf = keyPath[keyPath.length - 1];
  if (leaf === undefined) return stop(settingsPath, 'no setting was named');
  let holder: JsonObject = settings;
  for (const key of parents) {
    const next = holder[key];
    if (next === undefined) {
      holder[key] = {};
      holder = holder[key] as JsonObject;
    } else if (isObject(next)) {
      holder = next;
    } else {
      return stop(settingsPath, `"${key}" in the settings file is not an object`);
    }
  }
  const setting = keyPath.join('.');
  if (holder[leaf] === INBOUND_ACCEPT) {
    options.out(`Settings file: ${settingsPath}`);
    options.out(`${setting} is already ${INBOUND_ACCEPT}. Nothing was changed.`);
    return { ok: true, changed: false, settingsPath };
  }

  let backupPath: string | undefined;
  if (exists) {
    backupPath = backupPathFor(settingsPath, options.now);
    if (existsSync(backupPath)) {
      options.out(`A backup from today already exists, so it was kept: ${backupPath}`);
    } else {
      try {
        copyFileSync(writePath, backupPath, constants.COPYFILE_EXCL);
      } catch {
        return stop(settingsPath, `cannot write the backup ${backupPath}`);
      }
    }
  }

  holder[leaf] = INBOUND_ACCEPT;
  // Another writer may have changed the file since it was read. Its change
  // wins: this run stops rather than overwrite it.
  const change = exists ? changeSince(writePath, text) : undefined;
  if (change !== undefined) return stop(settingsPath, change);
  try {
    write(writePath, `${JSON.stringify(settings, null, indentOf(text))}\n`, mode);
  } catch {
    return {
      ok: false,
      code: 1,
      message: `${settingsPath}: cannot write the settings file. The file is unchanged${backupPath ? `, and the backup is ${backupPath}` : ''}.`,
    };
  }
  options.out(`Settings file: ${settingsPath}`);
  options.out(backupPath ? `Backup: ${backupPath}` : 'No backup: no settings file existed before, so a new one was created.');
  options.out(`Set ${setting} to ${INBOUND_ACCEPT}.`);
  return backupPath ? { ok: true, changed: true, settingsPath, backupPath } : { ok: true, changed: true, settingsPath };
}

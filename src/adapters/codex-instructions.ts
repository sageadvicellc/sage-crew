import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCapped } from '../crew/load.ts';
import type { Role } from '../roles/schema.ts';

/** The skill folders this package carries, one per skill. */
export function packageSkillsDir(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

/** The default team's skill for each role. Its body is the session's role instructions. */
export const ROLE_SKILLS: Readonly<Record<Role, string>> = {
  lead: 'department-lead',
  standby: 'department-standby',
  auditor: 'department-auditor',
  'reporting-chain': 'department-reporting-chain',
};

/** The largest skill file read as role instructions: 64 KiB. */
export const ROLE_TEXT_MAX_BYTES = 64 * 1024;

/** The largest `developer_instructions=<TOML string>` argument, after escaping: 32 KiB. */
export const ROLE_ARG_MAX_BYTES = 32 * 1024;

/** A role skill could not be read. The message names the step, the role, and the file. */
export class RoleInstructionsError extends Error {}

/** The TOML short escapes for control characters. Every other control character uses `\uXXXX`. */
const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Writes a value as a TOML 1.0 basic string. It escapes `\`, `"`, and every
 * control character from U+0000 to U+001F and U+007F, so the result is one
 * line. All other characters pass through. A lone surrogate has no UTF-8
 * form, so it is refused with a RoleInstructionsError.
 */
export function tomlString(value: string): string {
  const parts: string[] = ['"'];
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(i + 1))) {
      parts.push(value.slice(i, i + 2));
      i += 1;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      throw new RoleInstructionsError(`a lone surrogate at index ${i} cannot be written as a TOML string`);
    } else if (code === 0x22) {
      parts.push('\\"');
    } else if (code === 0x5c) {
      parts.push('\\\\');
    } else if (code <= 0x1f || code === 0x7f) {
      parts.push(SHORT_ESCAPES[code] ?? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`);
    } else {
      parts.push(value.charAt(i));
    }
  }
  parts.push('"');
  return parts.join('');
}

/** A reason for a failed open or stat, with the system code kept in brackets. */
function readProblem(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  switch (code) {
    case 'ENOENT':
      return 'the file does not exist';
    case 'EACCES':
    case 'EPERM':
      return 'the file cannot be read: permission denied';
    case 'ELOOP':
      return 'the path is a symbolic link, which is not followed';
    default:
      return `the file cannot be read${code === undefined ? '' : ` (${code})`}`;
  }
}

/** A front matter delimiter: `---`, with trailing spaces or tabs allowed. */
const DELIMITER = /^---[ \t]*\r?\n?$/;

/**
 * The skill text after its YAML front matter, with a leading UTF-8 byte
 * order mark and leading blank lines cut. A file whose line 1 does not
 * start with `---` has no front matter and is used whole. Returns why when
 * the front matter cannot be cut off cleanly, so none of it is ever sent.
 */
function skillBody(raw: string): { body: string } | { reason: string } {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  const lines = text.split(/(?<=\n)/);
  const first = lines[0] ?? '';
  if (!first.startsWith('---')) return { body: text };
  if (!DELIMITER.test(first)) return { reason: 'line 1 starts with --- but is not a front matter delimiter' };
  for (let i = 1; i < lines.length; i += 1) {
    if (DELIMITER.test(lines[i] as string)) return { body: lines.slice(i + 1).join('').replace(/^(?:\r?\n)+/, '') };
  }
  return { reason: 'the front matter never closes' };
}

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A role skill that was read: its path, its size in bytes, and its body. */
interface RoleSkill {
  path: string;
  bytes: number;
  body: string;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // A failed close never replaces the read's own result.
  }
}

function loadRoleSkill(role: Role, skillsDir: string): RoleSkill {
  const folder = join(skillsDir, ROLE_SKILLS[role]);
  const path = join(folder, 'SKILL.md');
  const fail = (reason: string): RoleInstructionsError => new RoleInstructionsError(`role instructions for ${role}: ${path}: ${reason}`);
  let realFolder: string;
  let isLink: boolean;
  try {
    const root = realpathSync(skillsDir);
    realFolder = realpathSync(folder);
    if (!realFolder.startsWith(root + sep)) throw fail('the skill folder resolves outside the skills folder');
    isLink = lstatSync(folder).isSymbolicLink();
  } catch (error) {
    if (error instanceof RoleInstructionsError) throw error;
    throw fail(readProblem(error));
  }
  if (isLink) throw fail('the skill folder is a symbolic link, which is not followed');

  let text: string;
  let bytes: number;
  let fd: number | undefined;
  try {
    fd = openSync(join(realFolder, 'SKILL.md'), OPEN_FLAGS);
    const info = fstatSync(fd);
    if (!info.isFile()) throw fail('the path is not a regular file');
    const tooLarge = `the file is larger than ${ROLE_TEXT_MAX_BYTES} bytes (${ROLE_TEXT_MAX_BYTES / 1024} KiB)`;
    if (info.size > ROLE_TEXT_MAX_BYTES) throw fail(tooLarge);
    const read = readCapped(fd, ROLE_TEXT_MAX_BYTES);
    if (read.tooLarge) throw fail(tooLarge);
    text = read.text;
    bytes = info.size;
  } catch (error) {
    if (error instanceof RoleInstructionsError) throw error;
    throw fail(readProblem(error));
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }

  const parsed = skillBody(text);
  if ('reason' in parsed) throw fail(parsed.reason);
  if (parsed.body.trim() === '') throw fail('the skill has no text after the front matter');
  return { path, bytes, body: parsed.body };
}

/**
 * Reads the default team's skill for a role, from the package's skills
 * folder at run time, and returns its body. The skill folder must resolve
 * inside the skills folder and must not be a symbolic link, the file is
 * opened with no link followed, and at most 64 KiB is read. It writes
 * nothing. Throws RoleInstructionsError, which names the step, when the
 * file is missing, too large, or has no clean body.
 */
export function readRoleInstructions(role: Role, skillsDir: string = packageSkillsDir()): string {
  return loadRoleSkill(role, skillsDir).body;
}

/**
 * The Codex arguments that give a session its role's instructions:
 * `-c developer_instructions=<TOML string>`. Codex adds
 * `developer_instructions` to its own built-in instructions, and parses a
 * `-c` value as TOML, so the text goes through tomlString. The escaped
 * argument is capped at 32 KiB, because escaping can make it up to six
 * times the size of the file.
 */
export function roleInstructionsArgs(role: Role, skillsDir: string = packageSkillsDir()): string[] {
  const skill = loadRoleSkill(role, skillsDir);
  const fail = (reason: string): RoleInstructionsError => new RoleInstructionsError(`role instructions for ${role}: ${skill.path}: ${reason}`);
  let value: string;
  try {
    value = tomlString(skill.body);
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error));
  }
  const arg = `developer_instructions=${value}`;
  const size = Buffer.byteLength(arg);
  if (size > ROLE_ARG_MAX_BYTES) {
    throw fail(
      `the escaped value is ${size} bytes, over the ${ROLE_ARG_MAX_BYTES}-byte (${ROLE_ARG_MAX_BYTES / 1024} KiB) limit, from a file of ${skill.bytes} bytes`,
    );
  }
  return ['-c', arg];
}

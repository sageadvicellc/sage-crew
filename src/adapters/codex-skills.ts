import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../fs-atomic.ts';
import type { PluginCheck, PluginOutcome } from './types.ts';

/**
 * The export of the approved skills for Codex CLI. Codex reads user skills
 * from `~/.agents/skills/`. The approved skills are the `skills` list in
 * the package's plugin manifest. Each exported folder holds a marker file
 * with the tree hash of the folder. A folder is this package's own only
 * when its marker names this package and the skill, and the folder still
 * hashes to the marker's value. No step follows a symbolic link.
 */

/** The marker file in each exported skill folder. */
export const SKILL_MARKER = '.trellis-crew-skill.json';
/** The name prefix of the temp folders an export makes beside the skills. */
export const TEMP_PREFIX = '.trellis-crew-';
const OWNER = 'trellis-crew';
const MARKER_MAX_BYTES = 4096;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** The mode bits a copy keeps and the hash covers: no group or other write, no special bits. */
const MODE_MASK = 0o755;

/** The folder Codex CLI reads user skills from. */
export function agentsSkillsDir(home: string): string {
  return join(home, '.agents', 'skills');
}

/** The package root, which holds `.claude-plugin/plugin.json` and `skills/`. */
export function packageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? describeError(error);
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface ApprovedSkill {
  name: string;
  /** The skill folder in the package. */
  source: string;
}

export type ApprovedResult = { ok: true; skills: ApprovedSkill[] } | { ok: false; message: string };

/** The skill name in one manifest entry, such as `./skills/department-lead/`, or undefined. */
function skillNameOf(entry: unknown): string | undefined {
  if (typeof entry !== 'string') return undefined;
  const name = /^(?:\.\/)?skills\/([^/]+)\/?$/.exec(entry)?.[1];
  return name !== undefined && SKILL_NAME.test(name) ? name : undefined;
}

/** Reads the approved skills from the plugin manifest under `root`. Names are deduped case-blind. */
export function approvedSkills(root: string): ApprovedResult {
  const manifestPath = join(root, '.claude-plugin', 'plugin.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, message: `the plugin manifest ${manifestPath} could not be read (${describeError(error)})` };
  }
  const list = (manifest as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(list)) return { ok: false, message: `the plugin manifest ${manifestPath} has no skills list` };
  if (list.length === 0) return { ok: false, message: `the plugin manifest ${manifestPath} has an empty skills list` };
  const skills: ApprovedSkill[] = [];
  for (const entry of list) {
    const name = skillNameOf(entry);
    if (name === undefined) {
      return { ok: false, message: `the plugin manifest lists ${JSON.stringify(entry)}, which is not a skill folder under skills/` };
    }
    if (skills.some((s) => same(s.name, name))) continue;
    const source = join(root, 'skills', name);
    let stat: Stats | undefined;
    try {
      stat = lstatOrUndefined(source);
    } catch (error) {
      return { ok: false, message: `the approved skill ${name} could not be read (${describeError(error)})` };
    }
    if (stat?.isDirectory() !== true) return { ok: false, message: `the approved skill ${name} has no folder at ${source}` };
    skills.push({ name, source });
  }
  return { ok: true, skills };
}

interface Entry {
  rel: string;
  abs: string;
  stat: Stats;
}

/** Each entry under `dir`, sorted by relative path, with the top marker file left out. Refuses a link or a special file. */
function walk(dir: string): Entry[] {
  const found: Entry[] = [];
  const visit = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (childRel === SKILL_MARKER) continue;
      const childAbs = join(abs, name);
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) throw new Error(`the skill tree holds a symbolic link, which is refused: ${childAbs}`);
      if (stat.isDirectory()) {
        found.push({ rel: childRel, abs: childAbs, stat });
        visit(childAbs, childRel);
      } else if (stat.isFile()) {
        found.push({ rel: childRel, abs: childAbs, stat });
      } else {
        throw new Error(`the skill tree holds a special file, which is refused: ${childAbs}`);
      }
    }
  };
  visit(dir, '');
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * SHA-256 over a skill folder: each relative path in sorted order, its
 * type, its mode & 0o755, and each file's length and bytes. The marker
 * file is left out, so a copy hashes the same as its source.
 */
export function treeHash(dir: string): string {
  const hash = createHash('sha256');
  for (const entry of walk(dir)) {
    const mode = (entry.stat.mode & MODE_MASK).toString(8);
    if (entry.stat.isDirectory()) {
      hash.update(`dir\0${mode}\0${entry.rel}\0`);
      continue;
    }
    const bytes = readFileSync(entry.abs);
    hash.update(`file\0${mode}\0${entry.rel}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

type Marker = { kind: 'none' } | { kind: 'foreign' } | { kind: 'unreadable'; reason: string } | { kind: 'ours'; sha256: string };

/** Reads at most MARKER_MAX_BYTES + 1 bytes, and never through a link. */
function readSmall(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MARKER_MAX_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Reads the marker in `dir`. A missing file or bad JSON is no marker; a link, a folder, or a large file is foreign. */
function readMarker(dir: string, skill: string): Marker {
  const path = join(dir, SKILL_MARKER);
  let text: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) return { kind: 'foreign' };
    text = readSmall(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { kind: 'none' };
    if (code === 'ELOOP') return { kind: 'foreign' };
    return { kind: 'unreadable', reason: `marker unreadable (${code})` };
  }
  if (Buffer.byteLength(text) > MARKER_MAX_BYTES) return { kind: 'foreign' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: 'none' };
  }
  if (typeof data !== 'object' || data === null) return { kind: 'foreign' };
  const { owner, skill: named, sha256 } = data as Record<string, unknown>;
  if (owner !== OWNER || typeof named !== 'string' || !same(named, skill)) return { kind: 'foreign' };
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return { kind: 'foreign' };
  return { kind: 'ours', sha256 };
}

/** What is at a skill path. */
type Found =
  | { kind: 'absent' }
  | { kind: 'link' }
  | { kind: 'not-owned' }
  | { kind: 'edited' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'owned'; sha256: string }
  | { kind: 'unmarked-copy' };

/**
 * Looks at `path` for `skill`. `sourceHash` is the package's hash for that
 * skill: an unmarked folder that matches it exactly is a copy this package
 * made before markers existed.
 */
function classify(path: string, skill: string, sourceHash: string | undefined): Found {
  let stat: Stats | undefined;
  try {
    stat = lstatOrUndefined(path);
  } catch (error) {
    return { kind: 'unreadable', reason: `unreadable (${errorCode(error)})` };
  }
  if (stat === undefined) return { kind: 'absent' };
  if (stat.isSymbolicLink()) return { kind: 'link' };
  if (!stat.isDirectory()) return { kind: 'not-owned' };
  const marker = readMarker(path, skill);
  if (marker.kind === 'foreign') return { kind: 'not-owned' };
  if (marker.kind === 'unreadable') return marker;
  if (marker.kind === 'none') {
    if (sourceHash === undefined) return { kind: 'not-owned' };
    try {
      return treeHash(path) === sourceHash ? { kind: 'unmarked-copy' } : { kind: 'not-owned' };
    } catch {
      return { kind: 'not-owned' };
    }
  }
  let hash: string;
  try {
    hash = treeHash(path);
  } catch (error) {
    return { kind: 'unreadable', reason: describeError(error) };
  }
  return hash === marker.sha256 ? { kind: 'owned', sha256: hash } : { kind: 'edited' };
}

/** The label for a folder the export must leave alone, the same in install and in the check. */
function blockLabel(found: Found): string | undefined {
  switch (found.kind) {
    case 'link':
      return 'a symbolic link';
    case 'not-owned':
      return 'a folder trellis-crew does not own';
    case 'edited':
      return 'a trellis-crew copy edited since export';
    case 'unreadable':
      return `unreadable: ${found.reason}`;
    default:
      return undefined;
  }
}

/** Why a folder on the path to the skills is refused, or undefined when it is a real folder or absent. */
function refusedFolder(path: string): string | undefined {
  const stat = lstatOrUndefined(path);
  if (stat === undefined || stat.isDirectory()) return undefined;
  return stat.isSymbolicLink() ? `${path} is a symbolic link, which is not followed` : `${path} is not a folder`;
}

/** The package's hash for a skill folder that is not approved, or undefined. */
function packageHash(root: string, name: string): string | undefined {
  try {
    const source = join(root, 'skills', name);
    return lstatOrUndefined(source)?.isDirectory() === true ? treeHash(source) : undefined;
  } catch {
    return undefined;
  }
}

interface Other {
  name: string;
  path: string;
  found: Found;
  sourceHash: string | undefined;
}

/**
 * Each folder in `skillsDir` that is not approved and that this package
 * owns, or once owned. Dot-prefixed names, links, and files are never read.
 */
function otherFolders(skillsDir: string, approved: readonly ApprovedSkill[], root: string): Other[] {
  if (lstatOrUndefined(skillsDir) === undefined) return [];
  const others: Other[] = [];
  const entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (approved.some((s) => same(s.name, entry.name))) continue;
    const path = join(skillsDir, entry.name);
    const sourceHash = packageHash(root, entry.name);
    const found = classify(path, entry.name, sourceHash);
    if (found.kind === 'absent' || found.kind === 'link' || found.kind === 'not-owned') continue;
    others.push({ name: entry.name, path, found, sourceHash });
  }
  return others;
}

/** Real folders in `skillsDir` with the temp prefix, left by an export that did not finish. */
function leftoverFolders(skillsDir: string): string[] {
  if (lstatOrUndefined(skillsDir) === undefined) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_PREFIX))
    .map((entry) => join(skillsDir, entry.name))
    .sort();
}

/** The file operations the export uses to move and remove folders. Tests pass a stand-in. */
export interface ExportFs {
  rename(from: string, to: string): void;
  remove(path: string): void;
}

const REAL_FS: ExportFs = {
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

/** An error for a cleanup that failed after `first`: it keeps `first` as the cause and names the path. */
function withCleanup(first: unknown, path: string, cleanup: unknown): Error {
  return new Error(`${describeError(first)}. The temp folder ${path} could not be removed (${describeError(cleanup)})`, {
    cause: first,
  });
}

/** Copies a tree of plain folders and files. Folders are 0o700 while it copies; the source modes are applied last, deepest first. */
function copyTree(source: string, dest: string): void {
  const entries = walk(source);
  for (const entry of entries) {
    const to = join(dest, ...entry.rel.split('/'));
    if (entry.stat.isDirectory()) mkdirSync(to, { mode: 0o700 });
    else copyFileSync(entry.abs, to, constants.COPYFILE_EXCL);
  }
  const deepestFirst = [...entries].sort((a, b) => b.rel.split('/').length - a.rel.split('/').length);
  for (const entry of deepestFirst) chmodSync(join(dest, ...entry.rel.split('/')), entry.stat.mode & MODE_MASK);
}

function markerText(skill: string, sha256: string): string {
  return `${JSON.stringify({ owner: OWNER, skill, sha256 }, null, 2)}\n`;
}

/** Copies one skill into a fresh temp folder in `skillsDir`, writes its marker, and returns the temp path. */
function stage(skillsDir: string, skill: ApprovedSkill, sourceHash: string, fsx: ExportFs): string {
  const temp = mkdtempSync(join(skillsDir, `${TEMP_PREFIX}${skill.name}-`));
  try {
    copyTree(skill.source, temp);
    if (treeHash(temp) !== sourceHash) throw new Error(`the copy of ${skill.name} does not match its source`);
    writeFileSync(join(temp, SKILL_MARKER), markerText(skill.name, sourceHash), { flag: 'wx', mode: 0o644 });
    chmodSync(temp, lstatSync(skill.source).mode & MODE_MASK);
    return temp;
  } catch (error) {
    try {
      fsx.remove(temp);
    } catch (cleanup) {
      throw withCleanup(error, temp, cleanup);
    }
    throw error;
  }
}

/** Puts the old copy back after `reason`, then throws. A failed rollback names both errors and where the old copy is. */
function restore(old: string, dest: string, fsx: ExportFs, reason: unknown): never {
  try {
    fsx.rename(old, dest);
  } catch (rollback) {
    throw new Error(
      `${describeError(reason)}. Putting the old copy back at ${dest} also failed (${describeError(rollback)}), so the old copy is at ${old}`,
      { cause: reason },
    );
  }
  throw reason;
}

/**
 * Puts the staged folder `temp` at `dest`. For `copy`, nothing may be at
 * `dest`. For `replace`, `dest` must be an owned copy: it is renamed to
 * `<temp>-old`, checked again there, and removed once the new copy is in
 * place. Exported for tests.
 */
export function swapIn(temp: string, dest: string, skill: string, kind: 'copy' | 'replace', fsx: ExportFs, out: (line: string) => void): void {
  const changed = new Error(`${dest} changed during the export, so it was left alone`);
  const now = classify(dest, skill, undefined);
  if (kind === 'copy') {
    if (now.kind !== 'absent') throw changed;
    fsx.rename(temp, dest);
    return;
  }
  if (now.kind !== 'owned') throw changed;
  const old = `${temp}-old`;
  fsx.rename(dest, old);
  if (classify(old, skill, undefined).kind !== 'owned') {
    restore(old, dest, fsx, new Error(`${dest} changed during the export, so it was put back and nothing was removed`));
  }
  try {
    fsx.rename(temp, dest);
  } catch (error) {
    restore(old, dest, fsx, error);
  }
  try {
    fsx.remove(old);
  } catch (error) {
    out(`warning: the new copy of ${skill} is installed, but the old copy at ${old} could not be removed (${describeError(error)}). Remove it by hand.`);
  }
}

export interface ExportOptions {
  /** The package root. Tests pass a stand-in package. */
  root?: string;
  /** The file operations for moves and removals. Tests pass a stand-in. */
  fs?: ExportFs;
}

interface Action {
  skill: ApprovedSkill;
  sourceHash: string;
  kind: 'copy' | 'replace' | 'adopt';
}

/**
 * Exports the approved skills into `~/.agents/skills` under `home`. It
 * first looks at every target. When any target is not this package's own,
 * or was edited since the export, it changes nothing and names each one.
 * Otherwise it removes its own leftover temp folders, copies each approved
 * skill, replaces each owned copy, adopts each exact unmarked copy, and
 * removes each owned folder whose skill is no longer approved. Nothing
 * else in the folder is touched.
 */
export function exportSkills(home: string, out: (line: string) => void, options: ExportOptions = {}): PluginOutcome {
  const root = options.root ?? packageRoot();
  const fsx = options.fs ?? REAL_FS;
  const skillsDir = agentsSkillsDir(home);
  const fail = (reason: string): PluginOutcome => ({ ok: false, message: `the skill export stopped: ${reason}` });

  let actions: Action[];
  let stale: Other[];
  try {
    const approved = approvedSkills(root);
    if (!approved.ok) return fail(approved.message);
    const hashes = new Map(approved.skills.map((skill) => [skill.name, treeHash(skill.source)]));
    for (const folder of [dirname(skillsDir), skillsDir]) {
      const refused = refusedFolder(folder);
      if (refused !== undefined) return fail(`${refused}, so nothing was changed`);
    }
    const blocked: string[] = [];
    actions = [];
    for (const skill of approved.skills) {
      const sourceHash = hashes.get(skill.name) as string;
      const dest = join(skillsDir, skill.name);
      const found = classify(dest, skill.name, sourceHash);
      const label = blockLabel(found);
      if (label !== undefined) blocked.push(`${skill.name} (${label}) at ${dest}`);
      else actions.push({ skill, sourceHash, kind: found.kind === 'absent' ? 'copy' : found.kind === 'unmarked-copy' ? 'adopt' : 'replace' });
    }
    const others = otherFolders(skillsDir, approved.skills, root);
    for (const other of others) {
      const label = blockLabel(other.found);
      if (label !== undefined) blocked.push(`${other.name} (${label}) at ${other.path}`);
    }
    if (blocked.length > 0) {
      return fail(`${blocked.join('; ')}. It was left alone, so nothing was changed. Move or rename it, then run the command again.`);
    }
    stale = others;
  } catch (error) {
    return fail(describeError(error));
  }

  const done: string[] = [];
  try {
    for (const folder of [dirname(skillsDir), skillsDir]) {
      if (lstatOrUndefined(folder) === undefined) mkdirSync(folder);
    }
    for (const leftover of leftoverFolders(skillsDir)) {
      fsx.remove(leftover);
      out(`Removed the leftover temp folder ${leftover}.`);
    }
    for (const action of actions) {
      const { skill, sourceHash } = action;
      const dest = join(skillsDir, skill.name);
      if (action.kind === 'adopt') {
        if (classify(dest, skill.name, sourceHash).kind !== 'unmarked-copy') throw new Error(`${dest} changed during the export, so it was left alone`);
        writeFileAtomic(join(dest, SKILL_MARKER), markerText(skill.name, sourceHash), 0o644);
        out(`Adopted the unmarked copy of ${skill.name} at ${dest}.`);
      } else {
        const temp = stage(skillsDir, skill, sourceHash, fsx);
        try {
          swapIn(temp, dest, skill.name, action.kind, fsx, out);
        } catch (error) {
          try {
            fsx.remove(temp);
          } catch (cleanup) {
            throw withCleanup(error, temp, cleanup);
          }
          throw error;
        }
      }
      done.push(skill.name);
    }

    const refused = refusedFolder(skillsDir);
    if (refused !== undefined) throw new Error(`${refused}, so no stale skill was removed`);
    const expected = join(realpathSync(home), '.agents', 'skills');
    if (realpathSync(skillsDir) !== expected) throw new Error(`${skillsDir} no longer resolves to ${expected}, so no stale skill was removed`);
    for (const other of stale) {
      const again = classify(other.path, other.name, other.sourceHash).kind;
      if (again !== 'owned' && again !== 'unmarked-copy') throw new Error(`${other.path} changed during the export, so it was left alone`);
      fsx.remove(other.path);
      out(`Removed the stale skill ${other.name}, which this package no longer ships.`);
    }
  } catch (error) {
    const already = done.length > 0 ? ` Already copied: ${done.join(', ')}.` : '';
    return fail(`${describeError(error)}.${already} Run trellis-crew update again to finish.`);
  }
  out(`Copied the approved trellis-crew skills into ${skillsDir}.`);
  return { ok: true };
}

export type SkillState = 'in-step' | 'drifted' | 'missing' | 'not-owned' | 'edited' | 'unreadable' | 'unmarked' | 'stale';

export interface SkillStatus {
  skill: string;
  state: SkillState;
  path: string;
  /** For not-owned, what is there; for unreadable, the error. */
  detail?: string;
}

export type SkillCheck = { ok: true; skills: SkillStatus[]; leftovers: string[] } | { ok: false; message: string };

function statusOf(skill: string, path: string, found: Found, sourceHash: string): SkillStatus {
  switch (found.kind) {
    case 'absent':
      return { skill, state: 'missing', path };
    case 'link':
    case 'not-owned':
      return { skill, state: 'not-owned', path, detail: blockLabel(found) as string };
    case 'edited':
      return { skill, state: 'edited', path };
    case 'unreadable':
      return { skill, state: 'unreadable', path, detail: found.reason };
    case 'unmarked-copy':
      return { skill, state: 'unmarked', path };
    case 'owned':
      return { skill, state: found.sha256 === sourceHash ? 'in-step' : 'drifted', path };
  }
}

/**
 * Compares each approved skill with its copy under `home`, finds each
 * owned folder that is no longer approved, and lists leftover temp
 * folders. It changes nothing.
 */
export function checkSkills(home: string, root = packageRoot()): SkillCheck {
  try {
    const skillsDir = agentsSkillsDir(home);
    const approved = approvedSkills(root);
    if (!approved.ok) return approved;
    for (const folder of [dirname(skillsDir), skillsDir]) {
      const refused = refusedFolder(folder);
      if (refused !== undefined) return { ok: false, message: refused };
    }
    const skills = approved.skills.map(({ name, source }) => {
      const sourceHash = treeHash(source);
      const path = join(skillsDir, name);
      return statusOf(name, path, classify(path, name, sourceHash), sourceHash);
    });
    for (const other of otherFolders(skillsDir, approved.skills, root)) {
      const { found } = other;
      if (found.kind === 'edited' || found.kind === 'unreadable') skills.push(statusOf(other.name, other.path, found, ''));
      else skills.push({ skill: other.name, state: 'stale', path: other.path });
    }
    return { ok: true, skills, leftovers: leftoverFolders(skillsDir) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

const STATE_WORDS: Record<SkillState, string> = {
  'in-step': 'in step',
  drifted: 'drifted',
  missing: 'missing',
  'not-owned': 'not owned',
  edited: 'edited since export',
  unreadable: 'unreadable',
  unmarked: 'unmarked copy',
  stale: 'stale',
};

function stateLine(s: SkillStatus): string {
  const head = `Skill ${s.skill}: ${STATE_WORDS[s.state]}.`;
  switch (s.state) {
    case 'in-step':
      return head;
    case 'drifted':
      return `${head} The copy at ${s.path} differs from the package source.`;
    case 'missing':
      return `${head} Nothing is at ${s.path}.`;
    case 'not-owned':
      return `${head} ${s.path} is ${s.detail ?? 'a folder trellis-crew does not own'}, so it is left alone.`;
    case 'edited':
      return `${head} The copy at ${s.path} changed after the export, so it is left alone.`;
    case 'unreadable':
      return `${head} ${s.path} could not be read (${s.detail ?? 'no detail'}).`;
    case 'unmarked':
      return `${head} ${s.path} matches the package, so install or update adopts it.`;
    case 'stale':
      return `${head} ${s.path} is a trellis-crew copy of a skill this package no longer ships.`;
  }
}

/** The states that make `update --check` exit 1. */
const FAILING: ReadonlySet<SkillState> = new Set(['drifted', 'missing', 'not-owned', 'edited', 'unreadable', 'stale']);

/** The skill lines for `update --check`. */
export function skillCheckReport(home: string, root = packageRoot()): PluginCheck {
  const check = checkSkills(home, root);
  if (!check.ok) return { lines: [], errors: [`The skill check failed: ${check.message}`], warnings: [] };
  const failing = check.skills.filter((s) => FAILING.has(s.state));
  return {
    lines: check.skills.map(stateLine),
    errors:
      failing.length === 0
        ? []
        : [`The skill check found ${failing.map((s) => `${s.skill} ${STATE_WORDS[s.state]}`).join(', ')}. See each line above.`],
    warnings: check.leftovers.map((path) => `warning: ${path} is a leftover temp folder from an export that did not finish. The next install or update removes it.`),
  };
}

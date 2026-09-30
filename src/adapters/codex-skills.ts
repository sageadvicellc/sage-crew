import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginCheck, PluginOutcome } from './types.ts';

/**
 * The export of the approved skills for Codex CLI. Codex reads user skills
 * from `~/.agents/skills/`. The approved skills are the `skills` list in
 * the package's plugin manifest. Each exported folder holds a marker file,
 * and only a folder with a matching marker counts as this package's own.
 * No step follows a symbolic link.
 */

/** The marker file in each exported skill folder. */
export const SKILL_MARKER = '.trellis-crew-skill.json';
const OWNER = 'trellis-crew';
/** The name prefix of the temp folders an export makes beside the skills. */
const TEMP_PREFIX = '.trellis-crew-';
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The package root, which holds `.claude-plugin/plugin.json` and `skills/`. */
export function packageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export interface ApprovedSkill {
  name: string;
  /** The skill folder in the package. */
  source: string;
}

export type ApprovedResult = { ok: true; skills: ApprovedSkill[] } | { ok: false; message: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The skill name in one manifest entry, such as `./skills/department-lead/`, or undefined. */
function skillNameOf(entry: unknown): string | undefined {
  if (typeof entry !== 'string') return undefined;
  const match = /^(?:\.\/)?skills\/([^/]+)\/?$/.exec(entry);
  const name = match?.[1];
  return name !== undefined && SKILL_NAME.test(name) ? name : undefined;
}

/** Reads the approved skills from the plugin manifest under `root`. */
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
  const skills: ApprovedSkill[] = [];
  for (const entry of list) {
    const name = skillNameOf(entry);
    if (name === undefined) {
      return { ok: false, message: `the plugin manifest lists ${JSON.stringify(entry)}, which is not a skill folder under skills/` };
    }
    const source = join(root, 'skills', name);
    if (lstatOrUndefined(source)?.isDirectory() !== true) {
      return { ok: false, message: `the approved skill ${name} has no folder at ${source}` };
    }
    if (!skills.some((s) => s.name === name)) skills.push({ name, source });
  }
  return { ok: true, skills };
}

/** Each entry under `dir`, sorted by relative path, with the marker file left out. Refuses a link or a special file. */
function walk(dir: string): { rel: string; abs: string; stat: Stats }[] {
  const found: { rel: string; abs: string; stat: Stats }[] = [];
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
 * type and executable bit, and each file's length and bytes. The marker
 * file is left out, so a copy hashes the same as its source.
 */
export function treeHash(dir: string): string {
  const hash = createHash('sha256');
  for (const entry of walk(dir)) {
    if (entry.stat.isDirectory()) {
      hash.update(`dir\0${entry.rel}\0`);
      continue;
    }
    const bytes = readFileSync(entry.abs);
    const mode = (entry.stat.mode & 0o111) === 0 ? 'file' : 'exec';
    hash.update(`${mode}\0${entry.rel}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** True when `dir` holds a marker, as a plain file, that names this package and `skill`. */
function isOwned(dir: string, skill: string): boolean {
  const path = join(dir, SKILL_MARKER);
  try {
    if (!lstatSync(path).isFile()) return false;
    const data = JSON.parse(readFileSync(path, 'utf8')) as { owner?: unknown; skill?: unknown } | null;
    return data?.owner === OWNER && data.skill === skill;
  } catch {
    return false;
  }
}

type TargetKind = 'absent' | 'owned' | 'not-owned' | 'link';

function targetKind(path: string, skill: string): TargetKind {
  const stat = lstatOrUndefined(path);
  if (stat === undefined) return 'absent';
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory() && isOwned(path, skill)) return 'owned';
  return 'not-owned';
}

/** Why a folder on the path to the skills is refused, or undefined when it is a real folder or absent. */
function refusedFolder(path: string): string | undefined {
  const stat = lstatOrUndefined(path);
  if (stat === undefined || stat.isDirectory()) return undefined;
  return stat.isSymbolicLink() ? `${path} is a symbolic link, which is not followed` : `${path} is not a folder`;
}

/** Owned folders in `skillsDir` whose skill is not approved. Dot-prefixed names are never read. */
function staleFolders(skillsDir: string, approved: ReadonlySet<string>): string[] {
  if (lstatOrUndefined(skillsDir) === undefined) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !approved.has(entry.name))
    .map((entry) => entry.name)
    .filter((name) => isOwned(join(skillsDir, name), name))
    .sort();
}

/** Copies a tree of plain folders and files. Refuses a link or a special file. */
function copyTree(source: string, dest: string): void {
  for (const entry of walk(source)) {
    const to = join(dest, ...entry.rel.split('/'));
    if (entry.stat.isDirectory()) {
      mkdirSync(to);
    } else {
      copyFileSync(entry.abs, to, constants.COPYFILE_EXCL);
    }
    chmodSync(to, entry.stat.mode & 0o777);
  }
}

/** Copies one skill into a fresh temp folder in `skillsDir`, writes its marker, and returns the temp path. */
function stage(skillsDir: string, skill: ApprovedSkill, sourceHash: string): string {
  const temp = mkdtempSync(join(skillsDir, `${TEMP_PREFIX}${skill.name}-`));
  try {
    copyTree(skill.source, temp);
    if (treeHash(temp) !== sourceHash) throw new Error(`the copy of ${skill.name} does not match its source`);
    const marker = { owner: OWNER, skill: skill.name, sha256: sourceHash };
    writeFileSync(join(temp, SKILL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    chmodSync(temp, lstatSync(skill.source).mode & 0o777);
    return temp;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/** Puts a staged folder at `dest`. An owned folder there is swapped out by rename and then removed. */
function swapIn(temp: string, dest: string, skill: string): void {
  const kind = targetKind(dest, skill);
  if (kind === 'absent') {
    renameSync(temp, dest);
    return;
  }
  if (kind !== 'owned') throw new Error(`${dest} changed during the export, so it was left alone`);
  const old = `${temp}-old`;
  renameSync(dest, old);
  try {
    renameSync(temp, dest);
  } catch (error) {
    renameSync(old, dest);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
}

const KIND_NOTE: Record<'not-owned' | 'link', string> = {
  'not-owned': 'a folder trellis-crew does not own',
  link: 'a symbolic link',
};

/**
 * Exports the approved skills into `skillsDir`, which is `~/.agents/skills`.
 * It first checks every target. When any target is not this package's own,
 * it changes nothing and names each one. Otherwise it copies each approved
 * skill, replaces each owned copy, and removes each owned folder whose
 * skill is no longer approved. Nothing else in the folder is touched.
 */
export function exportSkills(skillsDir: string, out: (line: string) => void, root = packageRoot()): PluginOutcome {
  const fail = (reason: string): PluginOutcome => ({ ok: false, message: `the skill export stopped: ${reason}` });
  const approved = approvedSkills(root);
  if (!approved.ok) return fail(approved.message);

  const hashes = new Map<string, string>();
  try {
    for (const skill of approved.skills) hashes.set(skill.name, treeHash(skill.source));
  } catch (error) {
    return fail(describeError(error));
  }

  for (const folder of [dirname(skillsDir), skillsDir]) {
    const refused = refusedFolder(folder);
    if (refused !== undefined) return fail(`${refused}, so nothing was changed`);
  }

  const conflicts: string[] = [];
  for (const skill of approved.skills) {
    const dest = join(skillsDir, skill.name);
    const kind = targetKind(dest, skill.name);
    if (kind === 'not-owned' || kind === 'link') conflicts.push(`${skill.name} (${KIND_NOTE[kind]}) at ${dest}`);
  }
  if (conflicts.length > 0) {
    return fail(
      `${conflicts.join('; ')}. It was left alone, so nothing was changed. Move or rename it, then run the command again.`,
    );
  }

  try {
    for (const folder of [dirname(skillsDir), skillsDir]) {
      if (lstatOrUndefined(folder) === undefined) mkdirSync(folder);
    }
    for (const skill of approved.skills) {
      const temp = stage(skillsDir, skill, hashes.get(skill.name) as string);
      try {
        swapIn(temp, join(skillsDir, skill.name), skill.name);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
    for (const name of staleFolders(skillsDir, new Set(approved.skills.map((s) => s.name)))) {
      rmSync(join(skillsDir, name), { recursive: true, force: true });
      out(`Removed the stale skill ${name}, which this package no longer ships.`);
    }
  } catch (error) {
    return fail(describeError(error));
  }
  out(`Copied the approved trellis-crew skills into ${skillsDir}.`);
  return { ok: true };
}

export type SkillState = 'in-step' | 'drifted' | 'missing' | 'not-owned' | 'stale';

export interface SkillStatus {
  skill: string;
  state: SkillState;
  path: string;
}

export type SkillCheck = { ok: true; skills: SkillStatus[] } | { ok: false; message: string };

/**
 * Compares each approved skill with its copy in `skillsDir`, and finds each
 * owned folder that is no longer approved. It changes nothing.
 */
export function checkSkills(skillsDir: string, root = packageRoot()): SkillCheck {
  const approved = approvedSkills(root);
  if (!approved.ok) return approved;
  for (const folder of [dirname(skillsDir), skillsDir]) {
    const refused = refusedFolder(folder);
    if (refused !== undefined) return { ok: false, message: refused };
  }
  try {
    const skills: SkillStatus[] = approved.skills.map(({ name, source }) => {
      const path = join(skillsDir, name);
      const kind = targetKind(path, name);
      if (kind === 'absent') return { skill: name, state: 'missing', path };
      if (kind !== 'owned') return { skill: name, state: 'not-owned', path };
      let copy: string | undefined;
      try {
        copy = treeHash(path);
      } catch {
        copy = undefined;
      }
      return { skill: name, state: copy === treeHash(source) ? 'in-step' : 'drifted', path };
    });
    for (const name of staleFolders(skillsDir, new Set(approved.skills.map((s) => s.name)))) {
      skills.push({ skill: name, state: 'stale', path: join(skillsDir, name) });
    }
    return { ok: true, skills };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

const STATE_LINE: Record<SkillState, (path: string) => string> = {
  'in-step': () => 'in step.',
  drifted: (path) => `drifted. The copy at ${path} differs from the package source.`,
  missing: (path) => `missing. Nothing is at ${path}.`,
  'not-owned': (path) => `not owned. ${path} is not a trellis-crew copy, so it is left alone.`,
  stale: (path) => `stale. ${path} is a trellis-crew copy of a skill this package no longer ships.`,
};

/** The skill lines for `update --check`. A drifted, missing, or stale skill is an error. */
export function skillCheckReport(skillsDir: string, root = packageRoot()): PluginCheck {
  const check = checkSkills(skillsDir, root);
  if (!check.ok) return { lines: [], errors: [`The skill check failed: ${check.message}`] };
  const lines = check.skills.map((s) => `Skill ${s.skill}: ${STATE_LINE[s.state](s.path)}`);
  const failing = check.skills.filter((s) => s.state === 'drifted' || s.state === 'missing' || s.state === 'stale');
  const errors =
    failing.length === 0
      ? []
      : [
          `The skill check found ${failing.map((s) => `${s.skill} ${s.state}`).join(', ')}. Run trellis-crew update to copy the skills fresh.`,
        ];
  return { lines, errors };
}

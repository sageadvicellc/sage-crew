import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexSkillsDir } from '../src/adapters/codex.ts';
import {
  agentsSkillsDir,
  approvedSkills,
  checkSkills,
  exportSkills,
  SKILL_MARKER,
  swapIn,
  treeHash,
  type ExportFs,
} from '../src/adapters/codex-skills.ts';
import { main } from '../src/cli.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { repoRoot } from './helpers/paths.ts';
import { installedOn } from './helpers/team.ts';

type Tree = Record<string, string>;

/** A stand-in package folder: a plugin manifest that lists `listed`, and a folder for each skill in `skills`. */
function standInPackage(skills: Record<string, Tree>, listed: readonly string[]): string {
  const root = makeFixtureHome();
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'trellis-crew', version: '0.1.0', skills: listed.map((name) => `./skills/${name}/`) }),
  );
  for (const [name, files] of Object.entries(skills)) writeTree(join(root, 'skills', name), files);
  return root;
}

function writeTree(dir: string, files: Tree): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** Every entry under `dir`, as relative path and text, for a before-and-after comparison. */
function snapshot(dir: string): Tree {
  const out: Tree = {};
  for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const abs = join(dir, rel);
    const stat = lstatSync(abs);
    out[rel] = stat.isFile() ? readFileSync(abs, 'utf8') : stat.isSymbolicLink() ? '<link>' : '<dir>';
  }
  return out;
}

function marker(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, SKILL_MARKER), 'utf8'));
}

/** Writes a marker. With no hash given, it holds the folder's own tree hash, as an export would. */
function writeMarker(dir: string, skill: string, options: { owner?: string; sha256?: string } = {}): void {
  const sha256 = options.sha256 ?? treeHash(dir);
  writeFileSync(join(dir, SKILL_MARKER), JSON.stringify({ owner: options.owner ?? 'trellis-crew', skill, sha256 }));
}

function dotEntries(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.'));
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

const TWO = { alpha: { 'SKILL.md': 'alpha v1\n', 'refs/notes.md': 'alpha notes\n' }, beta: { 'SKILL.md': 'beta v1\n' } };

function freshHome(): { home: string; target: string } {
  const home = makeFixtureHome();
  return { home, target: agentsSkillsDir(home) };
}

const quietOut = (): void => {};

/** An ExportFs over the real file system, with hooks a test sets. */
function hookedFs(hooks: { rename?: (from: string, to: string) => void; remove?: (path: string) => void } = {}): ExportFs {
  return {
    rename: hooks.rename ?? ((from, to) => renameSync(from, to)),
    remove: hooks.remove ?? ((path) => rmSync(path, { recursive: true, force: true })),
  };
}

describe('approved skills', () => {
  it('reads the skills list from the plugin manifest', () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    expect(approvedSkills(root)).toEqual({
      ok: true,
      skills: [
        { name: 'alpha', source: join(root, 'skills', 'alpha') },
        { name: 'beta', source: join(root, 'skills', 'beta') },
      ],
    });
  });

  it('the real package approves every skill in its manifest', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills: string[] };
    const approved = approvedSkills(repoRoot);
    if (!approved.ok) throw new Error(approved.message);
    expect(approved.skills.map((s) => s.name)).toEqual(manifest.skills.map((entry) => entry.replace(/^\.\/skills\/|\/$/g, '')));
  });

  it('the Codex target is ~/.agents/skills under the home the Env gives', () => {
    const home = makeFixtureHome();
    expect(codexSkillsDir(home)).toBe(join(home, '.agents', 'skills'));
    expect(agentsSkillsDir(home)).toBe(codexSkillsDir(home));
  });

  it('a missing manifest fails with a named reason', () => {
    const approved = approvedSkills(makeFixtureHome());
    expect(!approved.ok && approved.message).toMatch(/plugin manifest .*plugin\.json.* could not be read/);
  });

  it('an unreadable manifest fails with a named reason', () => {
    const root = standInPackage(TWO, ['alpha']);
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{ not json');
    const approved = approvedSkills(root);
    expect(!approved.ok && approved.message).toMatch(/plugin manifest .*plugin\.json.* could not be read/);
  });

  it('a manifest with no skills list, or an empty one, fails with a named reason', () => {
    const root = standInPackage(TWO, []);
    expect(approvedSkills(root)).toMatchObject({ ok: false, message: expect.stringMatching(/empty skills list/) });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'trellis-crew' }));
    expect(approvedSkills(root)).toMatchObject({ ok: false, message: expect.stringMatching(/has no skills list/) });
  });

  it('a listed skill with no folder fails with a named reason', () => {
    const approved = approvedSkills(standInPackage(TWO, ['alpha', 'gamma']));
    expect(!approved.ok && approved.message).toMatch(/approved skill gamma has no folder/);
  });

  it('a listed entry outside the skills folder is refused', () => {
    for (const entry of ['../outside/', './skills/../x/', './skills/a/b/', '/skills/alpha/', './skills/.hidden/', 7]) {
      const root = standInPackage(TWO, []);
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: [entry] }));
      const approved = approvedSkills(root);
      expect(!approved.ok && approved.message, String(entry)).toMatch(/not a skill folder under skills\//);
    }
  });

  it('a listed skill whose folder is a link is refused', () => {
    const root = standInPackage({ alpha: TWO.alpha }, ['alpha', 'beta']);
    symlinkSync(makeFixtureHome(), join(root, 'skills', 'beta'));
    const approved = approvedSkills(root);
    expect(!approved.ok && approved.message).toMatch(/approved skill beta has no folder/);
  });

  it('names are deduped case-blind', () => {
    const root = standInPackage(TWO, ['alpha', 'Alpha', 'beta', 'ALPHA']);
    const approved = approvedSkills(root);
    expect(approved.ok && approved.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
  });
});

describe('tree hash', () => {
  it('is stable, and the same for a copy with the marker file', () => {
    const a = makeFixtureHome();
    writeTree(a, TWO.alpha);
    const b = makeFixtureHome();
    writeTree(b, TWO.alpha);
    writeMarker(b, 'alpha');
    expect(treeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(treeHash(a)).toBe(treeHash(a));
    expect(treeHash(b)).toBe(treeHash(a));
  });

  it('changes when one byte changes', () => {
    const dir = makeFixtureHome();
    writeTree(dir, TWO.alpha);
    const before = treeHash(dir);
    writeFileSync(join(dir, 'refs', 'notes.md'), 'alpha notez\n');
    expect(treeHash(dir)).not.toBe(before);
  });

  it('changes when a path, a file mode, or an empty folder changes', () => {
    const dir = makeFixtureHome();
    writeTree(dir, TWO.alpha);
    const base = treeHash(dir);
    chmodSync(join(dir, 'SKILL.md'), 0o755);
    expect(treeHash(dir)).not.toBe(base);
    chmodSync(join(dir, 'SKILL.md'), 0o644);
    expect(treeHash(dir)).toBe(base);
    mkdirSync(join(dir, 'empty'));
    expect(treeHash(dir)).not.toBe(base);
    rmSync(join(dir, 'empty'), { recursive: true });

    const moved = makeFixtureHome();
    writeTree(moved, { 'SKILL.md': 'alpha v1\n', 'refs/notes2.md': 'alpha notes\n' });
    expect(treeHash(moved)).not.toBe(base);
  });

  it('covers mode & 0o755 only, so group and other write bits do not count', () => {
    const dir = makeFixtureHome();
    writeTree(dir, TWO.alpha);
    chmodSync(join(dir, 'SKILL.md'), 0o644);
    const base = treeHash(dir);
    chmodSync(join(dir, 'SKILL.md'), 0o666);
    expect(treeHash(dir)).toBe(base);
    chmodSync(join(dir, 'SKILL.md'), 0o600);
    expect(treeHash(dir)).not.toBe(base);
  });

  it('keeps file boundaries: moving bytes between files changes the hash', () => {
    const one = makeFixtureHome();
    writeTree(one, { a: 'xy', b: '' });
    const two = makeFixtureHome();
    writeTree(two, { a: 'x', b: 'y' });
    expect(treeHash(one)).not.toBe(treeHash(two));
  });

  it('refuses a symbolic link in the tree', () => {
    const dir = makeFixtureHome();
    writeTree(dir, TWO.alpha);
    symlinkSync(join(dir, 'SKILL.md'), join(dir, 'link.md'));
    expect(() => treeHash(dir)).toThrow(/symbolic link.*link\.md/);
  });
});

describe('skill export', () => {
  it('a fresh copy writes the approved skills and their markers', () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const { home, target } = freshHome();
    const lines: string[] = [];
    expect(exportSkills(home, (l) => lines.push(l), { root })).toEqual({ ok: true });
    expect(readdirSync(target).sort()).toEqual(['alpha', 'beta']);
    for (const name of ['alpha', 'beta'] as const) {
      const copy = join(target, name);
      const source = join(root, 'skills', name);
      expect(snapshot(copy)).toEqual({ ...snapshot(source), [SKILL_MARKER]: expect.any(String) });
      expect(marker(copy)).toEqual({ owner: 'trellis-crew', skill: name, sha256: treeHash(source) });
    }
    expect(lines.join('\n')).toContain(target);
  });

  it('applies the source modes with group and other write bits masked', () => {
    const root = standInPackage(TWO, ['alpha']);
    const source = join(root, 'skills', 'alpha');
    chmodSync(join(source, 'SKILL.md'), 0o775);
    chmodSync(join(source, 'refs', 'notes.md'), 0o666);
    chmodSync(join(source, 'refs'), 0o777);
    chmodSync(source, 0o775);
    const { home, target } = freshHome();
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    expect(mode(join(target, 'alpha', 'SKILL.md'))).toBe(0o755);
    expect(mode(join(target, 'alpha', 'refs', 'notes.md'))).toBe(0o644);
    expect(mode(join(target, 'alpha', 'refs'))).toBe(0o755);
    expect(mode(join(target, 'alpha'))).toBe(0o755);
    expect(checkSkills(home, root)).toMatchObject({ ok: true, skills: [{ skill: 'alpha', state: 'in-step' }] });
  });

  it('an unlisted package folder is not exported', () => {
    const root = standInPackage({ ...TWO, private: { 'SKILL.md': 'not approved\n' } }, ['alpha', 'beta']);
    const { home, target } = freshHome();
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    expect(readdirSync(target).sort()).toEqual(['alpha', 'beta']);
  });

  it('a second install replaces an owned folder and removes a stale owned one, and touches nothing else', () => {
    const { home, target } = freshHome();
    expect(exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    writeTree(join(target, 'users-own'), { 'SKILL.md': 'mine\n' });
    writeTree(join(target, '.dot-folder'), { 'x.md': 'mine\n' });
    writeFileSync(join(target, 'loose.md'), 'mine\n');
    const own = snapshot(join(target, 'users-own'));

    const second = standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']);
    const lines: string[] = [];
    expect(exportSkills(home, (l) => lines.push(l), { root: second })).toEqual({ ok: true });
    expect(snapshot(join(target, 'alpha'))).toEqual({ 'SKILL.md': 'alpha v2\n', [SKILL_MARKER]: expect.any(String) });
    expect(marker(join(target, 'alpha'))).toMatchObject({ sha256: treeHash(join(second, 'skills', 'alpha')) });
    expect(existsSync(join(target, 'beta'))).toBe(false);
    expect(lines.join('\n')).toMatch(/Removed the stale skill beta/);
    expect(snapshot(join(target, 'users-own'))).toEqual(own);
    expect(readdirSync(target).sort()).toEqual(['.dot-folder', 'alpha', 'loose.md', 'users-own']);
  });

  it('a folder whose marker names another skill or owner, or is broken, is never removed as stale', () => {
    const { home, target } = freshHome();
    writeTree(join(target, 'gamma'), { 'SKILL.md': 'x\n' });
    writeMarker(join(target, 'gamma'), 'other-name');
    writeTree(join(target, 'delta'), { 'SKILL.md': 'x\n' });
    writeMarker(join(target, 'delta'), 'delta', { owner: 'someone-else' });
    writeTree(join(target, 'epsilon'), { 'SKILL.md': 'x\n' });
    writeFileSync(join(target, 'epsilon', SKILL_MARKER), '{ broken');
    writeTree(join(target, 'zeta'), { 'SKILL.md': 'x\n' });
    writeMarker(join(target, 'zeta'), 'zeta', { sha256: 'not-hex' });
    expect(exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    for (const name of ['gamma', 'delta', 'epsilon', 'zeta']) expect(existsSync(join(target, name, 'SKILL.md')), name).toBe(true);
  });

  it('a marker that is a link, a folder, or over 4 KiB does not make a folder owned', () => {
    const cases: [string, (dir: string) => void][] = [
      [
        'link',
        (dir) => {
          const real = makeFixtureHome();
          writeTree(real, { 'SKILL.md': 'beta v1\n' });
          writeMarker(real, 'beta');
          symlinkSync(join(real, SKILL_MARKER), join(dir, SKILL_MARKER));
        },
      ],
      ['folder', (dir) => mkdirSync(join(dir, SKILL_MARKER))],
      [
        'large',
        (dir) =>
          writeFileSync(
            join(dir, SKILL_MARKER),
            JSON.stringify({ owner: 'trellis-crew', skill: 'beta', sha256: treeHash(dir), pad: 'x'.repeat(5000) }),
          ),
      ],
    ];
    for (const [label, plant] of cases) {
      const { home, target } = freshHome();
      writeTree(join(target, 'beta'), { 'SKILL.md': 'mine\n' });
      plant(join(target, 'beta'));
      const before = snapshot(target);
      const result = exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha', 'beta']) });
      expect(result.ok, label).toBe(false);
      expect(!result.ok && result.message, label).toMatch(/beta \(a folder trellis-crew does not own\)/);
      expect(snapshot(target), label).toEqual(before);
    }
  });

  it('a user folder with the same name is untouched, fails the export, and nothing is changed', () => {
    const { home, target } = freshHome();
    writeTree(join(target, 'beta'), { 'SKILL.md': 'my own beta\n' });
    const before = snapshot(target);
    const result = exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha', 'beta']) });
    expect(!result.ok && result.message).toMatch(/skill export stopped.*beta \(a folder trellis-crew does not own\)/);
    expect(!result.ok && result.message).toContain(join(target, 'beta'));
    expect(snapshot(target)).toEqual(before);
  });

  it('a link in place of a target is refused and left alone', () => {
    const { home, target } = freshHome();
    const elsewhere = makeFixtureHome();
    writeTree(elsewhere, { 'SKILL.md': 'linked\n' });
    writeMarker(elsewhere, 'alpha');
    mkdirSync(target, { recursive: true });
    symlinkSync(elsewhere, join(target, 'alpha'));
    const before = snapshot(elsewhere);
    const result = exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha', 'beta']) });
    expect(!result.ok && result.message).toMatch(/alpha \(a symbolic link\)/);
    expect(lstatSync(join(target, 'alpha')).isSymbolicLink()).toBe(true);
    expect(snapshot(elsewhere)).toEqual(before);
  });

  it('a link in place of ~/.agents/skills or ~/.agents is refused', () => {
    const root = standInPackage(TWO, ['alpha']);
    const elsewhere = makeFixtureHome();
    const skillsLink = freshHome();
    mkdirSync(dirname(skillsLink.target));
    symlinkSync(elsewhere, skillsLink.target);
    const one = exportSkills(skillsLink.home, quietOut, { root });
    expect(!one.ok && one.message).toMatch(/symbolic link/);
    expect(readdirSync(elsewhere)).toEqual([]);

    const agentsLink = freshHome();
    symlinkSync(elsewhere, dirname(agentsLink.target));
    const two = exportSkills(agentsLink.home, quietOut, { root });
    expect(!two.ok && two.message).toMatch(/symbolic link/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('a link inside an approved source folder stops the export before anything is written', () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    symlinkSync(join(root, 'skills', 'alpha', 'SKILL.md'), join(root, 'skills', 'beta', 'link.md'));
    const { home, target } = freshHome();
    const result = exportSkills(home, quietOut, { root });
    expect(!result.ok && result.message).toMatch(/symbolic link/);
    expect(existsSync(join(target, 'alpha'))).toBe(false);
  });

  it('a missing manifest stops the export with a named reason', () => {
    const { home, target } = freshHome();
    const result = exportSkills(home, quietOut, { root: makeFixtureHome() });
    expect(!result.ok && result.message).toMatch(/plugin manifest/);
    expect(existsSync(target)).toBe(false);
  });

  it('an empty skills list is an error, and nothing is removed', () => {
    const { home, target } = freshHome();
    expect(exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    const before = snapshot(target);
    const result = exportSkills(home, quietOut, { root: standInPackage(TWO, []) });
    expect(!result.ok && result.message).toMatch(/empty skills list/);
    expect(snapshot(target)).toEqual(before);
  });

  it('a permission error is a named step, not a thrown error', () => {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha']);
    mkdirSync(target, { recursive: true });
    chmodSync(target, 0o000);
    try {
      const result = exportSkills(home, quietOut, { root });
      expect(!result.ok && result.message).toMatch(/skill export stopped.*EACCES/);
      const check = checkSkills(home, root);
      expect(!check.ok && check.message).toMatch(/EACCES/);
    } finally {
      chmodSync(target, 0o755);
    }
  });

  it('leaves no temp folder behind', () => {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    exportSkills(home, quietOut, { root });
    exportSkills(home, quietOut, { root });
    expect(dotEntries(target)).toEqual([]);
    writeTree(join(target, 'gamma'), { 'SKILL.md': 'mine\n' });
    const listed = standInPackage({ ...TWO, gamma: { 'SKILL.md': 'g\n' } }, ['alpha', 'beta', 'gamma']);
    expect(exportSkills(home, quietOut, { root: listed }).ok).toBe(false);
    expect(dotEntries(target)).toEqual([]);
  });

  it('removes its own leftover temp folders at start, and nothing else with a dot name', () => {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha']);
    writeTree(join(target, '.trellis-crew-alpha-abc123'), { 'SKILL.md': 'half\n' });
    writeTree(join(target, '.trellis-crew-alpha-abc123-old'), { 'SKILL.md': 'old\n' });
    const elsewhere = makeFixtureHome();
    symlinkSync(elsewhere, join(target, '.trellis-crew-link'));
    writeFileSync(join(target, '.trellis-crew-note'), 'mine\n');
    writeTree(join(target, '.other'), { 'x.md': 'mine\n' });
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    expect(dotEntries(target).sort()).toEqual(['.other', '.trellis-crew-link', '.trellis-crew-note']);
  });
});

describe('migrating a copy made before markers', () => {
  it('an exact unmarked copy is adopted: it gets a marker and counts as owned', () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const { home, target } = freshHome();
    mkdirSync(target, { recursive: true });
    cpSync(join(root, 'skills', 'alpha'), join(target, 'alpha'), { recursive: true });
    const lines: string[] = [];
    expect(exportSkills(home, (l) => lines.push(l), { root })).toEqual({ ok: true });
    expect(marker(join(target, 'alpha'))).toEqual({ owner: 'trellis-crew', skill: 'alpha', sha256: treeHash(join(root, 'skills', 'alpha')) });
    expect(lines.join('\n')).toMatch(/Adopted the unmarked copy of alpha/);
    expect(checkSkills(home, root)).toMatchObject({ ok: true, skills: [{ state: 'in-step' }, { state: 'in-step' }] });
  });

  it('a modified unmarked copy stops the install and is untouched', () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const { home, target } = freshHome();
    mkdirSync(target, { recursive: true });
    cpSync(join(root, 'skills', 'alpha'), join(target, 'alpha'), { recursive: true });
    writeFileSync(join(target, 'alpha', 'SKILL.md'), 'alpha v1, edited\n');
    const before = snapshot(target);
    const result = exportSkills(home, quietOut, { root });
    expect(!result.ok && result.message).toMatch(/alpha \(a folder trellis-crew does not own\)/);
    expect(snapshot(target)).toEqual(before);
  });

  it('an exact unmarked copy of an unlisted package folder is removed as stale; a changed one stays', () => {
    const root = standInPackage({ ...TWO, retired: { 'SKILL.md': 'retired\n' }, kept: { 'SKILL.md': 'kept\n' } }, ['alpha']);
    const { home, target } = freshHome();
    mkdirSync(target, { recursive: true });
    cpSync(join(root, 'skills', 'retired'), join(target, 'retired'), { recursive: true });
    cpSync(join(root, 'skills', 'kept'), join(target, 'kept'), { recursive: true });
    writeFileSync(join(target, 'kept', 'SKILL.md'), 'kept, edited\n');
    expect(checkSkills(home, root)).toMatchObject({
      ok: true,
      skills: [
        { skill: 'alpha', state: 'missing' },
        { skill: 'retired', state: 'stale' },
      ],
    });
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    expect(existsSync(join(target, 'retired'))).toBe(false);
    expect(readFileSync(join(target, 'kept', 'SKILL.md'), 'utf8')).toBe('kept, edited\n');
  });
});

describe('the marker hash', () => {
  it('a forged marker with a wrong hash stays untouched and stops the install', () => {
    const { home, target } = freshHome();
    writeTree(join(target, 'alpha'), { 'SKILL.md': 'my alpha\n' });
    writeMarker(join(target, 'alpha'), 'alpha', { sha256: 'a'.repeat(64) });
    const before = snapshot(target);
    const result = exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha']) });
    expect(!result.ok && result.message).toMatch(/alpha \(a trellis-crew copy edited since export\)/);
    expect(snapshot(target)).toEqual(before);
  });

  it('an owned copy edited after the export is untouched and stops the install', () => {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    writeFileSync(join(target, 'alpha', 'SKILL.md'), 'my change\n');
    const before = snapshot(target);
    const result = exportSkills(home, quietOut, { root });
    expect(!result.ok && result.message).toMatch(/alpha \(a trellis-crew copy edited since export\)/);
    expect(snapshot(target)).toEqual(before);
  });

  it('an edited owned folder whose skill is no longer approved is not removed, and stops the install', () => {
    const { home, target } = freshHome();
    expect(exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    writeFileSync(join(target, 'beta', 'SKILL.md'), 'my change\n');
    const result = exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha']) });
    expect(!result.ok && result.message).toMatch(/beta \(a trellis-crew copy edited since export\)/);
    expect(readFileSync(join(target, 'beta', 'SKILL.md'), 'utf8')).toBe('my change\n');
  });

  it('a valid owned copy from an older package is replaced', () => {
    const { home, target } = freshHome();
    expect(exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    const newer = standInPackage({ alpha: { 'SKILL.md': 'alpha v3\n' } }, ['alpha']);
    expect(checkSkills(home, newer)).toMatchObject({ ok: true, skills: [{ skill: 'alpha', state: 'drifted' }] });
    expect(exportSkills(home, quietOut, { root: newer })).toEqual({ ok: true });
    expect(snapshot(join(target, 'alpha'))).toEqual({ 'SKILL.md': 'alpha v3\n', [SKILL_MARKER]: expect.any(String) });
  });
});

describe('the swap', () => {
  function ownedPair(): { dest: string; temp: string; skillsDir: string } {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha']);
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    const temp = join(target, '.trellis-crew-alpha-test01');
    writeTree(temp, { 'SKILL.md': 'alpha new\n' });
    writeMarker(temp, 'alpha');
    return { dest: join(target, 'alpha'), temp, skillsDir: target };
  }

  it('a failed swap puts the old copy back', () => {
    const { dest, temp } = ownedPair();
    const before = snapshot(dest);
    const fsx = hookedFs({
      rename: (from, to) => {
        if (from === temp) throw new Error('swap refused');
        renameSync(from, to);
      },
    });
    expect(() => swapIn(temp, dest, 'alpha', 'replace', fsx, quietOut)).toThrow(/^swap refused$/);
    expect(snapshot(dest)).toEqual(before);
    expect(existsSync(`${temp}-old`)).toBe(false);
  });

  it('a failed rollback names both errors and the -old path, and keeps the cause', () => {
    const { dest, temp } = ownedPair();
    const swapError = new Error('swap refused');
    const fsx = hookedFs({
      rename: (from, to) => {
        if (from === temp) throw swapError;
        if (from.endsWith('-old')) throw new Error('rollback refused');
        renameSync(from, to);
      },
    });
    let caught: unknown;
    try {
      swapIn(temp, dest, 'alpha', 'replace', fsx, quietOut);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain('swap refused');
    expect(error.message).toContain('rollback refused');
    expect(error.message).toContain(`${temp}-old`);
    expect(error.cause).toBe(swapError);
    expect(existsSync(`${temp}-old`)).toBe(true);
  });

  it('a folder edited in the gap after the rename is put back, and nothing is removed', () => {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    const newer = standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']);
    const fsx = hookedFs({
      rename: (from, to) => {
        renameSync(from, to);
        if (to.endsWith('-old')) writeFileSync(join(to, 'SKILL.md'), 'edited in the gap\n');
      },
    });
    const result = exportSkills(home, quietOut, { root: newer, fs: fsx });
    expect(!result.ok && result.message).toMatch(/changed during the export, so it was put back and nothing was removed/);
    expect(readFileSync(join(target, 'alpha', 'SKILL.md'), 'utf8')).toBe('edited in the gap\n');
    expect(existsSync(join(target, 'beta'))).toBe(true);
    expect(dotEntries(target)).toEqual([]);
  });

  it('when the old copy cannot be removed, the new copy counts as installed and a warning names the leftover', () => {
    const { home, target } = freshHome();
    expect(exportSkills(home, quietOut, { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    const newer = standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']);
    const lines: string[] = [];
    const fsx = hookedFs({
      remove: (path) => {
        if (path.endsWith('-old')) throw new Error('remove refused');
        rmSync(path, { recursive: true, force: true });
      },
    });
    expect(exportSkills(home, (l) => lines.push(l), { root: newer, fs: fsx })).toEqual({ ok: true });
    expect(readFileSync(join(target, 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha v2\n');
    const leftover = dotEntries(target);
    expect(leftover).toHaveLength(1);
    expect(lines.join('\n')).toMatch(new RegExp(`warning: .*${leftover[0]}.*remove refused`));
    expect(checkSkills(home, newer)).toMatchObject({ ok: true, leftovers: [join(target, leftover[0] as string)] });
  });

  it('a failure partway through names the skills already copied and says to run update again', () => {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const fsx = hookedFs({
      rename: (from, to) => {
        if (to === join(target, 'beta')) throw new Error('disk full');
        renameSync(from, to);
      },
    });
    const result = exportSkills(home, quietOut, { root, fs: fsx });
    expect(!result.ok && result.message).toMatch(/disk full.*Already copied: alpha\..*Run trellis-crew update again to finish/);
    expect(existsSync(join(target, 'alpha', SKILL_MARKER))).toBe(true);
    expect(existsSync(join(target, 'beta'))).toBe(false);
    expect(dotEntries(target)).toEqual([]);
  });
});

describe('drift check', () => {
  it('reports each state, and changes nothing', () => {
    const { home, target } = freshHome();
    const skills = {
      steady: { 'SKILL.md': 's\n' },
      drift: { 'SKILL.md': 'd\n' },
      gone: { 'SKILL.md': 'g\n' },
      mine: { 'SKILL.md': 'm\n' },
      linked: { 'SKILL.md': 'l\n' },
      edited: { 'SKILL.md': 'e\n' },
      broken: { 'SKILL.md': 'b\n' },
      bare: { 'SKILL.md': 'u\n' },
      old: { 'SKILL.md': 'o\n' },
    };
    const before = standInPackage(skills, ['steady', 'drift', 'gone', 'edited', 'broken', 'old']);
    expect(exportSkills(home, quietOut, { root: before })).toEqual({ ok: true });
    writeFileSync(join(target, 'drift', 'SKILL.md'), 'D\n');
    writeMarker(join(target, 'drift'), 'drift');
    rmSync(join(target, 'gone'), { recursive: true });
    writeTree(join(target, 'mine'), { 'SKILL.md': 'my own\n' });
    symlinkSync(makeFixtureHome(), join(target, 'linked'));
    writeFileSync(join(target, 'edited', 'SKILL.md'), 'E\n');
    symlinkSync(join(target, 'broken', 'SKILL.md'), join(target, 'broken', 'link.md'));
    writeTree(join(target, 'bare'), skills.bare);
    const listing = snapshot(target);

    const now = standInPackage(skills, ['steady', 'drift', 'gone', 'mine', 'linked', 'edited', 'broken', 'bare']);
    const check = checkSkills(home, now);
    if (!check.ok) throw new Error(check.message);
    expect(check.skills.map((s) => [s.skill, s.state])).toEqual([
      ['steady', 'in-step'],
      ['drift', 'drifted'],
      ['gone', 'missing'],
      ['mine', 'not-owned'],
      ['linked', 'not-owned'],
      ['edited', 'edited'],
      ['broken', 'unreadable'],
      ['bare', 'unmarked'],
      ['old', 'stale'],
    ]);
    expect(check.skills.find((s) => s.skill === 'linked')?.detail).toBe('a symbolic link');
    expect(check.skills.find((s) => s.skill === 'mine')?.detail).toBe('a folder trellis-crew does not own');
    expect(check.skills.find((s) => s.skill === 'broken')?.detail).toMatch(/symbolic link/);
    for (const s of check.skills) expect(s.path).toBe(join(target, s.skill));
    expect(snapshot(target)).toEqual(listing);
  });

  it('an unreadable marker is its own state, with the error code', () => {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha']);
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    chmodSync(join(target, 'alpha'), 0o000);
    try {
      const check = checkSkills(home, root);
      expect(check).toMatchObject({ ok: true, skills: [{ skill: 'alpha', state: 'unreadable', detail: 'marker unreadable (EACCES)' }] });
      const result = exportSkills(home, quietOut, { root });
      expect(!result.ok && result.message).toMatch(/alpha \(unreadable: marker unreadable \(EACCES\)\)/);
    } finally {
      chmodSync(join(target, 'alpha'), 0o755);
    }
  });

  it('with no skills folder, every approved skill is missing', () => {
    const { home } = freshHome();
    const check = checkSkills(home, standInPackage(TWO, ['alpha', 'beta']));
    expect(check.ok && check.skills.map((s) => s.state)).toEqual(['missing', 'missing']);
  });

  it('a link in place of the skills folder fails the check', () => {
    const { home, target } = freshHome();
    mkdirSync(dirname(target));
    symlinkSync(makeFixtureHome(), target);
    const check = checkSkills(home, standInPackage(TWO, ['alpha']));
    expect(!check.ok && check.message).toMatch(/symbolic link/);
  });

  it('lists leftover temp folders, and only real folders with the temp prefix', () => {
    const { home, target } = freshHome();
    const root = standInPackage(TWO, ['alpha']);
    expect(exportSkills(home, quietOut, { root })).toEqual({ ok: true });
    writeTree(join(target, '.trellis-crew-alpha-zz9'), { 'SKILL.md': 'half\n' });
    writeFileSync(join(target, '.trellis-crew-note'), 'mine\n');
    writeTree(join(target, '.other'), { 'x.md': 'mine\n' });
    expect(checkSkills(home, root)).toMatchObject({ ok: true, leftovers: [join(target, '.trellis-crew-alpha-zz9')] });
  });
});

describe('update --check on Codex CLI', () => {
  const quiet = { fetchLatest: async () => ({ status: 'not-published' as const }) };
  const installed = () => installedOn('codex', 'file-mailbox', quiet);

  it('all in step: exits 0, prints one line per approved skill after the version lines', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    t.out.lines.length = 0;
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    const approved = approvedSkills(repoRoot);
    if (!approved.ok) throw new Error(approved.message);
    const text = t.out.text();
    for (const { name } of approved.skills) expect(text).toContain(`Skill ${name}: in step.`);
    expect(text.indexOf('trellis-crew CLI:')).toBeLessThan(text.indexOf('Skill '));
    expect(text.indexOf('Plugin:')).toBeLessThan(text.indexOf('Skill '));
    expect(t.err.text()).toBe('');
  });

  it('exits 1 on drift, missing, or stale, names each one, and changes nothing', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const target = codexSkillsDir(t.env.home);
    writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'from an older package\n');
    writeMarker(join(target, 'department-lead'), 'department-lead');
    rmSync(join(target, 'department-auditor'), { recursive: true });
    writeTree(join(target, 'retired-skill'), { 'SKILL.md': 'old\n' });
    writeMarker(join(target, 'retired-skill'), 'retired-skill');
    const before = snapshot(t.env.home);
    expect(await main(['update', '--check'], t.deps)).toBe(1);
    expect(t.out.text()).toContain('Skill department-lead: drifted.');
    expect(t.out.text()).toContain('Skill department-auditor: missing.');
    expect(t.out.text()).toContain('Skill retired-skill: stale.');
    expect(t.err.text()).toMatch(/department-lead drifted/);
    expect(t.err.text()).toMatch(/department-auditor missing/);
    expect(t.err.text()).toMatch(/retired-skill stale/);
    expect(snapshot(t.env.home)).toEqual(before);
  });

  const breakers: [string, string, (target: string) => void][] = [
    [
      'drifted',
      'drifted.',
      (target) => {
        writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'x');
        writeMarker(join(target, 'department-lead'), 'department-lead');
      },
    ],
    ['missing', 'missing.', (target) => rmSync(join(target, 'department-lead'), { recursive: true })],
    [
      'stale',
      'stale.',
      (target) => {
        writeTree(join(target, 'retired-skill'), { 'SKILL.md': 'old\n' });
        writeMarker(join(target, 'retired-skill'), 'retired-skill');
      },
    ],
    [
      'not owned',
      'not owned.',
      (target) => {
        rmSync(join(target, 'department-lead'), { recursive: true });
        writeTree(join(target, 'department-lead'), { 'SKILL.md': 'my own\n' });
      },
    ],
    [
      'a link',
      'not owned. ',
      (target) => {
        rmSync(join(target, 'department-lead'), { recursive: true });
        symlinkSync(makeFixtureHome(), join(target, 'department-lead'));
      },
    ],
    ['edited', 'edited since export.', (target) => writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'mine\n')],
    [
      'unreadable',
      'unreadable.',
      (target) => symlinkSync(join(target, 'department-lead', 'SKILL.md'), join(target, 'department-lead', 'link.md')),
    ],
  ];
  for (const [label, line, breakIt] of breakers) {
    it(`exits 1 on ${label} alone, and names it`, async () => {
      const t = installed();
      expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
      breakIt(codexSkillsDir(t.env.home));
      expect(await main(['update', '--check'], t.deps)).toBe(1);
      const skill = label === 'stale' ? 'retired-skill' : 'department-lead';
      expect(t.out.text()).toContain(`Skill ${skill}: ${line}`);
      expect(t.err.text()).toContain(skill);
    });
  }

  it('a link gets the same label in install and in the check', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const target = codexSkillsDir(t.env.home);
    rmSync(join(target, 'department-lead'), { recursive: true });
    symlinkSync(makeFixtureHome(), join(target, 'department-lead'));
    await main(['update', '--check'], t.deps);
    expect(t.out.text()).toContain(`${join(target, 'department-lead')} is a symbolic link`);
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(1);
    expect(t.err.text()).toContain('department-lead (a symbolic link)');
  });

  it('warns about a leftover temp folder by name, with no change in exit code', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const leftover = join(codexSkillsDir(t.env.home), '.trellis-crew-department-lead-abc123');
    writeTree(leftover, { 'SKILL.md': 'half\n' });
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    expect(t.err.text()).toMatch(new RegExp(`warning: .*${basename(leftover)}`));
    expect(existsSync(leftover)).toBe(true);
  });
});

describe('install and update on Codex CLI', () => {
  it('a user folder with a skill name fails the install with a named step and stays untouched', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const target = codexSkillsDir(t.env.home);
    writeTree(join(target, 'department-lead'), { 'SKILL.md': 'my own\n' });
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/The plugin install failed: the skill export stopped.*department-lead/);
    expect(snapshot(join(target, 'department-lead'))).toEqual({ 'SKILL.md': 'my own\n' });
  });

  it('update (not --check) fails cleanly on a conflict: exit 1, a named step, nothing changed', async () => {
    const t = installedOn('codex', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const target = codexSkillsDir(t.env.home);
    writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'my edit\n');
    const before = snapshot(target);
    expect(await main(['update'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/The plugin update failed: the skill export stopped: .*department-lead \(a trellis-crew copy edited since export\)/);
    expect(snapshot(target)).toEqual(before);
  });

  it('writes only under the home the Env gives, never under the project folder', async () => {
    const home = makeFixtureHome();
    const project = makeFixtureHome();
    const t = installedOn('codex', 'file-mailbox');
    const deps = { ...t.deps, env: makeTestEnv({ home, cwd: project }) };
    expect(await main(['install', '--harness', 'codex'], deps)).toBe(0);
    expect(readdirSync(project)).toEqual([]);
    const approved = approvedSkills(repoRoot);
    if (!approved.ok) throw new Error(approved.message);
    expect(readdirSync(codexSkillsDir(home)).sort()).toEqual(approved.skills.map((s) => s.name).sort());
    expect(relative(home, codexSkillsDir(home)).startsWith('..')).toBe(false);
  });
});

/**
 * Finds each line in `text` that sets CODEX_HOME: an assignment, or a key
 * in an object literal. This is a heuristic line scan, not a parser. It
 * catches the common forms; a computed key or a value built at run time
 * could pass it, so review still owns that case.
 */
function codexHomeWrites(text: string): string[] {
  const patterns = [
    /\bCODEX_HOME\s*=(?!=)/,
    /\[\s*['"`]CODEX_HOME['"`]\s*\]\s*=(?!=)/,
    /(?:^|[{,\s])['"`]?CODEX_HOME['"`]?\s*:/,
    /\bCODEX_HOME\s*,?\s*(?:\.\.\.|})/,
  ];
  return text.split('\n').filter((line) => patterns.some((p) => p.test(line)));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => join(dir, rel))
    .filter((abs) => lstatSync(abs).isFile());
}

describe('CODEX_HOME', () => {
  it('the heuristic scan finds an assignment or an env key, and passes a read', () => {
    expect(codexHomeWrites('process.env.CODEX_HOME = dir;')).toHaveLength(1);
    expect(codexHomeWrites("env['CODEX_HOME'] = dir;")).toHaveLength(1);
    expect(codexHomeWrites('const vars = { ...env, CODEX_HOME: dir };')).toHaveLength(1);
    expect(codexHomeWrites("const vars = { 'CODEX_HOME': dir };")).toHaveLength(1);
    expect(codexHomeWrites('const vars = { ...env, CODEX_HOME };')).toHaveLength(1);
    expect(codexHomeWrites('codexHome: nonEmpty(process.env.CODEX_HOME),')).toEqual([]);
    expect(codexHomeWrites('if (process.env.CODEX_HOME === dir) {}')).toEqual([]);
    expect(codexHomeWrites(' * reader of HOME, PATH, CLAUDE_CONFIG_DIR, and CODEX_HOME. Every other')).toEqual([]);
  });

  it('no source file under src/ sets CODEX_HOME (heuristic scan)', () => {
    const files = sourceFiles(join(repoRoot, 'src'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(codexHomeWrites(readFileSync(file, 'utf8')), file).toEqual([]);
  });
});

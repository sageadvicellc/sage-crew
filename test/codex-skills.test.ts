import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexSkillsDir } from '../src/adapters/codex.ts';
import {
  approvedSkills,
  checkSkills,
  exportSkills,
  SKILL_MARKER,
  treeHash,
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

/** Every file under `dir`, as relative path and text, for a before-and-after comparison. */
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

function writeMarker(dir: string, skill: string, owner = 'trellis-crew'): void {
  writeFileSync(join(dir, SKILL_MARKER), JSON.stringify({ owner, skill, sha256: '0'.repeat(64) }));
}

function dotEntries(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.'));
}

const TWO = { alpha: { 'SKILL.md': 'alpha v1\n', 'refs/notes.md': 'alpha notes\n' }, beta: { 'SKILL.md': 'beta v1\n' } };

function freshHome(): { home: string; target: string } {
  const home = makeFixtureHome();
  return { home, target: codexSkillsDir(home) };
}

describe('approved skills', () => {
  it('reads the skills list from the plugin manifest', () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const approved = approvedSkills(root);
    expect(approved).toEqual({
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

  it('a missing manifest fails with a named reason', () => {
    const root = makeFixtureHome();
    const approved = approvedSkills(root);
    expect(approved.ok).toBe(false);
    expect(!approved.ok && approved.message).toMatch(/plugin manifest .*plugin\.json.* could not be read/);
  });

  it('an unreadable manifest fails with a named reason', () => {
    const root = standInPackage(TWO, ['alpha']);
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{ not json');
    const approved = approvedSkills(root);
    expect(!approved.ok && approved.message).toMatch(/plugin manifest .*plugin\.json.* could not be read/);
  });

  it('a manifest with no skills list fails with a named reason', () => {
    const root = standInPackage(TWO, []);
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'trellis-crew' }));
    const approved = approvedSkills(root);
    expect(!approved.ok && approved.message).toMatch(/has no skills list/);
  });

  it('a listed skill with no folder fails with a named reason', () => {
    const root = standInPackage(TWO, ['alpha', 'gamma']);
    const approved = approvedSkills(root);
    expect(!approved.ok && approved.message).toMatch(/approved skill gamma has no folder/);
  });

  it('a listed entry outside the skills folder is refused', () => {
    for (const entry of ['../outside/', './skills/../x/', './skills/a/b/', '/skills/alpha/', './skills/.hidden/', 7]) {
      const root = standInPackage(TWO, []);
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: [entry] }));
      const approved = approvedSkills(root);
      expect(approved.ok, String(entry)).toBe(false);
      expect(!approved.ok && approved.message, String(entry)).toMatch(/not a skill folder under skills\//);
    }
  });

  it('a listed skill whose folder is a link is refused', () => {
    const root = standInPackage({ alpha: TWO.alpha }, ['alpha', 'beta']);
    const elsewhere = makeFixtureHome();
    symlinkSync(elsewhere, join(root, 'skills', 'beta'));
    const approved = approvedSkills(root);
    expect(!approved.ok && approved.message).toMatch(/approved skill beta has no folder/);
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
    const exec = treeHash(dir);
    expect(exec).not.toBe(base);
    chmodSync(join(dir, 'SKILL.md'), 0o644);
    expect(treeHash(dir)).toBe(base);
    mkdirSync(join(dir, 'empty'));
    expect(treeHash(dir)).not.toBe(base);
    rmSync(join(dir, 'empty'), { recursive: true });

    const moved = makeFixtureHome();
    writeTree(moved, { 'SKILL.md': 'alpha v1\n', 'refs/notes2.md': 'alpha notes\n' });
    expect(treeHash(moved)).not.toBe(base);
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
    const { target } = freshHome();
    const lines: string[] = [];
    expect(exportSkills(target, (l) => lines.push(l), root)).toEqual({ ok: true });
    expect(readdirSync(target).sort()).toEqual(['alpha', 'beta']);
    for (const name of ['alpha', 'beta'] as const) {
      const copy = join(target, name);
      const source = join(root, 'skills', name);
      expect(snapshot(copy)).toEqual({ ...snapshot(source), [SKILL_MARKER]: expect.any(String) });
      expect(marker(copy)).toEqual({ owner: 'trellis-crew', skill: name, sha256: treeHash(source) });
    }
    expect(lines.join('\n')).toContain(target);
  });

  it('an unlisted package folder is not exported', () => {
    const root = standInPackage({ ...TWO, private: { 'SKILL.md': 'not approved\n' } }, ['alpha', 'beta']);
    const { target } = freshHome();
    expect(exportSkills(target, () => {}, root)).toEqual({ ok: true });
    expect(existsSync(join(target, 'private'))).toBe(false);
    expect(readdirSync(target).sort()).toEqual(['alpha', 'beta']);
  });

  it('a second install replaces an owned folder and removes a stale owned one, and touches nothing else', () => {
    const { target } = freshHome();
    const first = standInPackage(TWO, ['alpha', 'beta']);
    expect(exportSkills(target, () => {}, first)).toEqual({ ok: true });
    writeFileSync(join(target, 'alpha', 'leftover.txt'), 'old');
    writeTree(join(target, 'users-own'), { 'SKILL.md': 'mine\n' });
    writeTree(join(target, '.dot-folder'), { 'x.md': 'mine\n' });
    writeFileSync(join(target, 'loose.md'), 'mine\n');
    const othersBefore = {
      own: snapshot(join(target, 'users-own')),
      dot: snapshot(join(target, '.dot-folder')),
    };

    const second = standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']);
    const lines: string[] = [];
    expect(exportSkills(target, (l) => lines.push(l), second)).toEqual({ ok: true });
    expect(snapshot(join(target, 'alpha'))).toEqual({ 'SKILL.md': 'alpha v2\n', [SKILL_MARKER]: expect.any(String) });
    expect(marker(join(target, 'alpha'))).toMatchObject({ sha256: treeHash(join(second, 'skills', 'alpha')) });
    expect(existsSync(join(target, 'beta'))).toBe(false);
    expect(lines.join('\n')).toMatch(/Removed the stale skill beta/);
    expect(snapshot(join(target, 'users-own'))).toEqual(othersBefore.own);
    expect(snapshot(join(target, '.dot-folder'))).toEqual(othersBefore.dot);
    expect(readFileSync(join(target, 'loose.md'), 'utf8')).toBe('mine\n');
    expect(readdirSync(target).sort()).toEqual(['.dot-folder', 'alpha', 'loose.md', 'users-own']);
  });

  it('a folder whose marker names another skill or owner is not owned, so it is never removed as stale', () => {
    const { target } = freshHome();
    writeTree(join(target, 'gamma'), { 'SKILL.md': 'x\n' });
    writeMarker(join(target, 'gamma'), 'other-name');
    writeTree(join(target, 'delta'), { 'SKILL.md': 'x\n' });
    writeMarker(join(target, 'delta'), 'delta', 'someone-else');
    writeTree(join(target, 'epsilon'), { 'SKILL.md': 'x\n' });
    writeFileSync(join(target, 'epsilon', SKILL_MARKER), '{ broken');
    const root = standInPackage(TWO, ['alpha']);
    expect(exportSkills(target, () => {}, root)).toEqual({ ok: true });
    for (const name of ['gamma', 'delta', 'epsilon']) expect(existsSync(join(target, name, 'SKILL.md')), name).toBe(true);
  });

  it('a marker that is a link does not make a folder owned', () => {
    const { target } = freshHome();
    const real = makeFixtureHome();
    writeMarker(real, 'beta');
    writeTree(join(target, 'beta'), { 'SKILL.md': 'mine\n' });
    symlinkSync(join(real, SKILL_MARKER), join(target, 'beta', SKILL_MARKER));
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const result = exportSkills(target, () => {}, root);
    expect(result.ok).toBe(false);
    expect(readFileSync(join(target, 'beta', 'SKILL.md'), 'utf8')).toBe('mine\n');
  });

  it('a user folder with the same name is untouched, fails the export, and nothing is changed', () => {
    const { target } = freshHome();
    writeTree(join(target, 'beta'), { 'SKILL.md': 'my own beta\n' });
    const before = snapshot(target);
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const result = exportSkills(target, () => {}, root);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/skill export stopped.*beta/);
    expect(!result.ok && result.message).toContain(join(target, 'beta'));
    expect(snapshot(target)).toEqual(before);
  });

  it('a link in place of a target is refused and left alone', () => {
    const { target } = freshHome();
    const elsewhere = makeFixtureHome();
    writeTree(elsewhere, { 'SKILL.md': 'linked\n' });
    writeMarker(elsewhere, 'alpha');
    mkdirSync(target, { recursive: true });
    symlinkSync(elsewhere, join(target, 'alpha'));
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const result = exportSkills(target, () => {}, root);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/alpha \(a symbolic link\)/);
    expect(lstatSync(join(target, 'alpha')).isSymbolicLink()).toBe(true);
    expect(snapshot(elsewhere)).toEqual({ 'SKILL.md': 'linked\n', [SKILL_MARKER]: expect.any(String) });
  });

  it('a link in place of ~/.agents/skills or ~/.agents is refused', () => {
    const root = standInPackage(TWO, ['alpha']);
    const skillsLink = freshHome();
    const elsewhere = makeFixtureHome();
    mkdirSync(dirname(skillsLink.target));
    symlinkSync(elsewhere, skillsLink.target);
    const one = exportSkills(skillsLink.target, () => {}, root);
    expect(!one.ok && one.message).toMatch(/symbolic link/);
    expect(readdirSync(elsewhere)).toEqual([]);

    const agentsLink = freshHome();
    symlinkSync(elsewhere, dirname(agentsLink.target));
    const two = exportSkills(agentsLink.target, () => {}, root);
    expect(!two.ok && two.message).toMatch(/symbolic link/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('a link inside an approved source folder stops the export before anything is written', () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    symlinkSync(join(root, 'skills', 'alpha', 'SKILL.md'), join(root, 'skills', 'beta', 'link.md'));
    const { target } = freshHome();
    const result = exportSkills(target, () => {}, root);
    expect(!result.ok && result.message).toMatch(/symbolic link/);
    expect(existsSync(join(target, 'alpha'))).toBe(false);
  });

  it('a missing manifest stops the export with a named reason', () => {
    const { target } = freshHome();
    const result = exportSkills(target, () => {}, makeFixtureHome());
    expect(!result.ok && result.message).toMatch(/plugin manifest/);
    expect(existsSync(target)).toBe(false);
  });

  it('leaves no temp folder behind', () => {
    const { target } = freshHome();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    exportSkills(target, () => {}, root);
    exportSkills(target, () => {}, root);
    expect(dotEntries(target)).toEqual([]);
    writeTree(join(target, 'gamma'), { 'SKILL.md': 'mine\n' });
    const listed = standInPackage({ ...TWO, gamma: { 'SKILL.md': 'g\n' } }, ['alpha', 'beta', 'gamma']);
    expect(exportSkills(target, () => {}, listed).ok).toBe(false);
    expect(dotEntries(target)).toEqual([]);
  });
});

describe('drift check', () => {
  it('reports each of the five states', () => {
    const { target } = freshHome();
    const skills = {
      steady: { 'SKILL.md': 's\n' },
      drift: { 'SKILL.md': 'd\n' },
      gone: { 'SKILL.md': 'g\n' },
      mine: { 'SKILL.md': 'm\n' },
      old: { 'SKILL.md': 'o\n' },
    };
    const before = standInPackage(skills, ['steady', 'drift', 'gone', 'old']);
    expect(exportSkills(target, () => {}, before)).toEqual({ ok: true });
    writeFileSync(join(target, 'drift', 'SKILL.md'), 'D\n');
    rmSync(join(target, 'gone'), { recursive: true });
    writeTree(join(target, 'mine'), { 'SKILL.md': 'my own\n' });
    const listing = snapshot(target);

    const now = standInPackage(skills, ['steady', 'drift', 'gone', 'mine']);
    const check = checkSkills(target, now);
    expect(check).toEqual({
      ok: true,
      skills: [
        { skill: 'steady', state: 'in-step', path: join(target, 'steady') },
        { skill: 'drift', state: 'drifted', path: join(target, 'drift') },
        { skill: 'gone', state: 'missing', path: join(target, 'gone') },
        { skill: 'mine', state: 'not-owned', path: join(target, 'mine') },
        { skill: 'old', state: 'stale', path: join(target, 'old') },
      ],
    });
    expect(snapshot(target)).toEqual(listing);
  });

  it('an owned copy with a link inside it counts as drifted', () => {
    const { target } = freshHome();
    const root = standInPackage(TWO, ['alpha']);
    exportSkills(target, () => {}, root);
    symlinkSync(join(target, 'alpha', 'SKILL.md'), join(target, 'alpha', 'link.md'));
    expect(checkSkills(target, root)).toMatchObject({ ok: true, skills: [{ skill: 'alpha', state: 'drifted' }] });
  });

  it('a link in place of a target counts as not owned', () => {
    const { target } = freshHome();
    mkdirSync(target, { recursive: true });
    symlinkSync(makeFixtureHome(), join(target, 'alpha'));
    const root = standInPackage(TWO, ['alpha']);
    expect(checkSkills(target, root)).toMatchObject({ ok: true, skills: [{ skill: 'alpha', state: 'not-owned' }] });
  });

  it('with no skills folder, every approved skill is missing', () => {
    const { target } = freshHome();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const check = checkSkills(target, root);
    expect(check.ok && check.skills.map((s) => s.state)).toEqual(['missing', 'missing']);
  });

  it('a link in place of the skills folder fails the check', () => {
    const { target } = freshHome();
    mkdirSync(dirname(target));
    symlinkSync(makeFixtureHome(), target);
    const check = checkSkills(target, standInPackage(TWO, ['alpha']));
    expect(!check.ok && check.message).toMatch(/symbolic link/);
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
    writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'edited\n');
    rmSync(join(target, 'department-auditor'), { recursive: true });
    writeTree(join(target, 'retired-skill'), { 'SKILL.md': 'old\n' });
    writeMarker(join(target, 'retired-skill'), 'retired-skill');
    const before = snapshot(t.env.home);
    expect(await main(['update', '--check'], t.deps)).toBe(1);
    expect(t.out.text()).toContain('Skill department-lead: drifted.');
    expect(t.out.text()).toContain('Skill department-auditor: missing.');
    expect(t.out.text()).toContain('Skill retired-skill: stale.');
    expect(t.err.text()).toMatch(/department-lead/);
    expect(t.err.text()).toMatch(/department-auditor/);
    expect(t.err.text()).toMatch(/retired-skill/);
    expect(snapshot(t.env.home)).toEqual(before);
  });

  for (const [state, breakIt] of [
    ['drifted', (target: string) => writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'x')],
    ['missing', (target: string) => rmSync(join(target, 'department-lead'), { recursive: true })],
    [
      'stale',
      (target: string) => {
        writeTree(join(target, 'retired-skill'), { 'SKILL.md': 'old\n' });
        writeMarker(join(target, 'retired-skill'), 'retired-skill');
      },
    ],
  ] as const) {
    it(`exits 1 on ${state} alone`, async () => {
      const t = installed();
      expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
      breakIt(codexSkillsDir(t.env.home));
      expect(await main(['update', '--check'], t.deps)).toBe(1);
    });
  }

  it('a user folder with a skill name is reported as not owned, and does not fail the check', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const target = codexSkillsDir(t.env.home);
    rmSync(join(target, 'department-lead'), { recursive: true });
    writeTree(join(target, 'department-lead'), { 'SKILL.md': 'my own\n' });
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    expect(t.out.text()).toMatch(/Skill department-lead: not owned\./);
  });
});

describe('install on Codex CLI', () => {
  it('a user folder with a skill name fails the install with a named step and stays untouched', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const target = codexSkillsDir(t.env.home);
    writeTree(join(target, 'department-lead'), { 'SKILL.md': 'my own\n' });
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/The plugin install failed: the skill export stopped.*department-lead/);
    expect(snapshot(join(target, 'department-lead'))).toEqual({ 'SKILL.md': 'my own\n' });
  });

  it('writes only under the home the Env gives, never under the project folder', async () => {
    const home = makeFixtureHome();
    const project = makeFixtureHome();
    const t = installedOn('codex', 'file-mailbox');
    const env = makeTestEnv({ home, cwd: project });
    const deps = { ...t.deps, env };
    expect(await main(['install', '--harness', 'codex'], deps)).toBe(0);
    expect(readdirSync(project)).toEqual([]);
    const approved = approvedSkills(repoRoot);
    if (!approved.ok) throw new Error(approved.message);
    expect(readdirSync(codexSkillsDir(home)).sort()).toEqual(approved.skills.map((s) => s.name).sort());
    expect(relative(home, codexSkillsDir(home)).startsWith('..')).toBe(false);
  });
});

/** Finds each line in `text` that sets CODEX_HOME: an assignment, or a key in an object literal. */
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
  it('the scan finds an assignment or an env key, and passes a read', () => {
    expect(codexHomeWrites('process.env.CODEX_HOME = dir;')).toHaveLength(1);
    expect(codexHomeWrites("env['CODEX_HOME'] = dir;")).toHaveLength(1);
    expect(codexHomeWrites('const vars = { ...env, CODEX_HOME: dir };')).toHaveLength(1);
    expect(codexHomeWrites("const vars = { 'CODEX_HOME': dir };")).toHaveLength(1);
    expect(codexHomeWrites('const vars = { ...env, CODEX_HOME };')).toHaveLength(1);
    expect(codexHomeWrites('codexHome: nonEmpty(process.env.CODEX_HOME),')).toEqual([]);
    expect(codexHomeWrites('if (process.env.CODEX_HOME === dir) {}')).toEqual([]);
    expect(codexHomeWrites(' * reader of HOME, PATH, CLAUDE_CONFIG_DIR, and CODEX_HOME. Every other')).toEqual([]);
  });

  it('no source file under src/ sets CODEX_HOME', () => {
    const files = sourceFiles(join(repoRoot, 'src'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(codexHomeWrites(readFileSync(file, 'utf8')), file).toEqual([]);
  });
});

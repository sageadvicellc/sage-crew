import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { codexAdapter, codexExecArgs } from '../src/adapters/codex.ts';
import { ROLE_SKILLS, ROLE_TEXT_MAX_BYTES, readRoleInstructions, roleInstructionsArgs, tomlString } from '../src/adapters/codex-instructions.ts';
import type { SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import { main } from '../src/cli.ts';
import { ROLES, type Role } from '../src/roles/schema.ts';
import { writeInstallRecord } from '../src/store/install-yml.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { capture } from './helpers/io.ts';
import { fixtureBin, repoRoot } from './helpers/paths.ts';
import { recordingRunner } from './helpers/recording-runner.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn } from './helpers/team.ts';

/** The shipped skill's body, with its front matter cut off here, apart from the code under test. */
function shippedBody(role: Role): string {
  const raw = readFileSync(join(repoRoot, 'skills', ROLE_SKILLS[role], 'SKILL.md'), 'utf8');
  expect(raw.startsWith('---\n')).toBe(true);
  const close = raw.indexOf('\n---\n', 3);
  expect(close).toBeGreaterThan(0);
  return raw.slice(close + '\n---\n'.length).replace(/^\n+/, '');
}

/** The text a `-c developer_instructions=...` pair carries, parsed as TOML the way Codex parses it. */
function instructionsOf(args: readonly string[]): string {
  const at = args.indexOf('-c');
  expect(at).toBeGreaterThanOrEqual(0);
  const pair = args[at + 1] as string;
  expect(pair.startsWith('developer_instructions=')).toBe(true);
  const parsed = parse(pair) as { developer_instructions?: unknown };
  expect(typeof parsed.developer_instructions).toBe('string');
  return parsed.developer_instructions as string;
}

function writeSkill(dir: string, role: Role, text: string): string {
  const folder = join(dir, ROLE_SKILLS[role]);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'SKILL.md');
  writeFileSync(path, text);
  return path;
}

/** Every file under a folder, skipping .git and node_modules. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

describe('tomlString', () => {
  it('writes the exact TOML basic string for a fixed input', () => {
    const input = 'a"b\\c\nd\te\u0001f\u007fg\b\f\r"""é';
    expect(tomlString(input)).toBe(String.raw`"a\"b\\c\nd\te\u0001f\u007Fg\b\f\r\"\"\"é"`);
  });

  it('escapes every control character, so the value stays on one line', () => {
    let controls = '';
    for (let code = 0; code <= 0x1f; code += 1) controls += String.fromCharCode(code);
    controls += '\u007f';
    const out = tomlString(controls);
    expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(out.startsWith('"') && out.endsWith('"')).toBe(true);
  });

  it.each([
    ['double quotes', 'say "hi" and ""'],
    ['backslashes', 'C:\\path\\to\\ and \\n as text and \\\\'],
    ['newlines', 'one\ntwo\r\nthree\n'],
    ['tabs', 'a\tb\t\tc'],
    ['triple double quotes', 'x """ y """'],
    ['triple single quotes', "x ''' y '''"],
    ['a control character', 'bell\u0007 nul\u0000 del\u007f esc\u001b'],
    ['non-ASCII text', 'café, 日本語, emoji 😀, and a right-to-left mark \u200f'],
    ['an empty string', ''],
    ['role text', 'role text'],
  ])('round-trips %s through a TOML parser', (_label, text) => {
    const parsed = parse(`developer_instructions=${tomlString(text)}`) as { developer_instructions: string };
    expect(parsed.developer_instructions).toBe(text);
  });

  it('refuses a lone surrogate', () => {
    expect(() => tomlString('a\ud800b')).toThrow(/lone surrogate/);
    expect(() => tomlString('a\udc00')).toThrow(/lone surrogate/);
  });
});

describe('role instructions from the default team', () => {
  it.each(ROLES.map((role) => [role]))('%s gets its shipped skill body through -c developer_instructions', (role) => {
    const args = roleInstructionsArgs(role);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    const body = shippedBody(role);
    expect(body.length).toBeGreaterThan(0);
    expect(body.startsWith('---')).toBe(false);
    expect(instructionsOf(args)).toBe(body);
  });

  it('maps each role to its department skill', () => {
    expect(ROLE_SKILLS).toEqual({
      lead: 'department-lead',
      standby: 'department-standby',
      auditor: 'department-auditor',
      'reporting-chain': 'department-reporting-chain',
    });
  });

  it('places the instructions after exec and before the prompt', () => {
    const args = codexExecArgs([], 'the kickoff', 'lead');
    expect(args[0]).toBe('exec');
    expect(args.at(-1)).toBe('the kickoff');
    const at = args.indexOf('-c');
    expect(at).toBeGreaterThan(0);
    expect(at + 1).toBeLessThan(args.length - 1);
    expect(instructionsOf(args)).toBe(shippedBody('lead'));
  });

  it('start gives each supervised session the skill for its role', async () => {
    const t = installedOn('codex', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    const roleOf: Record<string, Role> = {
      'personal-assistant': 'reporting-chain',
      main: 'lead',
      benchmark: 'auditor',
      'worker-1': 'standby',
      'worker-2': 'standby',
      'worker-3': 'standby',
    };
    expect(job.sessions.map((s) => s.name).sort()).toEqual(Object.keys(roleOf).sort());
    for (const session of job.sessions) {
      expect(session.args[0]).toBe('exec');
      expect(session.args.indexOf('-c')).toBeLessThan(session.args.length - 1);
      expect(instructionsOf(session.args)).toBe(shippedBody(roleOf[session.name] as Role));
    }
  });

  it('launch, the respawn path, gives the one session its role skill before the prompt', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {} };
    const outcome = await codexAdapter.launch('benchmark', 'the kickoff', [], ctx, 'auditor');
    expect(outcome.ok).toBe(true);
    const args = t.runner.calls[0]?.args ?? [];
    expect(args[0]).toBe('exec');
    expect(args.at(-1)).toBe('the kickoff');
    expect(instructionsOf(args)).toBe(shippedBody('auditor'));
  });
});

describe('reading a role skill', () => {
  it('stops with the named step when the skill file is missing', () => {
    const dir = makeFixtureHome();
    expect(() => readRoleInstructions('lead', dir)).toThrow(/^role instructions for lead: .*department-lead.*SKILL\.md: the file does not exist$/);
  });

  it('stops when the skill file is larger than 64 KiB, and reads one at the cap', () => {
    expect(ROLE_TEXT_MAX_BYTES).toBe(64 * 1024);
    const dir = makeFixtureHome();
    const head = '---\nname: x\n---\n';
    writeSkill(dir, 'standby', head + 'r'.repeat(ROLE_TEXT_MAX_BYTES - head.length));
    expect(readRoleInstructions('standby', dir)).toBe('r'.repeat(ROLE_TEXT_MAX_BYTES - head.length));
    writeSkill(dir, 'standby', head + 'r'.repeat(ROLE_TEXT_MAX_BYTES - head.length + 1));
    expect(() => readRoleInstructions('standby', dir)).toThrow(/^role instructions for standby: .*larger than 65536 bytes/);
  });

  it('follows no symbolic link, for the file or its folder', () => {
    const dir = makeFixtureHome();
    const real = join(makeFixtureHome(), 'real.md');
    writeFileSync(real, '---\nname: x\n---\nrole text\n');
    mkdirSync(join(dir, ROLE_SKILLS.auditor));
    symlinkSync(real, join(dir, ROLE_SKILLS.auditor, 'SKILL.md'));
    expect(() => readRoleInstructions('auditor', dir)).toThrow(/^role instructions for auditor: .*symbolic link/);

    const other = makeFixtureHome();
    writeSkill(other, 'lead', '---\nname: x\n---\nrole text\n');
    symlinkSync(join(other, ROLE_SKILLS.lead), join(dir, ROLE_SKILLS.lead));
    expect(() => readRoleInstructions('lead', dir)).toThrow(/^role instructions for lead: .*symbolic link/);
  });

  it('uses the body after the front matter, and a file with no front matter whole', () => {
    const dir = makeFixtureHome();
    writeSkill(dir, 'lead', '---\nname: x\ndescription: y\n---\n\nrole text\n');
    expect(readRoleInstructions('lead', dir)).toBe('role text\n');
    writeSkill(dir, 'standby', 'role text\n');
    expect(readRoleInstructions('standby', dir)).toBe('role text\n');
    writeSkill(dir, 'auditor', '---\r\nname: x\r\n---\r\nrole text\r\n');
    expect(readRoleInstructions('auditor', dir)).toBe('role text\r\n');
  });

  it('stops on front matter that never closes, and on an empty body', () => {
    const dir = makeFixtureHome();
    writeSkill(dir, 'lead', '---\nname: x\nrole text\n');
    expect(() => readRoleInstructions('lead', dir)).toThrow(/^role instructions for lead: .*front matter never closes/);
    writeSkill(dir, 'standby', '---\nname: x\n---\n\n  \n');
    expect(() => readRoleInstructions('standby', dir)).toThrow(/^role instructions for standby: .*no text after the front matter/);
  });

  it('refuses a skill folder that is not a regular file', () => {
    const dir = makeFixtureHome();
    mkdirSync(join(dir, ROLE_SKILLS.lead, 'SKILL.md'), { recursive: true });
    expect(() => readRoleInstructions('lead', dir)).toThrow(/^role instructions for lead: .*not a regular file/);
  });
});

describe('role text stays out of the repository', () => {
  it('a roles file passed with --roles is read in place, and nothing lands in the project', async () => {
    const repo = makeFixtureRepo();
    repo.write('README.md', 'a project\n');
    repo.commit('first');
    const env = makeTestEnv({ cwd: repo.root });
    writeInstallRecord(env, { harness: 'codex', transport: 'file-mailbox', plugin_version: '0.1.0' });
    const elsewhere = makeFixtureHome();
    const rolesFile = join(elsewhere, 'team.yml');
    const marker = 'role text from the roles file';
    writeFileSync(rolesFile, SMALL_TEAM.replace('You lead.', marker));
    const runner = recordingRunner();
    const out = capture();
    const err = capture();
    expect(await main(['start', '--roles', rolesFile], { env, runner, out: out.write, err: err.write })).toBe(0);

    expect(repo.git('status', '--porcelain', '--untracked-files=all', '--ignored')).toBe('');
    const lead = shippedBody('lead');
    for (const file of filesUnder(repo.root)) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes(marker), file).toBe(false);
      expect(text.includes(lead), file).toBe(false);
    }

    // The session's instructions come from the shipped skill, never from the roles file.
    const spawn = runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    const boss = job.sessions.find((s) => s.name === 'boss');
    expect(instructionsOf(boss?.args ?? [])).toBe(lead);
    expect(instructionsOf(boss?.args ?? []).includes(marker)).toBe(false);
  });

  // The docs/ addenda are the source the shipped skills were written from, so
  // they share lines with them by design. Code and tests read the skills at
  // run time and hold no copy.
  it('no file in src or test holds a copy of a shipped role skill', () => {
    const files = ['src', 'test'].flatMap((dir) => filesUnder(join(repoRoot, dir)));
    for (const role of ROLES) {
      const lines = shippedBody(role)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 40);
      expect(lines.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const line of lines) expect(text.includes(line), `${file} holds a line of ${ROLE_SKILLS[role]}`).toBe(false);
      }
    }
  });
});

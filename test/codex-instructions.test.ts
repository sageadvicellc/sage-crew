import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { codexAdapter, codexExecArgs } from '../src/adapters/codex.ts';
import {
  ROLE_ARG_MAX_BYTES,
  ROLE_SKILLS,
  ROLE_TEXT_MAX_BYTES,
  RoleInstructionsError,
  readRoleInstructions,
  roleInstructionsArgs,
  tomlString,
} from '../src/adapters/codex-instructions.ts';
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

/**
 * The shipped skill's body, read by the real parser. The checks here hold
 * it to the file on disk without parsing it a second way: the body is the
 * file's tail, and what comes before it is the skill's own front matter.
 */
function shippedBody(role: Role): string {
  const raw = readFileSync(join(repoRoot, 'skills', ROLE_SKILLS[role], 'SKILL.md'), 'utf8');
  const body = readRoleInstructions(role);
  expect(body.trim().length).toBeGreaterThan(0);
  expect(raw.endsWith(body)).toBe(true);
  const head = raw.slice(0, raw.length - body.length);
  expect(head.startsWith('---\n')).toBe(true);
  expect(head).toContain(`\nname: ${ROLE_SKILLS[role]}\n`);
  expect(head).toMatch(/\n---\n\n*$/);
  expect(body).not.toContain(`name: ${ROLE_SKILLS[role]}`);
  return body;
}

/** A seeded pseudo-random generator (mulberry32), so a failing case can be run again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTROL_CODES = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f];

/** One piece of a generated string. None of them is a lone surrogate. */
function piece(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  switch (Math.floor(random() * 8)) {
    case 0:
      return String.fromCharCode(0x20 + Math.floor(random() * 0x5f));
    case 1:
      return String.fromCharCode(pick(CONTROL_CODES));
    case 2:
      return pick(['"', '\\', '"""', "'''"]);
    case 3:
      return pick(['\r', '\n', '\r\n']);
    case 4: {
      // A BMP character outside the surrogate range.
      const code = 0x80 + Math.floor(random() * (0xd800 - 0x80));
      return String.fromCharCode(code);
    }
    case 5:
      return String.fromCharCode(0xe000 + Math.floor(random() * (0x10000 - 0xe000)));
    case 6:
      return String.fromCodePoint(0x10000 + Math.floor(random() * 0x100000));
    default:
      return pick(['\u0085', ' ', ' ']);
  }
}

function generated(random: () => number): string {
  const length = Math.floor(random() * 201);
  let out = '';
  while (out.length < length) out += piece(random);
  return out;
}

/** Puts one lone surrogate into a string, fenced by ASCII so it can never pair up. */
function withLoneSurrogate(random: () => number, text: string): string {
  const lone = random() < 0.5 ? String.fromCharCode(0xd800 + Math.floor(random() * 0x400)) : String.fromCharCode(0xdc00 + Math.floor(random() * 0x400));
  // Cut only between whole code points.
  const points = Array.from(text);
  const at = Math.floor(random() * (points.length + 1));
  return [...points.slice(0, at), 'x', lone, 'x', ...points.slice(at)].join('');
}

const PROPERTY_SEED = 0x28c0de;
const PROPERTY_RUNS = 1000;

/** The text a `-c developer_instructions=...` pair carries, parsed as TOML the way Codex parses it. */
function instructionsOf(args: readonly string[]): string {
  const pairs = args.filter((arg, i) => args[i - 1] === '-c' && arg.startsWith('developer_instructions='));
  expect(pairs).toHaveLength(1);
  const pair = pairs[0] as string;
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

  it.each(CONTROL_CODES.map((code) => [`U+${code.toString(16).toUpperCase().padStart(4, '0')}`, String.fromCharCode(code)]))(
    'round-trips the control character %s on its own',
    (_label, text) => {
      const out = tomlString(text);
      expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect((parse(`developer_instructions=${out}`) as { developer_instructions: string }).developer_instructions).toBe(text);
    },
  );

  it('writes U+007F on its own as \\u007F', () => {
    expect(tomlString('\u007f')).toBe(String.raw`"\u007F"`);
  });

  it('passes a non-BMP character on its own through whole', () => {
    expect(tomlString('😀')).toBe('"😀"');
    expect((parse(`developer_instructions=${tomlString('😀')}`) as { developer_instructions: string }).developer_instructions).toBe('😀');
  });

  it('refuses a lone surrogate', () => {
    for (const text of ['a\ud800b', 'a\udc00', '\ud800', '😀\ud800', '\ude00\ud83d']) {
      expect(() => tomlString(text), JSON.stringify(text)).toThrow(RoleInstructionsError);
      expect(() => tomlString(text), JSON.stringify(text)).toThrow(/lone surrogate/);
    }
  });

  it(`round-trips ${PROPERTY_RUNS} seeded random strings, and refuses each one given a lone surrogate`, () => {
    const random = seeded(PROPERTY_SEED);
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const text = generated(random);
      const where = `seed ${PROPERTY_SEED}, run ${run}, input ${JSON.stringify(text)}`;
      const out = tomlString(text);
      expect(/[\u0000-\u001f\u007f]/.test(out), `raw control character in the output: ${where}`).toBe(false);
      const parsed = parse(`developer_instructions=${out}`) as { developer_instructions: string };
      expect(parsed.developer_instructions, `round trip failed: ${where}`).toBe(text);

      const broken = withLoneSurrogate(random, text);
      expect(() => tomlString(broken), `lone surrogate accepted: seed ${PROPERTY_SEED}, run ${run}, input ${JSON.stringify(broken)}`).toThrow(
        RoleInstructionsError,
      );
    }
  });
});

describe('role instructions from the default team', () => {
  it.each(ROLES.map((role) => [role]))('%s gets its shipped skill body through -c developer_instructions', (role) => {
    const args = roleInstructionsArgs(role);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    expect(instructionsOf(args)).toBe(shippedBody(role));
  });

  it('start on Codex says where the role text comes from', async () => {
    const t = installedOn('codex', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    expect(t.out.lines).toContain(
      'Role text: each Codex session gets the shipped default skill for its role. Each kickoff still comes from the roles file, or from the default team.',
    );
  });

  it('maps each role to its department skill', () => {
    expect(ROLE_SKILLS).toEqual({
      lead: 'department-lead',
      standby: 'department-standby',
      auditor: 'department-auditor',
      'reporting-chain': 'department-reporting-chain',
    });
  });

  it('places the instructions after the sandbox arguments and just before --', () => {
    const args = codexExecArgs([], 'the kickoff', undefined, 'lead');
    expect(args[0]).toBe('exec');
    expect(args.slice(-2)).toEqual(['--', 'the kickoff']);
    expect(args.at(-4)).toBe('-c');
    expect(args.at(-3)).toMatch(/^developer_instructions="/);
    expect(args.at(-5)).toMatch(/^sandbox_workspace_write\.writable_roots=/);
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
      expect(session.args.at(-4)).toBe('-c');
      expect(session.args.at(-2)).toBe('--');
      expect(instructionsOf(session.args)).toBe(shippedBody(roleOf[session.name] as Role));
    }
  });

  it('launch, the respawn path, gives the one session its role skill before the prompt', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {} };
    const outcome = await codexAdapter.launch('benchmark', 'the kickoff', [], ctx, 'auditor');
    expect(outcome.ok).toBe(true);
    const args = t.runner.calls.find((c) => c.kind === 'detached')?.args ?? [];
    expect(args[0]).toBe('exec');
    expect(args.slice(-2)).toEqual(['--', 'the kickoff']);
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

    // A folder link inside the skills folder passes the realpath check, and lstat still refuses it.
    writeSkill(dir, 'standby', '---\nname: x\n---\nrole text\n');
    symlinkSync(join(dir, ROLE_SKILLS.standby), join(dir, ROLE_SKILLS.lead));
    expect(() => readRoleInstructions('lead', dir)).toThrow(/^role instructions for lead: .*symbolic link/);
  });

  it('refuses a skill folder that resolves outside the skills folder', () => {
    const dir = makeFixtureHome();
    const other = makeFixtureHome();
    writeSkill(other, 'lead', '---\nname: x\n---\nrole text\n');
    symlinkSync(join(other, ROLE_SKILLS.lead), join(dir, ROLE_SKILLS.lead));
    expect(() => readRoleInstructions('lead', dir)).toThrow(/^role instructions for lead: .*resolves outside the skills folder/);
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

  it('strips a leading UTF-8 byte order mark', () => {
    const dir = makeFixtureHome();
    writeSkill(dir, 'lead', '﻿---\nname: x\n---\nrole text\n');
    expect(readRoleInstructions('lead', dir)).toBe('role text\n');
    writeSkill(dir, 'standby', '﻿role text\n');
    expect(readRoleInstructions('standby', dir)).toBe('role text\n');
  });

  it('reads a delimiter line with trailing spaces or tabs as a delimiter', () => {
    const dir = makeFixtureHome();
    writeSkill(dir, 'lead', '--- \nname: x\n---\t \nrole text\n');
    expect(readRoleInstructions('lead', dir)).toBe('role text\n');
  });

  it('stops when line 1 starts with --- but is not a delimiter, so no front matter goes out as instructions', () => {
    const dir = makeFixtureHome();
    for (const first of ['----', '---x', '--- name: x']) {
      writeSkill(dir, 'lead', `${first}\nname: x\n---\nrole text\n`);
      expect(() => readRoleInstructions('lead', dir), first).toThrow(/^role instructions for lead: .*line 1 starts with --- but is not a front matter delimiter/);
    }
  });

  it('keeps a --- rule inside the body', () => {
    const dir = makeFixtureHome();
    writeSkill(dir, 'lead', '---\nname: x\n---\nintro\n\n---\n\nmore\n');
    expect(readRoleInstructions('lead', dir)).toBe('intro\n\n---\n\nmore\n');
  });

  it('carries a CRLF body through the real parser and TOML unchanged', () => {
    const dir = makeFixtureHome();
    writeSkill(dir, 'auditor', '---\r\nname: x\r\n---\r\nrole text\r\nline two\r\n');
    expect(instructionsOf(roleInstructionsArgs('auditor', dir))).toBe('role text\r\nline two\r\n');
  });

  it('stops on front matter that never closes, and on an empty body', () => {
    const dir = makeFixtureHome();
    writeSkill(dir, 'lead', '---\nname: x\nrole text\n');
    expect(() => readRoleInstructions('lead', dir)).toThrow(/^role instructions for lead: .*front matter never closes/);
    writeSkill(dir, 'standby', '---\nname: x\n---\n\n  \n');
    expect(() => readRoleInstructions('standby', dir)).toThrow(/^role instructions for standby: .*no text after the front matter/);
    writeSkill(dir, 'auditor', '---\nname: x\n---');
    expect(() => readRoleInstructions('auditor', dir)).toThrow(/^role instructions for auditor: .*no text after the front matter/);
  });

  it('stops when the escaped value is over 32 KiB, even though the file is under the 64 KiB read cap', () => {
    expect(ROLE_ARG_MAX_BYTES).toBe(32 * 1024);
    const dir = makeFixtureHome();
    // 8,000 control characters: 8,000 bytes raw, 48,000 bytes once each is written as \u0001.
    const path = writeSkill(dir, 'lead', `---\nname: x\n---\n${'\u0001'.repeat(8000)}`);
    expect(() => roleInstructionsArgs('lead', dir)).toThrow(RoleInstructionsError);
    expect(() => roleInstructionsArgs('lead', dir)).toThrow(
      new RegExp(`^role instructions for lead: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: the escaped value is 48025 bytes, over the 32768-byte \\(32 KiB\\) limit, from a file of 8016 bytes$`),
    );
  });

  it('takes an escaped value of exactly 32 KiB, and stops at one byte more', () => {
    const dir = makeFixtureHome();
    // developer_instructions="<body>" is 25 bytes plus the body.
    const fits = ROLE_ARG_MAX_BYTES - 'developer_instructions=""'.length;
    writeSkill(dir, 'lead', `---\nname: x\n---\n${'r'.repeat(fits)}`);
    expect(Buffer.byteLength(roleInstructionsArgs('lead', dir)[1] as string)).toBe(ROLE_ARG_MAX_BYTES);
    writeSkill(dir, 'lead', `---\nname: x\n---\n${'r'.repeat(fits + 1)}`);
    expect(() => roleInstructionsArgs('lead', dir)).toThrow(/over the 32768-byte \(32 KiB\) limit/);
  });

  it('reads invalid UTF-8 as U+FFFD, so a file can never carry a lone surrogate', () => {
    const dir = makeFixtureHome();
    const path = writeSkill(dir, 'lead', '');
    // ED A0 80 is a surrogate written as UTF-8, which the decoder replaces.
    writeFileSync(path, Buffer.concat([Buffer.from('---\nname: x\n---\na'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('b\n')]));
    const text = instructionsOf(roleInstructionsArgs('lead', dir));
    expect(text.startsWith('a') && text.endsWith('b\n')).toBe(true);
    expect(text).toMatch(/^a�+b\n$/);
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

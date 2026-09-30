import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codexExecArgs } from '../src/adapters/codex-args.ts';
import { checkWorkdir, checkWorkdirSync } from '../src/adapters/codex-guard.ts';
import type * as Instructions from '../src/adapters/codex-instructions.ts';
import { runSupervisor } from '../src/adapters/codex-supervisor.ts';
import { main } from '../src/cli.ts';
import { readTeamFile, teamJsonPath, writeTeamFile } from '../src/store/team-json.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { capture } from './helpers/io.ts';
import { recordingRunner } from './helpers/recording-runner.ts';

// Stands in for an `npm link` install: the folder the package reads its
// skills from is set per test. Empty means the real package folder. Only
// packageSkillsDir is replaced, so role text is still read from the
// shipped skills.
const state = vi.hoisted(() => ({ skillsDir: '' }));

vi.mock('../src/adapters/codex-instructions.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Instructions>();
  return { ...actual, packageSkillsDir: () => (state.skillsDir === '' ? actual.packageSkillsDir() : state.skillsDir) };
});

const INSIDE = /this package's skills folder, .+, is inside it, so a session could change the role text that every later start sends/;

beforeEach(() => {
  state.skillsDir = '';
});

/** A fresh worktree top with a `skills` folder in it, as a trellis-crew checkout has. */
function checkoutRepo(): string {
  const root = makeFixtureRepo().root;
  mkdirSync(join(root, 'skills', 'department-lead'), { recursive: true });
  writeFileSync(join(root, 'skills', 'department-lead', 'SKILL.md'), 'role text\n');
  return root;
}

describe('the Codex working folder must not hold the package skills folder', () => {
  it('refuses a working folder that holds the skills folder, through the sync check, naming both paths', () => {
    const root = checkoutRepo();
    state.skillsDir = join(root, 'skills');
    const problem = checkWorkdirSync(root, makeFixtureHome());
    expect(problem).toMatch(INSIDE);
    expect(problem).toContain(`${root}:`);
    expect(problem).toContain(join(root, 'skills'));
  });

  it('refuses a working folder that is the skills folder itself', () => {
    const root = checkoutRepo();
    state.skillsDir = root;
    expect(checkWorkdirSync(root, makeFixtureHome())).toMatch(/this package's skills folder, .+, is the working folder itself/);
  });

  it('refuses it through the runner check too', async () => {
    const root = checkoutRepo();
    state.skillsDir = join(root, 'skills');
    expect(await checkWorkdir(makeTestEnv({ cwd: root }), recordingRunner())).toMatch(INSIDE);
  });

  it('passes a working folder when the skills folder is outside it', async () => {
    const root = checkoutRepo();
    const elsewhere = makeFixtureHome();
    mkdirSync(join(elsewhere, 'skills'));
    state.skillsDir = join(elsewhere, 'skills');
    expect(checkWorkdirSync(root, makeFixtureHome())).toBeUndefined();
    expect(await checkWorkdir(makeTestEnv({ cwd: root }), recordingRunner())).toBeUndefined();
  });

  it('up --harness codex refuses it and starts nothing', async () => {
    const root = checkoutRepo();
    state.skillsDir = join(root, 'skills');
    const env = makeTestEnv({ cwd: root });
    const runner = recordingRunner();
    const out = capture();
    const err = capture();
    expect(await main(['up', '--harness', 'codex'], { env, runner, out: out.write, err: err.write })).not.toBe(0);
    expect(err.text()).toMatch(INSIDE);
    expect(runner.calls.filter((c) => c.kind === 'detached')).toEqual([]);
    expect(existsSync(teamJsonPath(env))).toBe(false);
  });

  it('the supervisor refuses it and starts no session', async () => {
    const root = checkoutRepo();
    state.skillsDir = join(root, 'skills');
    const dir = makeFixtureHome();
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const warnings: string[] = [];
    await runSupervisor(
      {
        binary: join(dir, 'missing'),
        cwd: root,
        home: dir,
        teamPath,
        sessions: [{ name: 'main', role: 'lead', args: codexExecArgs([], 'k', undefined, 'lead') }],
      },
      { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line) },
    ).done;
    expect(warnings).toEqual([expect.stringMatching(/^trellis-crew supervisor: refused to start any session: /)]);
    expect(warnings[0]).toMatch(INSIDE);
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.pid).toBeNull();
  });
});

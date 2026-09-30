import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../src/cli.ts';
import { CODEX_EXPERIMENTAL_MESSAGE, codexExperimentalProblem } from '../src/experimental.ts';
import { installYmlPath, readInstallRecord } from '../src/store/install-yml.ts';
import { readTeam, teamJsonPath, writeTeam } from '../src/store/team-json.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { fixtureBin } from './helpers/paths.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { recordingRunner } from './helpers/recording-runner.ts';
import { installedOn, type Harnessed } from './helpers/team.ts';

const VARIABLE = 'TRELLIS_EXPERIMENTAL_CODEX';
const MESSAGE = 'Codex CLI support is experimental in this version and arrives in v1. Set TRELLIS_EXPERIMENTAL_CODEX=1 to try it.';

/** The same rig, with the flag variable set to `value`, or absent when undefined. */
function withFlag(t: Harnessed, value: string | undefined): Harnessed {
  const vars: Record<string, string | undefined> = { HOME: t.env.home, PATH: t.env.path };
  if (value !== undefined) vars[VARIABLE] = value;
  const env = { ...t.env, vars };
  return { ...t, env, deps: { ...t.deps, env } };
}

const OFF = undefined;
const ON = '1';

/** No runner call of any kind, and no file written under the state folder. */
function expectNothingHappened(t: Harnessed): void {
  expect(t.runner.calls).toEqual([]);
  expect(existsSync(teamJsonPath(t.env))).toBe(false);
  expect(existsSync(join(t.env.home, '.agents'))).toBe(false);
}

describe('codexExperimentalProblem', () => {
  it('allows Codex only for the exact value 1', () => {
    expect(codexExperimentalProblem({ [VARIABLE]: '1' })).toBeUndefined();
  });

  it('refuses when unset, empty, 0, true, or 1 with a space, and says Codex arrives in v1', () => {
    for (const value of [undefined, '', '0', 'true', ' 1', '1 ', '01', 'yes', 'TRUE']) {
      expect(codexExperimentalProblem({ [VARIABLE]: value })).toBe(MESSAGE);
    }
    expect(codexExperimentalProblem({})).toBe(MESSAGE);
    expect(CODEX_EXPERIMENTAL_MESSAGE).toBe(MESSAGE);
    expect(MESSAGE).toContain('arrives in v1');
  });

  it('is not fooled by another variable', () => {
    expect(codexExperimentalProblem({ TRELLIS_EXPERIMENTAL: '1', CODEX: '1' })).toBe(MESSAGE);
  });
});

describe('up --harness codex, flag off', () => {
  it('refuses with exit 2 and the message, before any runner call or file write', async () => {
    for (const value of [OFF, '', '0', 'true', ' 1']) {
      // A fresh home with no record, so any write would show.
      const env = makeTestEnv({ cwd: makeFixtureRepo().root });
      const runner = recordingRunner();
      const out = capture();
      const err = capture();
      const fresh = withFlag({ env, runner, out, err, deps: { env, runner, out: out.write, err: err.write } }, value);
      expect(await main(['up', '--harness', 'codex'], fresh.deps)).toBe(2);
      expect(fresh.err.text()).toContain(MESSAGE);
      expect(fresh.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 2. Nothing was installed or started.');
      expect(fresh.out.text()).not.toContain('Step 1 of 2');
      expect(fresh.runner.calls).toEqual([]);
      expect(existsSync(join(fresh.env.home, '.trellis-crew'))).toBe(false);
      expect(existsSync(join(fresh.env.home, '.agents'))).toBe(false);
    }
  });
});

describe('up --harness codex, flag on', () => {
  it('reaches the existing worktree-top refusal, unchanged', async () => {
    const t = withFlag(installedOn('codex', 'file-mailbox'), ON);
    mkdirSync(join(t.env.cwd, 'sub'));
    const deps: CliDeps = { ...t.deps, env: { ...t.env, cwd: join(t.env.cwd, 'sub') } };
    expect(await main(['up', '--harness', 'codex', '--yes'], deps)).toBe(2);
    expect(t.err.text()).not.toContain(MESSAGE);
    expect(t.err.text()).toContain('Codex CLI sessions can write their working folder, so trellis-crew starts them only at the top of a git worktree.');
    expect(t.err.text()).toMatch(/: it is not the top of a git worktree\. The top is /);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 2. Nothing was installed or started.');
  });

  it('installs and starts at the top of a worktree, as before', async () => {
    const t = withFlag(installedOn('codex', 'file-mailbox'), ON);
    expect(await main(['up', '--harness', 'codex', '--yes'], t.deps)).toBe(0);
    expect(t.err.text()).not.toContain(MESSAGE);
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toHaveLength(1);
  });
});

describe('every other way Codex is chosen or started, flag off and on', () => {
  it('install --harness codex', async () => {
    const off = withFlag(installedOn('claude-code', 'native'), OFF);
    const before = readFileSync(installYmlPath(off.env), 'utf8');
    expect(await main(['install', '--harness', 'codex', '--non-interactive'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expect(off.runner.calls).toEqual([]);
    expect(readFileSync(installYmlPath(off.env), 'utf8')).toBe(before);
    expect(existsSync(join(off.env.home, '.agents'))).toBe(false);

    const on = withFlag(installedOn('claude-code', 'native'), ON);
    expect(await main(['install', '--harness', 'codex', '--non-interactive'], on.deps)).toBe(0);
    expect(on.err.text()).not.toContain(MESSAGE);
    expect(readInstallRecord(on.env)).toMatchObject({ ok: true, record: { harness: 'codex' } });
  });

  it('install with no --harness, when install.yml records codex', async () => {
    const off = withFlag(installedOn('codex', 'file-mailbox'), OFF);
    const before = readFileSync(installYmlPath(off.env), 'utf8');
    expect(await main(['install'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expect(off.runner.calls).toEqual([]);
    expect(readFileSync(installYmlPath(off.env), 'utf8')).toBe(before);

    const on = withFlag(installedOn('codex', 'file-mailbox'), ON);
    expect(await main(['install'], on.deps)).toBe(0);
    expect(on.err.text()).not.toContain(MESSAGE);
  });

  it('install that detects only Codex on PATH', async () => {
    const bin = makeFixtureHome();
    const only = join(bin, 'only-codex');
    mkdirSync(only);
    copyFileSync(join(fixtureBin, 'codex'), join(only, 'codex'));
    const env = makeTestEnv({ path: only });
    const runner = recordingRunner();
    const out = capture();
    const err = capture();
    const off = { ...env, vars: { HOME: env.home, PATH: only } };
    expect(await main(['install', '--non-interactive'], { env: off, runner, out: out.write, err: err.write })).toBe(2);
    expect(err.text()).toContain(MESSAGE);
    expect(existsSync(installYmlPath(off))).toBe(false);
    expect(existsSync(join(off.home, '.agents'))).toBe(false);
    expect(runner.calls.filter((c) => c.args[0] === 'plugin' || c.args[0] === 'skills')).toEqual([]);
  });

  it('start when install.yml records codex', async () => {
    const off = withFlag(installedOn('codex', 'file-mailbox'), OFF);
    expect(await main(['start'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expectNothingHappened(off);

    const on = withFlag(installedOn('codex', 'file-mailbox'), ON);
    expect(await main(['start'], on.deps)).toBe(0);
    expect(on.err.text()).not.toContain(MESSAGE);
    expect(on.runner.calls.filter((c) => c.kind === 'detached')).toHaveLength(1);
  });

  it('respawn when the team record and install.yml name codex', async () => {
    const record = { version: 1 as const, harness: 'codex' as const, transport: 'file-mailbox' as const, sessions: [{ name: 'main', pid: null, session_id: null }] };

    const off = withFlag(installedOn('codex', 'file-mailbox'), OFF);
    writeTeam(off.env, record);
    expect(await main(['respawn', 'main'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expect(off.err.text()).not.toContain('cannot stop');
    expect(off.runner.calls).toEqual([]);
    expect(readTeam(off.env)).toMatchObject({ ok: true, record: { sessions: [{ name: 'main', pid: null }] } });

    // With the flag on, respawn goes past the gate to its own next check, which is unchanged.
    const on = withFlag(installedOn('codex', 'file-mailbox'), ON);
    writeTeam(on.env, record);
    expect(await main(['respawn', 'main'], on.deps)).toBe(1);
    expect(on.err.text()).not.toContain(MESSAGE);
    expect(on.err.text()).toContain('cannot stop main');
  });

  it('update when install.yml records codex', async () => {
    const fetchLatest = async () => ({ status: 'not-published' as const });
    const off = withFlag(installedOn('codex', 'file-mailbox', { fetchLatest }), OFF);
    const before = readFileSync(installYmlPath(off.env), 'utf8');
    expect(await main(['update'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expect(off.runner.calls).toEqual([]);
    expect(readFileSync(installYmlPath(off.env), 'utf8')).toBe(before);

    const on = withFlag(installedOn('codex', 'file-mailbox', { fetchLatest }), ON);
    await main(['update', '--check'], on.deps);
    expect(on.err.text()).not.toContain(MESSAGE);
    expect(on.out.text()).toContain('--check: nothing was changed.');
  });

  it('stop and status still work with the flag off, so a running team can always be ended', async () => {
    const t = withFlag(installedOn('codex', 'file-mailbox'), OFF);
    writeTeam(t.env, { version: 1, harness: 'codex', transport: 'file-mailbox', sessions: [{ name: 'main', pid: null, session_id: null }] });
    expect(await main(['status'], t.deps)).toBe(0);
    await main(['stop'], t.deps);
    expect(t.err.text()).not.toContain(MESSAGE);
    expect(t.out.text()).not.toContain(MESSAGE);
  });
});

/** The Claude Code configuration folder, which install needs to exist. */
function withClaudeFolder(t: Harnessed): Harnessed {
  mkdirSync(join(t.env.home, '.claude'));
  return t;
}

describe('Claude Code never reads the flag', () => {
  /** An Env whose vars record every name read from them. */
  function watched(t: Harnessed, reads: string[]): Harnessed {
    const vars = new Proxy({ HOME: t.env.home, PATH: t.env.path } as Record<string, string | undefined>, {
      get(target, key) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.has(target, key);
      },
    });
    const env = { ...t.env, vars };
    return { ...t, env, deps: { ...t.deps, env } };
  }

  it('up, install, start, respawn-free update, and status on claude-code with the flag absent', async () => {
    const reads: string[] = [];
    const up = watched(withClaudeFolder(installedOn('claude-code', 'native')), reads);
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], up.deps)).toBe(0);
    expect(up.err.text()).not.toContain(MESSAGE);

    const install = watched(withClaudeFolder(installedOn('claude-code', 'native')), reads);
    expect(await main(['install', '--harness', 'claude-code', '--non-interactive', '--skip-inbound'], install.deps)).toBe(0);

    const start = watched(installedOn('claude-code', 'native'), reads);
    expect(await main(['start'], start.deps)).toBe(0);

    const update = watched(installedOn('claude-code', 'native', { fetchLatest: async () => ({ status: 'not-published' as const }) }), reads);
    expect(await main(['update', '--check'], update.deps)).toBe(0);

    expect(reads).not.toContain(VARIABLE);
  });

  it('a claude-code record is unaffected when the variable is set to something else', async () => {
    const t = withFlag(installedOn('claude-code', 'native'), '0');
    expect(await main(['start'], t.deps)).toBe(0);
    expect(t.err.text()).not.toContain(MESSAGE);
  });
});

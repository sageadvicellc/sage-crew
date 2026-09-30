import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import { parseCommand, USAGE } from '../src/args.ts';
import { main, type CliDeps } from '../src/cli.ts';
import { upInstallOptions } from '../src/commands/up.ts';
import { readInstallRecord } from '../src/store/install-yml.ts';
import { readTeam, teamJsonPath } from '../src/store/team-json.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture, type Capture } from './helpers/io.ts';
import { fixtureBin, repoRoot } from './helpers/paths.ts';
import { recordingRunner, type RecordingRunner } from './helpers/recording-runner.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { writeRoles } from './helpers/team.ts';
import type { Env } from '../src/env.ts';

interface Rig {
  env: Env;
  runner: RecordingRunner;
  out: Capture;
  err: Capture;
  ask: ReturnType<typeof vi.fn>;
  deps: CliDeps;
  settings: string;
}

/** A fresh fixture home with no install.yml, a Claude Code folder, and a recording runner that runs nothing. */
function rig(options: { tty?: boolean } = {}): Rig {
  const env = makeTestEnv({ stdinIsTTY: options.tty === true });
  mkdirSync(join(env.home, '.claude'));
  const settings = join(env.home, '.claude', 'settings.json');
  writeFileSync(settings, '{"theme": "dark"}\n');
  const runner = recordingRunner();
  const out = capture();
  const err = capture();
  const ask = vi.fn(async () => 'y');
  return {
    env,
    runner,
    out,
    err,
    ask,
    settings,
    deps: { env, runner, out: out.write, err: err.write, ask, now: () => new Date('2026-03-04T10:00:00Z') },
  };
}

function supervisorJob(t: Rig): SupervisorJob {
  const spawns = t.runner.calls.filter((c) => c.kind === 'detached');
  expect(spawns).toHaveLength(1);
  return JSON.parse(readFileSync(spawns[0]?.args[1] as string, 'utf8')) as SupervisorJob;
}

const settingsOf = (t: Rig): unknown => JSON.parse(readFileSync(t.settings, 'utf8'));
const bgRuns = (t: Rig) => t.runner.calls.filter((c) => c.kind === 'run' && c.args[0] === '--bg');

describe('up: parsing', () => {
  it('parses --harness with the flags that start takes', () => {
    expect(parseCommand(['up', '--harness', 'codex'])).toEqual({
      ok: true,
      command: { name: 'up', harness: 'codex', yes: false, acceptInbound: false, skipInbound: false },
    });
    expect(parseCommand(['up', '--harness', 'claude-code', '--workers', '2', '--roles', 'team.yml', '-y', '--skip-inbound'])).toEqual({
      ok: true,
      command: { name: 'up', harness: 'claude-code', workers: 2, roles: 'team.yml', yes: true, acceptInbound: false, skipInbound: true },
    });
    expect(parseCommand(['up', '--harness', 'claude-code', '--accept-inbound'])).toMatchObject({
      ok: true,
      command: { acceptInbound: true, skipInbound: false },
    });
  });

  it('needs --harness, and takes only codex or claude-code', () => {
    expect(parseCommand(['up'])).toMatchObject({ ok: false, message: expect.stringMatching(/up needs --harness codex or --harness claude-code/) });
    for (const name of ['hermes', 'qwen-code', 'amp', 'opencode', 'bogus', 'Codex CLI', 'claude']) {
      expect(parseCommand(['up', '--harness', name])).toMatchObject({
        ok: false,
        message: expect.stringContaining(`not "${name}"`),
      });
    }
  });

  it('refuses a --roles value that is a URL or a git@ address', () => {
    for (const value of ['https://example.com/team.yml', 'file:///tmp/team.yml', 'ssh://host/team.yml', 'git@example.com:team.git']) {
      expect(parseCommand(['up', '--harness', 'codex', '--roles', value])).toMatchObject({
        ok: false,
        message: expect.stringMatching(/--roles takes a local file path, not a URL or a git address/),
      });
    }
  });

  it('refuses --accept-inbound with --skip-inbound, a bad worker count, and an unknown flag', () => {
    expect(parseCommand(['up', '--harness', 'claude-code', '--accept-inbound', '--skip-inbound'])).toMatchObject({
      ok: false,
      message: '--accept-inbound and --skip-inbound cannot be used together',
    });
    expect(parseCommand(['up', '--harness', 'codex', '--workers', '0'])).toMatchObject({ ok: false });
    expect(parseCommand(['up', '--harness', 'codex', '--reconfigure'])).toMatchObject({ ok: false });
  });

  it('a usage error exits 2, installs nothing, and starts nothing', async () => {
    for (const argv of [['up'], ['up', '--harness', 'hermes'], ['up', '--harness', 'codex', '--roles', 'https://example.com/t.yml']]) {
      const t = rig();
      expect(await main(argv, t.deps)).toBe(2);
      expect(t.runner.calls).toEqual([]);
      expect(existsSync(join(t.env.home, '.trellis-crew'))).toBe(false);
    }
  });

  it('USAGE names up and its flags', () => {
    expect(USAGE).toContain(
      'trellis-crew up --harness <codex|claude-code> [--workers N] [--roles sagespec.yml] [--yes] [--accept-inbound | --skip-inbound]',
    );
  });

  it('the README describes up', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('trellis-crew up --harness codex');
    expect(readme).toContain('trellis-crew up --harness claude-code');
    expect(readme).toContain('--accept-inbound');
  });
});

describe('up: the install step', () => {
  it('builds the install options as if install --harness <name> --non-interactive were given', () => {
    for (const harness of ['codex', 'claude-code'] as const) {
      const parsed = parseCommand(['install', '--harness', harness, '--non-interactive']);
      if (!parsed.ok) throw new Error(parsed.message);
      const { name: _name, ...install } = parsed.command as Extract<typeof parsed.command, { name: 'install' }>;
      expect(upInstallOptions({ harness, yes: false, acceptInbound: false, skipInbound: false })).toMatchObject(install);
    }
  });

  it('up --yes never consents to the inbound setting; only --accept-inbound does', () => {
    const base = { harness: 'claude-code' as const, acceptInbound: false, skipInbound: false };
    expect(upInstallOptions({ ...base, yes: true })).toMatchObject({ yes: false, rolesYes: true, nonInteractive: true });
    expect(upInstallOptions({ ...base, yes: false, acceptInbound: true })).toMatchObject({ yes: true, rolesYes: false });
    expect(upInstallOptions({ ...base, yes: false, skipInbound: true })).toMatchObject({ yes: false, skipInbound: true });
    expect(upInstallOptions({ ...base, yes: false, roles: 'team.yml' })).toMatchObject({ roles: 'team.yml' });
  });
});

describe('up --harness codex', () => {
  it('installs with no question, then starts the team under the supervisor, in one step', async () => {
    const t = rig({ tty: true });
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(0);
    expect(t.ask).not.toHaveBeenCalled();
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'codex', transport: 'file-mailbox' } });
    expect(readdirSync(join(t.env.home, '.agents', 'skills')).sort()).toEqual(readdirSync(join(repoRoot, 'skills')).sort());
    // No probe runs, because --harness names the harness, and no codex process runs in a test.
    expect(t.runner.calls.filter((c) => c.kind === 'run')).toEqual([]);
    const job = supervisorJob(t);
    expect(job.binary).toBe(join(fixtureBin, 'codex'));
    expect(job.sessions).toHaveLength(6);
    const team = readTeam(t.env);
    expect(team.ok && team.record?.harness).toBe('codex');
    const text = t.out.text();
    expect(text.indexOf('Step 1 of 2: install on Codex CLI')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Step 1 of 2')).toBeLessThan(text.indexOf('Step 2 of 2: start the team.'));
    expect(text.indexOf('Step 2 of 2')).toBeLessThan(text.indexOf('Started the supervisor'));
  });

  it('every codex exec session runs in workspace-write with network access off, and no bypass flag appears', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(0);
    for (const session of supervisorJob(t).sessions) {
      expect(session.args.slice(0, -1)).toEqual(['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '--']);
      expect(session.args.at(-1)).toMatch(/You are|trellis-crew start-up/);
      for (const arg of session.args.slice(0, -1)) {
        expect(arg).not.toContain('danger-full-access');
        expect(arg).not.toContain('dangerously-bypass-approvals-and-sandbox');
      }
    }
  });

  it('passes --workers through to start', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'codex', '--workers', '2'], t.deps)).toBe(0);
    expect(supervisorJob(t).sessions.map((s) => s.name)).toEqual(['personal-assistant', 'main', 'benchmark', 'worker-1', 'worker-2']);
  });

  it('passes --roles through to start, and asks nothing for a file named on the command line', async () => {
    const t = rig({ tty: true });
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM);
    expect(await main(['up', '--harness', 'codex', '--roles', 'team.yml'], t.deps)).toBe(0);
    expect(t.ask).not.toHaveBeenCalled();
    expect(supervisorJob(t).sessions.map((s) => s.name)).toEqual(['chain', 'boss', 'helper-a', 'helper-b', 'watcher']);
    const team = readTeam(t.env);
    expect(team.ok && team.record?.roles?.file).toBe(file);
  });

  it('stops at a failed install with its message, names the step, and starts nothing', async () => {
    const t = rig();
    const bare = { ...t.deps, env: { ...t.env, path: join(t.env.home, 'no-bin') } };
    expect(await main(['up', '--harness', 'codex'], bare)).toBe(1);
    expect(t.err.text()).toContain('Codex CLI is not on PATH, so the plugin cannot be installed.');
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 1. Nothing was started.');
    expect(t.out.text()).not.toContain('Step 2 of 2');
    expect(t.runner.calls).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('names the start step when start fails after the install', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(0);
    const before = t.runner.calls.length;
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/A team record already exists/);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 2 of 2, start, with exit code 1.');
    expect(t.runner.calls.length).toBe(before);
  });

  it('a roles file found in this folder needs --yes, because up asks no question', async () => {
    const t = rig({ tty: true });
    writeFileSync(join(t.env.cwd, 'sagespec.yml'), SMALL_TEAM);
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(2);
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.err.text()).toContain('trellis-crew up asks no question about a roles file. Read it, then run up again with --yes.');
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 2. Nothing was started.');
    expect(t.runner.calls).toEqual([]);

    const yes = rig({ tty: true });
    writeFileSync(join(yes.env.cwd, 'sagespec.yml'), SMALL_TEAM);
    expect(await main(['up', '--harness', 'codex', '--yes'], yes.deps)).toBe(0);
    expect(yes.ask).not.toHaveBeenCalled();
    expect(supervisorJob(yes).sessions.map((s) => s.name)).toEqual(['chain', 'boss', 'helper-a', 'helper-b', 'watcher']);
  });

  it('refuses a roles file that names another harness, and starts nothing', async () => {
    const t = rig();
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('harness: auto', 'harness: claude-code'));
    expect(await main(['up', '--harness', 'codex', '--roles', file], t.deps)).toBe(2);
    expect(t.err.text()).toContain(`${file}: the roles file names the harness claude-code, but --harness is codex. Nothing was started.`);
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });
});

describe('up --roles is a local regular file', () => {
  it('refuses a missing file, a folder, and a symbolic link, before any install', async () => {
    const missing = rig();
    expect(await main(['up', '--harness', 'codex', '--roles', 'nope.yml'], missing.deps)).toBe(2);
    expect(missing.err.text()).toContain(`${join(missing.env.cwd, 'nope.yml')}: --roles must name a local regular file (ENOENT). Nothing was installed.`);

    const folder = rig();
    mkdirSync(join(folder.env.cwd, 'team'));
    expect(await main(['up', '--harness', 'codex', '--roles', 'team'], folder.deps)).toBe(2);
    expect(folder.err.text()).toMatch(/--roles must name a local regular file \(not a regular file\)/);

    const link = rig();
    const real = writeRoles(link.env, 'real.yml', SMALL_TEAM);
    symlinkSync(real, join(link.env.cwd, 'team.yml'));
    expect(await main(['up', '--harness', 'codex', '--roles', 'team.yml'], link.deps)).toBe(2);
    expect(link.err.text()).toMatch(/--roles must name a local regular file \(a symbolic link\)/);

    for (const t of [missing, folder, link]) {
      expect(t.runner.calls).toEqual([]);
      expect(existsSync(join(t.env.home, '.trellis-crew'))).toBe(false);
      expect(existsSync(join(t.env.home, '.agents'))).toBe(false);
    }
  });
});

describe('up --harness claude-code', () => {
  it('with --accept-inbound, installs the plugin, sets the inbound setting, then starts each session', async () => {
    const t = rig({ tty: true });
    expect(await main(['up', '--harness', 'claude-code', '--accept-inbound'], t.deps)).toBe(0);
    expect(t.ask).not.toHaveBeenCalled();
    const runs = t.runner.calls.filter((c) => c.kind === 'run');
    expect(runs.slice(0, 2).map((c) => c.args.slice(0, 2))).toEqual([
      ['plugin', 'marketplace'],
      ['plugin', 'install'],
    ]);
    expect(runs.some((c) => c.args.includes('--version'))).toBe(false);
    expect(bgRuns(t)).toHaveLength(6);
    expect(settingsOf(t)).toEqual({ theme: 'dark', crossSessionInbound: 'accept' });
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'claude-code', transport: 'native' } });
    expect(t.out.text()).toMatch(/every Claude Code session/);
  });

  it('with no inbound flag, it asks nothing, leaves the settings file alone, names up\'s flags, and starts nothing', async () => {
    const t = rig({ tty: true });
    expect(await main(['up', '--harness', 'claude-code'], t.deps)).toBe(1);
    expect(t.ask).not.toHaveBeenCalled();
    expect(settingsOf(t)).toEqual({ theme: 'dark' });
    expect(existsSync(`${t.settings}.2026-03-04.bak`)).toBe(false);
    expect(t.err.text()).toContain('Run up again with --accept-inbound to set it, or with --skip-inbound to leave it.');
    expect(t.err.text()).not.toMatch(/install again with --yes/);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 1. Nothing was started.');
    expect(bgRuns(t)).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('--yes alone does not consent to the inbound setting', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'claude-code', '--yes'], t.deps)).toBe(1);
    expect(settingsOf(t)).toEqual({ theme: 'dark' });
    expect(bgRuns(t)).toEqual([]);
  });

  it('with --skip-inbound, leaves the settings file alone and starts the team', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound', '--workers', '1'], t.deps)).toBe(0);
    expect(settingsOf(t)).toEqual({ theme: 'dark' });
    expect(bgRuns(t).map((c) => c.args[2])).toEqual(['personal-assistant', 'main', 'benchmark', 'worker-1']);
  });

  it('stops at a failed plugin install with its message', async () => {
    const t = rig();
    const failing = recordingRunner((_command, args) =>
      args[0] === 'plugin' ? { code: 1, stdout: '', stderr: 'fixture refusal\n', timedOut: false } : { code: 0, stdout: '', stderr: '', timedOut: false },
    );
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], { ...t.deps, runner: failing })).toBe(1);
    expect(t.err.text()).toMatch(/The plugin install failed: claude plugin marketplace add .*: fixture refusal/);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 1. Nothing was started.');
    expect(failing.calls.filter((c) => c.args[0] === '--bg')).toEqual([]);
  });
});

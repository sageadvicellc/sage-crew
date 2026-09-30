import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter, codexExecArgs, refusedCodexFlag } from '../src/adapters/codex.ts';
import { runSupervisor, type SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import { main } from '../src/cli.ts';
import { processStartTime } from '../src/runner.ts';
import { readTeam, readTeamFile, writeTeamFile } from '../src/store/team-json.ts';
import { makeFixtureHome } from './helpers/env.ts';
import { fixtureBin, repoRoot } from './helpers/paths.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn, writeRoles } from './helpers/team.ts';

function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every `codex exec` argv up to the kickoff: the sandbox, network access off, then `--`. */
const SANDBOXED_EXEC = ['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '--'];

function expectNoBypass(args: readonly string[]): void {
  for (const arg of args) {
    expect(arg).not.toContain('danger-full-access');
    expect(arg).not.toContain('dangerously-bypass-approvals-and-sandbox');
  }
}

describe('codex exec arguments', () => {
  it('sets workspace-write with network access off, and puts the kickoff after --', () => {
    expect(codexExecArgs([], 'do the work')).toEqual([...SANDBOXED_EXEC, 'do the work']);
    // A kickoff that starts with - stays the prompt, because it follows --.
    expect(codexExecArgs([], '--dangerously-bypass-approvals-and-sandbox')).toEqual([...SANDBOXED_EXEC, '--dangerously-bypass-approvals-and-sandbox']);
    const args = codexExecArgs(['-m', 'model-a'], 'k');
    expect(args).toEqual(['exec', '-m', 'model-a', ...SANDBOXED_EXEC.slice(1), 'k']);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expectNoBypass(args.slice(0, -1));
  });

  it('refuses a launch flag that could change the sandbox', () => {
    const refused = [
      ['--sandbox', 'danger-full-access'],
      ['--sandbox=danger-full-access'],
      ['-s', 'danger-full-access'],
      ['-sdanger-full-access'],
      ['-c', 'sandbox_mode="danger-full-access"'],
      ['-csandbox_workspace_write.network_access=true'],
      ['--config', 'sandbox_workspace_write.network_access=true'],
      ['--config=sandbox_mode="danger-full-access"'],
      ['--dangerously-bypass-approvals-and-sandbox'],
      ['-m', 'danger-full-access'],
    ];
    for (const flagArgs of refused) {
      expect(refusedCodexFlag(flagArgs)).toMatch(/is refused on Codex CLI, because trellis-crew sets the sandbox itself/);
      expect(() => codexExecArgs(flagArgs, 'k')).toThrow(/is refused on Codex CLI/);
    }
    expect(refusedCodexFlag([])).toBeUndefined();
    expect(refusedCodexFlag(['-m', 'model-a', '--effort', 'high'])).toBeUndefined();
  });

  it('respawn refuses an injected sandbox flag and starts nothing', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {} };
    const outcome = await codexAdapter.launch('main', 'k', ['--sandbox', 'danger-full-access'], ctx);
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/"--sandbox" is refused on Codex CLI/) });
    expect(t.runner.calls).toEqual([]);
  });

  it('start refuses a roles-file flag that reaches the sandbox, and starts no supervisor', async () => {
    // Codex has no verified launch flag today, so a stand-in maps model to --sandbox to show the guard holds.
    const leaky = { ...codexAdapter, flags: { model: '--sandbox' } };
    const t = installedOn('codex', 'file-mailbox', { adapters: { codex: leaky } });
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: danger-full-access'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/helper-a: the launch flag "--sandbox" is refused on Codex CLI/);
    expect(t.runner.calls).toEqual([]);
    expect(readTeam(t.env)).toEqual({ ok: true, record: undefined });
  });

  it('a roles-file value on Codex is ignored with a warning, so it never reaches codex exec', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: danger-full-access'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.text()).toContain('warning: helper-a: model ignored. Codex CLI has no verified flag for it.');
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    for (const session of job.sessions) {
      expect(session.args.slice(0, -1)).toEqual(SANDBOXED_EXEC);
      expectNoBypass(session.args.slice(0, -1));
    }
  });
});

describe('Codex CLI', () => {
  it('49: start returns at once while the detached supervisor keeps running', async () => {
    const t = installedOn('codex', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    const spawns = t.runner.calls.filter((c) => c.kind === 'detached');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe(process.execPath);
    expect(spawns[0]?.args[0]).toMatch(/codex-supervisor\.(ts|js)$/);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    const supervisor = team.record.supervisor_pid as number;
    expect(t.runner.living.has(supervisor)).toBe(true);
    expect(team.record.sessions.map((s) => s.name)).toHaveLength(6);

    const job = JSON.parse(readFileSync(spawns[0]?.args[1] as string, 'utf8')) as SupervisorJob;
    expect(job.binary).toBe(join(fixtureBin, 'codex'));
    expect(job.supervisorPid).toBeUndefined();
    const mainJob = job.sessions.find((s) => s.name === 'main');
    expect(mainJob?.args).toEqual([...SANDBOXED_EXEC, mainJob?.args.at(-1)]);
    expect(mainJob?.args.at(-1)).toMatch(/You are main, the lead\.[\s\S]*file mailbox at/);
    expect(t.out.text()).toMatch(/supervisor/);
  });

  it('the supervisor job file goes only into a private state folder', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const { codexAdapter } = await import('../src/adapters/codex.ts');
    const launchAll = codexAdapter.launchAll;
    if (launchAll === undefined) throw new Error('no launchAll');
    chmodSync(join(t.env.home, '.trellis-crew'), 0o755);
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {} };
    await expect(launchAll([{ name: 'main', kickoff: 'k', flagArgs: [] }], ctx, join(t.env.home, 'team.json'))).rejects.toThrow(
      /open to other users/,
    );
    expect(t.runner.calls).toEqual([]);
  });

  it('46: each set field prints one warning, and the session still starts', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: model-a'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.lines.filter((l) => l.startsWith('warning: helper-a:'))).toEqual([
      'warning: helper-a: autocompact ignored. Codex CLI has no verified flag for it.',
      'warning: helper-a: model ignored. Codex CLI has no verified flag for it.',
    ]);
  });

  it('the supervisor waits for its record, starts each child, records the pids, and ends them on stop', async () => {
    const dir = makeFixtureHome();
    const bin = join(dir, 'codex');
    writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n');
    chmodSync(bin, 0o755);
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, {
      version: 1,
      harness: 'codex',
      supervisor_pid: process.pid,
      sessions: [
        { name: 'main', pid: null, session_id: null },
        { name: 'worker-1', pid: null, session_id: null },
      ],
    });
    const job: SupervisorJob = {
      binary: bin,
      cwd: dir,
      teamPath,
      sessions: [
        { name: 'main', args: ['exec', 'kickoff one'] },
        { name: 'worker-1', args: ['exec', 'kickoff two'] },
      ],
    };
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10 });
    await waitFor(() => {
      const team = readTeamFile(teamPath);
      return team.ok && !!team.record && team.record.sessions.every((s) => s.pid !== null);
    });
    const team = readTeamFile(teamPath);
    if (!team.ok || !team.record) throw new Error('no team');
    const pids = team.record.sessions.map((s) => s.pid as number);
    for (const pid of pids) expect(alive(pid)).toBe(true);
    // Each child's start time is recorded, so stop can tell a reused pid.
    for (const entry of team.record.sessions) expect(processStartTime(entry.pid as number)).toEqual({ status: 'running', started: entry.started });
    handle.stop();
    await handle.done;
    await waitFor(() => pids.every((pid) => !alive(pid)));
  });

  it('the supervisor starts nothing when its record never names it', async () => {
    const dir = makeFixtureHome();
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', sessions: [{ name: 'main', pid: null, session_id: null }] });
    const handle = runSupervisor(
      { binary: join(dir, 'missing'), cwd: dir, teamPath, sessions: [{ name: 'main', args: ['exec', 'k'] }] },
      { ownPid: process.pid, pollMs: 10, waitMs: 100 },
    );
    await handle.done;
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.pid).toBeNull();
  });

  it('install copies each skill folder into ~/.agents/skills, and update copies them fresh', async () => {
    const t = installedOn('codex', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    mkdirSync(join(t.env.home, '.codex'));
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const skills = readdirSync(join(repoRoot, 'skills'));
    const target = join(t.env.home, '.agents', 'skills');
    expect(readdirSync(target).sort()).toEqual(skills.sort());
    for (const skill of skills) {
      expect(readFileSync(join(target, skill, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8'));
    }
    writeFileSync(join(target, 'department-lead', 'stale.txt'), 'old');
    writeFileSync(join(target, 'someone-elses-skill.md'), 'keep');
    expect(await main(['update'], t.deps)).toBe(0);
    expect(existsSync(join(target, 'department-lead', 'stale.txt'))).toBe(false);
    expect(existsSync(join(target, 'someone-elses-skill.md'))).toBe(true);
    expect(t.runner.calls).toEqual([]);
  });
});

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSupervisor, type SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import { main } from '../src/cli.ts';
import { processStartTime } from '../src/runner.ts';
import { readTeam, readTeamFile, teamJsonPath, writeTeam, writeTeamFile } from '../src/store/team-json.ts';
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
    expect(mainJob?.args[0]).toBe('exec');
    // exec, then -c developer_instructions=<the role skill>, then the kickoff.
    expect(mainJob?.args).toHaveLength(4);
    expect(mainJob?.args[1]).toBe('-c');
    expect(mainJob?.args[2]).toMatch(/^developer_instructions="/);
    expect(mainJob?.args[3]).toMatch(/You are main, the lead\.[\s\S]*file mailbox at/);
    expect(t.out.text()).toMatch(/supervisor/);
  });

  it('the supervisor job file goes only into a private state folder', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const { codexAdapter } = await import('../src/adapters/codex.ts');
    const launchAll = codexAdapter.launchAll;
    if (launchAll === undefined) throw new Error('no launchAll');
    chmodSync(join(t.env.home, '.trellis-crew'), 0o755);
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {} };
    const outcome = await launchAll([{ name: 'main', role: 'lead', kickoff: 'k', flagArgs: [] }], ctx, join(t.env.home, 'team.json'));
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/^could not write the supervisor job file .*: .*open to other users/) });
    expect(t.runner.calls).toEqual([]);
  });

  it('start leaves no team record when the supervisor job file cannot be written', async () => {
    const t = installedOn('codex', 'file-mailbox');
    // A folder where the job file goes, so the atomic rename over it fails.
    mkdirSync(join(t.env.home, '.trellis-crew', 'codex-supervisor.json', 'blocker'), { recursive: true });
    expect(await main(['start'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/The supervisor could not start: could not write the supervisor job file/);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
    expect(t.runner.calls).toEqual([]);
  });

  it('the supervisor records a child that fails to spawn, in its log and on the team entry', async () => {
    const dir = makeFixtureHome();
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const lines: string[] = [];
    const handle = runSupervisor(
      { binary: join(dir, 'missing'), cwd: dir, teamPath, sessions: [{ name: 'main', args: ['exec', 'k'] }] },
      { ownPid: process.pid, pollMs: 10, warn: (line) => lines.push(line) },
    );
    await handle.done;
    expect(lines).toEqual([expect.stringMatching(/^trellis-crew supervisor: main: could not start: .*ENOENT/)]);
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.error).toMatch(/^could not start: .*ENOENT/);
  });

  it('the supervisor records a child that exits non-zero, and not one that exits 0', async () => {
    const dir = makeFixtureHome();
    const fails = join(dir, 'fails');
    writeFileSync(fails, '#!/bin/sh\nexit 3\n');
    chmodSync(fails, 0o755);
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const lines: string[] = [];
    await runSupervisor(
      { binary: fails, cwd: dir, teamPath, sessions: [{ name: 'main', args: ['exec', 'k'] }] },
      { ownPid: process.pid, pollMs: 10, warn: (line) => lines.push(line) },
    ).done;
    expect(lines).toEqual(['trellis-crew supervisor: main: exited with code 3']);
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.error).toBe('exited with code 3');

    const passes = join(dir, 'passes');
    writeFileSync(passes, '#!/bin/sh\nexit 0\n');
    chmodSync(passes, 0o755);
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const quiet: string[] = [];
    await runSupervisor(
      { binary: passes, cwd: dir, teamPath, sessions: [{ name: 'main', args: ['exec', 'k'] }] },
      { ownPid: process.pid, pollMs: 10, warn: (line) => quiet.push(line) },
    ).done;
    expect(quiet).toEqual([]);
    const clean = readTeamFile(teamPath);
    expect(clean.ok && clean.record?.sessions[0]?.error).toBeUndefined();
  });

  it('the default report writes the line to codex-supervisor.log beside the team record', async () => {
    const dir = makeFixtureHome();
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await runSupervisor(
        { binary: join(dir, 'missing'), cwd: dir, teamPath, sessions: [{ name: 'main', args: ['exec', 'k'] }] },
        { ownPid: process.pid, pollMs: 10 },
      ).done;
    } finally {
      stderr.mockRestore();
    }
    expect(readFileSync(join(dir, 'codex-supervisor.log'), 'utf8')).toMatch(/^\S+ trellis-crew supervisor: main: could not start: .*ENOENT.*\n$/);
  });

  it('status prints the error the supervisor recorded for a session', async () => {
    const t = installedOn('codex', 'file-mailbox');
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      sessions: [
        { name: 'main', pid: null, session_id: null, error: 'exited with code 3' },
        { name: 'worker-1', pid: null, session_id: null },
      ],
    });
    expect(await main(['status'], t.deps)).toBe(0);
    expect(t.out.lines.find((l) => l.startsWith('main'))).toMatch(/error: exited with code 3$/);
    expect(t.out.lines.find((l) => l.startsWith('worker-1'))).not.toMatch(/error/);
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
    // A child ended by stop is not an error.
    const after = readTeamFile(teamPath);
    expect(after.ok && after.record?.sessions.map((s) => s.error)).toEqual([undefined, undefined]);
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

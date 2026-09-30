import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { treeHash } from '../src/adapters/codex-skills.ts';
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
    expect(mainJob?.args).toHaveLength(2);
    expect(mainJob?.args[1]).toMatch(/You are main, the lead\.[\s\S]*file mailbox at/);
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

  it('install copies each approved skill folder into ~/.agents/skills with its marker, and update copies them fresh', async () => {
    const t = installedOn('codex', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    mkdirSync(join(t.env.home, '.codex'));
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const manifest = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills: string[] };
    const skills = manifest.skills.map((entry) => entry.replace(/^\.\/skills\/|\/$/g, ''));
    const target = join(t.env.home, '.agents', 'skills');
    expect(readdirSync(target).sort()).toEqual([...skills].sort());
    for (const skill of skills) {
      expect(readFileSync(join(target, skill, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8'));
      expect(JSON.parse(readFileSync(join(target, skill, '.trellis-crew-skill.json'), 'utf8'))).toMatchObject({ owner: 'trellis-crew', skill });
    }
    // A copy from an older package: an extra file, and a marker whose hash covers it.
    writeFileSync(join(target, 'department-lead', 'stale.txt'), 'old');
    const lead = join(target, 'department-lead');
    writeFileSync(join(lead, '.trellis-crew-skill.json'), JSON.stringify({ owner: 'trellis-crew', skill: 'department-lead', sha256: treeHash(lead) }));
    writeFileSync(join(target, 'someone-elses-skill.md'), 'keep');
    mkdirSync(join(target, 'someone-elses-folder'));
    expect(await main(['update'], t.deps)).toBe(0);
    expect(existsSync(join(target, 'department-lead', 'stale.txt'))).toBe(false);
    expect(existsSync(join(target, 'someone-elses-skill.md'))).toBe(true);
    expect(existsSync(join(target, 'someone-elses-folder'))).toBe(true);
    expect(t.runner.calls).toEqual([]);
  });
});

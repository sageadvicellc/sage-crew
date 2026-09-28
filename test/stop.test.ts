import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { readTeam, teamJsonPath, writeTeam } from '../src/store/team-json.ts';
import { claudeInstalled, installedOn } from './helpers/team.ts';

describe('stop', () => {
  it('48: ends only the recorded pids, the supervisor first, then its children', async () => {
    const t = claudeInstalled();
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      supervisor_pid: 4100,
      sessions: [
        { name: 'main', pid: 4101, session_id: null },
        { name: 'worker-1', pid: 4102, session_id: null },
      ],
    });
    for (const pid of [4100, 4101, 4102, 4999]) t.runner.living.add(pid);
    expect(await main(['stop'], t.deps)).toBe(0);
    const kills = t.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command));
    expect(kills).toEqual([4100, 4101, 4102]);
    expect(t.runner.living.has(4999)).toBe(true);
    expect(t.runner.calls.filter((c) => c.kind !== 'kill')).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('a recorded pid that now belongs to another process is never signalled', async () => {
    const t = claudeInstalled();
    for (const pid of [4100, 4101, 4102]) t.runner.living.add(pid);
    t.runner.starts.set(4100, 'start-supervisor');
    t.runner.starts.set(4101, 'start-someone-else');
    t.runner.starts.set(4102, 'start-worker');
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      supervisor_pid: 4100,
      supervisor_started: 'start-supervisor',
      sessions: [
        { name: 'main', pid: 4101, session_id: null, started: 'start-main' },
        { name: 'worker-1', pid: 4102, session_id: null, started: 'start-worker' },
      ],
    });
    expect(await main(['stop'], t.deps)).toBe(0);
    const kills = t.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command));
    expect(kills).toEqual([4100, 4102]);
    expect(t.runner.living.has(4101)).toBe(true);
    expect(t.out.text()).toMatch(/main: pid 4101 now belongs to another process, so it was not signalled/);
  });

  it('start records each detached process start time, and the team record keeps it', async () => {
    const t = installedOn('qwen-code', 'native');
    expect(await main(['start'], t.deps)).toBe(0);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    for (const entry of team.record.sessions) {
      expect(entry.started).toBe(t.runner.starts.get(entry.pid as number));
    }
  });

  it('48: a session with no local process is left alone and named', async () => {
    const t = claudeInstalled();
    expect(await main(['start'], t.deps)).toBe(0);
    const before = t.runner.calls.length;
    expect(await main(['stop'], t.deps)).toBe(0);
    expect(t.runner.calls.length).toBe(before);
    expect(t.out.text()).toMatch(/worker-1: .*still runs/);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('says so when no team is running', async () => {
    const t = claudeInstalled();
    expect(await main(['stop'], t.deps)).toBe(0);
    expect(t.out.text()).toMatch(/No team is running/);
    expect(t.runner.calls).toEqual([]);
  });
});

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
    expect(await main(['stop', '--force-stop'], t.deps)).toBe(0);
    const kills = t.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command));
    expect(kills).toEqual([4100, 4101, 4102]);
    expect(t.runner.living.has(4999)).toBe(true);
    expect(t.runner.calls.filter((c) => c.kind !== 'kill')).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  function noStartTimes() {
    const t = claudeInstalled();
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      sessions: [
        { name: 'main', pid: 4101, session_id: null },
        { name: 'worker-1', pid: 4102, session_id: null, started: 'start-worker' },
      ],
    });
    for (const pid of [4101, 4102]) t.runner.living.add(pid);
    t.runner.starts.set(4102, 'start-worker');
    return t;
  }

  it('a record with no start time is warned about and not signalled, and the record is kept', async () => {
    const t = noStartTimes();
    expect(await main(['stop'], t.deps)).toBe(1);
    const kills = t.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command));
    expect(kills).toEqual([4102]);
    expect(t.runner.living.has(4101)).toBe(true);
    expect(t.err.text()).toMatch(/warning: main: the team record holds no start time for pid 4101, so the CLI cannot tell whether it is the process it started/);
    expect(t.err.text()).toMatch(/--force-stop/);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
  });

  it('a terminal can confirm a pid with no start time, and the default answer is no', async () => {
    const asked: string[] = [];
    const yes = noStartTimes();
    const ask = async (question: string) => {
      asked.push(question);
      return 'y';
    };
    expect(await main(['stop'], { ...yes.deps, env: { ...yes.env, stdinIsTTY: true }, ask })).toBe(0);
    expect(yes.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command))).toEqual([4101, 4102]);
    expect(asked).toEqual(['Signal main (pid 4101) anyway? [y/N] ']);
    expect(existsSync(teamJsonPath(yes.env))).toBe(false);

    const no = noStartTimes();
    expect(await main(['stop'], { ...no.deps, env: { ...no.env, stdinIsTTY: true }, ask: async () => '' })).toBe(1);
    expect(no.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command))).toEqual([4102]);
    expect(existsSync(teamJsonPath(no.env))).toBe(true);
  });

  it('respawn does not signal a pid with no start time unless --force-stop is given', async () => {
    const t = noStartTimes();
    expect(await main(['respawn', 'main'], t.deps)).toBe(1);
    expect(t.runner.calls.filter((c) => c.kind === 'kill')).toEqual([]);
    expect(t.err.text()).toMatch(/no start time for pid 4101/);
    expect(t.err.text()).toMatch(/Nothing was started/);
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

  it('a pid whose start time cannot be read is warned about, never signalled, and the record is kept', async () => {
    const t = claudeInstalled();
    for (const pid of [4101, 4102]) t.runner.living.add(pid);
    t.runner.starts.set(4102, 'start-worker');
    t.runner.unknown.set(4101, 'ps failed: exit code 2');
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      sessions: [
        { name: 'main', pid: 4101, session_id: null, started: 'start-main' },
        { name: 'worker-1', pid: 4102, session_id: null, started: 'start-worker' },
      ],
    });
    expect(await main(['stop'], t.deps)).toBe(1);
    const kills = t.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command));
    expect(kills).toEqual([4102]);
    expect(t.err.text()).toMatch(/main: cannot tell whether pid 4101 is the process the CLI started \(ps failed: exit code 2\)/);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
    expect(t.err.text()).toMatch(/Kept the team record/);
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

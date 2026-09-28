import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { writeTeam } from '../src/store/team-json.ts';
import { claudeInstalled } from './helpers/team.ts';

describe('status', () => {
  it('47: lists each entry with its pid, session id, and state, and the supervisor', async () => {
    const t = claudeInstalled();
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      supervisor_pid: 4100,
      sessions: [
        { name: 'main', pid: 4101, session_id: 'id-main' },
        { name: 'worker-1', pid: 4102, session_id: null },
        { name: 'remote', pid: null, session_id: 'thread-1' },
      ],
    });
    t.runner.living.add(4100);
    t.runner.living.add(4101);
    expect(await main(['status'], t.deps)).toBe(0);
    const text = t.out.text();
    expect(text).toMatch(/supervisor\s+pid 4100\s+running/);
    expect(text).toMatch(/main\s+pid 4101\s+session id-main\s+running/);
    expect(text).toMatch(/worker-1\s+pid 4102\s+session -\s+not running/);
    expect(text).toMatch(/remote\s+pid -\s+session thread-1\s+unknown/);
    expect(t.runner.calls.filter((c) => c.kind === 'kill')).toEqual([]);
  });

  it('47: lists a started Claude Code team', async () => {
    const t = claudeInstalled();
    expect(await main(['start'], t.deps)).toBe(0);
    t.out.lines.length = 0;
    expect(await main(['status'], t.deps)).toBe(0);
    for (const name of ['personal-assistant', 'main', 'benchmark', 'research', 'worker-1', 'worker-2', 'worker-3']) {
      expect(t.out.text()).toContain(name);
    }
  });

  it('says so when no team is running', async () => {
    const t = claudeInstalled();
    expect(await main(['status'], t.deps)).toBe(0);
    expect(t.out.text()).toMatch(/No team is running/);
  });
});

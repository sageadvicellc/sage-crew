import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { readTeam, teamJsonPath } from '../src/store/team-json.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { claudeInstalled, detachedAdapter, writeRoles } from './helpers/team.ts';
import { fixtureBin } from './helpers/paths.ts';
import { join } from 'node:path';

describe('start on Claude Code', () => {
  it('45: runs --bg --name <n> --autocompact <v>, never -p, and adds no --model or --effort unless set', async () => {
    const t = claudeInstalled();
    expect(await main(['start'], t.deps)).toBe(0);
    const runs = t.runner.calls.filter((c) => c.kind === 'run');
    expect(runs).toHaveLength(7);
    for (const call of runs) {
      expect(call.command).toBe(join(fixtureBin, 'claude'));
      expect(call.args.slice(0, 3)).toEqual(['--bg', '--name', call.args[2]]);
      expect(call.args).toContain('--autocompact');
      expect(call.args).not.toContain('-p');
      expect(call.args).not.toContain('--model');
      expect(call.args).not.toContain('--effort');
    }
    const main1 = runs.find((c) => c.args[2] === 'main');
    expect(main1?.args.slice(0, 5)).toEqual(['--bg', '--name', 'main', '--autocompact', '600k']);
    expect(main1?.args.at(-1)).toMatch(/^You are the lead\.[\s\S]*## trellis-crew start-up/);
  });

  it('45: adds --model and --effort only for the session that sets them', async () => {
    const t = claudeInstalled();
    const file = writeRoles(
      t.env,
      'team.yml',
      SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: model-a\n    effort: high'),
    );
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    const runs = t.runner.calls.filter((c) => c.kind === 'run');
    const helperA = runs.find((c) => c.args[2] === 'helper-a');
    expect(helperA?.args.slice(0, 9)).toEqual([
      '--bg', '--name', 'helper-a', '--autocompact', '400k', '--model', 'model-a', '--effort', 'high',
    ]);
    const chain = runs.find((c) => c.args[2] === 'chain');
    expect(chain?.args).toEqual(['--bg', '--name', 'chain', chain?.args.at(-1)]);
  });

  it('45: the Claude Code bounds apply at start, and a failure starts nothing', async () => {
    const t = claudeInstalled();
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 99k'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(/team\.yml:\d+: .*100k to 1M/);
    expect(t.runner.calls).toEqual([]);
  });

  it('47: team.json holds each name, pid, and session id', async () => {
    const t = claudeInstalled();
    expect(await main(['start'], t.deps)).toBe(0);
    const team = readTeam(t.env);
    expect(team.ok && team.record?.harness).toBe('claude-code');
    if (!team.ok || !team.record) return;
    expect(team.record.sessions.map((s) => s.name)).toEqual([
      'personal-assistant', 'main', 'benchmark', 'research', 'worker-1', 'worker-2', 'worker-3',
    ]);
    // Gaps: the pid behind a --bg session and the session id format are not documented.
    for (const entry of team.record.sessions) expect(entry).toMatchObject({ pid: null, session_id: null });
    expect(t.out.text()).toContain(teamJsonPath(t.env));
  });

  it('47: a detached harness records a pid and a session id per session', async () => {
    const t = claudeInstalled({ adapters: { 'claude-code': detachedAdapter('claude-code') } });
    expect(await main(['start'], t.deps)).toBe(0);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    for (const entry of team.record.sessions) {
      expect(entry.pid).toBeGreaterThan(40000);
      expect(entry.session_id).toBe(`fixture-${entry.name}`);
    }
  });

  it('refuses to start over a recorded team', async () => {
    const t = claudeInstalled();
    expect(await main(['start'], t.deps)).toBe(0);
    const before = t.runner.calls.length;
    expect(await main(['start'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/stop/);
    expect(t.runner.calls.length).toBe(before);
  });

  it('stops with exit 1 when no harness is chosen yet', async () => {
    const t = claudeInstalled();
    const bare = { ...t.deps, env: { ...t.env, home: join(t.env.home, 'empty') } };
    expect(await main(['start'], bare)).toBe(1);
    expect(t.err.text()).toMatch(/install/);
    expect(t.runner.calls).toEqual([]);
  });

  it('a failed launch stops the rest and keeps what started in team.json', async () => {
    const t = claudeInstalled();
    let count = 0;
    t.runner.run = async (command, args) => {
      t.runner.calls.push({ kind: 'run', command, args });
      count += 1;
      return count === 3
        ? { code: 1, stdout: '', stderr: 'fixture failure\n', timedOut: false }
        : { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    expect(await main(['start'], t.deps)).toBe(1);
    expect(t.runner.calls).toHaveLength(3);
    const team = readTeam(t.env);
    expect(team.ok && team.record?.sessions.map((s) => s.name)).toEqual(['personal-assistant', 'main']);
    expect(t.err.text()).toMatch(/benchmark.*fixture failure/);
  });

  it('51: top-level --roles f does the same as start --roles f', async () => {
    const a = claudeInstalled();
    const b = claudeInstalled();
    const fileA = writeRoles(a.env, 'team.yml', SMALL_TEAM);
    const fileB = writeRoles(b.env, 'team.yml', SMALL_TEAM);
    expect(await main(['--roles', fileA], a.deps)).toBe(0);
    expect(await main(['start', '--roles', fileB], b.deps)).toBe(0);
    expect(a.runner.calls).toEqual(b.runner.calls);
    expect(existsSync(teamJsonPath(a.env))).toBe(true);
    const recordA = JSON.parse(readFileSync(teamJsonPath(a.env), 'utf8')) as { sessions: unknown };
    const recordB = JSON.parse(readFileSync(teamJsonPath(b.env), 'utf8')) as { sessions: unknown };
    expect(recordA.sessions).toEqual(recordB.sessions);
  });
});

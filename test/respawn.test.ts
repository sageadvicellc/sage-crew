import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { START_UP_HEADING } from '../src/kickoff/compose.ts';
import { readTeam } from '../src/store/team-json.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { claudeInstalled, detachedAdapter, writeRoles, type Harnessed } from './helpers/team.ts';

const CLAUDE_FLAGS = { autocompact: '--autocompact', model: '--model', effort: '--effort' } as const;
const TEAM = SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: model-a');

async function started(flags: Parameters<typeof detachedAdapter>[1] = CLAUDE_FLAGS): Promise<Harnessed & { file: string }> {
  const t = claudeInstalled({ adapters: { 'claude-code': detachedAdapter('claude-code', flags) } });
  const file = writeRoles(t.env, 'team.yml', TEAM);
  expect(await main(['start', '--roles', file], t.deps)).toBe(0);
  t.runner.calls.length = 0;
  t.out.lines.length = 0;
  t.err.lines.length = 0;
  return { ...t, file };
}

function entry(t: Harnessed, name: string) {
  const team = readTeam(t.env);
  if (!team.ok || !team.record) throw new Error('no team');
  const found = team.record.sessions.find((s) => s.name === name);
  if (!found) throw new Error(`no entry ${name}`);
  return found;
}

describe('respawn', () => {
  it('52: restarts one session under the same name with the given flags, and keeps roles-file values for the rest', async () => {
    const t = await started();
    const old = entry(t, 'helper-a');
    expect(await main(['respawn', 'helper-a', '--effort', 'high'], t.deps)).toBe(0);
    const kills = t.runner.calls.filter((c) => c.kind === 'kill');
    expect(kills.map((c) => Number(c.command))).toEqual([old.pid]);
    const launches = t.runner.calls.filter((c) => c.kind === 'detached');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.args.slice(0, 6)).toEqual(['--autocompact', '400k', '--model', 'model-a', '--effort', 'high']);

    t.runner.calls.length = 0;
    expect(await main(['respawn', 'helper-a', '--model', 'model-b', '--autocompact', '500k'], t.deps)).toBe(0);
    const again = t.runner.calls.find((c) => c.kind === 'detached');
    expect(again?.args.slice(0, 4)).toEqual(['--autocompact', '500k', '--model', 'model-b']);
    expect(again?.args).not.toContain('--effort');
  });

  it('53: sends the kickoff again and updates the pid and session id in team.json', async () => {
    const t = await started();
    const old = entry(t, 'helper-a');
    const others = readTeam(t.env);
    expect(await main(['respawn', 'helper-a'], t.deps)).toBe(0);
    const launch = t.runner.calls.find((c) => c.kind === 'detached');
    expect(launch?.args.at(-1)).toMatch(/^You help\.\n\n## trellis-crew start-up\nYou are helper-a, a worker\./);
    expect(launch?.args.at(-1)).toContain(START_UP_HEADING);
    const now = entry(t, 'helper-a');
    expect(now.pid).not.toBe(old.pid);
    expect(now.session_id).toBe(`fixture-helper-a-${now.pid}`);
    const after = readTeam(t.env);
    if (!others.ok || !others.record || !after.ok || !after.record) throw new Error('no team');
    expect(after.record.sessions.filter((s) => s.name !== 'helper-a')).toEqual(
      others.record.sessions.filter((s) => s.name !== 'helper-a'),
    );
    expect(after.record.sessions.map((s) => s.name)).toEqual(others.record.sessions.map((s) => s.name));
  });

  it('54: the roles file does not change', async () => {
    const t = await started();
    const before = readFileSync(t.file, 'utf8');
    const mtime = statSync(t.file).mtimeMs;
    expect(await main(['respawn', 'helper-a', '--model', 'model-z'], t.deps)).toBe(0);
    expect(readFileSync(t.file, 'utf8')).toBe(before);
    expect(statSync(t.file).mtimeMs).toBe(mtime);
  });

  it('55: an invalid flag value or an unknown name fails before anything stops', async () => {
    const t = await started();
    const cases: string[][] = [
      ['respawn', 'nobody'],
      ['respawn', 'helper-a', '--autocompact', 'lots'],
      ['respawn', 'helper-a', '--autocompact', '99k'],
      ['respawn', 'helper-a', '--effort', 'extreme'],
      ['respawn', 'helper-a', '--model', ''],
      ['respawn', 'helper-a', '--model=--dangerously-skip-permissions'],
      ['respawn', 'helper-a', '--model', 'model a'],
      ['respawn', 'helper-a', '--effort=-x'],
    ];
    for (const argv of cases) {
      expect(await main(argv, t.deps), argv.join(' ')).toBe(2);
    }
    expect(t.runner.calls).toEqual([]);
    expect(t.err.text()).toMatch(/nobody/);
  });

  it('56: a flag the harness cannot take prints the same warning as start', async () => {
    const t = claudeInstalled({ adapters: { 'claude-code': detachedAdapter('claude-code', {}) } });
    const file = writeRoles(t.env, 'team.yml', TEAM);
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    const atStart = t.err.lines.find((l) => l.startsWith('warning: helper-a: model'));
    expect(atStart).toBe('warning: helper-a: model ignored. Fixture Harness has no verified flag for it.');
    t.err.lines.length = 0;
    expect(await main(['respawn', 'helper-a', '--model', 'model-b'], t.deps)).toBe(0);
    expect(t.err.lines).toContain(atStart);
  });

  it('refuses on a session with no local process, and changes nothing', async () => {
    const t = claudeInstalled();
    expect(await main(['start'], t.deps)).toBe(0);
    t.runner.calls.length = 0;
    expect(await main(['respawn', 'worker-1', '--model', 'model-b'], t.deps)).toBe(1);
    expect(t.runner.calls).toEqual([]);
    expect(t.err.text()).toMatch(/cannot stop worker-1/);
  });

  it('fails when no team is running', async () => {
    const t = claudeInstalled();
    expect(await main(['respawn', 'worker-1'], t.deps)).toBe(1);
    expect(t.runner.calls).toEqual([]);
  });
});

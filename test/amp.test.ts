import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAmpThreadId } from '../src/adapters/amp.ts';
import { main } from '../src/cli.ts';
import { readTeam, writeTeam } from '../src/store/team-json.ts';
import { fixtureBin } from './helpers/paths.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn, writeRoles } from './helpers/team.ts';

const amp = join(fixtureBin, 'amp');

describe('Amp', () => {
  it('starts each session as a titled thread with amp -ox, holding no local process', async () => {
    const t = installedOn('amp', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    const runs = t.runner.calls.filter((c) => c.kind === 'run');
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toEqual([]);
    expect(runs).toHaveLength(7);
    const mainRun = runs.find((c) => c.args[1] === 'main');
    expect(mainRun?.command).toBe(amp);
    expect(mainRun?.args.slice(0, 3)).toEqual(['--title', 'main', '-ox']);
    expect(mainRun?.args).toHaveLength(4);
    expect(mainRun?.args[3]).toMatch(/You are main, the lead\.[\s\S]*file mailbox at/);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    for (const entry of team.record.sessions) expect(entry).toMatchObject({ pid: null, session_id: null });
  });

  it('a failed amp -ox stops the start and names the session', async () => {
    const t = installedOn('amp', 'file-mailbox');
    t.runner.run = async (command, args) => {
      t.runner.calls.push({ kind: 'run', command, args });
      return { code: 3, stdout: '', stderr: 'fixture failure\n', timedOut: false };
    };
    expect(await main(['start'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/could not start: amp -ox: fixture failure/);
  });

  it('46: each set field prints one warning, and the thread still starts', async () => {
    const t = installedOn('amp', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    effort: high'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.lines.filter((l) => l.startsWith('warning: helper-a:'))).toEqual([
      'warning: helper-a: autocompact ignored. Amp has no verified flag for it.',
      'warning: helper-a: effort ignored. Amp has no verified flag for it.',
    ]);
    expect(t.runner.calls.some((c) => c.args[1] === 'helper-a')).toBe(true);
  });

  it('the thread id is a gap, so no id is read from amp output', () => {
    expect(parseAmpThreadId('any output at all\n')).toBeNull();
  });

  it('50: stop leaves each thread running, prints its id, and ends no process', async () => {
    const t = installedOn('amp', 'file-mailbox');
    writeTeam(t.env, {
      version: 1,
      harness: 'amp',
      sessions: [
        { name: 'main', pid: null, session_id: 'fixture-thread-1' },
        { name: 'worker-1', pid: null, session_id: null },
      ],
    });
    expect(await main(['stop'], t.deps)).toBe(0);
    expect(t.out.lines).toContain('main: Amp thread fixture-thread-1 still runs. No command to stop a thread is documented.');
    expect(t.out.lines).toContain('worker-1: Amp thread still runs, but its id was not recorded. No command to stop a thread is documented.');
    expect(t.runner.calls).toEqual([]);
  });

  it('install names the skill source gap and runs no amp command', async () => {
    const t = installedOn('amp', 'file-mailbox');
    expect(await main(['install', '--harness', 'amp'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/source.*amp skill add.*not documented/);
    expect(t.runner.calls).toEqual([]);
  });

  it('update runs amp skill update trellis-crew and prints amp update', async () => {
    const t = installedOn('amp', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    expect(await main(['update'], t.deps)).toBe(0);
    expect(t.runner.calls.map((c) => [c.command, ...c.args])).toEqual([[amp, 'skill', 'update', 'trellis-crew']]);
    expect(t.out.text()).toContain('To update Amp itself, run: amp update');
  });
});

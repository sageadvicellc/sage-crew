import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { readTeam } from '../src/store/team-json.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn, writeRoles } from './helpers/team.ts';

describe('Hermes Agent', () => {
  it('prints the documented chat command and the kickoff for each session, and runs nothing', async () => {
    const t = installedOn('hermes', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    expect(t.runner.calls).toEqual([]);
    const text = t.out.text();
    expect(text).toContain('hermes chat -p main');
    expect(text).toContain('hermes chat -p worker-3');
    expect(text).toMatch(/You are the lead\.[\s\S]*## trellis-crew start-up\nYou are main, the lead\./);
    expect(text).toMatch(/file mailbox at .*\.trellis-crew\/mailbox/);
    expect(existsSync(join(t.env.home, '.trellis-crew', 'mailbox'))).toBe(true);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    for (const entry of team.record.sessions) expect(entry).toMatchObject({ pid: null, session_id: null });
  });

  it('46: each set field prints one warning, and the session is still set up', async () => {
    const t = installedOn('hermes', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    effort: high'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.lines.filter((l) => l.startsWith('warning: helper-a:'))).toEqual([
      'warning: helper-a: autocompact ignored. Hermes Agent has no verified flag for it.',
      'warning: helper-a: effort ignored. Hermes Agent has no verified flag for it.',
    ]);
    expect(t.out.text()).toContain('hermes chat -p helper-a');
  });

  it('install names the skill source gap and runs no hermes command', async () => {
    const t = installedOn('hermes', 'file-mailbox');
    expect(await main(['install', '--harness', 'hermes'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/source.*hermes skills install.*not documented/);
    expect(t.runner.calls).toEqual([]);
  });

  it('update names the same gap, prints hermes update, and runs nothing', async () => {
    const t = installedOn('hermes', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    expect(await main(['update'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/not documented/);
    expect(t.out.text()).toContain('hermes update');
    expect(t.runner.calls).toEqual([]);
  });

  it('stop names each session it did not start', async () => {
    const t = installedOn('hermes', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    expect(await main(['stop'], t.deps)).toBe(0);
    expect(t.out.text()).toMatch(/main: the CLI started no process for it/);
    expect(t.runner.calls).toEqual([]);
  });
});

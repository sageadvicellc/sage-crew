import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
import type { RolesConfig } from '../src/roles/schema.ts';
import { defaultTeam } from '../src/roles/defaults.ts';
import { loadTeam } from '../src/roles/load.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { recordingRunner } from './helpers/recording-runner.ts';
import { SMALL_TEAM } from './helpers/roles.ts';

function names(config: RolesConfig): string[] {
  return config.sessions.map((s) => s.name);
}

function byName(config: RolesConfig, name: string) {
  const session = config.sessions.find((s) => s.name === name);
  if (!session) throw new Error(`no session ${name}`);
  return session;
}

const TWO_LEADS = SMALL_TEAM.replace(
  'workers: [helper-a, helper-b]',
  'workers: [helper-a]',
).replace(
  '  - name: watcher',
  `  - name: boss-two
    role: lead
    reports_to: chain
    workers: [helper-b]
    kickoff: |
      You also lead.
  - name: watcher`,
);

function cliDeps(cwd?: string) {
  const env = makeTestEnv(cwd ? { cwd } : {});
  const runner = recordingRunner();
  const err = capture();
  const startTeam = vi.fn(async (_config: RolesConfig) => 0);
  return { env, runner, err, startTeam, deps: { env, runner, out: () => {}, err: err.write, startTeam } };
}

describe('default team', () => {
  it('14: seven sessions, three workers, section 3 autocompact values, no model and no effort', () => {
    const team = defaultTeam();
    expect(names(team)).toEqual([
      'personal-assistant',
      'main',
      'benchmark',
      'research',
      'worker-1',
      'worker-2',
      'worker-3',
    ]);
    expect(team.sessions.filter((s) => s.role === 'standby')).toHaveLength(3);
    expect(Object.fromEntries(team.sessions.map((s) => [s.name, s.autocompact]))).toEqual({
      'personal-assistant': '300k',
      main: '600k',
      benchmark: '600k',
      research: '600k',
      'worker-1': '400k',
      'worker-2': '400k',
      'worker-3': '400k',
    });
    for (const session of team.sessions) {
      expect(session.model).toBeUndefined();
      expect(session.effort).toBeUndefined();
    }
    expect(byName(team, 'main').workers).toEqual(['worker-1', 'worker-2', 'worker-3']);
    expect(byName(team, 'benchmark').clock).toBe('30m');
  });

  it('15: --workers 5 gives five workers under main, each at 400k', () => {
    const team = defaultTeam({ workers: 5 });
    const workers = team.sessions.filter((s) => s.role === 'standby');
    expect(workers.map((s) => s.name)).toEqual(['worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5']);
    for (const worker of workers) {
      expect(worker.reports_to).toBe('main');
      expect(worker.autocompact).toBe('400k');
    }
    expect(byName(team, 'main').workers).toHaveLength(5);
  });

  it('16: --merge-reporters gives one benchmark-research at 600k', () => {
    const team = defaultTeam({ mergeReporters: true });
    expect(names(team)).not.toContain('benchmark');
    expect(names(team)).not.toContain('research');
    const merged = byName(team, 'benchmark-research');
    expect(merged.autocompact).toBe('600k');
    expect(merged.reports_to).toBe('personal-assistant');
    expect(team.sessions).toHaveLength(6);
  });

  it('17: --workers 2 --roles f replaces the standby sessions under the file lead', () => {
    const env = makeTestEnv();
    const file = join(env.cwd, 'team.yml');
    writeFileSync(file, SMALL_TEAM);
    const result = loadTeam({ env, roles: file, workers: 2 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(names(result.config)).toEqual(['chain', 'boss', 'watcher', 'worker-1', 'worker-2']);
    expect(byName(result.config, 'boss').workers).toEqual(['worker-1', 'worker-2']);
    for (const name of ['worker-1', 'worker-2']) {
      expect(byName(result.config, name)).toMatchObject({ role: 'standby', reports_to: 'boss', autocompact: '400k' });
    }
  });

  it('18: --workers with a two-lead file exits 2 and starts nothing', async () => {
    const t = cliDeps();
    const file = join(t.env.cwd, 'two-leads.yml');
    writeFileSync(file, TWO_LEADS);
    expect(loadTeam({ env: t.env, roles: file }).ok).toBe(true);
    expect(await main(['start', '--workers', '2', '--roles', file], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(/lead/);
    expect(t.startTeam).not.toHaveBeenCalled();
    expect(t.runner.calls).toEqual([]);
  });

  it('19: with no --roles, the CLI reads ./sagespec.yml when it exists', async () => {
    const t = cliDeps();
    writeFileSync(join(t.env.cwd, 'sagespec.yml'), SMALL_TEAM);
    expect(await main(['start'], t.deps)).toBe(0);
    expect(names(t.startTeam.mock.calls[0]?.[0] as RolesConfig)).toContain('boss');

    const bare = cliDeps();
    expect(await main(['start'], bare.deps)).toBe(0);
    expect(bare.startTeam.mock.calls[0]?.[0]).toEqual(defaultTeam());
  });

  it('51 groundwork: top-level --roles loads the same file as start --roles', async () => {
    const t = cliDeps();
    const file = join(t.env.cwd, 'team.yml');
    writeFileSync(file, SMALL_TEAM);
    expect(await main(['--roles', file], t.deps)).toBe(0);
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.startTeam.mock.calls[0]?.[0]).toEqual(t.startTeam.mock.calls[1]?.[0]);
  });

  it('a missing --roles file exits 2', async () => {
    const t = cliDeps();
    expect(await main(['start', '--roles', join(t.env.cwd, 'missing.yml')], t.deps)).toBe(2);
    expect(t.startTeam).not.toHaveBeenCalled();
  });

  it('--merge-reporters on a roles file exits 2', async () => {
    const t = cliDeps();
    const file = join(t.env.cwd, 'team.yml');
    writeFileSync(file, SMALL_TEAM);
    expect(await main(['start', '--merge-reporters', '--roles', file], t.deps)).toBe(2);
    expect(t.startTeam).not.toHaveBeenCalled();
  });
});

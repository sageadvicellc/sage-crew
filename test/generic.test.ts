import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/deps.ts';
import { readTeam } from '../src/store/team-json.ts';
import { writeInstallRecord } from '../src/store/install-yml.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { fixtureBin } from './helpers/paths.ts';
import { recordingRunner } from './helpers/recording-runner.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { writeRoles } from './helpers/team.ts';

/** A fixture home with OpenCode on PATH and chosen at install. */
function openCodeInstalled(extra: Partial<CliDeps> = {}) {
  const binDir = makeFixtureHome();
  const bin = join(binDir, 'opencode');
  writeFileSync(bin, '#!/bin/sh\n# Fixture stub. Does nothing.\nexit 0\n');
  chmodSync(bin, 0o755);
  const env = makeTestEnv({ path: `${fixtureBin}${delimiter}${binDir}` });
  writeInstallRecord(env, { harness: 'opencode', transport: 'file-mailbox', plugin_version: null });
  const runner = recordingRunner();
  const out = capture();
  const err = capture();
  return { env, runner, out, err, deps: { env, runner, out: out.write, err: err.write, ...extra } satisfies CliDeps };
}

describe('generic tier three', () => {
  it('prints the kickoff for each session and runs nothing', async () => {
    const t = openCodeInstalled();
    expect(await main(['start'], t.deps)).toBe(0);
    expect(t.runner.calls).toEqual([]);
    const text = t.out.text();
    expect(text).toMatch(/--- main ---\nNot started: /);
    expect(text).toMatch(/You are main, the lead\.[\s\S]*file mailbox at/);
    expect(text).toContain('--- end of worker-3 ---');
    expect(text).not.toMatch(/Start it in its own terminal with/);
    expect(existsSync(join(t.env.home, '.trellis-crew', 'mailbox'))).toBe(true);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    expect(team.record.sessions).toHaveLength(7);
    for (const entry of team.record.sessions) expect(entry).toMatchObject({ pid: null, session_id: null });
  });

  it('46: each set field prints one warning, and the session is still set up', async () => {
    const t = openCodeInstalled();
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: model-a'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.lines.filter((l) => l.startsWith('warning: helper-a:'))).toEqual([
      'warning: helper-a: autocompact ignored. OpenCode has no verified flag for it.',
      'warning: helper-a: model ignored. OpenCode has no verified flag for it.',
    ]);
    expect(t.out.text()).toContain('--- helper-a ---');
  });

  it('stop names each session it did not start and ends nothing', async () => {
    const t = openCodeInstalled();
    expect(await main(['start'], t.deps)).toBe(0);
    expect(await main(['stop'], t.deps)).toBe(0);
    expect(t.out.text()).toMatch(/worker-1: the CLI started no process for it/);
    expect(t.runner.calls).toEqual([]);
  });

  it('install names the plugin gap, still records the choice, and runs nothing', async () => {
    const t = openCodeInstalled();
    expect(await main(['install', '--harness', 'opencode', '--reconfigure'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/OpenCode.*not documented/);
    expect(t.err.text()).not.toMatch(/not built yet/);
    expect(t.runner.calls).toEqual([]);
  });

  it('update names the plugin gap and the self-update gap, and runs nothing', async () => {
    const t = openCodeInstalled({ fetchLatest: async () => ({ status: 'not-published' }) });
    expect(await main(['update'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/OpenCode.*not documented/);
    expect(t.out.text()).toContain('the OpenCode update command is not documented yet.');
    expect(t.runner.calls).toEqual([]);
  });
});

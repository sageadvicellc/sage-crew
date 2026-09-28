import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installYmlPath, readInstallRecord, writeInstallRecord } from '../src/store/install-yml.ts';
import { readTeam, teamJsonPath, writeTeam, type TeamRecord } from '../src/store/team-json.ts';
import { makeTestEnv } from './helpers/env.ts';

// Supporting tests for plan tests 33, 35, and 47, which use these stores.

describe('install.yml store', () => {
  it('round-trips the harness, the transport, and the plugin version under the state folder', () => {
    const env = makeTestEnv();
    expect(readInstallRecord(env)).toEqual({ ok: true, record: undefined });
    writeInstallRecord(env, { harness: 'claude-code', transport: 'native', plugin_version: '0.1.0' });
    expect(installYmlPath(env)).toBe(join(env.home, '.trellis-crew', 'install.yml'));
    expect(readFileSync(installYmlPath(env), 'utf8')).toMatch(/harness: claude-code/);
    expect(readInstallRecord(env)).toEqual({
      ok: true,
      record: { harness: 'claude-code', transport: 'native', plugin_version: '0.1.0' },
    });
  });

  it('holds a null plugin version and the CLI version', () => {
    const env = makeTestEnv();
    writeInstallRecord(env, { harness: 'hermes', transport: 'file-mailbox', plugin_version: null, cli_version: '0.1.0' });
    expect(readInstallRecord(env)).toEqual({
      ok: true,
      record: { harness: 'hermes', transport: 'file-mailbox', plugin_version: null, cli_version: '0.1.0' },
    });
  });

  it('reports a damaged file instead of guessing', () => {
    const env = makeTestEnv();
    mkdirSync(join(env.home, '.trellis-crew'));
    for (const bad of [
      'harness: [',
      'harness: pigeon\ntransport: native\nplugin_version: "1"',
      'harness: hermes\ntransport: native\nplugin_version: 1',
      '- a list',
    ]) {
      writeFileSync(installYmlPath(env), bad);
      expect(readInstallRecord(env).ok, bad).toBe(false);
    }
  });
});

describe('team.json store', () => {
  const record: TeamRecord = {
    version: 1,
    harness: 'codex',
    supervisor_pid: 4100,
    sessions: [
      { name: 'main', pid: 4101, session_id: null },
      { name: 'worker-1', pid: 4102, session_id: 'fixture-id' },
    ],
  };

  it('round-trips the pid, name, session id, and supervisor pid', () => {
    const env = makeTestEnv();
    expect(readTeam(env)).toEqual({ ok: true, record: undefined });
    writeTeam(env, record);
    expect(teamJsonPath(env)).toBe(join(env.home, '.trellis-crew', 'team.json'));
    expect(readTeam(env)).toEqual({ ok: true, record });
    expect(statSync(teamJsonPath(env)).mode & 0o777).toBe(0o600);
  });

  it('reports a damaged file instead of guessing', () => {
    const env = makeTestEnv();
    mkdirSync(join(env.home, '.trellis-crew'));
    for (const bad of ['{', '{"version": 1, "harness": "codex", "sessions": [{"name": 3}]}', '[]']) {
      writeFileSync(teamJsonPath(env), bad);
      expect(readTeam(env).ok, bad).toBe(false);
    }
    expect(existsSync(join(env.home, '.trellis-crew', 'install.yml'))).toBe(false);
  });
});

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main, type CliDeps } from '../src/cli.ts';
import type { FetchLatest } from '../src/registry.ts';
import { installYmlPath, readInstallRecord, writeInstallRecord } from '../src/store/install-yml.ts';
import { cliVersion } from '../src/versions.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { recordingRunner } from './helpers/recording-runner.ts';

function rig(fetchLatest: FetchLatest, harness: 'claude-code' | 'hermes' | 'qwen-code' | 'codex' | 'amp' = 'claude-code') {
  const env = makeTestEnv();
  writeInstallRecord(env, { harness, transport: 'native', plugin_version: null, cli_version: '0.0.1' });
  const runner = recordingRunner();
  const out = capture();
  const err = capture();
  const deps: CliDeps = { env, runner, out: out.write, err: err.write, fetchLatest };
  return { env, runner, out, err, deps };
}

const published: FetchLatest = async () => ({ status: 'ok', version: '9.9.9' });

describe('update', () => {
  it('36: prints both versions', async () => {
    const t = rig(published);
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    expect(t.out.text()).toContain(`installed ${cliVersion()}`);
    expect(t.out.text()).toContain('latest on npm 9.9.9');
    expect(t.out.text()).toContain('npm install -g trellis-crew@latest');
  });

  it('36: a registry 404 prints "not published"', async () => {
    const fetchLatest = vi.fn<FetchLatest>(async () => ({ status: 'not-published' }));
    const t = rig(fetchLatest);
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    expect(fetchLatest).toHaveBeenCalledWith('trellis-crew');
    expect(t.out.text()).toMatch(/latest on npm: not published/);
  });

  it('36: a registry error is reported, never guessed', async () => {
    const t = rig(async () => ({ status: 'error', message: 'fixture outage' }));
    await main(['update', '--check'], t.deps);
    expect(t.err.text()).toMatch(/could not be read \(fixture outage\)/);
    expect(t.out.text()).not.toMatch(/could not be read/);
  });

  it('a registry version that is not a version is an error, and is never printed', async () => {
    const t = rig(async () => ({ status: 'ok', version: '9.9.9\u001b[2Jfixture' }));
    await main(['update', '--check'], t.deps);
    expect(t.err.text()).toMatch(/could not be read \(the registry returned a value that is not a version\)/);
    expect(t.out.text() + t.err.text()).not.toContain('\u001b');
    expect(t.out.text()).not.toMatch(/Update the CLI with/);
  });

  it('37: --check writes nothing', async () => {
    const t = rig(published);
    const state = join(t.env.home, '.trellis-crew');
    const before = readFileSync(installYmlPath(t.env), 'utf8');
    const mtime = statSync(installYmlPath(t.env)).mtimeMs;
    const listing = readdirSync(t.env.home, { recursive: true });
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    expect(readFileSync(installYmlPath(t.env), 'utf8')).toBe(before);
    expect(statSync(installYmlPath(t.env)).mtimeMs).toBe(mtime);
    expect(readdirSync(t.env.home, { recursive: true })).toEqual(listing);
    expect(existsSync(state)).toBe(true);
    expect(t.runner.calls).toEqual([]);
  });

  it('37: without --check, the version fields in install.yml are rewritten', async () => {
    const t = rig(published);
    await main(['update'], t.deps);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { cli_version: cliVersion() } });
  });

  it('38: the harness update command prints and never runs', async () => {
    const cases = [
      ['claude-code', 'claude update'],
      ['hermes', 'hermes update'],
      ['amp', 'amp update'],
      ['qwen-code', 'no documented update command'],
      ['codex', 'not documented yet'],
    ] as const;
    for (const [harness, expected] of cases) {
      const t = rig(published, harness);
      await main(['update'], t.deps);
      expect(t.out.text(), harness).toContain(expected);
      expect(t.runner.calls.filter((c) => c.args.length === 1 && c.args[0] === 'update'), harness).toEqual([]);
    }
  });

  it('with no install record, says to install first', async () => {
    const env = makeTestEnv();
    const out = capture();
    const err = capture();
    const runner = recordingRunner();
    expect(await main(['update'], { env, runner, out: out.write, err: err.write, fetchLatest: published })).toBe(1);
    expect(err.text()).toMatch(/install/);
    expect(out.text()).toContain('latest on npm 9.9.9');
  });
});

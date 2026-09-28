import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MARKETPLACE_NAME,
  CLAUDE_MARKETPLACE_REPO,
  CLAUDE_PLUGIN_ID,
} from '../src/adapters/claude-code.ts';
import { main, type CliDeps } from '../src/cli.ts';
import { readInstallRecord, writeInstallRecord } from '../src/store/install-yml.ts';
import { bundledPluginVersion } from '../src/versions.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { fixtureBin, repoRoot } from './helpers/paths.ts';
import { recordingRunner, type Responder } from './helpers/recording-runner.ts';

const claude = join(fixtureBin, 'claude');
const ok = { code: 0, stdout: '', stderr: '', timedOut: false };

function rig(responder: Responder = () => ok) {
  const env = makeTestEnv();
  mkdirSync(join(env.home, '.claude'));
  const runner = recordingRunner(responder);
  const out = capture();
  const err = capture();
  const deps: CliDeps = {
    env,
    runner,
    out: out.write,
    err: err.write,
    now: () => new Date('2026-03-04T10:00:00Z'),
    fetchLatest: async () => ({ status: 'not-published' }),
  };
  return { env, runner, out, err, deps };
}

function pluginCalls(runner: ReturnType<typeof recordingRunner>) {
  return runner.calls.filter((c) => c.kind === 'run' && c.args[0] === 'plugin').map((c) => [c.command, ...c.args]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('Claude Code plugin install and update', () => {
  it('derives the marketplace name from the repository constant', () => {
    expect(CLAUDE_MARKETPLACE_NAME).toBe(CLAUDE_MARKETPLACE_REPO.split('/')[1]);
    expect(CLAUDE_PLUGIN_ID).toBe(`trellis-crew@${CLAUDE_MARKETPLACE_NAME}`);
  });

  it('32: Claude Code gets its documented install arguments, marketplace first', async () => {
    const t = rig();
    expect(await main(['install', '--non-interactive', '--yes'], t.deps)).toBe(0);
    expect(pluginCalls(t.runner)).toEqual([
      [claude, 'plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE_REPO],
      [claude, 'plugin', 'install', CLAUDE_PLUGIN_ID],
    ]);
    expect(readInstallRecord(t.env)).toMatchObject({
      ok: true,
      record: { harness: 'claude-code', plugin_version: bundledPluginVersion() },
    });
  });

  it('32: a failed plugin command stops the install before the settings file and install.yml', async () => {
    const t = rig((_command, args) =>
      args[1] === 'install' ? { code: 1, stdout: '', stderr: 'fixture: plugin not found\n', timedOut: false } : ok,
    );
    const settings = join(t.env.home, '.claude', 'settings.json');
    writeFileSync(settings, '{}\n');
    expect(await main(['install', '--non-interactive'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/fixture: plugin not found/);
    expect(readFileSync(settings, 'utf8')).toBe('{}\n');
    expect(existsSync(join(t.env.home, '.trellis-crew', 'install.yml'))).toBe(false);
  });

  it('update runs the documented plugin update and rewrites the plugin version', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'claude-code', transport: 'native', plugin_version: '0.0.1' });
    expect(await main(['update'], t.deps)).toBe(0);
    expect(pluginCalls(t.runner)).toEqual([[claude, 'plugin', 'update', CLAUDE_PLUGIN_ID]]);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { plugin_version: bundledPluginVersion() } });
    expect(t.out.text()).toContain('claude update');
  });

  it('update --check runs no plugin command', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'claude-code', transport: 'native', plugin_version: '0.0.1' });
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    expect(t.runner.calls).toEqual([]);
  });

  it('no other source file holds the marketplace repository or name', () => {
    const home = join(repoRoot, 'src', 'adapters', 'claude-code.ts');
    const offenders = sourceFiles(join(repoRoot, 'src'))
      .filter((file) => file !== home)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes(CLAUDE_MARKETPLACE_REPO) || text.includes(CLAUDE_MARKETPLACE_NAME);
      })
      .map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
    const own = readFileSync(home, 'utf8');
    expect(own.split(CLAUDE_MARKETPLACE_REPO).length - 1).toBe(1);
    expect(own.split(CLAUDE_MARKETPLACE_NAME).length - 1).toBe(1);
  });
});

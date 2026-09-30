import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
import { writeInstallRecord } from '../src/store/install-yml.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { recordingRunner, type RecordedCall } from './helpers/recording-runner.ts';
import { repoRoot } from './helpers/paths.ts';

/** A value that is not a real key. The tests check that it is never echoed. */
const FIXTURE_KEY = 'fixture-key-value-9f3c1a';
const WARNING =
  'warning: ANTHROPIC_API_KEY is not set. Trellis runs your installed Claude Code under your own sign-in. Use an Anthropic API key.';

function rig(vars: Record<string, string | undefined> = {}) {
  const base = makeTestEnv({ cwd: makeFixtureRepo().root });
  const env = { ...base, vars: { ...base.vars, ...vars } };
  mkdirSync(join(env.home, '.claude'));
  writeFileSync(join(env.home, '.claude', 'settings.json'), '{"theme": "dark"}\n');
  const runner = recordingRunner();
  const out = capture();
  const err = capture();
  const ask = vi.fn(async () => 'y');
  const deps = { env, runner, out: out.write, err: err.write, ask, now: () => new Date('2026-03-04T10:00:00Z') };
  return { env, runner, out, err, deps };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const srcDir = join(repoRoot, 'src');
const files = sourceFiles(srcDir).map((path) => ({ name: relative(repoRoot, path), text: readFileSync(path, 'utf8') }));

/** Every line of every source file that matches, as `file:line`. */
function hits(pattern: RegExp): string[] {
  return files.flatMap((f) =>
    f.text
      .split('\n')
      .flatMap((line, i) => (pattern.test(line) ? [`${f.name}:${i + 1}`] : [])),
  );
}

/*
 * The scan below is a heuristic. It reads text, so it cannot see a string
 * that code builds at run time. It pairs with the runtime check further
 * down, which records every call the CLI makes to the claude binary.
 */
describe('sign-in safety: static scan of src/', () => {
  it('scans the source files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no literal runs login, logout, or setup-token as a claude subcommand', () => {
    expect(hits(/\bclaude\s+(login|logout|setup-token)\b/i)).toEqual([]);
    expect(hits(/['"`]\/?(login|logout|setup-token)['"`]/)).toEqual([]);
    expect(hits(/['"`]\/login\b/)).toEqual([]);
  });

  it('no reference to a Claude credential store', () => {
    const stores = [
      '\\.credentials\\.json',
      '\\.claude\\.json',
      '/usr/bin/security',
      'find-generic-password',
      'Claude Code-credentials',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
    ];
    for (const store of stores) expect(hits(new RegExp(store))).toEqual([]);
  });

  it('ANTHROPIC_API_KEY appears in one file only, and there it is read only as a set check', () => {
    const named = hits(/ANTHROPIC_API_KEY/).map((h) => h.split(':')[0]);
    expect(new Set(named)).toEqual(new Set(['src/sign-in.ts']));
    const text = files.find((f) => f.name === 'src/sign-in.ts')?.text ?? '';
    const code = text.split('\n').filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line));
    // The only read of the variable is one comparison with undefined or the empty string.
    const reads = code.filter((line) => /vars\[/.test(line));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/vars\[API_KEY_NAME\]/);
    expect(reads[0]).toMatch(/(===|!==) ?(undefined|'')/);
    // The value is never put in a template, an argument, or a file write.
    expect(code.join('\n')).not.toMatch(/\$\{[^}]*vars/);
    expect(code.join('\n')).not.toMatch(/writeFile|appendFile|out\(|err\(/);
  });
});

describe('sign-in safety: run time', () => {
  const FORBIDDEN = new Set(['login', 'logout', 'setup-token', '/login']);
  const PLUGIN_SUBCOMMANDS = new Set(['marketplace', 'install', 'update']);

  function expectOnlyAllowedClaudeCalls(calls: readonly RecordedCall[]): void {
    const claudeCalls = calls.filter((c) => basename(c.command) === 'claude');
    expect(claudeCalls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.kind).not.toBe('detached');
      for (const arg of call.args) expect(FORBIDDEN.has(arg)).toBe(false);
    }
    for (const call of claudeCalls) {
      expect(['--bg', 'plugin']).toContain(call.args[0]);
      if (call.args[0] === 'plugin') expect(PLUGIN_SUBCOMMANDS.has(call.args[1] ?? '')).toBe(true);
    }
  }

  function expectNoCredentialFiles(home: string): void {
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    expect(existsSync(join(home, '.claude', '.credentials.json'))).toBe(false);
  }

  it('up --harness claude-code calls claude with --bg and plugin only', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], t.deps)).toBe(0);
    expectOnlyAllowedClaudeCalls(t.runner.calls);
    expectNoCredentialFiles(t.env.home);
  });

  it('start calls claude with --bg only', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    writeInstallRecord(t.env, { harness: 'claude-code', transport: 'native', plugin_version: null });
    expect(await main(['start', '--yes'], t.deps)).toBe(0);
    expectOnlyAllowedClaudeCalls(t.runner.calls);
    expect(t.runner.calls.every((c) => c.args[0] === '--bg')).toBe(true);
    expectNoCredentialFiles(t.env.home);
  });

  it('no output or argument carries the key value', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], t.deps)).toBe(0);
    expect(t.out.text() + t.err.text()).not.toContain(FIXTURE_KEY);
    for (const call of t.runner.calls) expect(call.args.join(' ')).not.toContain(FIXTURE_KEY);
  });
});

describe('up: the API key warning', () => {
  it('warns on stderr when ANTHROPIC_API_KEY is unset, before step 1, and still succeeds', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], t.deps)).toBe(0);
    expect(t.err.text()).toContain(WARNING);
    expect(t.out.text()).not.toContain('warning: ANTHROPIC_API_KEY');
  });

  it('warns when ANTHROPIC_API_KEY is empty', async () => {
    const t = rig({ ANTHROPIC_API_KEY: '' });
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], t.deps)).toBe(0);
    expect(t.err.text()).toContain(WARNING);
  });

  it('does not warn when it is set, and never echoes the value', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], t.deps)).toBe(0);
    expect(t.err.text()).not.toContain('ANTHROPIC_API_KEY');
    expect(t.out.text() + t.err.text()).not.toContain(FIXTURE_KEY);
  });

  it('does not change the exit code of a failing up', async () => {
    const t = rig();
    // No inbound flag: the install step exits 1, with the warning already printed.
    expect(await main(['up', '--harness', 'claude-code'], t.deps)).toBe(1);
    expect(t.err.text()).toContain(WARNING);
  });

  it('does not warn on codex, which has its own sign-in', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(0);
    expect(t.err.text()).not.toContain('ANTHROPIC_API_KEY');
  });
});

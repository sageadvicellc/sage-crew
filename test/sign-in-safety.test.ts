import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
import type { FetchLatest } from '../src/registry.ts';
import { makeTestEnv } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { recordingRunner, type RecordedCall } from './helpers/recording-runner.ts';
import { repoRoot } from './helpers/paths.ts';

/**
 * Records every call to a node:fs function whose first argument names a
 * Claude credential file. It lets the run-time test prove that no command
 * touches the sentinel files it plants. The wrapper changes nothing else.
 */
const touched = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    if (typeof value === 'function' && /^[a-z]/.test(key)) {
      const original = value as (...args: unknown[]) => unknown;
      wrapped[key] = Object.assign(
        function (this: unknown, ...args: unknown[]) {
          const first = args[0];
          if (typeof first === 'string' && /(^|\/)(\.credentials\.json|\.claude\.json)$/.test(first)) touched.push(`${key}:${first}`);
          return original.apply(this, args);
        },
        original,
      );
    } else {
      wrapped[key] = value;
    }
  }
  return { ...wrapped, default: wrapped };
});

/** A value that is not a real key. The tests check that it is never echoed. */
const FIXTURE_KEY = 'fixture-key-value-9f3c1a';
const SENTINEL = 'sentinel-not-a-real-file';
const WARNING =
  'warning: ANTHROPIC_API_KEY is not set. Trellis runs your installed Claude Code under your own sign-in. Use an Anthropic API key. If you sign in another way, you can ignore this.';

function rig(vars: Record<string, string | undefined> = {}) {
  const base = makeTestEnv({ cwd: makeFixtureRepo().root });
  const env = { ...base, vars: { ...base.vars, ...vars } };
  mkdirSync(join(env.home, '.claude'));
  writeFileSync(join(env.home, '.claude', 'settings.json'), '{"theme": "dark"}\n');
  const runner = recordingRunner();
  /** Every printed line, in order, tagged with its stream. */
  const log: string[] = [];
  const outLines: string[] = [];
  const errLines: string[] = [];
  const out = (line: string) => {
    log.push(`out:${line}`);
    outLines.push(line);
  };
  const err = (line: string) => {
    log.push(`err:${line}`);
    errLines.push(line);
  };
  const fetchLatest: FetchLatest = async () => ({ status: 'ok', version: '9.9.9' });
  const deps = { env, runner, out, err, ask: vi.fn(async () => 'y'), fetchLatest, now: () => new Date('2026-03-04T10:00:00Z') };
  return { env, runner, log, deps, outText: () => outLines.join('\n'), errText: () => errLines.join('\n') };
}

/** Every file that ships as code: src, root scripts, and the package.json scripts. Tests are not shipped. */
const CODE_EXTENSIONS = /\.(ts|js|mjs|cjs)$/;

function codeFiles(dir: string, top: boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return top ? [] : codeFiles(path, false);
    return CODE_EXTENSIONS.test(name) ? [path] : [];
  });
}

const packageScripts = Object.entries(
  (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {},
).map(([name, script]) => ({ name: `package.json#scripts.${name}`, text: script }));

const files = [
  ...codeFiles(join(repoRoot, 'src'), false),
  ...codeFiles(repoRoot, true),
].map((path) => ({ name: relative(repoRoot, path), text: readFileSync(path, 'utf8') }));
const shipped = [...files, ...packageScripts];

/** Every line of every shipped file that matches, as `file:line`. */
function hits(pattern: RegExp): string[] {
  return shipped.flatMap((f) => f.text.split('\n').flatMap((line, i) => (pattern.test(line) ? [`${f.name}:${i + 1}`] : [])));
}

const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const CALL = /\b(run|spawn|spawnSync|spawnDetached|execFile|execFileSync|exec|execSync|pluginCommand)\s*\(/g;

/** The text of each call to a process-starting function, from its open parenthesis to its close. */
function callSites(text: string): string[] {
  const sites: string[] = [];
  for (const match of text.matchAll(CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let quote = '';
    let i = open;
    for (; i < text.length; i += 1) {
      const c = text[i] as string;
      if (quote !== '') {
        if (c === '\\') i += 1;
        else if (c === quote) quote = '';
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    sites.push(text.slice(open, i + 1));
  }
  return sites;
}

/** The string literals inside process-starting calls, as `file: literal`. */
function callSiteLiterals(): { where: string; literal: string }[] {
  return shipped.flatMap((f) =>
    callSites(f.text).flatMap((site) => (site.match(STRING_LITERAL) ?? []).map((literal) => ({ where: f.name, literal }))),
  );
}

/*
 * The scan below is a heuristic. It reads text, so it cannot see a string
 * that code builds at run time. It pairs with the runtime check further
 * down, which records every call the CLI makes to any program.
 */
describe('sign-in safety: static scan of shipped code', () => {
  it('scans the source files and the package scripts', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(packageScripts.length).toBeGreaterThan(3);
    expect(files.some((f) => f.name === 'src/adapters/claude-code.ts')).toBe(true);
  });

  it('the call-site finder sees the calls that start a process', () => {
    const sites = callSites(files.find((f) => f.name === 'src/adapters/claude-code.ts')?.text ?? '');
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(callSites("runner.run('x', ['a', 'b(c'], {})")).toEqual(["('x', ['a', 'b(c'], {})"]);
  });

  it('no literal runs login, logout, auth, or setup-token as a claude subcommand', () => {
    expect(hits(/\bclaude\s+(auth|login|logout|setup-token)\b/i)).toEqual([]);
    expect(hits(/['"`]\/?(auth|login|logout|setup-token)['"`]/)).toEqual([]);
  });

  it('no string in a process call holds login, logout, setup-token, or auth, even as part of a word', () => {
    const bad = callSiteLiterals().filter(({ literal }) => /login|logout|setup-token|auth/i.test(literal));
    expect(bad).toEqual([]);
  });

  it('no process call names security, the macOS keychain tool', () => {
    const bad = callSiteLiterals().filter(({ literal }) => /\bsecurity\b/i.test(literal));
    expect(bad).toEqual([]);
    expect(hits(/['"`](\/usr\/bin\/)?security['"`]/)).toEqual([]);
  });

  it('the claude adapter starts claude only with a fixed first argument', () => {
    const text = files.find((f) => f.name === 'src/adapters/claude-code.ts')?.text ?? '';
    const runs = [...text.matchAll(/runner\.(?:run|spawnDetached)\(/g)];
    const fixed = [...text.matchAll(/runner\.(?:run|spawnDetached)\(\s*ctx\.binaryPath,\s*\[\s*'([^']+)'/g)].map((m) => m[1]);
    // Every call names its first argument by a literal, so no dynamic subcommand can reach claude.
    expect(fixed).toHaveLength(runs.length);
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(fixed)).toEqual(new Set(['--bg', 'plugin']));
    // The plugin helper takes its subcommand from literals at its call sites.
    const helper = [...text.matchAll(/pluginCommand\(ctx,\s*\[\s*'([^']+)'/g)].map((m) => m[1]);
    const helperCalls = [...text.matchAll(/pluginCommand\(/g)].length - 1;
    expect(helper).toHaveLength(helperCalls);
    expect(new Set(helper)).toEqual(new Set(['marketplace', 'install', 'update']));
  });

  it('node:child_process is imported only by the runner, the codex supervisor, and the codex folder check', () => {
    const named = new Set(hits(/child_process/).map((h) => h.split(':')[0]));
    // src/runner.ts starts every process the CLI runs. src/adapters/codex-supervisor.ts is
    // the detached codex process. src/adapters/codex-guard.ts runs git, read only, for the
    // codex working-folder check.
    expect(named).toEqual(new Set(['src/runner.ts', 'src/adapters/codex-supervisor.ts', 'src/adapters/codex-guard.ts']));
  });

  it('no reference to a Claude credential store or a credential helper', () => {
    const stores = [
      '\\.credentials\\.json',
      '\\.claude\\.json',
      '/usr/bin/security',
      'find-generic-password',
      'Claude Code-credentials',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'apiKeyHelper',
    ];
    for (const store of stores) expect(hits(new RegExp(store))).toEqual([]);
    expect(hits(/credentials/i)).toEqual([]);
  });

  it('ANTHROPIC_API_KEY appears in one file only, and there it is read only as a set check', () => {
    const named = hits(/ANTHROPIC_API_KEY/).map((h) => h.split(':')[0]);
    expect(new Set(named)).toEqual(new Set(['src/sign-in.ts']));
    const text = files.find((f) => f.name === 'src/sign-in.ts')?.text ?? '';
    const code = text.split('\n').filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line));
    // The only read of any variable is one comparison of its trimmed value with the empty string.
    const reads = code.filter((line) => /vars\[/.test(line));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/vars\[name\]/);
    expect(reads[0]).toMatch(/\.trim\(\) !== ''/);
    // The value is never put in a template, an argument, or a file write.
    expect(code.join('\n')).not.toMatch(/\$\{[^}]*vars/);
    expect(code.join('\n')).not.toMatch(/writeFile|appendFile|out\(|err\(/);
  });
});

describe('sign-in safety: run time', () => {
  const ALLOWED_PROGRAMS = new Set(['claude', 'git']);
  const LAUNCH_FLAGS = new Set(['--autocompact', '--model', '--effort']);
  const PLUGIN_SUBCOMMANDS = new Set(['marketplace', 'install', 'update']);

  /** `--bg --name <n> [--flag value]... -- <kickoff>`, or `plugin marketplace add <repo>`, or `plugin install|update <id>`. */
  function claudeShapeProblem(args: readonly string[]): string | undefined {
    if (args[0] === '--bg') {
      if (args[1] !== '--name') return 'no --name after --bg';
      if ((args[2] ?? '-').startsWith('-')) return 'no session name';
      const end = args.indexOf('--', 3);
      if (end !== args.length - 2) return 'the kickoff is not the one argument after --';
      for (let i = 3; i < end; i += 2) {
        if (!LAUNCH_FLAGS.has(args[i] ?? '')) return `unknown launch flag ${args[i] ?? ''}`;
        if (args[i + 1] === undefined || i + 1 >= end) return 'a launch flag has no value';
      }
      return undefined;
    }
    if (args[0] === 'plugin' && PLUGIN_SUBCOMMANDS.has(args[1] ?? '')) {
      if (args[1] === 'marketplace') return args[2] === 'add' && args.length === 4 ? undefined : 'marketplace takes add <repo> only';
      return args.length === 3 ? undefined : 'plugin install and update take one plugin id';
    }
    return `first argument ${args[0] ?? '(none)'} is not allowed`;
  }

  function expectOnlyAllowedCalls(calls: readonly RecordedCall[]): void {
    const runs = calls.filter((c) => c.kind !== 'kill');
    expect(runs.every((c) => c.kind === 'run')).toBe(true);
    for (const call of runs) {
      expect(ALLOWED_PROGRAMS.has(basename(call.command))).toBe(true);
      expect(basename(call.command)).not.toBe('security');
    }
    const claudeCalls = runs.filter((c) => basename(c.command) === 'claude');
    expect(claudeCalls.length).toBeGreaterThan(0);
    for (const call of claudeCalls) expect(claudeShapeProblem(call.args)).toBeUndefined();
  }

  const COMMANDS: string[][] = [
    ['install', '--harness', 'claude-code', '--non-interactive', '--skip-inbound'],
    ['start', '--yes'],
    ['status'],
    ['respawn', 'main', '--yes', '--force-stop'],
    ['stop', '--force-stop'],
    ['update', '--check'],
    ['update'],
    ['up', '--harness', 'claude-code', '--skip-inbound'],
    ['stop', '--force-stop'],
  ];

  it('the shape check refuses what it should', () => {
    expect(claudeShapeProblem(['login'])).toBeDefined();
    expect(claudeShapeProblem(['auth', 'login'])).toBeDefined();
    expect(claudeShapeProblem(['setup-token'])).toBeDefined();
    expect(claudeShapeProblem(['plugin', 'login'])).toBeDefined();
    expect(claudeShapeProblem(['--bg', '--name', 'a', '--', 'k', 'login'])).toBeDefined();
    expect(claudeShapeProblem(['--bg', '--name', 'a', '--', 'kickoff'])).toBeUndefined();
    expect(claudeShapeProblem(['--bg', '--name', 'a', '--model', 'm', '--', 'kickoff'])).toBeUndefined();
    expect(claudeShapeProblem(['plugin', 'marketplace', 'add', 'owner/repo'])).toBeUndefined();
  });

  it('install, start, status, respawn, stop, update, and up on claude-code call only allowed programs, in allowed shapes', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    for (const argv of COMMANDS) await main(argv, t.deps);
    expectOnlyAllowedCalls(t.runner.calls);
    const claudeArgs = t.runner.calls.filter((c) => basename(c.command) === 'claude').map((c) => c.args[0]);
    expect(claudeArgs).toContain('--bg');
    expect(claudeArgs).toContain('plugin');
  });

  it('none of those commands touches a Claude credentials file, which the fixture home holds as sentinels', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    const credentials = join(t.env.home, '.claude', '.credentials.json');
    const config = join(t.env.home, '.claude.json');
    writeFileSync(credentials, SENTINEL);
    writeFileSync(config, SENTINEL);
    touched.length = 0;
    // A control: the recorder sees a read of a sentinel, so silence below means something.
    readFileSync(credentials, 'utf8');
    expect(touched).toEqual([`readFileSync:${credentials}`]);
    touched.length = 0;
    for (const argv of COMMANDS) await main(argv, t.deps);
    expect(touched).toEqual([]);
    expect(readFileSync(credentials, 'utf8')).toBe(SENTINEL);
    expect(readFileSync(config, 'utf8')).toBe(SENTINEL);
  });

  it('no output or argument carries the key value', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    for (const argv of COMMANDS) await main(argv, t.deps);
    expect(t.log.join('\n')).not.toContain(FIXTURE_KEY);
    for (const call of t.runner.calls) expect(call.args.join(' ')).not.toContain(FIXTURE_KEY);
  });

  it('a run with no sentinel creates no credentials file', async () => {
    const t = rig();
    for (const argv of COMMANDS) await main(argv, t.deps);
    expect(existsSync(join(t.env.home, '.claude.json'))).toBe(false);
    expect(existsSync(join(t.env.home, '.claude', '.credentials.json'))).toBe(false);
  });
});

describe('up: the API key warning', () => {
  const UP = ['up', '--harness', 'claude-code', '--skip-inbound'];

  it('warns on stderr when ANTHROPIC_API_KEY is unset, and still succeeds', async () => {
    const t = rig();
    expect(await main(UP, t.deps)).toBe(0);
    expect(t.errText()).toContain(WARNING);
    expect(t.outText()).not.toContain('warning: ANTHROPIC_API_KEY');
  });

  it('warns when ANTHROPIC_API_KEY is empty or only white space', async () => {
    for (const value of ['', '   ', '\t\n']) {
      const t = rig({ ANTHROPIC_API_KEY: value });
      expect(await main(UP, t.deps)).toBe(0);
      expect(t.errText()).toContain(WARNING);
    }
  });

  it('does not warn when it is set, and never echoes the value', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    expect(await main(UP, t.deps)).toBe(0);
    expect(t.errText()).not.toContain('ANTHROPIC_API_KEY');
    expect(t.log.join('\n')).not.toContain(FIXTURE_KEY);
  });

  it('does not warn when Claude Code runs on Bedrock or Vertex', async () => {
    for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
      const t = rig({ [name]: '1' });
      expect(await main(UP, t.deps)).toBe(0);
      expect(t.errText()).not.toContain('ANTHROPIC_API_KEY');
    }
    const empty = rig({ CLAUDE_CODE_USE_BEDROCK: '' });
    expect(await main(UP, empty.deps)).toBe(0);
    expect(empty.errText()).toContain(WARNING);
  });

  it('prints the warning before any step output', async () => {
    const t = rig();
    expect(await main(UP, t.deps)).toBe(0);
    expect(t.log[0]).toBe(`err:${WARNING}`);
    expect(t.log.findIndex((line) => line.startsWith('out:Step 1 of 2'))).toBeGreaterThan(0);
  });

  it('gives the same exit code with the key set and unset on the same failing input', async () => {
    // No inbound flag: the install step exits 1.
    const unset = rig();
    const set = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    const codeUnset = await main(['up', '--harness', 'claude-code'], unset.deps);
    const codeSet = await main(['up', '--harness', 'claude-code'], set.deps);
    expect(codeUnset).toBe(1);
    expect(codeSet).toBe(codeUnset);
    expect(unset.errText()).toContain(WARNING);
    expect(set.errText()).not.toContain('ANTHROPIC_API_KEY');
  });

  it('does not warn on codex, which has its own sign-in', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(0);
    expect(t.errText()).not.toContain('ANTHROPIC_API_KEY');
  });
});

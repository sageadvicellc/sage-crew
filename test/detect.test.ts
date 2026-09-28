import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
import { confirmHarness } from '../src/detect/confirm.ts';
import { findBinary, HARNESSES, probeHarnesses, sortCandidates, type Candidate } from '../src/detect/probe.ts';
import { createRunner } from '../src/runner.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { recordingRunner } from './helpers/recording-runner.ts';

const runner = createRunner();

function find(candidates: Candidate[], id: string): Candidate | undefined {
  return candidates.find((c) => c.harness.id === id);
}

function stubDir(stubs: Record<string, string>): string {
  const dir = join(makeFixtureHome(), 'bin');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

describe('detection', () => {
  it('20: a Claude stub plus its folder scores three', async () => {
    const env = makeTestEnv();
    mkdirSync(join(env.home, '.claude'));
    const claude = find(await probeHarnesses(env, runner), 'claude-code');
    expect(claude?.hits).toBe(3);
    expect(claude?.binaryPath).toBe(join(env.path, 'claude'));
    expect(claude?.version).toBe('2.1.0');
  });

  it('20: the binary alone scores two, the folder alone scores one', async () => {
    const env = makeTestEnv();
    expect(find(await probeHarnesses(env, runner), 'claude-code')?.hits).toBe(2);
    const noBin = makeTestEnv({ path: stubDir({}) });
    mkdirSync(join(noBin.home, '.claude'));
    const folderOnly = find(await probeHarnesses(noBin, runner), 'claude-code');
    expect(folderOnly?.hits).toBe(1);
    expect(folderOnly?.binaryPath).toBeUndefined();
  });

  it('21: CLAUDE_CONFIG_DIR and CODEX_HOME are honoured', async () => {
    const home = makeFixtureHome();
    const claudeDir = join(home, 'elsewhere', 'claude');
    const codexDir = join(home, 'elsewhere', 'codex');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    const env = makeTestEnv({ home, claudeConfigDir: claudeDir, codexHome: codexDir });
    const found = await probeHarnesses(env, runner);
    expect(find(found, 'claude-code')).toMatchObject({ hits: 3, configPath: claudeDir });
    expect(find(found, 'codex')).toMatchObject({ configPath: codexDir });

    const unset = makeTestEnv({ home });
    const plain = await probeHarnesses(unset, runner);
    expect(find(plain, 'claude-code')?.hits).toBe(2);
    expect(find(plain, 'codex')?.configPath).toBeUndefined();
  });

  it('22: Qwen scores two at most and is still offered', async () => {
    const env = makeTestEnv();
    mkdirSync(join(env.home, '.qwen'));
    const recorder = recordingRunner();
    const qwen = find(await probeHarnesses(env, recorder), 'qwen-code');
    expect(qwen?.hits).toBe(2);
    expect(recorder.calls.some((c) => c.command.endsWith('qwen'))).toBe(false);
    const out = capture();
    const result = await confirmHarness({
      candidates: [qwen as Candidate],
      nonInteractive: true,
      isTTY: false,
      ask: async () => '',
      out: out.write,
    });
    expect(result).toMatchObject({ ok: true, harness: { id: 'qwen-code' } });
    expect(out.text()).toMatch(/Found Qwen Code at .*qwen \(tier one, native messaging\)\./);
  });

  it('23: a version command that fails or hangs counts as a miss, never a crash', async () => {
    const env = makeTestEnv({ path: stubDir({ claude: 'exit 3', hermes: 'exec /bin/sleep 30' }) });
    const started = Date.now();
    const found = await probeHarnesses(env, runner, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(find(found, 'claude-code')?.hits).toBe(1);
    expect(find(found, 'hermes')?.hits).toBe(1);

    const throwing = recordingRunner(() => {
      throw new Error('spawn exploded');
    });
    const warnings: string[] = [];
    const again = await probeHarnesses(makeTestEnv(), throwing, { warn: (line) => warnings.push(line) });
    expect(find(again, 'claude-code')?.hits).toBe(1);
    // An unexpected throw is a miss, but it leaves a trace.
    expect(warnings.some((w) => /claude --version.*spawn exploded/.test(w))).toBe(true);
  });

  it('install passes probe warnings to standard error', async () => {
    const throwing = recordingRunner((_command, args) => {
      if (args[0] === '--version') throw new Error('spawn exploded');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    });
    const env = makeTestEnv();
    const err = capture();
    const out = capture();
    await main(['install', '--non-interactive'], { env, runner: throwing, out: out.write, err: err.write });
    expect(err.text()).toMatch(/warning: .*--version.*spawn exploded/);
  });

  it('a relative PATH entry is skipped, because it depends on the current folder', () => {
    const dir = stubDir({ claude: 'echo 1.0.0' });
    const relativeDir = relative(process.cwd(), dir);
    expect(isAbsolute(relativeDir)).toBe(false);
    expect(findBinary('claude', relativeDir)).toBeUndefined();
    expect(findBinary('claude', `.${delimiter}${relativeDir}`)).toBeUndefined();
    expect(findBinary('claude', `${relativeDir}${delimiter}${dir}`)).toBe(join(dir, 'claude'));
  });

  it('24: candidates sort by tier, then by hits', async () => {
    const env = makeTestEnv();
    mkdirSync(join(env.home, '.codex'));
    mkdirSync(join(env.home, '.hermes'));
    mkdirSync(join(env.home, '.config', 'amp'), { recursive: true });
    writeFileSync(join(env.home, '.config', 'amp', 'settings.json'), '{}');
    const order = (await probeHarnesses(env, runner)).map((c) => `${c.harness.id}:${c.hits}`);
    expect(order).toEqual(['claude-code:2', 'qwen-code:1', 'hermes:3', 'amp:3', 'codex:2']);

    const [claude, qwen, hermes] = HARNESSES;
    const made = (harness: typeof claude, hits: number): Candidate => ({ harness: harness as Candidate['harness'], hits });
    const sorted = sortCandidates([made(hermes, 3), made(qwen, 2), made(claude, 1)]);
    expect(sorted.map((c) => c.harness.id)).toEqual(['qwen-code', 'claude-code', 'hermes']);
  });

  it('25: no candidate exits 1 and prints the install pages', async () => {
    const env = makeTestEnv({ path: stubDir({}) });
    const found = await probeHarnesses(env, runner);
    expect(found).toEqual([]);
    const result = await confirmHarness({ candidates: found, nonInteractive: false, isTTY: true, ask: vi.fn(), out: () => {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(1);
    const text = result.lines.join('\n');
    for (const harness of HARNESSES) expect(text).toContain(harness.displayName);
    expect(text).toContain('install page: not documented yet');
    expect(text).not.toMatch(/https?:/);
  });
});

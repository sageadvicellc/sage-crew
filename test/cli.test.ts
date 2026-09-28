import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_USAGE, main } from '../src/cli.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { repoRoot } from './helpers/paths.ts';
import { recordingRunner } from './helpers/recording-runner.ts';

function deps() {
  const out = capture();
  const err = capture();
  const runner = recordingRunner();
  return { out, err, runner, deps: { env: makeTestEnv(), runner, out: out.write, err: err.write } };
}

describe('cli skeleton', () => {
  it('prints the package version', async () => {
    const t = deps();
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    expect(await main(['--version'], t.deps)).toBe(0);
    expect(t.out.text()).toBe(pkg.version);
  });

  it('prints usage for help', async () => {
    const t = deps();
    expect(await main(['--help'], t.deps)).toBe(0);
    expect(t.out.text()).toMatch(/trellis-crew start/);
  });

  it('exits 2 on a usage error and runs nothing', async () => {
    const t = deps();
    expect(await main(['launch'], t.deps)).toBe(EXIT_USAGE);
    expect(t.err.text()).toMatch(/launch/);
    expect(t.runner.calls).toEqual([]);
  });
});

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../../src/adapters/types.ts';
import type { CliDeps } from '../../src/cli.ts';
import type { Env } from '../../src/env.ts';
import { writeInstallRecord } from '../../src/store/install-yml.ts';
import { makeTestEnv } from './env.ts';
import { capture, type Capture } from './io.ts';
import { recordingRunner, type RecordingRunner } from './recording-runner.ts';

export interface Harnessed {
  env: Env;
  runner: RecordingRunner;
  out: Capture;
  err: Capture;
  deps: CliDeps;
}

/** A fixture home with Claude Code chosen at install, and a recording runner. */
export function claudeInstalled(extra: Partial<CliDeps> = {}): Harnessed {
  const env = makeTestEnv();
  writeInstallRecord(env, { harness: 'claude-code', transport: 'native', plugin_version: '0.1.0' });
  const runner = recordingRunner();
  const out = capture();
  const err = capture();
  return { env, runner, out, err, deps: { env, runner, out: out.write, err: err.write, ...extra } };
}

/** Writes a roles file into the Env's current folder and returns its path. */
export function writeRoles(env: Env, name: string, text: string): string {
  const path = join(env.cwd, name);
  writeFileSync(path, text);
  return path;
}

/**
 * A stand-in adapter that starts each session as a detached process, so
 * tests can exercise the pid paths that a later harness step fills in.
 */
export function detachedAdapter(id: Adapter['id'] = 'qwen-code', flags: Adapter['flags'] = {}): Adapter {
  return {
    id,
    displayName: 'Fixture Harness',
    flags,
    async launch(name, kickoff, flagArgs, ctx) {
      const { pid } = await ctx.runner.spawnDetached(ctx.binaryPath, [...flagArgs, kickoff]);
      return { ok: true, entry: { name, pid, session_id: `fixture-${name}-${pid}` } };
    },
    noProcessNote: (entry) => `${entry.name}: fixture note`,
  };
}

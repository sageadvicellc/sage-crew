import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunner } from '../src/runner.ts';
import { makeFixtureHome } from './helpers/env.ts';
import { fixtureBin } from './helpers/paths.ts';

describe('runner', () => {
  const runner = createRunner();

  it('captures output and the exit code', async () => {
    const result = await runner.run(join(fixtureBin, 'claude'), ['--version'], {
      env: { PATH: fixtureBin },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Claude Code/);
    expect(result.timedOut).toBe(false);
  });

  it('reports a missing binary as a failed result, never a throw', async () => {
    const result = await runner.run(join(fixtureBin, 'no-such-binary'), [], {
      env: { PATH: fixtureBin },
    });
    expect(result.code).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('kills a command that runs past its timeout', async () => {
    const dir = makeFixtureHome();
    const hang = join(dir, 'hang');
    writeFileSync(hang, '#!/bin/sh\nsleep 30\n');
    chmodSync(hang, 0o755);
    const started = Date.now();
    const result = await runner.run(hang, [], { env: { PATH: '/bin:/usr/bin' }, timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

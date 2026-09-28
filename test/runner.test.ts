import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunner, processStartTime } from '../src/runner.ts';
import { makeFixtureHome } from './helpers/env.ts';
import { fixtureBin } from './helpers/paths.ts';

describe('process start time', () => {
  it('reads a live process start time, and absent for a gone one', () => {
    const own = processStartTime(process.pid);
    expect(own).toMatchObject({ status: 'running', started: expect.stringMatching(/\d/) });
    expect(processStartTime(process.pid)).toEqual(own);
    expect(processStartTime(2 ** 22 + 12345)).toEqual({ status: 'absent' });
  });

  it('only exit 1 with no output means absent. Any other ps failure is unknown, never absent', () => {
    const dir = makeFixtureHome();
    const stub = (name: string, body: string): string => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    expect(processStartTime(1234, { ps: stub('gone', 'exit 1') })).toEqual({ status: 'absent' });
    expect(processStartTime(1234, { ps: stub('odd', 'exit 2') })).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/exit code 2/) });
    expect(processStartTime(1234, { ps: stub('noisy', 'echo junk; exit 1') })).toMatchObject({ status: 'unknown' });
    expect(processStartTime(1234, { ps: stub('empty', 'exit 0') })).toMatchObject({ status: 'unknown' });
    expect(processStartTime(1234, { ps: join(dir, 'missing') })).toMatchObject({ status: 'unknown' });
    expect(processStartTime(1234, { ps: stub('slow', 'exec /bin/sleep 5'), timeoutMs: 200 })).toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/time/),
    });
  });
});

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

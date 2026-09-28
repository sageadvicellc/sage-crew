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
    const gonePid = 2 ** 22 + 12345;
    expect(processStartTime(gonePid, { ps: stub('gone', 'exit 1') })).toEqual({ status: 'absent' });
    // A ps that rejects -p, as busybox ps does, can exit 1 with no output
    // for a live pid. A pid that still exists is then unknown, not absent.
    expect(processStartTime(process.pid, { ps: stub('rejects-p', 'exit 1') })).toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/ps reported no such process, but pid \d+ exists/),
    });
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

  it('keeps raw output bytes when asked, so binary output survives', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x80, 0x0a]);
    const result = await runner.run(process.execPath, ['-e', `process.stdout.write(Buffer.from([${[...bytes].join(',')}]))`], {
      env: { PATH: '/bin:/usr/bin' },
      bytes: true,
    });
    expect(result.code).toBe(0);
    expect(result.truncated).toBeFalsy();
    expect(result.bytes?.equals(bytes)).toBe(true);
    const text = await runner.run(process.execPath, ['-e', 'process.stdout.write("plain")'], { env: { PATH: '/bin:/usr/bin' } });
    expect(text.stdout).toBe('plain');
    expect(text.bytes).toBeUndefined();
  });

  it('stops reading at maxBytes and ends the command', async () => {
    const started = Date.now();
    const script = 'process.stdout.write(Buffer.alloc(100000, 7)); setTimeout(() => {}, 30000)';
    const result = await runner.run(process.execPath, ['-e', script], { env: { PATH: '/bin:/usr/bin' }, bytes: true, maxBytes: 8000 });
    expect(result.truncated).toBe(true);
    expect(result.bytes?.length).toBe(8000);
    expect(result.bytes?.every((b) => b === 7)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
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

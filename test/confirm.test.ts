import { describe, expect, it, vi } from 'vitest';
import { confirmHarness } from '../src/detect/confirm.ts';
import { probeHarnesses, type Candidate } from '../src/detect/probe.ts';
import { createRunner } from '../src/runner.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';

const runner = createRunner();

describe('confirmation', () => {
  async function candidates(): Promise<Candidate[]> {
    return probeHarnesses(makeTestEnv(), runner);
  }

  it('26: --harness skips the prompt', async () => {
    const ask = vi.fn(async () => 'y');
    const result = await confirmHarness({
      candidates: await candidates(),
      harnessFlag: 'hermes',
      nonInteractive: false,
      isTTY: true,
      ask,
      out: () => {},
    });
    expect(result).toMatchObject({ ok: true, harness: { id: 'hermes' } });
    expect(ask).not.toHaveBeenCalled();
  });

  it('26: --non-interactive takes the best candidate and prints the choice', async () => {
    const ask = vi.fn(async () => 'y');
    const out = capture();
    const result = await confirmHarness({ candidates: await candidates(), nonInteractive: true, isTTY: true, ask, out: out.write });
    expect(result).toMatchObject({ ok: true, harness: { id: 'claude-code' } });
    expect(ask).not.toHaveBeenCalled();
    expect(out.text()).toMatch(/Using Claude Code/);
  });

  it('26: no terminal skips the prompt', async () => {
    const ask = vi.fn(async () => 'y');
    const result = await confirmHarness({ candidates: await candidates(), nonInteractive: false, isTTY: false, ask, out: () => {} });
    expect(result).toMatchObject({ ok: true, harness: { id: 'claude-code' } });
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks on a terminal, and takes yes, no, or another harness', async () => {
    const found = await candidates();
    const out = capture();
    const yes = vi.fn(async () => '');
    expect(await confirmHarness({ candidates: found, nonInteractive: false, isTTY: true, ask: yes, out: out.write })).toMatchObject({
      ok: true,
      harness: { id: 'claude-code' },
    });
    expect(yes).toHaveBeenCalledWith('Use Claude Code? [Y/n/other] ');
    expect(out.lines[0]).toMatch(/^Found Claude Code 2\.1\.0 at .*claude \(tier one, native messaging\)\.$/);

    const no = await confirmHarness({ candidates: found, nonInteractive: false, isTTY: true, ask: async () => 'n', out: () => {} });
    expect(no).toMatchObject({ ok: false, code: 1 });

    const answers = ['other', 'amp'];
    const other = await confirmHarness({
      candidates: found,
      nonInteractive: false,
      isTTY: true,
      ask: async () => answers.shift() ?? '',
      out: () => {},
    });
    expect(other).toMatchObject({ ok: true, harness: { id: 'amp' } });

    const unknown = await confirmHarness({ candidates: found, nonInteractive: false, isTTY: true, ask: async () => 'pigeon', out: () => {} });
    expect(unknown).toMatchObject({ ok: false, code: 2 });
  });

  it('an unknown --harness is a usage error', async () => {
    const result = await confirmHarness({ candidates: [], harnessFlag: 'pigeon', nonInteractive: true, isTTY: false, ask: vi.fn(), out: () => {} });
    expect(result).toMatchObject({ ok: false, code: 2 });
  });
});

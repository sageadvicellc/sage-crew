import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as Instructions from '../src/adapters/codex-instructions.ts';
import { codexAdapter } from '../src/adapters/codex.ts';
import { main } from '../src/cli.ts';
import { EXIT_RUNTIME } from '../src/deps.ts';
import type { Role } from '../src/roles/schema.ts';
import { teamJsonPath } from '../src/store/team-json.ts';
import { makeFixtureHome } from './helpers/env.ts';
import { fixtureBin } from './helpers/paths.ts';
import { installedOn } from './helpers/team.ts';

// The package's skills folder stands in as an empty fixture folder, so every
// real read in the launch path finds no skill file.
const state = vi.hoisted(() => ({ skillsDir: '' }));

vi.mock('../src/adapters/codex-instructions.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Instructions>();
  return { ...actual, roleInstructionsArgs: (role: Role) => actual.roleInstructionsArgs(role, state.skillsDir) };
});

describe('Codex CLI with a skill file missing', () => {
  it('start stops at the role instructions step, and starts nothing', async () => {
    state.skillsDir = makeFixtureHome();
    const t = installedOn('codex', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.err.text()).toMatch(/could not start: role instructions for [a-z-]+: .*SKILL\.md: the file does not exist/);
    expect(t.runner.calls).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('launch, the respawn path, stops at the role instructions step, and spawns nothing', async () => {
    state.skillsDir = makeFixtureHome();
    const t = installedOn('codex', 'file-mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {} };
    const outcome = await codexAdapter.launch('worker-1', 'the kickoff', [], ctx, 'standby');
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/^role instructions for standby: .*the file does not exist$/) });
    expect(t.runner.calls).toEqual([]);
  });
});

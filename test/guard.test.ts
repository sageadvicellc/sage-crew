import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { repoRoot } from './helpers/paths.ts';
import { assertIsolatedHome, HOME_VARS } from './setup/home-guard.ts';

const tempHome = inject('tempHome');

function isolatedVars(): Record<string, string> {
  return {
    HOME: tempHome,
    USERPROFILE: tempHome,
    XDG_CONFIG_HOME: join(tempHome, '.config'),
    CLAUDE_CONFIG_DIR: join(tempHome, '.claude'),
    CODEX_HOME: join(tempHome, '.codex'),
  };
}

describe('home guard', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trellis-crew-outside-')));
  afterAll(() => rmSync(outside, { recursive: true, force: true }));

  it('62: passes when every home variable sits inside the temp home', () => {
    expect(() => assertIsolatedHome(isolatedVars(), tempHome, tempHome)).not.toThrow();
  });

  it('62: fails a test that points HOME at a real folder', () => {
    const vars = { ...isolatedVars(), HOME: outside };
    expect(() => assertIsolatedHome(vars, tempHome, tempHome)).toThrow(/HOME/);
  });

  it('62: fails when os.homedir() resolves outside the temp home', () => {
    expect(() => assertIsolatedHome(isolatedVars(), outside, tempHome)).toThrow(/homedir/);
  });

  it('62: fails when any guarded variable is unset or escapes', () => {
    for (const name of HOME_VARS) {
      const unset: Record<string, string | undefined> = { ...isolatedVars(), [name]: undefined };
      expect(() => assertIsolatedHome(unset, tempHome, tempHome)).toThrow(name);
      const escaped = { ...isolatedVars(), [name]: join(tempHome, '..', 'elsewhere') };
      expect(() => assertIsolatedHome(escaped, tempHome, tempHome)).toThrow(name);
    }
  });

  it('62: the live test process runs inside the temp home', () => {
    expect(() => assertIsolatedHome(process.env, undefined, tempHome)).not.toThrow();
  });

  it('62: the lint rule bans os.homedir and process.env.HOME outside src/env.ts', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const leaks = [
      "import os from 'node:os';\nexport const h = os.homedir();\n",
      "import { homedir } from 'node:os';\nexport const h = homedir();\n",
      'export const h = process.env.HOME;\n',
      "export const h = process.env['HOME'];\n",
      'const { HOME } = process.env;\nexport const h = HOME;\n',
    ];
    for (const code of leaks) {
      const [result] = await eslint.lintText(code, { filePath: join(repoRoot, 'src', 'leak.ts') });
      expect(result?.errorCount, code).toBeGreaterThan(0);
    }
    const [allowed] = await eslint.lintText(leaks[2] as string, { filePath: join(repoRoot, 'src', 'env.ts') });
    expect(allowed?.errorCount).toBe(0);
  });
});

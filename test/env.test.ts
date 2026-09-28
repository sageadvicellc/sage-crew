import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { claudeDir, codexDir, envFromProcess, expandHome, stateDir } from '../src/env.ts';
import { makeTestEnv } from './helpers/env.ts';

describe('env', () => {
  it('reads the home and harness folders from the process', () => {
    const env = envFromProcess();
    expect(env.home).toBe(inject('tempHome'));
    expect(env.claudeConfigDir).toBe(join(inject('tempHome'), '.claude'));
    expect(env.codexHome).toBe(join(inject('tempHome'), '.codex'));
  });

  it('prefers CLAUDE_CONFIG_DIR and CODEX_HOME over the home defaults', () => {
    const env = makeTestEnv({ claudeConfigDir: '/fixture/claude', codexHome: '/fixture/codex' });
    expect(claudeDir(env)).toBe('/fixture/claude');
    expect(codexDir(env)).toBe('/fixture/codex');
  });

  it('falls back to folders under the home', () => {
    const env = makeTestEnv();
    expect(claudeDir(env)).toBe(join(env.home, '.claude'));
    expect(codexDir(env)).toBe(join(env.home, '.codex'));
    expect(stateDir(env)).toBe(join(env.home, '.trellis-crew'));
  });

  it('expands a leading tilde against the Env home only', () => {
    const env = makeTestEnv();
    expect(expandHome('~/.trellis-crew/mailbox', env)).toBe(join(env.home, '.trellis-crew', 'mailbox'));
    expect(expandHome('~', env)).toBe(env.home);
    expect(expandHome('relative/~/x', env)).toBe('relative/~/x');
  });
});

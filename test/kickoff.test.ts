import { describe, expect, it } from 'vitest';
import { composeKickoff, START_UP_HEADING } from '../src/kickoff/compose.ts';
import { defaultTeam } from '../src/roles/defaults.ts';
import type { RolesConfig, Session } from '../src/roles/schema.ts';
import { validateRoles } from '../src/roles/validate.ts';
import { SMALL_TEAM } from './helpers/roles.ts';

function session(config: RolesConfig, name: string): Session {
  const found = config.sessions.find((s) => s.name === name);
  if (!found) throw new Error(`no session ${name}`);
  return found;
}

const claude = { harness: 'claude-code', transport: 'native' } as const;
const mailbox = { harness: 'codex', transport: 'file-mailbox', mailboxPath: '/fixture/mailbox' } as const;

function startUp(text: string): string {
  const at = text.indexOf(START_UP_HEADING);
  expect(at).toBeGreaterThan(0);
  return text.slice(at);
}

describe('kickoff composer', () => {
  it('starts with the roles-file kickoff, then the start-up block', () => {
    const team = defaultTeam();
    const main = session(team, 'main');
    const text = composeKickoff(team, main, claude);
    expect(text.startsWith(main.kickoff.trimEnd())).toBe(true);
    expect(startUp(text)).toMatch(/You are main, the lead\. You report to personal-assistant\./);
  });

  it('39: Claude Code workers state 20 subagents', () => {
    const team = defaultTeam();
    const block = startUp(composeKickoff(team, session(team, 'worker-2'), claude));
    expect(block).toMatch(/up to 20 subagents at once/);
  });

  it('40: the Claude Code lead states its worker count times 20', () => {
    const three = defaultTeam();
    expect(startUp(composeKickoff(three, session(three, 'main'), claude))).toMatch(/up to 60 subagents at once/);
    const five = defaultTeam({ workers: 5 });
    expect(startUp(composeKickoff(five, session(five, 'main'), claude))).toMatch(/up to 100 subagents at once/);
  });

  it('41: other harnesses state no figure', () => {
    const team = defaultTeam();
    for (const name of ['main', 'worker-1']) {
      for (const ctx of [mailbox, { harness: 'qwen-code', transport: 'native' } as const]) {
        const block = startUp(composeKickoff(team, session(team, name), ctx));
        expect(block).not.toMatch(/subagent/i);
        expect(block).not.toMatch(/\b20\b/);
      }
    }
    const reporter = startUp(composeKickoff(team, session(team, 'personal-assistant'), claude));
    expect(reporter).not.toMatch(/subagents at once/);
  });

  it('42: benchmark names its clock, and research sends nothing', () => {
    const team = defaultTeam();
    const benchmark = startUp(composeKickoff(team, session(team, 'benchmark'), claude));
    expect(benchmark).toMatch(/to personal-assistant: "Auditor clock started at <time>, interval 30m\. First check at <time>\."/);
    const research = startUp(composeKickoff(team, session(team, 'research'), claude));
    expect(research).toMatch(/Start-up message: none\. Send nothing at kickoff/);
    expect(research).not.toMatch(/"I am|Auditor clock|No work yet/);
    const chain = startUp(composeKickoff(team, session(team, 'personal-assistant'), claude));
    expect(chain).toContain(
      '"I am the reporting chain. Send me one line per change. Decisions go to the operator through me."',
    );
    const main = startUp(composeKickoff(team, session(team, 'main'), claude));
    expect(main).toContain('"No work yet; wait for a hand-off addressed to you."');
    expect(main).toContain('worker-1, worker-2, worker-3');
  });

  it('43: a custom roles file gets the start-up block', () => {
    const result = validateRoles(SMALL_TEAM, {});
    if (!result.ok) throw new Error('fixture invalid');
    const config = result.config;
    const chain = startUp(composeKickoff(config, session(config, 'chain'), claude));
    expect(chain).toMatch(/You are chain, the reporting chain\. You report to you, the operator\./);
    expect(chain).toContain('"I am the reporting chain.');
    const watcher = startUp(composeKickoff(config, session(config, 'watcher'), mailbox));
    expect(watcher).toMatch(/to chain: "Auditor clock started at <time>, interval 30m\./);
    expect(watcher).toContain('/fixture/mailbox');
    const boss = startUp(composeKickoff(config, session(config, 'boss'), claude));
    expect(boss).toMatch(/up to 40 subagents at once/);
    expect(boss).toContain('helper-a, helper-b');
  });

  it('44: the lead and each worker see every task profile with its model and effort', () => {
    const team: RolesConfig = {
      ...defaultTeam(),
      task_profiles: { build: { model: 'model-a', effort: 'high' }, review: { effort: 'medium' } },
    };
    for (const name of ['main', 'worker-1', 'worker-2', 'worker-3']) {
      const block = startUp(composeKickoff(team, session(team, name), claude));
      expect(block, name).toContain('- build: model model-a, effort high');
      expect(block, name).toContain('- review: model unset, effort medium');
    }
    for (const name of ['personal-assistant', 'benchmark', 'research']) {
      expect(startUp(composeKickoff(team, session(team, name), claude)), name).not.toContain('- build:');
    }
  });

  it('names each transport in the messaging line', () => {
    const team = defaultTeam();
    const main = session(team, 'main');
    expect(startUp(composeKickoff(team, main, claude))).toMatch(/ListAgents.*SendMessage/);
    expect(startUp(composeKickoff(team, main, mailbox))).toMatch(
      /file mailbox at \/fixture\/mailbox\. Each session reads and writes its own file in that folder\./,
    );
  });
});

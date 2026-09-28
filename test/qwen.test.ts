import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { readInstallRecord, writeInstallRecord } from '../src/store/install-yml.ts';
import { readTeam } from '../src/store/team-json.ts';
import { fixtureBin } from './helpers/paths.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn, writeRoles } from './helpers/team.ts';

const qwen = join(fixtureBin, 'qwen');
const NOW = () => new Date('2026-03-04T10:00:00Z');

describe('Qwen Code', () => {
  it('starts each session as its own detached qwen -p process, named through the first prompt', async () => {
    const t = installedOn('qwen-code', 'native');
    expect(await main(['start'], t.deps)).toBe(0);
    const launches = t.runner.calls.filter((c) => c.kind === 'detached');
    expect(launches).toHaveLength(6);
    for (const call of launches) {
      expect(call.command).toBe(qwen);
      expect(call.args).toHaveLength(2);
      expect(call.args[0]).toBe('-p');
    }
    const main1 = launches[1]?.args[1] ?? '';
    expect(main1).toMatch(/^Your session name is main\. Set it with \/rename main before anything else\.\n\nYou are the lead\./);
    expect(main1).toMatch(/Messaging: use the harness cross-session messaging/);
    expect(main1).not.toMatch(/subagents at once/);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    for (const entry of team.record.sessions) {
      expect(entry.pid).toBeGreaterThan(40000);
      expect(entry.session_id).toBeNull();
    }
  });

  it('46: each set field prints one warning naming the session and the field, and the session still starts', async () => {
    const t = installedOn('qwen-code', 'native');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: model-a\n    effort: high'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    const warnings = t.err.lines.filter((l) => l.startsWith('warning: helper-a:'));
    expect(warnings).toEqual([
      'warning: helper-a: autocompact ignored. Qwen Code has no verified flag for it.',
      'warning: helper-a: model ignored. Qwen Code has no verified flag for it.',
      'warning: helper-a: effort ignored. Qwen Code has no verified flag for it.',
    ]);
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toHaveLength(5);
  });

  it('status prints the output of qwen sessions ps', async () => {
    const t = installedOn('qwen-code', 'native');
    t.runner.run = async (command, args) => {
      t.runner.calls.push({ kind: 'run', command, args });
      return { code: 0, stdout: 'fixture session list\n', stderr: '', timedOut: false };
    };
    expect(await main(['start'], t.deps)).toBe(0);
    expect(await main(['status'], t.deps)).toBe(0);
    expect(t.runner.calls.filter((c) => c.kind === 'run').map((c) => [c.command, ...c.args])).toEqual([[qwen, 'sessions', 'ps']]);
    expect(t.out.text()).toContain('fixture session list');
  });

  it('install backs up the user settings file and sets agents.crossSessionInbound, and names the plugin gap', async () => {
    const t = installedOn('qwen-code', 'native', { now: NOW });
    const dir = join(t.env.home, '.qwen');
    mkdirSync(dir);
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, '{"agents": {"crossSessionMessaging": true}, "theme": "x"}\n');
    expect(await main(['install', '--harness', 'qwen-code', '--yes'], t.deps)).toBe(1);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
      agents: { crossSessionMessaging: true, crossSessionInbound: 'accept' },
      theme: 'x',
    });
    expect(readFileSync(`${settings}.2026-03-04.bak`, 'utf8')).toBe('{"agents": {"crossSessionMessaging": true}, "theme": "x"}\n');
    expect(t.err.text()).toMatch(/repository URL.*not documented/);
    expect(t.runner.calls.filter((c) => c.args[0] === 'extensions')).toEqual([]);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'qwen-code', plugin_version: null } });
  });

  it('install stops when the Qwen folder is missing', async () => {
    const t = installedOn('qwen-code', 'native', { now: NOW });
    expect(await main(['install', '--harness', 'qwen-code', '--reconfigure'], t.deps)).toBe(1);
    expect(existsSync(join(t.env.home, '.qwen'))).toBe(false);
  });

  it('update runs qwen extensions update', async () => {
    const t = installedOn('qwen-code', 'native', { fetchLatest: async () => ({ status: 'not-published' }) });
    writeInstallRecord(t.env, { harness: 'qwen-code', transport: 'native', plugin_version: null });
    expect(await main(['update'], t.deps)).toBe(0);
    expect(t.runner.calls.map((c) => [c.command, ...c.args])).toEqual([[qwen, 'extensions', 'update']]);
    expect(t.out.text()).toContain('Qwen Code has no documented update command');
  });
});

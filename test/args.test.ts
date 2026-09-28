import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/args.ts';

describe('args', () => {
  it('parses start with its flags', () => {
    expect(parseCommand(['start', '--workers', '5', '--roles', 'team.yml'])).toEqual({
      ok: true,
      command: { name: 'start', workers: 5, roles: 'team.yml', mergeReporters: false, yes: false },
    });
  });

  it('parses start --yes and -y', () => {
    expect(parseCommand(['start', '--yes'])).toMatchObject({ ok: true, command: { name: 'start', yes: true } });
    expect(parseCommand(['start', '-y'])).toMatchObject({ ok: true, command: { name: 'start', yes: true } });
  });

  it('treats a leading --roles as start', () => {
    expect(parseCommand(['--roles', 'team.yml'])).toEqual({
      ok: true,
      command: { name: 'start', roles: 'team.yml', mergeReporters: false, yes: false },
    });
  });

  it('parses install, update, status, stop, and respawn', () => {
    expect(parseCommand(['install', '--harness', 'claude-code', '--non-interactive'])).toMatchObject({
      ok: true,
      command: { name: 'install', harness: 'claude-code', nonInteractive: true, reconfigure: false },
    });
    expect(parseCommand(['update', '--check'])).toMatchObject({ ok: true, command: { name: 'update', check: true } });
    expect(parseCommand(['status'])).toMatchObject({ ok: true, command: { name: 'status' } });
    expect(parseCommand(['stop'])).toMatchObject({ ok: true, command: { name: 'stop' } });
    expect(parseCommand(['respawn', 'worker-1', '--model', 'm', '--effort', 'high', '--autocompact', '400k'])).toEqual({
      ok: true,
      command: { name: 'respawn', session: 'worker-1', model: 'm', effort: 'high', autocompact: '400k' },
    });
  });

  it('rejects an unknown command, an unknown flag, and a bad worker count', () => {
    expect(parseCommand(['launch']).ok).toBe(false);
    expect(parseCommand(['start', '--bogus']).ok).toBe(false);
    expect(parseCommand(['start', '--workers', '0']).ok).toBe(false);
    expect(parseCommand(['start', '--workers', 'two']).ok).toBe(false);
    expect(parseCommand(['respawn']).ok).toBe(false);
  });

  it('accepts file as a transport name', () => {
    expect(parseCommand(['install', '--transport', 'file'])).toMatchObject({
      ok: true,
      command: { name: 'install', transport: 'file-mailbox' },
    });
    expect(parseCommand(['install', '--transport', 'pigeon']).ok).toBe(false);
    // Plan decision 16: no MCP mailbox in this build.
    expect(parseCommand(['install', '--transport', 'mcp-mailbox']).ok).toBe(false);
  });

  it('parses help and version', () => {
    expect(parseCommand([])).toEqual({ ok: true, command: { name: 'help' } });
    expect(parseCommand(['--help'])).toEqual({ ok: true, command: { name: 'help' } });
    expect(parseCommand(['--version'])).toEqual({ ok: true, command: { name: 'version' } });
  });
});

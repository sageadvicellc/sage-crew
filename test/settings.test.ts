import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../src/fs-atomic.ts';
import { claudeInboundTarget, setInboundAccept } from '../src/settings/inbound.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';

const NOW = new Date('2026-03-04T10:00:00Z');
const BACKUP_NAME = 'settings.json.2026-03-04.bak';

function setup(settings?: string, mode = 0o644) {
  const env = makeTestEnv();
  const dir = join(env.home, '.claude');
  mkdirSync(dir);
  const path = join(dir, 'settings.json');
  if (settings !== undefined) {
    writeFileSync(path, settings);
    chmodSync(path, mode);
  }
  return { env, dir, path, backup: join(dir, BACKUP_NAME), target: claudeInboundTarget(env) };
}

const ORIGINAL = `{
  "model": "some-model",
  "permissions": {
    "allow": ["Bash(npm test)"],
    "deny": []
  },
  "crossSessionInbound": "hold",
  "env": { "A": "1" }
}
`;

describe('settings writer', () => {
  it('28: copies the settings file to a dated backup beside it before any write, and prints both paths', () => {
    const t = setup(ORIGINAL);
    const out = capture();
    const writer = vi.fn((path: string, text: string, mode: number) => {
      expect(readFileSync(t.backup, 'utf8')).toBe(ORIGINAL);
      expect(readFileSync(t.path, 'utf8')).toBe(ORIGINAL);
      writeFileAtomic(path, text, mode);
    });
    const result = setInboundAccept(t.target, { now: NOW, out: out.write, writeFile: writer });
    expect(result).toMatchObject({ ok: true, changed: true, settingsPath: t.path, backupPath: t.backup });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(readFileSync(t.backup, 'utf8')).toBe(ORIGINAL);
    expect(out.text()).toContain(t.path);
    expect(out.text()).toContain(t.backup);
  });

  it('28: honours CLAUDE_CONFIG_DIR', () => {
    const env = makeTestEnv();
    const dir = join(env.home, 'custom-claude');
    mkdirSync(dir);
    writeFileSync(join(dir, 'settings.json'), '{}\n');
    const target = claudeInboundTarget({ ...env, claudeConfigDir: dir });
    const result = setInboundAccept(target, { now: NOW, out: () => {} });
    expect(result).toMatchObject({ ok: true, settingsPath: join(dir, 'settings.json') });
    expect(existsSync(join(env.home, '.claude'))).toBe(false);
  });

  it('29: only crossSessionInbound changes, and every other key survives', () => {
    const t = setup(ORIGINAL, 0o600);
    setInboundAccept(t.target, { now: NOW, out: () => {} });
    const before = JSON.parse(ORIGINAL) as Record<string, unknown>;
    const after = JSON.parse(readFileSync(t.path, 'utf8')) as Record<string, unknown>;
    expect(after).toEqual({ ...before, crossSessionInbound: 'accept' });
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(statSync(t.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(t.dir).sort()).toEqual(['settings.json', BACKUP_NAME]);
  });

  it('29: adds the key when it is missing, and changes nothing when it is already accept', () => {
    const t = setup('{"theme": "dark"}');
    setInboundAccept(t.target, { now: NOW, out: () => {} });
    expect(JSON.parse(readFileSync(t.path, 'utf8'))).toEqual({ theme: 'dark', crossSessionInbound: 'accept' });

    const again = setup('{"crossSessionInbound": "accept"}');
    const result = setInboundAccept(again.target, { now: NOW, out: () => {} });
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(existsSync(again.backup)).toBe(false);
  });

  it('30: a second run on the same day never overwrites the first backup', () => {
    const t = setup(ORIGINAL);
    setInboundAccept(t.target, { now: NOW, out: () => {} });
    writeFileSync(t.path, '{"crossSessionInbound": "refuse", "later": true}\n');
    const out = capture();
    const result = setInboundAccept(t.target, { now: new Date('2026-03-04T23:59:00Z'), out: out.write });
    expect(result).toMatchObject({ ok: true, changed: true, backupPath: t.backup });
    expect(readFileSync(t.backup, 'utf8')).toBe(ORIGINAL);
    expect(out.text()).toMatch(/kept/);
    expect(JSON.parse(readFileSync(t.path, 'utf8'))).toEqual({ crossSessionInbound: 'accept', later: true });

    setInboundAccept(t.target, { now: new Date('2026-03-05T00:01:00Z'), out: () => {} });
    expect(readFileSync(t.backup, 'utf8')).toBe(ORIGINAL);
  });

  it.skipIf(process.getuid?.() === 0)('31: an unreadable settings file stops the install and writes nothing', () => {
    const t = setup(ORIGINAL);
    chmodSync(t.path, 0o000);
    const result = setInboundAccept(t.target, { now: NOW, out: () => {} });
    chmodSync(t.path, 0o644);
    expect(result).toMatchObject({ ok: false, code: 1 });
    expect(readFileSync(t.path, 'utf8')).toBe(ORIGINAL);
    expect(readdirSync(t.dir)).toEqual(['settings.json']);
  });

  it('31: an invalid settings file stops the install and writes nothing', () => {
    for (const bad of ['{ "model": ', '[1, 2]', '"text"', '{"crossSessionInbound": 3} trailing']) {
      const t = setup(bad);
      const result = setInboundAccept(t.target, { now: NOW, out: () => {} });
      expect(result, bad).toMatchObject({ ok: false, code: 1 });
      expect(readFileSync(t.path, 'utf8')).toBe(bad);
      expect(readdirSync(t.dir)).toEqual(['settings.json']);
    }
  });

  it('31: a missing configuration folder stops and writes nothing', () => {
    const env = makeTestEnv();
    const result = setInboundAccept(claudeInboundTarget(env), { now: NOW, out: () => {} });
    expect(result).toMatchObject({ ok: false, code: 1 });
    expect(existsSync(join(env.home, '.claude'))).toBe(false);
  });

  it('creates the settings file when the folder exists and the file does not', () => {
    const t = setup();
    const out = capture();
    const result = setInboundAccept(t.target, { now: NOW, out: out.write });
    expect(result).toMatchObject({ ok: true, changed: true, settingsPath: t.path });
    expect(JSON.parse(readFileSync(t.path, 'utf8'))).toEqual({ crossSessionInbound: 'accept' });
    expect(existsSync(t.backup)).toBe(false);
    expect(out.text()).toMatch(/no backup/i);
  });

  it('writes through a symlinked settings file and keeps the link', () => {
    const t = setup();
    const real = join(t.env.home, 'dotfiles-settings.json');
    writeFileSync(real, ORIGINAL);
    symlinkSync(real, t.path);
    setInboundAccept(t.target, { now: NOW, out: () => {} });
    expect(JSON.parse(readFileSync(real, 'utf8'))).toMatchObject({ crossSessionInbound: 'accept' });
    expect(lstatSync(t.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(t.backup, 'utf8')).toBe(ORIGINAL);
  });

  it('sets a nested key path, as the Qwen Code user settings use', () => {
    const t = setup('{"agents": {"crossSessionMessaging": true}}');
    const result = setInboundAccept(
      { settingsPath: t.path, keyPath: ['agents', 'crossSessionInbound'] },
      { now: NOW, out: () => {} },
    );
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(t.path, 'utf8'))).toEqual({
      agents: { crossSessionMessaging: true, crossSessionInbound: 'accept' },
    });
  });
});

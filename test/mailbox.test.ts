import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAILBOX, ensureMailboxFolder, mailboxPath } from '../src/mailbox/folder.ts';
import { main } from '../src/cli.ts';
import { privateFolderProblem } from '../src/fs-private.ts';
import { defaultTeam } from '../src/roles/defaults.ts';
import { writeInstallRecord } from '../src/store/install-yml.ts';
import { writeTeam } from '../src/store/team-json.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { recordingRunner } from './helpers/recording-runner.ts';

describe('file mailbox folder', () => {
  it('34: the mailbox folder exists after it is ensured, private to the operator', () => {
    const env = makeTestEnv();
    const path = mailboxPath(defaultTeam(), env);
    expect(path).toBe(join(env.home, '.trellis-crew', 'mailbox'));
    expect(ensureMailboxFolder(path)).toEqual({ ok: true, path, created: true });
    expect(statSync(path).isDirectory()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(ensureMailboxFolder(path)).toEqual({ ok: true, path, created: false });
  });

  it('34: the default is used when the roles file names no mailbox', () => {
    const env = makeTestEnv();
    expect(mailboxPath({}, env)).toBe(join(env.home, DEFAULT_MAILBOX.slice(2)));
  });

  it('34: a relative mailbox resolves against the current folder', () => {
    const env = makeTestEnv();
    expect(mailboxPath({ ...defaultTeam(), mailbox: 'team-mail' }, env)).toBe(join(env.cwd, 'team-mail'));
  });

  it('34: a file in the way is an error, and nothing is created', () => {
    const env = makeTestEnv();
    const path = join(env.home, 'blocked');
    writeFileSync(path, 'not a folder');
    expect(ensureMailboxFolder(path)).toMatchObject({ ok: false });
    const nested = join(env.home, 'blocked', 'inner');
    expect(ensureMailboxFolder(nested)).toMatchObject({ ok: false });
    expect(existsSync(nested)).toBe(false);
  });

  it('34: an existing private folder is kept as it is', () => {
    const env = makeTestEnv();
    const path = join(env.home, 'existing');
    mkdirSync(path, { mode: 0o700 });
    expect(ensureMailboxFolder(path)).toEqual({ ok: true, path, created: false });
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it('an existing folder that other users can open, or a symlink, is refused and left alone', () => {
    const env = makeTestEnv();
    const open = join(env.home, 'open');
    mkdirSync(open);
    chmodSync(open, 0o750);
    expect(ensureMailboxFolder(open)).toMatchObject({ ok: false, message: expect.stringMatching(/open to other users/) });
    expect(statSync(open).mode & 0o777).toBe(0o750);

    const real = join(env.home, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(env.home, 'link');
    symlinkSync(real, link);
    expect(ensureMailboxFolder(link)).toMatchObject({ ok: false, message: expect.stringMatching(/symlink/) });
  });

  it('a folder owned by another user is refused', () => {
    const env = makeTestEnv();
    const path = join(env.home, 'theirs');
    mkdirSync(path, { mode: 0o700 });
    const own = process.getuid?.();
    if (own === undefined) return;
    expect(privateFolderProblem(path, own)).toBeUndefined();
    expect(privateFolderProblem(path, own + 1)).toMatch(/belongs to another user/);
  });

  it('the state folder is checked before install.yml or team.json is written', async () => {
    const env = makeTestEnv();
    const elsewhere = join(env.home, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(env.home, '.trellis-crew'));
    expect(() => writeInstallRecord(env, { harness: 'codex', transport: 'file-mailbox', plugin_version: null })).toThrow(/symlink/);
    expect(() => writeTeam(env, { version: 1, harness: 'codex', sessions: [] })).toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);

    const err = capture();
    const code = await main(['install', '--harness', 'codex', '--non-interactive'], {
      env,
      runner: recordingRunner(),
      out: () => {},
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/\.trellis-crew is a symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

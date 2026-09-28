import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAILBOX, ensureMailboxFolder, mailboxPath } from '../src/mailbox/folder.ts';
import { defaultTeam } from '../src/roles/defaults.ts';
import { makeTestEnv } from './helpers/env.ts';

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

  it('34: an existing folder is kept as it is', () => {
    const env = makeTestEnv();
    const path = join(env.home, 'existing');
    mkdirSync(path, { mode: 0o750 });
    expect(ensureMailboxFolder(path)).toEqual({ ok: true, path, created: false });
    expect(statSync(path).mode & 0o777).toBe(0o750);
  });
});

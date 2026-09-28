import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseAllowlist,
  parseDenyList,
  scanPath,
  scanText,
  type FindingClass,
} from '../src/sanitize/checks.ts';
import { runSanitize } from '../src/sanitize/run.ts';
import { createRunner } from '../src/runner.ts';
import { makeFixtureHome } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { capture } from './helpers/io.ts';
import { repoRoot } from './helpers/paths.ts';

// Every fake leak is built at runtime, so this file itself holds no string
// that the sanitizer, or any other secret scanner, would flag.
const TERM = ['example', 'internal', 'name'].join('-');
const fake = {
  githubToken: 'ghp' + '_' + 'Fa1ke'.repeat(8),
  githubPat: 'github' + '_pat_' + 'Fa1ke'.repeat(12),
  anthropicKey: 'sk' + '-ant-' + 'fake'.repeat(8),
  awsKey: 'AKIA' + 'FAKE'.repeat(4),
  slackToken: 'xox' + 'b-' + '1234567890-fake',
  npmToken: 'npm' + '_' + 'Fa1ke'.repeat(8).slice(0, 36),
  privateKey: '-----BEGIN ' + 'RSA ' + 'PRIVATE KEY-----',
  urlCredential: 'https:' + '//' + 'fixture:not-a-real-pass' + '@host.example/path',
  macHome: ['', 'Users', 'example', 'project'].join('/'),
  linuxHome: ['', 'home', 'example', 'project'].join('/'),
  windowsHome: 'C:' + '\\' + ['Users', 'example', 'project'].join('\\'),
  socketFile: ['', 'tmp', 'example-agent.sock'].join('/'),
  socketDir: ['', 'tmp', 'example-socks', 'agent'].join('/'),
  ticketUrl: 'https:' + '//github.com/' + ['other-owner', 'other-repo', 'issues', '12'].join('/'),
  ticketApi: 'api.github.com/' + ['repos', 'other-owner', 'other-repo', 'pulls', '7'].join('/'),
  ticketShort: ['other-owner', 'other-repo'].join('/') + '#' + '12',
  tracker: 'https:' + '//example.' + 'atlassian.net/' + 'browse/KEY-1',
};

const seeded: Array<[string, string, FindingClass]> = [
  ['a GitHub token', fake.githubToken, 'secret'],
  ['a GitHub fine-grained token', fake.githubPat, 'secret'],
  ['an Anthropic key', fake.anthropicKey, 'secret'],
  ['an AWS access key', fake.awsKey, 'secret'],
  ['a Slack token', fake.slackToken, 'secret'],
  ['an npm token', fake.npmToken, 'secret'],
  ['a private-key block', fake.privateKey, 'secret'],
  ['a credential in a URL', fake.urlCredential, 'secret'],
  ['a deny-listed name', `ask ${TERM.toUpperCase()} about it`, 'deny-list'],
  ['a macOS home path', `see ${fake.macHome}/notes`, 'private-path'],
  ['a Linux home path', `see ${fake.linuxHome}/notes`, 'private-path'],
  ['a Windows home path', `see ${fake.windowsHome}\\notes`, 'private-path'],
  ['a socket file', `connect to ${fake.socketFile}`, 'private-path'],
  ['a socket folder', `listen on ${fake.socketDir}`, 'private-path'],
  ['a ticket link to another repository', fake.ticketUrl, 'ticket-link'],
  ['an API ticket link to another repository', fake.ticketApi, 'ticket-link'],
  ['a ticket shorthand for another repository', `fixed in ${fake.ticketShort}`, 'ticket-link'],
  ['a private tracker link', fake.tracker, 'ticket-link'],
];

const clean = [
  'The token prefix ghp_ is flagged only with a full token after it.',
  'Settings live in ~/.claude/settings.json and the mailbox in ~/.trellis-crew/mailbox.',
  'A home path looks like /Users/<name>/ or /home/<name>/ in the docs.',
  'The docs page https://example.com/home/page/ and https://example.com/en/users/guide/ are fine.',
  'Our own tracker: https://github.com/sageadvicellc/trellis-crew/issues/4 and sageadvicellc/trellis-crew#4.',
  'A URL with a user and no password: ssh://git@host.example/repo.git',
  'A placeholder credential: https://user:<token>@host.example/path',
  `A longer word that only contains the term: ${TERM}s and pre${TERM}`,
  'A funding link https://github.com/sponsors/example is not a ticket.',
];

function denyList(extra = ''): ReturnType<typeof parseDenyList>['list'] {
  const parsed = parseDenyList(`# fixture deny-list\n${TERM}\n${extra}`);
  expect(parsed.errors).toEqual([]);
  return parsed.list;
}

describe('sanitize checks', () => {
  it.each(seeded)('57: flags %s', (_label, text, cls) => {
    const findings = scanText(text, { where: 'fixture.md', path: 'fixture.md', deny: denyList() });
    expect(findings.map((f) => f.cls)).toContain(cls);
  });

  it('57: clean fixtures pass', () => {
    for (const text of clean) {
      expect(scanText(text, { where: 'fixture.md', path: 'fixture.md', deny: denyList() }), text).toEqual([]);
    }
  });

  it('57: a committed .env file is a secret finding', () => {
    expect(scanPath('.env', {}).map((f) => f.cls)).toEqual(['secret']);
    expect(scanPath('config/.env.production', {}).map((f) => f.cls)).toEqual(['secret']);
    expect(scanPath('.env.example', {})).toEqual([]);
    expect(scanPath('src/env.ts', {})).toEqual([]);
  });

  it('57: findings name the line and never echo the leaked text', () => {
    const [finding] = scanText(`line one\n${fake.githubToken}\n`, { where: 'a.md', path: 'a.md' });
    expect(finding?.line).toBe(2);
    expect(JSON.stringify(finding)).not.toContain(fake.githubToken);
    const [deny] = scanText(TERM, { where: 'a.md', path: 'a.md', deny: denyList() });
    expect(JSON.stringify(deny)).not.toContain(TERM);
  });

  it('58: an allowance clears its one file and no other', () => {
    const list = denyList(`allow docs/a.md ${TERM}\n`);
    expect(scanText(`${TERM} here`, { where: 'docs/a.md', path: 'docs/a.md', deny: list })).toEqual([]);
    expect(scanText(`${TERM} here`, { where: 'docs/b.md', path: 'docs/b.md', deny: list })).toHaveLength(1);
    expect(scanText(`${TERM} here`, { where: 'commit message', deny: list })).toHaveLength(1);
  });

  it('58: an allowance clears one term only', () => {
    const other = ['another', 'internal', 'word'].join('-');
    const list = denyList(`${other}\nallow docs/a.md ${TERM}\n`);
    const findings = scanText(`${TERM} and ${other}`, { where: 'docs/a.md', path: 'docs/a.md', deny: list });
    expect(findings).toHaveLength(1);
  });

  it('58: a malformed deny-list line is an error', () => {
    expect(parseDenyList('allow only-a-path\n').errors).toHaveLength(1);
  });

  it('the committed allowlist clears a reviewed file for one non-deny-list class', () => {
    const { entries, errors } = parseAllowlist('# reviewed\nfixtures/leak.md ticket-link\n');
    expect(errors).toEqual([]);
    const ctx = { where: 'fixtures/leak.md', path: 'fixtures/leak.md', allow: entries };
    expect(scanText(fake.ticketUrl, ctx)).toEqual([]);
    expect(scanText(fake.githubToken, ctx)).toHaveLength(1);
    expect(scanText(fake.ticketUrl, { ...ctx, where: 'other.md', path: 'other.md' })).toHaveLength(1);
  });

  it('the committed allowlist refuses the deny-list class', () => {
    expect(parseAllowlist('a.md deny-list\n').errors).toHaveLength(1);
  });
});

function denyFile(extra = ''): string {
  const path = join(makeFixtureHome(), 'denylist.txt');
  writeFileSync(path, `${TERM}\n${extra}`);
  return path;
}

async function sanitize(cwd: string, vars: Record<string, string | undefined>, range?: string) {
  const out = capture();
  const err = capture();
  const code = await runSanitize({
    cwd,
    runner: createRunner(),
    vars: { PATH: process.env.PATH, ...vars },
    ...(range === undefined ? {} : { range }),
    out: out.write,
    err: err.write,
  });
  return { code, out: out.text(), err: err.text() };
}

describe('sanitize run', () => {
  it('57: a leak in a tracked file, the staged diff, or a commit message fails', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing to see\n');
    repo.commit('chore: clean start');

    const tracked = makeFixtureRepo();
    tracked.write('notes.md', `see ${fake.macHome}/x\n`);
    tracked.commit('chore: add notes');

    const staged = makeFixtureRepo();
    staged.write('clean.md', 'nothing\n');
    staged.commit('chore: start');
    staged.write('clean.md', `nothing\n${fake.githubToken}\n`);
    staged.git('add', 'clean.md');
    staged.write('clean.md', 'nothing\n');

    const message = makeFixtureRepo();
    message.write('clean.md', 'nothing\n');
    message.commit(`chore: fixes ${fake.ticketShort}`);

    const envFile = makeFixtureRepo();
    envFile.write('.env', 'KEY=value\n');
    envFile.commit('chore: add env');

    const vars = { SANITIZE_DENYLIST: denyFile() };
    expect((await sanitize(repo.root, vars, 'HEAD')).code).toBe(0);

    const t = await sanitize(tracked.root, vars, 'HEAD');
    expect(t.code).toBe(1);
    expect(t.err).toMatch(/private-path: notes\.md:1/);

    const s = await sanitize(staged.root, vars, 'HEAD');
    expect(s.code).toBe(1);
    expect(s.err).toMatch(/secret: clean\.md \(staged\):2/);

    const m = await sanitize(message.root, vars, 'HEAD');
    expect(m.code).toBe(1);
    expect(m.err).toMatch(/ticket-link: commit [0-9a-f]{7} message:1/);

    const e = await sanitize(envFile.root, vars, 'HEAD');
    expect(e.code).toBe(1);
    expect(e.err).toMatch(/secret: \.env/);
  });

  it('58: a deny-list allowance clears one file of a real repository', async () => {
    const repo = makeFixtureRepo();
    repo.write('docs/a.md', `${TERM}\n`);
    repo.write('docs/b.md', `${TERM}\n`);
    repo.commit('chore: add docs');
    const result = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile(`allow docs/a.md ${TERM}\n`) }, 'HEAD');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/deny-list: docs\/b\.md:1/);
    expect(result.err).not.toMatch(/docs\/a\.md/);
    expect(result.err).not.toContain(TERM);
  });

  it('59: an unset SANITIZE_DENYLIST warns, names the variable, and still runs the other checks', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    const result = await sanitize(repo.root, {}, 'HEAD');
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/warning: SANITIZE_DENYLIST is unset/);

    const leaky = makeFixtureRepo();
    leaky.write('notes.md', `see ${fake.macHome}/x\n`);
    leaky.commit('chore: add notes');
    const other = await sanitize(leaky.root, {}, 'HEAD');
    expect(other.code).toBe(1);
    expect(other.err).toMatch(/private-path: notes\.md:1/);
  });

  it('59: an unset SANITIZE_DENYLIST fails when SANITIZE_REQUIRE_DENYLIST=1', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    const result = await sanitize(repo.root, { SANITIZE_REQUIRE_DENYLIST: '1' }, 'HEAD');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/SANITIZE_DENYLIST/);
  });

  it('59: a deny-list path that does not exist, or holds no terms, fails', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    const missing = join(makeFixtureHome(), 'missing.txt');
    expect((await sanitize(repo.root, { SANITIZE_DENYLIST: missing }, 'HEAD')).code).toBe(1);
    const empty = join(makeFixtureHome(), 'empty.txt');
    writeFileSync(empty, '# nothing\n');
    expect((await sanitize(repo.root, { SANITIZE_DENYLIST: empty }, 'HEAD')).code).toBe(1);
  });

  it('a leak added in one commit and removed in a later one still fails', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    repo.write('notes.md', `line one\n${fake.githubToken}\n`);
    repo.commit('chore: add notes');
    const added = repo.git('rev-parse', '--short=7', 'HEAD').trim();
    repo.write('notes.md', 'line one\n');
    repo.commit('chore: tidy notes');

    const vars = { SANITIZE_DENYLIST: denyFile() };
    const all = await sanitize(repo.root, vars, 'HEAD~2..HEAD');
    expect(all.code).toBe(1);
    expect(all.err).toContain(`secret: notes.md (commit ${added}):2`);
    expect(all.err).not.toContain(fake.githubToken);

    // The range that holds only the removal is clean.
    expect((await sanitize(repo.root, vars, 'HEAD~1..HEAD')).code).toBe(0);

    // A deny-listed term added in history fails too, and a file allowance clears it.
    const deny = makeFixtureRepo();
    deny.write('clean.md', 'nothing\n');
    deny.commit('chore: start');
    deny.write('docs/a.md', `${TERM}\n`);
    deny.commit('chore: add a');
    deny.write('docs/a.md', 'gone\n');
    deny.commit('chore: remove a');
    expect((await sanitize(deny.root, vars, 'HEAD~2..HEAD')).err).toMatch(/deny-list: docs\/a\.md \(commit [0-9a-f]{7}\):1/);
    const allowed = { SANITIZE_DENYLIST: denyFile(`allow docs/a.md ${TERM}\n`) };
    expect((await sanitize(deny.root, allowed, 'HEAD~2..HEAD')).code).toBe(0);
  });

  it('a UTF-16 file is decoded and scanned, and a real binary file is still skipped', async () => {
    const leak = `see ${fake.macHome}/x\n`;
    const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16();
    const files: Array<[string, Buffer]> = [
      ['le-bom.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(leak, 'utf16le')])],
      ['be-bom.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(leak)])],
      ['le-plain.txt', Buffer.from(leak, 'utf16le')],
    ];
    for (const [name, bytes] of files) {
      const repo = makeFixtureRepo();
      writeFileSync(join(repo.root, name), bytes);
      repo.commit('chore: add file');
      const result = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
      expect(result.code, name).toBe(1);
      expect(result.err, name).toContain(`private-path: ${name}:1`);
    }
    const binary = makeFixtureRepo();
    writeFileSync(join(binary.root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x00, 0x01]));
    binary.commit('chore: add binary');
    expect((await sanitize(binary.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD')).code).toBe(0);
  });

  it('a tracked file it cannot read fails the run and is named', async () => {
    const locked = makeFixtureRepo();
    locked.write('clean.md', 'nothing\n');
    locked.write('locked.md', 'nothing\n');
    locked.commit('chore: start');
    chmodSync(join(locked.root, 'locked.md'), 0o000);
    const l = await sanitize(locked.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    chmodSync(join(locked.root, 'locked.md'), 0o644);
    expect(l.code).toBe(1);
    expect(l.err).toMatch(/sanitize: cannot read locked\.md/);

    const gone = makeFixtureRepo();
    gone.write('clean.md', 'nothing\n');
    gone.write('gone.md', 'nothing\n');
    gone.commit('chore: start');
    rmSync(join(gone.root, 'gone.md'));
    const g = await sanitize(gone.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(g.code).toBe(1);
    expect(g.err).toMatch(/sanitize: cannot read gone\.md/);
  });

  it('60: the repository passes with the fixture deny-list', async () => {
    const result = await sanitize(repoRoot, {
      SANITIZE_DENYLIST: join(repoRoot, 'test', 'fixtures', 'sanitize', 'denylist.txt'),
      SANITIZE_REQUIRE_DENYLIST: '1',
    });
    expect(result.err).not.toMatch(/: (secret|deny-list|private-path|ticket-link): /);
    expect(result.code).toBe(0);
  });
});

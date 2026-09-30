import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  parseAllowlist,
  parseDenyList,
  scanPath,
  scanText,
  type FindingClass,
} from '../src/sanitize/checks.ts';
import { CANNOT_READ, decodeText, parseStagedDiff, runSanitize } from '../src/sanitize/run.ts';
import { createRunner, type Runner, type RunResult } from '../src/runner.ts';
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
  sessionUrl: 'https:' + '//claude.ai/' + ['code', 'session' + '_' + '01' + 'Fa1ke'.repeat(5)].join('/'),
  sessionPath: 'claude.ai/' + ['code', 'session' + 's'].join('/'),
  sessionId: 'session' + '_' + '01' + 'Fa1ke'.repeat(5),
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
  ['a Claude session link', `see ${fake.sessionUrl}`, 'session-link'],
  ['a Claude session path with no scheme', `see ${fake.sessionPath}`, 'session-link'],
  ['a bare Claude session id', `resume ${fake.sessionId} later`, 'session-link'],
  ['a session link in capitals', `see ${fake.sessionUrl.toUpperCase()}`, 'session-link'],
  ['a session id with a prefix', `id cse_${fake.sessionId}`, 'session-link'],
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
  'Names such as session_id, session_token, and session_2 are code, not session ids.',
  'A long name such as session_initializationparameters has no digit, so it is not an id.',
  'The page https://claude.ai/code is not a session link.',
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
    expect(parseDenyList('allow @author\n').errors).toHaveLength(1);
  });

  it('allow @author clears one term in the author and committer fields only', () => {
    const other = ['another', 'internal', 'word'].join('-');
    const list = denyList(`${other}\nallow @author ${TERM.toUpperCase()}\n`);
    const identity = { where: 'commit abc1234 author email', identity: true, deny: list };
    expect(scanText(`${TERM}@example.invalid`, identity)).toEqual([]);
    expect(scanText(`${other}@example.invalid`, identity)).toHaveLength(1);
    // Whole word only: a longer word that holds the term is not cleared or matched.
    expect(scanText(`pre${TERM}@example.invalid`, identity)).toEqual([]);
    // The same term still fails in a message, a file, a file name, and a
    // file whose path is literally @author.
    expect(scanText(`${TERM} here`, { where: 'commit abc1234 message', deny: list })).toHaveLength(1);
    expect(scanText(`${TERM} here`, { where: 'docs/a.md', path: 'docs/a.md', deny: list })).toHaveLength(1);
    expect(scanText(`${TERM} here`, { where: '@author', path: '@author', deny: list })).toHaveLength(1);
    expect(scanPath(`docs/${TERM}.md`, { deny: list })).toHaveLength(1);
    expect(scanPath('@author', { deny: denyList(`allow @author ${TERM}\n`) })).toEqual([]);
    // A path allowance never clears an identity field.
    const byPath = denyList(`allow docs/a.md ${TERM}\n`);
    expect(scanText(`${TERM}@example.invalid`, { where: 'commit abc1234 author email', identity: true, deny: byPath })).toHaveLength(1);
  });

  it('a session link finding never echoes the link or the id', () => {
    const findings = scanText(`${fake.sessionUrl}\n${fake.sessionId}\n`, { where: 'a.md', path: 'a.md' });
    // The link on line 1 also holds an id, so line 1 has two findings.
    expect(findings.map((f) => f.cls)).toEqual(['session-link', 'session-link', 'session-link']);
    expect([...new Set(findings.map((f) => f.line))]).toEqual([1, 2]);
    expect(JSON.stringify(findings)).not.toContain(fake.sessionId);
  });

  it('the committed allowlist cannot clear the session-link class', () => {
    const { entries, errors } = parseAllowlist('fixtures/leak.md session-link\n');
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('a session link in a commit message fails the run', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit(`chore: notes\n\n${fake.sessionUrl}`);
    const result = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/session-link: commit [0-9a-f]{7} message:3/);
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

  it('a deny-listed term in a commit author or committer field fails, and never prints the field', async () => {
    const email = `${TERM}@example.invalid`;
    const author = makeFixtureRepo();
    author.write('clean.md', 'nothing\n');
    author.git('add', '-A');
    author.git('commit', '-q', '-m', 'chore: start', `--author=Fixture Author <${email}>`);
    const a = await sanitize(author.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(a.code).toBe(1);
    expect(a.err).toMatch(/deny-list: commit [0-9a-f]{7} author email: deny-listed term/);
    expect(a.err).not.toMatch(/author name|committer/);
    expect(a.err).not.toContain(TERM);

    const committer = makeFixtureRepo();
    committer.write('clean.md', 'nothing\n');
    committer.git('add', '-A');
    committer.git('-c', `user.name=${TERM}`, 'commit', '-q', '-m', 'chore: start');
    const c = await sanitize(committer.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(c.code).toBe(1);
    expect(c.err).toMatch(/deny-list: commit [0-9a-f]{7} committer name: deny-listed term/);
    expect(c.err).toMatch(/deny-list: commit [0-9a-f]{7} author name: deny-listed term/);
  });

  it('allow @author clears the author fields, but the same term in a message or a file still fails', async () => {
    const email = `${TERM}@example.invalid`;
    const vars = { SANITIZE_DENYLIST: denyFile(`allow @author ${TERM}\n`) };
    const make = () => {
      const repo = makeFixtureRepo();
      repo.write('clean.md', 'nothing\n');
      return repo;
    };
    const commitAs = (repo: ReturnType<typeof make>, message: string) => {
      repo.git('add', '-A');
      repo.git('-c', `user.name=${TERM}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message);
    };

    const onlyAuthor = make();
    commitAs(onlyAuthor, 'chore: start');
    const clean = await sanitize(onlyAuthor.root, vars, 'HEAD');
    expect(clean.err).toBe('');
    expect(clean.code).toBe(0);

    const inMessage = make();
    commitAs(inMessage, `chore: ask ${TERM}`);
    const m = await sanitize(inMessage.root, vars, 'HEAD');
    expect(m.code).toBe(1);
    expect(m.err).toMatch(/deny-list: commit [0-9a-f]{7} message:1/);
    expect(m.err).not.toMatch(/author|committer/);

    const inFile = make();
    inFile.write('notes.md', `${TERM}\n`);
    commitAs(inFile, 'chore: start');
    const f = await sanitize(inFile.root, vars, 'HEAD');
    expect(f.code).toBe(1);
    expect(f.err).toMatch(/deny-list: notes\.md:1/);

    const namedAuthor = make();
    namedAuthor.write('@author', `${TERM}\n`);
    commitAs(namedAuthor, 'chore: start');
    const n = await sanitize(namedAuthor.root, vars, 'HEAD');
    expect(n.code).toBe(1);
    expect(n.err).toMatch(/deny-list: @author:1/);
    expect(n.err).toMatch(/deny-list: @author \(commit [0-9a-f]{7}\):1/);
  });

  it('a blob git cannot read fails with the reason, cut short and escaped', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    writeFileSync(join(repo.root, 'wide.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('plain\n', 'utf16le')]));
    repo.git('add', 'wide.txt');
    const real = createRunner();
    const failing = (result: Partial<RunResult>): Runner => ({
      ...real,
      run: (command, args, options) =>
        args.includes('cat-file')
          ? Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, ...result })
          : real.run(command, args, options),
    });
    const run = async (runner: Runner) => {
      const err = capture();
      const code = await runSanitize({
        cwd: repo.root,
        runner,
        vars: { PATH: process.env.PATH, SANITIZE_DENYLIST: denyFile() },
        range: 'HEAD',
        out: () => {},
        err: err.write,
      });
      return { code, err: err.text() };
    };
    const exit = await run(failing({ code: 128, stderr: `fatal: synthetic\u001b[2K failure\n${'x'.repeat(400)}` }));
    expect(exit.code).toBe(1);
    expect(exit.err).toMatch(/cannot read wide\.txt \(staged\): git cat-file failed: exit code 128: fatal: synthetic\\x1b\[2K failure x+\.\.\.\n/);
    expect(exit.err).not.toContain('x'.repeat(300));
    expect(exit.err).not.toContain('\u001b');
    const spawnError = await run(failing({ error: 'spawn git ENOENT' }));
    expect(spawnError.err).toMatch(/cannot read wide\.txt \(staged\): git cat-file could not run: spawn git ENOENT/);
    const slow = await run(failing({ timedOut: true }));
    expect(slow.err).toMatch(/cannot read wide\.txt \(staged\): git cat-file failed: timed out/);
  });

  it('a file path with an escape sequence or a newline prints with neither', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    const name = 'z\u001b[2K\n::error::forged';
    writeFileSync(join(repo.root, name), `${TERM}\n`);
    repo.git('add', '--', name);
    const wide = `w\u001b[2K\n::error::wide`;
    writeFileSync(join(repo.root, wide), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${TERM}\n`, 'utf16le')]));
    repo.git('add', '--', wide);
    rmSync(join(repo.root, wide));
    const result = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(result.code).toBe(1);
    expect(result.err).not.toContain('\u001b');
    expect(result.err.split('\n').filter((line) => line !== '').every((line) => line.startsWith('sanitize: '))).toBe(true);
    expect(result.err).toContain('deny-list: z\\x1b[2K\\n::error::forged:1');
    expect(result.err).toContain('w\\x1b[2K\\n::error::wide (staged)');
  });

  it('a staged binary file named like a stage number is read as that path', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.write('x', 'nothing here\n');
    repo.commit('chore: start');
    writeFileSync(join(repo.root, '0:x'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${TERM}\n`, 'utf16le')]));
    repo.git('add', '--', '0:x');
    rmSync(join(repo.root, '0:x'));
    const result = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(result.code).toBe(1);
    expect(result.err).toContain('deny-list: 0:x (staged):1');
    expect(result.err).not.toMatch(/cannot read 0:x \(staged\)/);
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

  it('an added line that reads like a diff header does not hide the lines after it', async () => {
    const diff = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,0 +1,3 @@',
      '+++ /dev/null',
      '+--- a/other',
      '+third',
      '@@ -9 +11,2 @@',
      '-old',
      '+++ b/fake',
      '+last',
    ].join('\n');
    expect(parseStagedDiff(diff)).toEqual([
      { path: 'notes.md', lines: ['++ /dev/null', '--- a/other', 'third', '++ b/fake', 'last'], lineNumbers: [1, 2, 3, 11, 12] },
    ]);

    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    repo.write('notes.md', `++ /dev/null\n${fake.githubToken}\n`);
    repo.git('add', 'notes.md');
    const staged = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(staged.err).toContain('secret: notes.md (staged):2');
    repo.commit('chore: add notes');
    repo.write('notes.md', 'gone\n');
    repo.commit('chore: remove notes');
    const history = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD~2..HEAD');
    expect(history.err).toMatch(/secret: notes\.md \(commit [0-9a-f]{7}\):2/);
  });

  it('a UTF-16 file is scanned in the staged diff and in history, and odd-length UTF-16 cannot be read', async () => {
    const leak = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`see ${fake.macHome}/x\n`, 'utf16le')]);
    const vars = { SANITIZE_DENYLIST: denyFile() };

    const staged = makeFixtureRepo();
    staged.write('clean.md', 'nothing\n');
    staged.commit('chore: start');
    writeFileSync(join(staged.root, 'wide.txt'), leak);
    staged.git('add', 'wide.txt');
    rmSync(join(staged.root, 'wide.txt'));
    staged.git('rm', '-q', '--cached', 'clean.md');
    const s = await sanitize(staged.root, vars, 'HEAD');
    expect(s.err).toContain('private-path: wide.txt (staged):1');

    const history = makeFixtureRepo();
    history.write('clean.md', 'nothing\n');
    history.commit('chore: start');
    writeFileSync(join(history.root, 'wide.txt'), leak);
    history.commit('chore: add wide');
    history.git('rm', '-q', 'wide.txt');
    history.commit('chore: remove wide');
    const h = await sanitize(history.root, vars, 'HEAD~2..HEAD');
    expect(h.code).toBe(1);
    expect(h.err).toMatch(/private-path: wide\.txt \(commit [0-9a-f]{7}\):1/);

    const odd = makeFixtureRepo();
    odd.write('clean.md', 'nothing\n');
    odd.commit('chore: start');
    writeFileSync(join(odd.root, 'odd.txt'), Buffer.concat([leak, Buffer.from([0x41])]));
    odd.commit('chore: add odd');
    const o = await sanitize(odd.root, vars, 'HEAD~1..HEAD');
    expect(o.code).toBe(1);
    expect(o.err).toMatch(/sanitize: cannot read odd\.txt\n/);
    expect(o.err).toMatch(/sanitize: cannot read odd\.txt \(commit [0-9a-f]{7}\)/);
    odd.write('odd2.txt', 'x');
    writeFileSync(join(odd.root, 'odd2.txt'), Buffer.concat([leak, Buffer.from([0x41])]));
    odd.git('add', 'odd2.txt');
    expect((await sanitize(odd.root, vars, 'HEAD')).err).toMatch(/sanitize: cannot read odd2\.txt \(staged\)/);
  });

  it('a committed line that holds a separator and a git option changes nothing on disk', async () => {
    const target = join(makeFixtureHome(), 'target.txt');
    writeFileSync(target, 'keep this text\n');
    const before = statSync(target).mtimeMs;
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    for (const separator of ['\x1e', '\x1f']) {
      repo.write(`trap-${separator.charCodeAt(0)}.md`, `a\n${separator}--output=${target}\nsee ${fake.macHome}/x\n`);
      repo.commit('chore: add trap');
    }
    repo.git('commit', '-q', '--allow-empty', '-m', `chore: note\n\n\x1e--output=${target}`);
    const result = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD~3..HEAD');
    expect(readFileSync(target, 'utf8')).toBe('keep this text\n');
    expect(statSync(target).mtimeMs).toBe(before);
    expect(result.code).toBe(1);
    // Every commit is read whole, so the leak after the trap line is found in each.
    expect(result.err.match(/private-path: trap-\d+\.md \(commit [0-9a-f]{7}\):3/g)).toHaveLength(2);
    expect(result.err).not.toMatch(/cannot read|unexpected/);
  });

  it('a commit id that is not hex is a failure, and never reaches git', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    const real = createRunner();
    const seen: string[][] = [];
    const runner: Runner = {
      ...real,
      run: (command, args, options) => {
        seen.push([...args]);
        if (args.includes('--format=%H')) {
          return Promise.resolve({ code: 0, stdout: '--output=/dev/null\0', stderr: '', timedOut: false });
        }
        return real.run(command, args, options);
      },
    };
    const err = capture();
    const code = await runSanitize({
      cwd: repo.root,
      runner,
      vars: { PATH: process.env.PATH, SANITIZE_DENYLIST: denyFile() },
      range: 'HEAD',
      out: () => {},
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/sanitize: the commit list for HEAD holds a value that is not a commit id/);
    expect(seen.filter((args) => args.includes('--output=/dev/null'))).toEqual([]);
    // Every revision that git receives follows --end-of-options.
    for (const args of seen) {
      const range = args.indexOf('HEAD');
      if (range !== -1) expect(args.indexOf('--end-of-options')).toBe(range - 1);
    }
  });

  it('a large binary blob is classified from its first 8,000 bytes and never read whole', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    // Pseudo-random bytes from a fixed seed, as compressed or image data looks.
    const binary = Buffer.alloc(2 * 1024 * 1024);
    let seed = 12345;
    for (let i = 0; i < binary.length; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      binary[i] = seed >>> 16;
    }
    writeFileSync(join(repo.root, 'big.bin'), binary);
    const wide = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${'plain '.repeat(2000)}see ${fake.macHome}/x\n`, 'utf16le')]);
    writeFileSync(join(repo.root, 'wide.txt'), wide);
    repo.git('add', 'big.bin', 'wide.txt');
    const real = createRunner();
    const reads: Array<{ spec: string; maxBytes: number | undefined }> = [];
    const runner: Runner = {
      ...real,
      run: (command, args, options) => {
        if (args.includes('cat-file')) reads.push({ spec: args[args.length - 1] as string, maxBytes: options?.maxBytes });
        return real.run(command, args, options);
      },
    };
    const err = capture();
    const code = await runSanitize({
      cwd: repo.root,
      runner,
      vars: { PATH: process.env.PATH, SANITIZE_DENYLIST: denyFile() },
      range: 'HEAD',
      out: () => {},
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/private-path: wide\.txt \(staged\):1/);
    expect(err.text()).not.toMatch(/big\.bin/);
    expect(reads.filter((r) => r.spec === ':0:big.bin')).toEqual([{ spec: ':0:big.bin', maxBytes: 8000 }]);
    expect(reads.filter((r) => r.spec === ':0:wide.txt')).toEqual([
      { spec: ':0:wide.txt', maxBytes: 8000 },
      { spec: ':0:wide.txt', maxBytes: undefined },
    ]);
  });

  it('a leak added only inside a merge commit fails', async () => {
    const repo = makeFixtureRepo();
    repo.write('clean.md', 'nothing\n');
    repo.commit('chore: start');
    repo.git('checkout', '-q', '-b', 'side');
    repo.write('side.md', 'side\n');
    repo.commit('chore: side');
    repo.git('checkout', '-q', 'main');
    repo.write('main.md', 'main\n');
    repo.commit('chore: main');
    repo.git('merge', '-q', '--no-ff', '--no-commit', 'side');
    repo.write('merged.md', `${fake.githubToken}\n`);
    repo.git('add', 'merged.md');
    repo.git('commit', '-q', '-m', 'chore: merge side');
    repo.write('merged.md', 'gone\n');
    repo.commit('chore: tidy');
    const result = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD~2..HEAD');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/secret: merged\.md \(commit [0-9a-f]{7}\):1/);
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

  it('UTF-16 with no byte-order mark and mostly non-Latin text is decoded, in both byte orders', async () => {
    // Mostly CJK, so far fewer than 90% of the characters are ASCII.
    const text = `${'日本語の文書です。'.repeat(40)}\n\u{1f331} see ${fake.macHome}/x\n`;
    const le = Buffer.from(text, 'utf16le');
    const be = Buffer.from(le).swap16();
    expect(decodeText(le)).toBe(text);
    expect(decodeText(be)).toBe(text);
    expect(decodeText(Buffer.concat([le, Buffer.from([0x41])]))).toBe(CANNOT_READ);

    const repo = makeFixtureRepo();
    writeFileSync(join(repo.root, 'cjk.txt'), le);
    repo.commit('chore: add file');
    const result = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(result.code).toBe(1);
    expect(result.err).toContain('private-path: cjk.txt:2');
  });

  it('a binary whose zero bytes all share one parity still counts as binary unless it decodes as valid text', () => {
    // 16-bit samples: high bytes are zero, but the low bytes hold control codes.
    const samples = Buffer.alloc(4000);
    for (let i = 0; i < samples.length; i += 2) samples[i] = i % 31;
    expect(decodeText(samples)).toBeUndefined();
    // A lone surrogate is not valid UTF-16.
    const lone = Buffer.from('日本\n', 'utf16le');
    const broken = Buffer.concat([lone, Buffer.from([0x00, 0xd8, 0x41, 0x00]), lone]);
    expect(decodeText(broken)).toBeUndefined();
    // Zero bytes in both parities: binary.
    expect(decodeText(Buffer.from([0x89, 0x50, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x00]))).toBeUndefined();
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

  it('the script scans the working folder it runs in, not the tree it is loaded from', () => {
    // CI loads the sanitizer from the base commit and runs it in the
    // branch's folder, so the branch is read only as data.
    const repo = makeFixtureRepo();
    repo.write('notes.md', `see ${fake.macHome}/notes\n`);
    repo.commit('chore: start');
    const script = join(repoRoot, 'src', 'sanitize', 'run.ts');
    const run = spawnSync(process.execPath, [script, '--range', 'HEAD'], {
      cwd: repo.root,
      env: { PATH: process.env.PATH, SANITIZE_DENYLIST: denyFile() },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/private-path: notes\.md:1/);
  });

  it('a named allowlist replaces the one in the scanned repository', async () => {
    const repo = makeFixtureRepo();
    repo.write('notes.md', `see ${fake.macHome}/notes\n`);
    repo.write('.sanitize-allow', 'notes.md private-path\n');
    repo.commit('chore: start');
    // The repository's own allowlist clears the finding.
    const own = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile() }, 'HEAD');
    expect(own.code).toBe(0);
    // A named allowlist that lacks the entry, as the base commit's would,
    // leaves the finding in place.
    const base = join(repo.root, '..', `base-allow-${Date.now()}`);
    writeFileSync(base, '# no entries\n');
    const named = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile(), SANITIZE_ALLOWLIST: base }, 'HEAD');
    rmSync(base);
    expect(named.code).toBe(1);
    expect(named.err).toMatch(/private-path: notes\.md:1/);
    // A named allowlist that does not exist counts as empty.
    const missing = await sanitize(repo.root, { SANITIZE_DENYLIST: denyFile(), SANITIZE_ALLOWLIST: `${base}-missing` }, 'HEAD');
    expect(missing.code).toBe(1);
  });

  it('CI runs the base sanitizer on the branch as data, and only there holds the secret', () => {
    const workflow = parseYaml(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
      jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
    };
    const gates = JSON.stringify(workflow.jobs['gates']);
    expect(gates).not.toContain('secrets.');
    expect(gates).not.toContain('sanitize');
    const steps = workflow.jobs['sanitize']?.steps ?? [];
    const checkouts = steps.filter((s) => String(s['uses'] ?? '').startsWith('actions/checkout@'));
    expect(checkouts.map((s) => (s['with'] as Record<string, unknown>)['path'])).toEqual(['base', 'head']);
    for (const s of checkouts) expect((s['with'] as Record<string, unknown>)['persist-credentials']).toBe(false);
    for (const s of steps) expect(String(s['run'] ?? ''), 'no npm in the sanitize job').not.toMatch(/\bnpm\b/);
    const run = steps.find((s) => String(s['run'] ?? '').includes('sanitize/run.ts'));
    expect(run?.['run']).toBe('node "$GITHUB_WORKSPACE/base/src/sanitize/run.ts"');
    expect(run?.['working-directory']).toBe('head');
    const env = run?.['env'] as Record<string, string>;
    expect(env['SANITIZE_REQUIRE_DENYLIST']).toBe('1');
    expect(env['SANITIZE_ALLOWLIST']).toMatch(/\/base\/\.sanitize-allow$/);
  });

  it('the sanitizer imports only node built-ins and its own files, so CI installs nothing to run it', () => {
    const seen = new Set<string>();
    const queue = [join(repoRoot, 'src', 'sanitize', 'run.ts')];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      // A dynamic import or a require could load a package too.
      expect(text, `${file} loads a module at run time`).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
      for (const [, spec] of text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        if ((spec as string).startsWith('node:')) continue;
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
        queue.push(join(file, '..', spec as string));
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('60: the repository passes with the fixture deny-list', async () => {
    const result = await sanitize(repoRoot, {
      SANITIZE_DENYLIST: join(repoRoot, 'test', 'fixtures', 'sanitize', 'denylist.txt'),
      SANITIZE_REQUIRE_DENYLIST: '1',
    });
    expect(result.err).not.toMatch(/: (secret|deny-list|private-path|ticket-link|session-link): /);
    expect(result.code).toBe(0);
  });
});

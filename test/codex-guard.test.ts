import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.ts';
import { codexExecArgs } from '../src/adapters/codex-args.ts';
import { checkWorkdir, checkWorkdirSync, codexChildEnv, codexMailboxProblem, CODEX_CHILD_ENV } from '../src/adapters/codex-guard.ts';
import { runSupervisor, type SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import type { AdapterContext } from '../src/adapters/types.ts';
import { main } from '../src/cli.ts';
import type { Env } from '../src/env.ts';
import type { RunOptions } from '../src/runner.ts';
import { readTeam, readTeamFile, writeTeamFile } from '../src/store/team-json.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { fixtureBin } from './helpers/paths.ts';
import { isGitCall, recordingRunner } from './helpers/recording-runner.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn, writeRoles } from './helpers/team.ts';

const RULE = 'Codex CLI sessions can write their working folder, so trellis-crew starts them only at the top of a git worktree.';

/** The five working folders every place must judge: four refused and one that passes. */
function folders(): { home: string; cases: { name: string; cwd: string; reason: RegExp | null }[] } {
  const home = makeFixtureHome();
  const repo = makeFixtureRepo();
  mkdirSync(join(repo.root, 'sub'));
  const plain = makeFixtureHome();
  return {
    home,
    cases: [
      { name: 'the home folder', cwd: home, reason: /: it is your home folder\.$/ },
      { name: '/', cwd: '/', reason: /^.*\/: it is the root folder\.$/ },
      { name: 'a folder that is not a repo', cwd: plain, reason: /: it is not in a git worktree \(.*not a git repository.*\)\.$/ },
      { name: 'a subfolder of a repo', cwd: join(repo.root, 'sub'), reason: /: it is not the top of a git worktree\. The top is .+\.$/ },
      { name: 'a valid worktree top', cwd: repo.root, reason: null },
    ],
  };
}

function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > until) return reject(new Error('timed out waiting'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('the Codex working folder: checkWorkdir through the injected runner', () => {
  for (const { name, cwd, reason } of folders().cases) {
    it(`judges ${name}`, async () => {
      const { home } = folders();
      const env = makeTestEnv({ home: name === 'the home folder' ? cwd : home, cwd });
      const runner = recordingRunner();
      const problem = await checkWorkdir(env, runner);
      if (reason === null) expect(problem).toBeUndefined();
      else {
        expect(problem?.startsWith(`${RULE} `)).toBe(true);
        expect(problem).toMatch(reason);
      }
    });
  }

  it('runs git rev-parse --show-toplevel through the runner, in the folder', async () => {
    const repo = makeFixtureRepo();
    const env = makeTestEnv({ cwd: repo.root });
    const runner = recordingRunner();
    expect(await checkWorkdir(env, runner)).toBeUndefined();
    expect(runner.calls).toEqual([{ kind: 'run', command: join(fixtureBin, 'git'), args: ['rev-parse', '--show-toplevel'] }]);
  });

  it('refuses when git is not on PATH', async () => {
    const repo = makeFixtureRepo();
    const env = makeTestEnv({ cwd: repo.root, path: join(repo.root, 'no-bin') });
    expect(await checkWorkdir(env, recordingRunner())).toMatch(/not in a git worktree \(git is not on PATH\)/);
  });
});

describe('the Codex working folder: checkWorkdirSync, for the supervisor', () => {
  for (const { name, cwd, reason } of folders().cases) {
    it(`judges ${name}`, () => {
      const { home } = folders();
      const problem = checkWorkdirSync(cwd, name === 'the home folder' ? cwd : home);
      if (reason === null) expect(problem).toBeUndefined();
      else expect(problem).toMatch(reason);
    });
  }
});

function ctxFor(env: Env, mailbox?: string): AdapterContext & { runner: ReturnType<typeof recordingRunner> } {
  return { env, runner: recordingRunner(), binaryPath: join(fixtureBin, 'codex'), out: () => {}, ...(mailbox === undefined ? {} : { mailbox }) };
}

describe('the Codex working folder: the adapter refuses before it writes the job or starts a session', () => {
  for (const { name, cwd, reason } of folders().cases) {
    it(`launchAll and launch judge ${name}`, async () => {
      const { home } = folders();
      const env = makeTestEnv({ home: name === 'the home folder' ? cwd : home, cwd });
      const mailbox = join(env.home, '.trellis-crew', 'mailbox');
      const all = ctxFor(env, mailbox);
      const outcome = await codexAdapter.launchAll?.([{ name: 'main', kickoff: 'k', flagArgs: [] }], all, join(env.home, 'team.json'));
      const one = ctxFor(env, mailbox);
      const single = await codexAdapter.launch('main', 'k', [], one);
      if (reason === null) {
        expect(outcome).toMatchObject({ ok: true });
        expect(single).toMatchObject({ ok: true });
        return;
      }
      expect(outcome).toEqual({ ok: false, message: expect.stringMatching(reason) });
      expect(single).toEqual({ ok: false, message: expect.stringMatching(reason) });
      expect(existsSync(join(env.home, '.trellis-crew', 'codex-supervisor.json'))).toBe(false);
      expect(all.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
      expect(one.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
    });
  }

  it('start from the home folder starts nothing on Codex', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const deps = { ...t.deps, env: { ...t.env, cwd: t.env.home } };
    expect(await main(['start'], deps)).toBe(1);
    expect(t.err.text()).toContain(RULE);
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toEqual([]);
    expect(readTeam(t.env)).toEqual({ ok: true, record: undefined });
  });
});

function supervisorRig(cwd: string, home: string) {
  const dir = makeFixtureHome();
  const bin = join(dir, 'codex');
  writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n');
  chmodSync(bin, 0o755);
  const teamPath = join(dir, 'team.json');
  writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
  const job: SupervisorJob = { binary: bin, cwd, home, teamPath, sessions: [{ name: 'main', args: codexExecArgs([], 'k', undefined) }] };
  return { job, teamPath };
}

describe('the Codex working folder: the supervisor refuses before it starts any child', () => {
  for (const { name, cwd, reason } of folders().cases) {
    it(`judges ${name}`, async () => {
      const { home } = folders();
      const { job, teamPath } = supervisorRig(cwd, name === 'the home folder' ? cwd : home);
      const warnings: string[] = [];
      const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line) });
      if (reason === null) {
        await waitFor(() => {
          const team = readTeamFile(teamPath);
          return team.ok && team.record?.sessions[0]?.pid !== null;
        });
        expect(warnings).toEqual([]);
        handle.stop();
        await handle.done;
        return;
      }
      await handle.done;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^trellis-crew supervisor: refused to start any session: Codex CLI sessions can write their working folder/);
      expect(warnings[0]).toMatch(reason);
      const team = readTeamFile(teamPath);
      expect(team.ok && team.record?.sessions[0]?.pid).toBeNull();
    });
  }

  it('the default report writes the reason to codex-supervisor.log beside the team record', async () => {
    const home = makeFixtureHome();
    const { job, teamPath } = supervisorRig(home, home);
    // The default report also writes the line to standard error, so this test prints it once.
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10 });
    await handle.done;
    expect(readFileSync(join(dirname(teamPath), 'codex-supervisor.log'), 'utf8')).toMatch(/refused to start any session: .*it is your home folder\./);
  });
});

describe('the Codex mailbox is a folder inside the state folder', () => {
  function envAt(): Env {
    const home = makeFixtureHome();
    mkdirSync(join(home, '.trellis-crew'), { mode: 0o700 });
    return makeTestEnv({ home, cwd: makeFixtureRepo().root });
  }

  it('accepts the default mailbox and another folder inside the state folder, even before it exists', () => {
    const env = envAt();
    expect(codexMailboxProblem(join(env.home, '.trellis-crew', 'mailbox'), env)).toBeUndefined();
    expect(codexMailboxProblem(join(env.home, '.trellis-crew', 'team', 'mail'), env)).toBeUndefined();
  });

  it('refuses /, the home folder, the state folder and its parents, a parent of the working folder, and anything outside', () => {
    const env = envAt();
    const state = join(env.home, '.trellis-crew');
    const inside = makeTestEnv({ home: env.home, cwd: join(state, 'mail', 'project') });
    mkdirSync(inside.cwd, { recursive: true });
    const cases: [string, Env, RegExp][] = [
      ['/', env, /\/: it is the root folder\.$/],
      [env.home, env, /: it is your home folder\.$/],
      [state, env, /: it is the state folder itself\.$/],
      [dirname(env.home), env, /: it holds the state folder\.$/],
      [join(state, 'mail'), inside, /: it holds the working folder\.$/],
      [inside.cwd, inside, /: it holds the working folder\.$/],
      [join(makeFixtureHome(), 'mail'), env, /: it is outside the state folder\.$/],
    ];
    for (const [mailbox, at, reason] of cases) {
      const problem = codexMailboxProblem(mailbox, at);
      expect(problem).toMatch(/^The file mailbox on Codex CLI must be a folder inside .*\.trellis-crew, because every session can write it\. /);
      expect(problem).toMatch(reason);
    }
  });

  it('follows a symbolic link inside the state folder to where it points', () => {
    const env = envAt();
    const outside = makeFixtureHome();
    symlinkSync(outside, join(env.home, '.trellis-crew', 'link'));
    expect(codexMailboxProblem(join(env.home, '.trellis-crew', 'link', 'mail'), env)).toMatch(/it is outside the state folder/);
  });

  it('start on Codex refuses a roles file that names an outside mailbox, and creates no folder there', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/team-mail'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(/The file mailbox on Codex CLI must be a folder inside .*: it is outside the state folder\./);
    expect(existsSync(join(t.env.home, 'team-mail'))).toBe(false);
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toEqual([]);
  });

  it('other harnesses keep an outside mailbox, as before', async () => {
    const t = installedOn('qwen-code', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/team-mail'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(existsSync(join(t.env.home, 'team-mail'))).toBe(true);
  });
});

describe('the Codex child environment is an allowlist', () => {
  const listed = Object.fromEntries(CODEX_CHILD_ENV.map((key) => [key, `v-${key}`]));

  it('keeps each listed variable and drops every other one, with every other CODEX_ variable', () => {
    expect(CODEX_CHILD_ENV).toEqual([
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'OPENAI_API_KEY', 'CODEX_HOME',
    ]);
    expect(codexChildEnv({ ...listed, CODEX_SANDBOX: 'seatbelt', CODEX_OTHER: 'x', SECRET_X: 's', UNSET: undefined })).toEqual(listed);
  });

  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('the supervisor starts each child with the allowlist only', async () => {
    for (const key of ['SECRET_X', 'CODEX_SANDBOX', 'OPENAI_API_KEY', 'LANG']) saved[key] = process.env[key];
    process.env.SECRET_X = 'secret';
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.OPENAI_API_KEY = 'fixture-key';
    process.env.LANG = 'C';
    const repo = makeFixtureRepo();
    const { job, teamPath } = supervisorRig(repo.root, makeFixtureHome());
    const out = join(dirname(teamPath), 'child-env.txt');
    writeFileSync(job.binary, `#!/bin/sh\n/usr/bin/env > '${out}'\nexec /bin/sleep 30\n`);
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: () => {} });
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').includes('LANG='));
    const lines = readFileSync(out, 'utf8').split('\n');
    expect(lines).toContain('OPENAI_API_KEY=fixture-key');
    expect(lines).toContain('LANG=C');
    expect(lines.some((line) => line.startsWith('SECRET_X='))).toBe(false);
    expect(lines.some((line) => line.startsWith('CODEX_SANDBOX='))).toBe(false);
    handle.stop();
    await handle.done;
  });

  it('respawn starts its one session with the allowlist only', async () => {
    const repo = makeFixtureRepo();
    const env = makeTestEnv({ cwd: repo.root, vars: { ...listed, SECRET_X: 's', CODEX_SANDBOX: 'seatbelt' } });
    const ctx = ctxFor(env, join(env.home, '.trellis-crew', 'mailbox'));
    let seen: RunOptions['env'];
    ctx.runner.spawnDetached = async (_command, _args, options) => {
      seen = options?.env;
      return { pid: 41000 };
    };
    expect(await codexAdapter.launch('main', 'k', [], ctx)).toMatchObject({ ok: true });
    expect(seen).toEqual(listed);
  });
});

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.ts';
import { codexExecArgs, codexSandboxArgs, execArgsProblem, refusedCodexFlag } from '../src/adapters/codex-args.ts';
import { readRoleInstructions, roleInstructionsArgs, tomlString } from '../src/adapters/codex-instructions.ts';
import type { Role } from '../src/roles/schema.ts';
import { runSupervisor, type SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import { main } from '../src/cli.ts';
import { processStartTime } from '../src/runner.ts';
import { readTeam, readTeamFile, teamJsonPath, writeTeam, writeTeamFile } from '../src/store/team-json.ts';
import { makeFixtureHome } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { isGitCall } from './helpers/recording-runner.ts';
import { fixtureBin, repoRoot } from './helpers/paths.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn, writeRoles } from './helpers/team.ts';

function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Every `codex exec` argv up to the kickoff: the sandbox, network access
 * off, the writable roots, the role's instructions, then `--`.
 */
function sandboxedExec(roots: readonly string[], role: Role): string[] {
  return [
    'exec',
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    ...roleInstructionsArgs(role),
    '--',
  ];
}

/** The role of each session in the default team and in SMALL_TEAM. */
const SESSION_ROLES: Readonly<Record<string, Role>> = {
  'personal-assistant': 'reporting-chain',
  main: 'lead',
  benchmark: 'auditor',
  'worker-1': 'standby',
  'worker-2': 'standby',
  'worker-3': 'standby',
  chain: 'reporting-chain',
  boss: 'lead',
  'helper-a': 'standby',
  'helper-b': 'standby',
  watcher: 'auditor',
};

function roleOf(name: string): Role {
  const role = SESSION_ROLES[name];
  if (role === undefined) throw new Error(`no fixture role for ${name}`);
  return role;
}

/** A one-session supervisor job for `main`, in a fresh git worktree, with the arguments the CLI builds. */
function oneSessionJob(binary: string, home: string, teamPath: string): SupervisorJob {
  return { binary, cwd: makeFixtureRepo().root, home, teamPath, sessions: [{ name: 'main', role: 'lead', args: codexExecArgs([], 'k', undefined, 'lead') }] };
}

function expectNoBypass(args: readonly string[]): void {
  for (const arg of args) {
    expect(arg).not.toContain('danger-full-access');
    expect(arg).not.toContain('dangerously-bypass-approvals-and-sandbox');
  }
}

describe('codex exec arguments', () => {
  it('sets workspace-write, network access off, and the mailbox as the one writable root, and puts the kickoff after --', () => {
    expect(codexExecArgs([], 'do the work', '/srv/mail', 'lead')).toEqual([...sandboxedExec(['/srv/mail'], 'lead'), 'do the work']);
    // A kickoff that starts with - stays the prompt, because it follows --.
    expect(codexExecArgs([], '--dangerously-bypass-approvals-and-sandbox', '/srv/mail', 'lead')).toEqual([
      ...sandboxedExec(['/srv/mail'], 'lead'),
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    // With no mailbox, the writable roots are empty, so none from the user's config apply.
    expect(codexExecArgs([], 'k', undefined, 'lead')).toEqual([...sandboxedExec([], 'lead'), 'k']);
    // The path is quoted as a TOML string, so a quote or a backslash in it stays inside the string.
    expect(codexSandboxArgs('/srv/a "b"\\c').at(-1)).toBe('sandbox_workspace_write.writable_roots=["/srv/a \\"b\\"\\\\c"]');
    const args = codexExecArgs([], 'k', '/srv/mail', 'lead');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expectNoBypass(args.slice(0, -1));
  });

  it('refuses a mailbox path with a control character, or one that is not absolute', () => {
    expect(() => codexSandboxArgs('/srv/mail\nx')).toThrow(/the mailbox folder path holds a control character/);
    expect(() => codexSandboxArgs('/srv/mail\u007f')).toThrow(/control character/);
    expect(() => codexSandboxArgs('mail')).toThrow(/must be an absolute path/);
  });

  it('refuses every launch flag, because no Codex launch flag is verified', () => {
    const refused = [
      ['--sandbox', 'danger-full-access'],
      ['--sandbox=danger-full-access'],
      ['-s', 'danger-full-access'],
      ['-sdanger-full-access'],
      ['-c', 'sandbox_mode="danger-full-access"'],
      ['--config', 'sandbox_workspace_write.network_access=true'],
      ['--dangerously-bypass-approvals-and-sandbox'],
      ['--add-dir', '/'],
      ['-C', '/'],
      ['-p', 'wide-open'],
      ['--profile', 'wide-open'],
      ['--enable', 'x'],
      ['--ignore-user-config'],
      ['--oss'],
      ['-m', 'model-a'],
    ];
    for (const flagArgs of refused) {
      expect(refusedCodexFlag(flagArgs)).toBe(
        `the launch flag "${flagArgs[0]}" is refused on Codex CLI, because no Codex launch flag is verified. trellis-crew sets the sandbox itself.`,
      );
      expect(() => codexExecArgs(flagArgs, 'k', '/srv/mail', 'lead')).toThrow(/is refused on Codex CLI/);
    }
    expect(refusedCodexFlag([])).toBeUndefined();
  });

  it('refuses a bare word, which codex exec reads as a subcommand or the prompt', () => {
    for (const word of ['resume', 'fork', 'review', 'help']) {
      expect(refusedCodexFlag([word])).toBe(`the launch argument "${word}" is refused on Codex CLI, because it is a codex exec subcommand.`);
    }
    expect(refusedCodexFlag(['danger-full-access'])).toBe('the launch argument "danger-full-access" is refused on Codex CLI, because it is not a flag.');
  });

  it('checks a value apart from its flag name, once a flag is verified', () => {
    const verified = new Set(['-m']);
    // A model name is a value. It never trips the name check.
    expect(refusedCodexFlag(['-m', 'sonnet'], verified)).toBeUndefined();
    expect(refusedCodexFlag(['-m', 'danger-full-access'], verified)).toBeUndefined();
    expect(refusedCodexFlag(['-m', 'review'], verified)).toBeUndefined();
    expect(refusedCodexFlag(['-m', '-sonnet'], verified)).toBe('the value "-sonnet" of the launch flag "-m" is refused on Codex CLI, because it starts with -.');
    expect(refusedCodexFlag(['-m'], verified)).toBe('the launch flag "-m" is refused on Codex CLI, because it has no value.');
    expect(refusedCodexFlag(['-m', 'a\nb'], verified)).toMatch(/because it holds a control character/);
    expect(refusedCodexFlag(['-m', 'sonnet', '--oss'], verified)).toMatch(/"--oss" is refused/);
  });

  it('execArgsProblem accepts only the exact sandbox arguments', () => {
    expect(execArgsProblem(codexExecArgs([], 'k', '/srv/mail', 'lead'), 'lead')).toBeUndefined();
    expect(execArgsProblem(codexExecArgs([], 'k', undefined, 'lead'), 'lead')).toBeUndefined();
    expect(execArgsProblem(['exec', 'k'], 'lead')).toMatch(/not the sandbox arguments that trellis-crew sets/);
    const wide = codexExecArgs([], 'k', '/srv/mail', 'lead').map((a) => (a === 'workspace-write' ? 'danger-full-access' : a));
    expect(execArgsProblem(wide, 'lead')).toMatch(/not the sandbox arguments that trellis-crew sets/);
    const netOn = codexExecArgs([], 'k', '/srv/mail', 'lead').map((a) => a.replace('network_access=false', 'network_access=true'));
    expect(execArgsProblem(netOn, 'lead')).toMatch(/not the sandbox arguments/);
    const twoRoots = codexExecArgs([], 'k', '/srv/mail', 'lead').map((a) => a.replace('["/srv/mail"]', '["/srv/mail","/"]'));
    expect(execArgsProblem(twoRoots, 'lead')).toMatch(/not the sandbox arguments/);
    expect(execArgsProblem(['exec', '--oss', ...codexExecArgs([], 'k', '/srv/mail', 'lead').slice(1)], 'lead')).toMatch(/"--oss" is refused/);
  });

  it('builds the exact full argv, and execArgsProblem accepts it for that role only', () => {
    const value = `developer_instructions=${tomlString(readRoleInstructions('lead'))}`;
    const args = codexExecArgs([], 'the kickoff', '/srv/mail', 'lead');
    expect(args).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'sandbox_workspace_write.writable_roots=["/srv/mail"]',
      '-c',
      value,
      '--',
      'the kickoff',
    ]);
    expect(execArgsProblem(args, 'lead')).toBeUndefined();
    // The same argv checked against another role's skill is refused.
    expect(execArgsProblem(args, 'standby')).toMatch(/not the shipped skill for the standby role/);
  });

  describe('execArgsProblem refuses every smuggled -c', () => {
    const body = (): string => readRoleInstructions('lead');
    const good = (): string[] => codexExecArgs([], 'k', '/srv/mail', 'lead');
    const devValue = (): string => good().at(-3) as string;
    /** The good argv with the role pair at the end replaced by `pair`. */
    const withRolePair = (...pair: string[]): string[] => [...good().slice(0, -4), ...pair, '--', 'k'];
    /** The good argv with `extra` put in as launch flags, right after exec. */
    const withFlags = (...extra: string[]): string[] => ['exec', ...extra, ...good().slice(1)];
    /** The good argv with `extra` put in just before `--`, after the role pair. */
    const beforeDashes = (...extra: string[]): string[] => [...good().slice(0, -2), ...extra, '--', 'k'];

    const flagRefused = /is refused on Codex CLI, because no Codex launch flag is verified/;
    const notRolePair = /^the arguments do not end with the role instructions that trellis-crew sets$/;
    const notShipped = /^the developer_instructions value is not the shipped skill for the lead role$/;
    const notSandbox = /^the arguments are not the sandbox arguments that trellis-crew sets$/;
    const cases: [string, () => string[], RegExp][] = [
      ['-c sandbox_mode=danger-full-access as a launch flag', () => withFlags('-c', 'sandbox_mode="danger-full-access"'), flagRefused],
      ['-c sandbox_mode=danger-full-access just before --', () => beforeDashes('-c', 'sandbox_mode="danger-full-access"'), notRolePair],
      ['-c sandbox_mode=danger-full-access in place of the role pair', () => withRolePair('-c', 'sandbox_mode="danger-full-access"'), notRolePair],
      ['a second developer_instructions as a launch flag', () => withFlags('-c', devValue()), flagRefused],
      ['a second developer_instructions just before --', () => beforeDashes('-c', devValue()), notSandbox],
      ['developer_instructions with changed text', () => withRolePair('-c', `developer_instructions=${tomlString(`${body()}and one more line\n`)}`), notShipped],
      ['developer_instructions with another role skill', () => withRolePair('-c', `developer_instructions=${tomlString(readRoleInstructions('standby'))}`), notShipped],
      ['--config developer_instructions in place of -c', () => withRolePair('--config', devValue()), notRolePair],
      ['--config developer_instructions as a launch flag', () => withFlags('--config', devValue()), flagRefused],
      // A joined form is one argument, so the argv is one short and fails the length check first.
      ['the joined --config=developer_instructions in place of the pair', () => withRolePair(`--config=${devValue()}`), notSandbox],
      ['the joined --config=developer_instructions as a launch flag', () => withFlags(`--config=${devValue()}`), flagRefused],
      ['the joined -cdeveloper_instructions in place of the pair', () => withRolePair(`-c${devValue()}`), notSandbox],
      // Padded back to full length, the joined form fails the role-pair check instead.
      ['the joined -cdeveloper_instructions padded to full length', () => withRolePair('--oss', `-c${devValue()}`), notRolePair],
      ['the joined -cdeveloper_instructions as a launch flag', () => withFlags(`-c${devValue()}`), flagRefused],
      ['a value hiding a newline plus sandbox_mode', () => withRolePair('-c', `${devValue()}\nsandbox_mode="danger-full-access"`), notShipped],
      ['a hand-written value with a raw newline plus sandbox_mode', () => withRolePair('-c', 'developer_instructions="x"\nsandbox_mode="danger-full-access"'), notShipped],
      ['no role pair at all', () => [...good().slice(0, -4), '--', 'k'], notSandbox],
    ];

    it.each(cases)('refuses %s', (_label, build, reason) => {
      expect(execArgsProblem(build(), 'lead')).toMatch(reason);
    });

    it('refuses a role that is not one of the four', () => {
      expect(execArgsProblem(good(), 'admin' as Role)).toBe('the role "admin" is not one of lead, standby, auditor, reporting-chain');
    });

    it('the supervisor starts none of them, nor a session whose job names an unknown role', async () => {
      const dir = makeFixtureHome();
      const bin = join(dir, 'codex');
      writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n');
      chmodSync(bin, 0o755);
      const teamPath = join(dir, 'team.json');
      const sessions: SupervisorJob['sessions'] = cases.map(([_label, build], i) => ({ name: `smuggle-${i}`, role: 'lead', args: build() }));
      sessions.push({ name: 'unknown-role', role: 'admin' as Role, args: good() });
      writeTeamFile(teamPath, {
        version: 1,
        harness: 'codex',
        supervisor_pid: process.pid,
        sessions: sessions.map((s) => ({ name: s.name, pid: null, session_id: null })),
      });
      const warnings: string[] = [];
      await runSupervisor(
        { binary: bin, cwd: makeFixtureRepo().root, home: dir, teamPath, sessions },
        { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line) },
      ).done;
      const team = readTeamFile(teamPath);
      if (!team.ok || !team.record) throw new Error('no team');
      expect(team.record.sessions.every((s) => s.pid === null)).toBe(true);
      expect(team.record.sessions.every((s) => s.error?.startsWith('refused, so it was not started: '))).toBe(true);
      expect(warnings).toHaveLength(sessions.length);
      expect(warnings.at(-1)).toBe(
        'trellis-crew supervisor: unknown-role: refused, so it was not started: the role "admin" is not one of lead, standby, auditor, reporting-chain',
      );
    });
  });

  it('respawn refuses an injected sandbox flag and starts nothing', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {}, mailbox: '/srv/mail' };
    const outcome = await codexAdapter.launch('main', 'k', ['--sandbox', 'danger-full-access'], ctx, 'lead');
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/"--sandbox" is refused on Codex CLI/) });
    expect(t.runner.calls).toEqual([]);
  });

  it('respawn passes the mailbox as the writable root', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const mailbox = join(t.env.home, '.trellis-crew', 'mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {}, mailbox };
    expect(await codexAdapter.launch('main', 'k', [], ctx, 'lead')).toMatchObject({ ok: true });
    expect(t.runner.calls.find((c) => c.kind === 'detached')?.args).toEqual([...sandboxedExec([mailbox], 'lead'), 'k']);
  });

  it('launchAll refuses a mailbox path with a control character, and starts nothing', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {}, mailbox: '/srv/ma\til' };
    const outcome = await codexAdapter.launchAll?.([{ name: 'main', role: 'lead', kickoff: 'k', flagArgs: [] }], ctx, join(t.env.home, 'team.json'));
    expect(outcome).toEqual({ ok: false, notStarted: true, message: expect.stringMatching(/^main: the mailbox folder path holds a control character/) });
    expect(t.runner.calls).toEqual([]);
  });

  it('start gives each session the default mailbox as its writable root', async () => {
    const t = installedOn('codex', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    const mailbox = join(t.env.home, '.trellis-crew', 'mailbox');
    for (const session of job.sessions) expect(session.args.slice(0, -1)).toEqual(sandboxedExec([mailbox], roleOf(session.name)));
  });

  it('start gives each session a custom mailbox from the roles file as its writable root', async () => {
    const t = installedOn('codex', 'file-mailbox');
    // On Codex the mailbox must sit inside the state folder, so the custom one is there.
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/.trellis-crew/team-mail'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    const mailbox = join(t.env.home, '.trellis-crew', 'team-mail');
    for (const session of job.sessions) expect(session.args.slice(0, -1)).toEqual(sandboxedExec([mailbox], roleOf(session.name)));
  });

  it('start refuses a roles-file flag that reaches the sandbox, and starts no supervisor', async () => {
    // Codex has no verified launch flag today, so a stand-in maps model to --sandbox to show the guard holds.
    const leaky = { ...codexAdapter, flags: { model: '--sandbox' } };
    const t = installedOn('codex', 'file-mailbox', { adapters: { codex: leaky } });
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: danger-full-access'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(1);
    expect(t.err.text()).toContain('helper-a: the launch flag "--sandbox" is refused on Codex CLI, because no Codex launch flag is verified.');
    expect(t.runner.calls).toEqual([]);
    expect(readTeam(t.env)).toEqual({ ok: true, record: undefined });
  });

  it('a roles-file value on Codex is ignored with a warning, so it never reaches codex exec', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: danger-full-access'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.text()).toContain('warning: helper-a: model ignored. Codex CLI has no verified flag for it.');
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    for (const session of job.sessions) {
      expect(session.args.slice(0, -1)).toEqual(sandboxedExec([join(t.env.home, '.trellis-crew', 'mailbox')], roleOf(session.name)));
      expectNoBypass(session.args.slice(0, -1));
    }
  });
});

describe('Codex CLI', () => {
  it('49: start returns at once while the detached supervisor keeps running', async () => {
    const t = installedOn('codex', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    const spawns = t.runner.calls.filter((c) => c.kind === 'detached');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe(process.execPath);
    expect(spawns[0]?.args[0]).toMatch(/codex-supervisor\.(ts|js)$/);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    const supervisor = team.record.supervisor_pid as number;
    expect(t.runner.living.has(supervisor)).toBe(true);
    expect(team.record.sessions.map((s) => s.name)).toHaveLength(6);

    const job = JSON.parse(readFileSync(spawns[0]?.args[1] as string, 'utf8')) as SupervisorJob;
    expect(job.binary).toBe(join(fixtureBin, 'codex'));
    expect(job.supervisorPid).toBeUndefined();
    const mainJob = job.sessions.find((s) => s.name === 'main');
    // The sandbox, then -c developer_instructions=<the role skill>, then --, then the kickoff.
    expect(mainJob?.args).toEqual([...sandboxedExec([join(t.env.home, '.trellis-crew', 'mailbox')], 'lead'), mainJob?.args.at(-1)]);
    expect(mainJob?.args.at(-1)).toMatch(/You are main, the lead\.[\s\S]*file mailbox at/);
    expect(t.out.text()).toMatch(/supervisor/);
  });

  it('the supervisor job file goes only into a private state folder', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const { codexAdapter } = await import('../src/adapters/codex.ts');
    const launchAll = codexAdapter.launchAll;
    if (launchAll === undefined) throw new Error('no launchAll');
    chmodSync(join(t.env.home, '.trellis-crew'), 0o755);
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {} };
    // A folder or disk problem is a named step that failed, never a throw.
    expect(await launchAll([{ name: 'main', role: 'lead', kickoff: 'k', flagArgs: [] }], ctx, join(t.env.home, 'team.json'))).toEqual({
      ok: false,
      message: expect.stringMatching(/^could not write the supervisor job file .*codex-supervisor\.json: .*open to other users/),
    });
    expect(existsSync(join(t.env.home, '.trellis-crew', 'codex-supervisor.json'))).toBe(false);
    // Only the working-folder check ran.
    expect(t.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
  });

  it('start leaves no team record when the supervisor job file cannot be written', async () => {
    const t = installedOn('codex', 'file-mailbox');
    // A folder where the job file goes, so the atomic rename over it fails.
    mkdirSync(join(t.env.home, '.trellis-crew', 'codex-supervisor.json', 'blocker'), { recursive: true });
    expect(await main(['start'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/The supervisor could not start: could not write the supervisor job file/);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
    // Only the working-folder check ran.
    expect(t.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
  });

  it('the supervisor records a child that fails to spawn, in its log and on the team entry', async () => {
    const dir = makeFixtureHome();
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const lines: string[] = [];
    const handle = runSupervisor(oneSessionJob(join(dir, 'missing'), dir, teamPath), {
      ownPid: process.pid,
      pollMs: 10,
      warn: (line) => lines.push(line),
    });
    await handle.done;
    expect(lines).toEqual([expect.stringMatching(/^trellis-crew supervisor: main: could not start: .*ENOENT/)]);
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.error).toMatch(/^could not start: .*ENOENT/);
  });

  it('the supervisor records a child that exits non-zero, and not one that exits 0', async () => {
    const dir = makeFixtureHome();
    const fails = join(dir, 'fails');
    writeFileSync(fails, '#!/bin/sh\nexit 3\n');
    chmodSync(fails, 0o755);
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const lines: string[] = [];
    await runSupervisor(oneSessionJob(fails, dir, teamPath), { ownPid: process.pid, pollMs: 10, warn: (line) => lines.push(line) }).done;
    expect(lines).toEqual(['trellis-crew supervisor: main: exited with code 3']);
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.error).toBe('exited with code 3');

    const passes = join(dir, 'passes');
    writeFileSync(passes, '#!/bin/sh\nexit 0\n');
    chmodSync(passes, 0o755);
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const quiet: string[] = [];
    await runSupervisor(oneSessionJob(passes, dir, teamPath), { ownPid: process.pid, pollMs: 10, warn: (line) => quiet.push(line) }).done;
    expect(quiet).toEqual([]);
    const clean = readTeamFile(teamPath);
    expect(clean.ok && clean.record?.sessions[0]?.error).toBeUndefined();
  });

  it('the default report writes the line to codex-supervisor.log beside the team record', async () => {
    const dir = makeFixtureHome();
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await runSupervisor(oneSessionJob(join(dir, 'missing'), dir, teamPath), { ownPid: process.pid, pollMs: 10 }).done;
    } finally {
      stderr.mockRestore();
    }
    expect(readFileSync(join(dir, 'codex-supervisor.log'), 'utf8')).toMatch(/^\S+ trellis-crew supervisor: main: could not start: .*ENOENT.*\n$/);
  });

  it('the default report follows no link at codex-supervisor.log, and the supervisor still ends cleanly', async () => {
    const dir = makeFixtureHome();
    const outside = join(makeFixtureHome(), 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    symlinkSync(outside, join(dir, 'codex-supervisor.log'));
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await runSupervisor(oneSessionJob(join(dir, 'missing'), dir, teamPath), { ownPid: process.pid, pollMs: 10 }).done;
    } finally {
      stderr.mockRestore();
    }
    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
    // The refused write is reported as an error on standard error, after the line itself.
    expect(written).toEqual([
      expect.stringMatching(/^trellis-crew supervisor: main: could not start: .*ENOENT\n$/),
      expect.stringMatching(/^trellis-crew supervisor: could not write .*codex-supervisor\.log: .*ELOOP.*\n$/),
    ]);
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.error).toMatch(/^could not start: .*ENOENT/);
  });

  it('status prints the error the supervisor recorded for a session', async () => {
    const t = installedOn('codex', 'file-mailbox');
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      sessions: [
        { name: 'main', pid: null, session_id: null, error: 'exited with code 3' },
        { name: 'worker-1', pid: null, session_id: null },
      ],
    });
    expect(await main(['status'], t.deps)).toBe(0);
    expect(t.out.lines.find((l) => l.startsWith('main'))).toMatch(/error: exited with code 3$/);
    expect(t.out.lines.find((l) => l.startsWith('worker-1'))).not.toMatch(/error/);
  });

  it('46: each set field prints one warning, and the session still starts', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: model-a'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.lines.filter((l) => l.startsWith('warning: helper-a:'))).toEqual([
      'warning: helper-a: autocompact ignored. Codex CLI has no verified flag for it.',
      'warning: helper-a: model ignored. Codex CLI has no verified flag for it.',
    ]);
  });

  it('the supervisor waits for its record, starts each child, records the pids, and ends them on stop', async () => {
    const dir = makeFixtureHome();
    const bin = join(dir, 'codex');
    writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n');
    chmodSync(bin, 0o755);
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, {
      version: 1,
      harness: 'codex',
      supervisor_pid: process.pid,
      sessions: [
        { name: 'main', pid: null, session_id: null },
        { name: 'worker-1', pid: null, session_id: null },
      ],
    });
    const job: SupervisorJob = {
      binary: bin,
      cwd: makeFixtureRepo().root,
      home: dir,
      teamPath,
      sessions: [
        { name: 'main', role: 'lead', args: codexExecArgs([], 'kickoff one', dir, 'lead') },
        { name: 'worker-1', role: 'standby', args: codexExecArgs([], 'kickoff two', dir, 'standby') },
      ],
    };
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: () => {} });
    await waitFor(() => {
      const team = readTeamFile(teamPath);
      return team.ok && !!team.record && team.record.sessions.every((s) => s.pid !== null);
    });
    const team = readTeamFile(teamPath);
    if (!team.ok || !team.record) throw new Error('no team');
    const pids = team.record.sessions.map((s) => s.pid as number);
    for (const pid of pids) expect(alive(pid)).toBe(true);
    // Each child's start time is recorded, so stop can tell a reused pid.
    for (const entry of team.record.sessions) expect(processStartTime(entry.pid as number)).toEqual({ status: 'running', started: entry.started });
    handle.stop();
    await handle.done;
    await waitFor(() => pids.every((pid) => !alive(pid)));
    // A child ended by stop is not an error.
    const after = readTeamFile(teamPath);
    expect(after.ok && after.record?.sessions.map((s) => s.error)).toEqual([undefined, undefined]);
  });

  it('the supervisor refuses a child whose arguments lack the exact sandbox, says why, and starts the rest', async () => {
    const dir = makeFixtureHome();
    const bin = join(dir, 'codex');
    writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n');
    chmodSync(bin, 0o755);
    const teamPath = join(dir, 'team.json');
    const names = ['bare', 'wide', 'flagged', 'good'];
    writeTeamFile(teamPath, {
      version: 1,
      harness: 'codex',
      supervisor_pid: process.pid,
      sessions: names.map((name) => ({ name, pid: null, session_id: null })),
    });
    const good = codexExecArgs([], 'k', dir, 'lead');
    const job: SupervisorJob = {
      binary: bin,
      cwd: makeFixtureRepo().root,
      home: dir,
      teamPath,
      sessions: [
        { name: 'bare', role: 'lead', args: ['exec', 'k'] },
        { name: 'wide', role: 'lead', args: good.map((a) => (a === 'workspace-write' ? 'danger-full-access' : a)) },
        { name: 'flagged', role: 'lead', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', ...good.slice(1)] },
        { name: 'good', role: 'lead', args: good },
      ],
    };
    const warnings: string[] = [];
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line) });
    await waitFor(() => {
      const team = readTeamFile(teamPath);
      return team.ok && team.record?.sessions.find((s) => s.name === 'good')?.pid !== null;
    });
    const team = readTeamFile(teamPath);
    if (!team.ok || !team.record) throw new Error('no team');
    expect(team.record.sessions.filter((s) => s.pid !== null).map((s) => s.name)).toEqual(['good']);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/^trellis-crew supervisor: bare: refused, so it was not started: .*not the sandbox arguments/);
    expect(warnings[1]).toMatch(/^trellis-crew supervisor: wide: refused/);
    expect(warnings[2]).toMatch(/^trellis-crew supervisor: flagged: refused, so it was not started: .*--dangerously-bypass-approvals-and-sandbox/);
    handle.stop();
    await handle.done;
  });

  it('the supervisor starts nothing when its record never names it', async () => {
    const dir = makeFixtureHome();
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', sessions: [{ name: 'main', pid: null, session_id: null }] });
    const handle = runSupervisor(
      { binary: join(dir, 'missing'), cwd: makeFixtureRepo().root, home: dir, teamPath, sessions: [{ name: 'main', role: 'lead', args: ['exec', 'k'] }] },
      { ownPid: process.pid, pollMs: 10, waitMs: 100 },
    );
    await handle.done;
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.pid).toBeNull();
  });

  it('install copies each skill folder into ~/.agents/skills, and update copies them fresh', async () => {
    const t = installedOn('codex', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    mkdirSync(join(t.env.home, '.codex'));
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const skills = readdirSync(join(repoRoot, 'skills'));
    const target = join(t.env.home, '.agents', 'skills');
    expect(readdirSync(target).sort()).toEqual(skills.sort());
    for (const skill of skills) {
      expect(readFileSync(join(target, skill, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8'));
    }
    writeFileSync(join(target, 'department-lead', 'stale.txt'), 'old');
    writeFileSync(join(target, 'someone-elses-skill.md'), 'keep');
    expect(await main(['update'], t.deps)).toBe(0);
    expect(existsSync(join(target, 'department-lead', 'stale.txt'))).toBe(false);
    expect(existsSync(join(target, 'someone-elses-skill.md'))).toBe(true);
    expect(t.runner.calls).toEqual([]);
  });
});

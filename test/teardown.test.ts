import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { USAGE } from '../src/args.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, main } from '../src/cli.ts';
import { POLL_INTERVAL_MS, TIMED_JOBS_FILE } from '../src/commands/teardown.ts';
import { teamJsonPath, writeTeam, type TeamEntry } from '../src/store/team-json.ts';
import { crewYml } from './helpers/crew.ts';
import { HEAD_SHA1, WRITTEN_AT, writeHandoff, type HandoffParts } from './helpers/handoff.ts';
import { claudeInstalled, type Harnessed } from './helpers/team.ts';

interface Rig extends Harnessed {
  project: string;
  handoffs: string;
  sleeps: number[];
  /** Runs after each fake sleep, with the count of sleeps so far. */
  hooks: { onSleep?: (count: number) => void };
  sessions: TeamEntry[];
}

interface RigOptions {
  /** The session names in team.json. */
  sessions?: string[];
  /** The lines of the teardown block, or null for no block. */
  teardown?: string[] | null;
  /** No team.json at all. */
  noTeam?: boolean;
  /** The fake clock's start, in milliseconds. Default: WRITTEN_AT. */
  start?: number;
}

const START = Date.parse(WRITTEN_AT);

/**
 * A fixture project in the Env's current folder: a crew.yml with a
 * teardown block, a team record with one pid per session, a fake clock,
 * and a fake sleep that moves the clock and never waits.
 */
function rig(options: RigOptions = {}): Rig {
  const sleeps: number[] = [];
  const hooks: Rig['hooks'] = {};
  let clock = options.start ?? START;
  const t = claudeInstalled({
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      hooks.onSleep?.(sleeps.length);
    },
  });
  const project = t.env.cwd;
  const teardown = options.teardown === undefined ? ['teardown:', '  handoffs: .crew/handoffs', '  timeout: 10'] : options.teardown ?? [];
  writeFileSync(join(project, 'crew.yml'), crewYml({ extra: teardown }));
  const names = options.sessions ?? ['worker-1', 'worker-2'];
  const sessions: TeamEntry[] = names.map((name, index) => ({ name, pid: 4101 + index, session_id: null, started: `start-${index}` }));
  if (!options.noTeam) writeTeam(t.env, { version: 1, harness: 'codex', sessions });
  for (const entry of sessions) {
    t.runner.living.add(entry.pid as number);
    t.runner.starts.set(entry.pid as number, entry.started as string);
  }
  return { ...t, project, handoffs: join(project, '.crew', 'handoffs'), sleeps, hooks, sessions };
}

function kills(t: Rig): number[] {
  return t.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command));
}

function confirm(t: Rig, session: string, parts: HandoffParts = {}): string {
  return writeHandoff(t.handoffs, session, parts);
}

function all(t: Rig): string {
  return `${t.out.text()}\n${t.err.text()}`;
}

describe('teardown: the command line', () => {
  it('USAGE lists teardown with its flags', () => {
    expect(USAGE).toContain('trellis-crew teardown [--config crew.yml] [--timeout S] [--dry-run]');
  });

  it.each(['9', '3601', '0', 'abc', '1.5', '-10', ''])('--timeout %j fails with exit 2 and stops nothing', async (value) => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2');
    expect(await main(['teardown', `--timeout=${value}`], t.deps)).toBe(EXIT_USAGE);
    expect(t.err.text()).toMatch(/--timeout takes a whole number of seconds from 10 to 3600/);
    expect(t.runner.calls).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
  });

  it.each(['10', '3600'])('--timeout %s passes', async (value) => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2');
    expect(await main(['teardown', '--timeout', value], t.deps)).toBe(EXIT_OK);
  });

  it('an unknown flag fails with exit 2 and stops nothing', async () => {
    const t = rig();
    expect(await main(['teardown', '--force-stop'], t.deps)).toBe(EXIT_USAGE);
    expect(t.runner.calls).toEqual([]);
  });

  it('a positional argument fails with exit 2', async () => {
    const t = rig();
    expect(await main(['teardown', 'worker-1'], t.deps)).toBe(EXIT_USAGE);
    expect(t.runner.calls).toEqual([]);
  });
});

describe('teardown: the crew configuration', () => {
  it('a crew.yml with no teardown block exits 2, names the block, and stops nothing', async () => {
    const t = rig({ teardown: null });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_USAGE);
    expect(t.err.text()).toMatch(/teardown/);
    expect(t.err.text()).toContain(join(t.project, 'crew.yml'));
    expect(t.runner.calls).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
  });

  it('a missing crew.yml exits 2 and names the file', async () => {
    const t = rig();
    expect(await main(['teardown', '--config', 'other.yml'], t.deps)).toBe(EXIT_USAGE);
    expect(t.err.text()).toContain(join(t.project, 'other.yml'));
    expect(t.err.text()).toMatch(/does not exist/);
    expect(t.runner.calls).toEqual([]);
  });

  it('a crew.yml with an error exits 2 with the file, line, field, and reason', async () => {
    const t = rig({ teardown: ['teardown:', '  handoffs: /abs'] });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_USAGE);
    expect(t.err.text()).toMatch(/crew\.yml:\d+: teardown\.handoffs: /);
    expect(t.runner.calls).toEqual([]);
  });

  it('reads --config from another folder, and resolves the handoff folder against that folder', async () => {
    const t = rig({ teardown: null });
    const sub = join(t.project, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'crew.yml'), crewYml({ extra: ['teardown:', '  handoffs: notes'] }));
    writeHandoff(join(sub, 'notes'), 'worker-1');
    writeHandoff(join(sub, 'notes'), 'worker-2');
    expect(await main(['teardown', '--config', 'sub/crew.yml'], t.deps)).toBe(EXIT_OK);
    expect(kills(t)).toEqual([4101, 4102]);
    expect(existsSync(join(sub, 'notes', TIMED_JOBS_FILE))).toBe(true);
  });

  it('uses the timeout from crew.yml when no --timeout is given', async () => {
    const t = rig({ teardown: ['teardown:', '  handoffs: .crew/handoffs', '  timeout: 20'] });
    confirm(t, 'worker-1');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it('--timeout overrides the file value', async () => {
    const t = rig({ teardown: ['teardown:', '  handoffs: .crew/handoffs', '  timeout: 3600'] });
    confirm(t, 'worker-1');
    expect(await main(['teardown', '--timeout', '10'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });
});

describe('teardown: no team', () => {
  it('prints "No team is running." and exits 0', async () => {
    const t = rig({ noTeam: true });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(t.out.text()).toMatch(/No team is running\./);
    expect(t.runner.calls).toEqual([]);
    expect(t.sleeps).toEqual([]);
  });
});

describe('teardown: confirm and stop', () => {
  it('stops the team when every session confirms on the first pass', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { fields: { push: 'nothing-to-push', branch: 'null', head: 'null' } });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(t.sleeps).toEqual([]);
    expect(kills(t)).toEqual([4101, 4102]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
    expect(t.out.text()).toMatch(/worker-1: confirmed\. Pushed feat\/example at 0123456789ab/);
    expect(t.out.text()).toMatch(/worker-2: confirmed\. Nothing to push\./);
  });

  it('waits for a session that confirms only after two polls, then stops the team', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    t.hooks.onSleep = (count) => {
      if (count === 2) confirm(t, 'worker-2');
    };
    expect(await main(['teardown', '--timeout', '60'], t.deps)).toBe(EXIT_OK);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(kills(t)).toEqual([4101, 4102]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('keeps waiting while a handoff says a status other than done', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { fields: { status: 'working' } });
    t.hooks.onSleep = (count) => {
      if (count === 1) confirm(t, 'worker-2');
    };
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS]);
    expect(kills(t)).toEqual([4101, 4102]);
  });

  it('names a session that never confirms, signals nothing, keeps team.json, and exits 1', async () => {
    const t = rig({ sessions: ['worker-1', 'worker-2', 'worker-3'] });
    confirm(t, 'worker-1');
    confirm(t, 'worker-3', { fields: { status: 'working' } });
    const before = readFileSync(teamJsonPath(t.env), 'utf8');
    expect(await main(['teardown', '--timeout', '10'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(kills(t)).toEqual([]);
    expect(t.runner.calls).toEqual([]);
    expect(readFileSync(teamJsonPath(t.env), 'utf8')).toBe(before);
    expect(t.out.text()).toMatch(/worker-2: not confirmed by the timeout \(10 s\)/);
    expect(t.out.text()).toMatch(/worker-3: not confirmed by the timeout \(10 s\).*"working"/);
    expect(t.err.text()).toMatch(/worker-2/);
    expect(t.err.text()).toMatch(/worker-3/);
    expect(t.err.text()).not.toMatch(/worker-1/);
    expect(t.err.text()).toMatch(/Nothing was stopped/);
    expect(existsSync(join(t.handoffs, TIMED_JOBS_FILE))).toBe(false);
  });

  it('writing: true blocks the stop, even after the timeout', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { fields: { writing: 'true' } });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(kills(t)).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
    expect(t.out.text()).toMatch(/worker-2: .*write is still in progress/);
    expect(t.err.text()).toMatch(/worker-2/);
  });

  it('a write that ends before the timeout lets the stop go ahead', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { fields: { writing: 'true' } });
    t.hooks.onSleep = () => confirm(t, 'worker-2');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS]);
    expect(kills(t)).toEqual([4101, 4102]);
  });

  it('an invalid handoff is named with its reason and blocks the stop', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { body: '## Open items\n\n## Live state\n' });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(kills(t)).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
    expect(t.out.text()).toMatch(/worker-2: the handoff is invalid/);
    expect(t.out.text()).toMatch(/## Next step/);
    expect(t.err.text()).toMatch(/worker-2/);
  });

  it('a handoff for another session is invalid', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    writeFileSync(join(t.handoffs, 'worker-2.md'), readFileSync(join(t.handoffs, 'worker-1.md')));
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.out.text()).toMatch(/worker-2: the handoff is invalid.*session/);
    expect(kills(t)).toEqual([]);
  });

  it('a handoff that is a symbolic link is refused, not followed, and blocks the stop', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    const elsewhere = join(t.project, 'elsewhere');
    writeHandoff(elsewhere, 'worker-2');
    symlinkSync(join(elsewhere, 'worker-2.md'), join(t.handoffs, 'worker-2.md'));
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.out.text()).toMatch(/worker-2: the handoff is invalid.*symbolic link/);
    expect(kills(t)).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
  });

  it('a failed push is confirmed with a warning, and does not block the stop', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { fields: { push: 'failed' } });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(t.err.text()).toMatch(/warning: worker-2: the push failed/);
    expect(kills(t)).toEqual([4101, 4102]);
  });

  it('repeats every push warning in one summary line at the end of the run', async () => {
    const t = rig({ sessions: ['worker-1', 'worker-2', 'worker-3'] });
    confirm(t, 'worker-1', { fields: { push: 'failed' } });
    confirm(t, 'worker-2');
    confirm(t, 'worker-3', { fields: { push: 'failed', branch: 'null', head: 'null' } });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(kills(t)).toEqual([4101, 4102, 4103]);
    expect(t.err.lines.at(-1)).toMatch(/^warning: the push failed for 2 session\(s\): worker-1, worker-3\./);
  });

  it('prints the push summary last on a blocked run and on a dry run too', async () => {
    const blocked = rig();
    confirm(blocked, 'worker-1', { fields: { push: 'failed' } });
    expect(await main(['teardown'], blocked.deps)).toBe(EXIT_RUNTIME);
    expect(blocked.err.lines.at(-1)).toMatch(/^warning: the push failed for 1 session\(s\): worker-1\./);

    const dry = rig();
    confirm(dry, 'worker-1', { fields: { push: 'failed' } });
    expect(await main(['teardown', '--dry-run'], dry.deps)).toBe(EXIT_OK);
    expect(dry.err.lines.at(-1)).toMatch(/^warning: the push failed for 1 session\(s\): worker-1\./);
  });

  it('prints no push summary when every push went well', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(t.err.text()).not.toMatch(/push failed/);
  });

  it('a leftover handoff from an earlier team does not confirm, and nothing is signalled', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { fields: { written: '2025-12-31T12:00:00Z' } });
    const before = readFileSync(teamJsonPath(t.env), 'utf8');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(t.runner.calls).toEqual([]);
    expect(readFileSync(teamJsonPath(t.env), 'utf8')).toBe(before);
    expect(t.out.text()).toMatch(
      /worker-2: not confirmed by the timeout \(10 s\)\. Its handoff says it was written at 2025-12-31T12:00:00Z, and the file last changed at .+\. One of them is before this teardown started at 2026-01-01T00:00:00\.000Z/,
    );
    expect(t.err.text()).toMatch(/Blocked by: worker-2 \(not confirmed\)/);
    expect(existsSync(join(t.handoffs, TIMED_JOBS_FILE))).toBe(false);
  });

  it('a leftover handoff that the session writes again during the wait confirms', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { fields: { written: '2025-12-31T12:00:00Z' } });
    t.hooks.onSleep = () => confirm(t, 'worker-2', { fields: { written: '2026-01-01T00:00:05Z' } });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(kills(t)).toEqual([4101, 4102]);
  });

  it('reads every handoff once more before the stop, and blocks when a settled session changed', async () => {
    const t = rig();
    confirm(t, 'worker-1', { extra: ['timed_jobs:', '  - schedule: every hour', '    prompt: Check.'] });
    // worker-1 settles on the first pass. During the wait, worker-2
    // confirms and worker-1 starts a new write.
    t.hooks.onSleep = () => {
      confirm(t, 'worker-2');
      confirm(t, 'worker-1', { fields: { writing: 'true' } });
    };
    const before = readFileSync(teamJsonPath(t.env), 'utf8');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS]);
    expect(t.runner.calls).toEqual([]);
    expect(readFileSync(teamJsonPath(t.env), 'utf8')).toBe(before);
    expect(existsSync(join(t.handoffs, TIMED_JOBS_FILE))).toBe(false);
    expect(t.out.text()).toMatch(/worker-1: changed after it confirmed/);
    expect(t.err.text()).toMatch(/Blocked by: worker-1 \(a write is in progress\)/);
    expect(t.err.text()).not.toMatch(/Blocked by: .*worker-2/);
  });

  it('blocks the stop when the final read finds a handoff gone', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    t.hooks.onSleep = () => {
      confirm(t, 'worker-2');
      writeFileSync(join(t.handoffs, 'worker-1.md'), 'no longer a handoff');
    };
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.runner.calls).toEqual([]);
    expect(t.err.text()).toMatch(/Blocked by: worker-1 \(handoff invalid\)/);
  });

  it('two team entries with one name block the stop, and the report names the duplicate', async () => {
    const t = rig({ sessions: ['worker-1', 'worker-1', 'worker-2'] });
    confirm(t, 'worker-1');
    confirm(t, 'worker-2');
    const before = readFileSync(teamJsonPath(t.env), 'utf8');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.runner.calls).toEqual([]);
    expect(readFileSync(teamJsonPath(t.env), 'utf8')).toBe(before);
    expect(t.err.text()).toMatch(/warning: the team record lists the session "worker-1" 2 times/);
    expect(t.err.text()).toMatch(/Blocked by: worker-1 \(listed 2 times in the team record\)/);
    expect(t.err.text()).not.toMatch(/Blocked by: .*worker-2/);
  });

  it('a session name that breaks the path-safe rule is skipped, named, and blocks the stop', async () => {
    const t = rig({ sessions: ['worker-1', '../escape'] });
    confirm(t, 'worker-1');
    // A file where the unsafe name would point, so a read of it would show.
    writeFileSync(join(t.project, '.crew', 'escape.md'), 'not a handoff');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.err.text()).toMatch(/"\.\.\/escape"/);
    expect(t.err.text()).toMatch(/skipped/);
    expect(all(t)).not.toMatch(/escape\.md/);
    expect(kills(t)).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
  });

  it('does not stop the team when team.json changed during the wait', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    t.hooks.onSleep = () => {
      confirm(t, 'worker-2');
      writeTeam(t.env, {
        version: 1,
        harness: 'codex',
        sessions: [...t.sessions, { name: 'worker-3', pid: 4200, session_id: null, started: 'start-new' }],
      });
    };
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(kills(t)).toEqual([]);
    expect(t.err.text()).toMatch(/team record .* changed while teardown waited, so nothing was stopped/);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
  });

  it('stops through the stop code: a pid with no start time is not signalled', async () => {
    const t = rig();
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      sessions: [
        { name: 'worker-1', pid: 4101, session_id: null },
        { name: 'worker-2', pid: 4102, session_id: null, started: 'start-1' },
      ],
    });
    confirm(t, 'worker-1');
    confirm(t, 'worker-2');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(kills(t)).toEqual([4102]);
    expect(t.err.text()).toMatch(/no start time for pid 4101/);
  });
});

describe('teardown: the handoff folder', () => {
  it('refuses a handoff folder that is a symbolic link, and stops nothing', async () => {
    const t = rig();
    const real = join(t.project, 'real-handoffs');
    writeHandoff(real, 'worker-1');
    writeHandoff(real, 'worker-2');
    mkdirSync(join(t.project, '.crew'));
    symlinkSync(real, t.handoffs);
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.err.text()).toContain(t.handoffs);
    expect(t.err.text()).toMatch(/symbolic link/);
    expect(t.runner.calls).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(true);
  });

  it('refuses a symbolic link between the crew.yml folder and the handoff folder', async () => {
    const t = rig();
    const real = join(t.project, 'real-crew');
    writeHandoff(join(real, 'handoffs'), 'worker-1');
    writeHandoff(join(real, 'handoffs'), 'worker-2');
    symlinkSync(real, join(t.project, '.crew'));
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.err.text()).toContain(join(t.project, '.crew'));
    expect(t.err.text()).toMatch(/symbolic link/);
    expect(t.runner.calls).toEqual([]);
  });

  it('refuses a handoff path that is a file', async () => {
    const t = rig();
    mkdirSync(join(t.project, '.crew'));
    writeFileSync(t.handoffs, 'a file');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.err.text()).toMatch(/not a folder/);
    expect(t.runner.calls).toEqual([]);
  });

  it('names the error code when a folder part cannot be checked', async (context) => {
    if (process.getuid?.() === 0) context.skip();
    const t = rig();
    const crew = join(t.project, '.crew');
    mkdirSync(crew);
    chmodSync(crew, 0o000);
    try {
      expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    } finally {
      chmodSync(crew, 0o700);
    }
    expect(t.err.text()).toMatch(/cannot check the handoff folder \(EACCES\)/);
    expect(t.runner.calls).toEqual([]);
  });

  it('creates a missing handoff folder one private part at a time before it writes the jobs file', async () => {
    const t = rig({ sessions: [] });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(statSync(join(t.project, '.crew')).mode & 0o777).toBe(0o700);
    expect(statSync(t.handoffs).mode & 0o777).toBe(0o700);
    expect(parse(readFileSync(join(t.handoffs, TIMED_JOBS_FILE), 'utf8'))).toEqual({ version: 1, jobs: [] });
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('treats a missing folder as no session confirmed yet', async () => {
    const t = rig();
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(t.out.text()).toMatch(/worker-1: not confirmed/);
    expect(t.out.text()).toMatch(/worker-2: not confirmed/);
    expect(existsSync(t.handoffs)).toBe(false);
  });
});

describe('teardown: timed jobs', () => {
  const JOBS_1 = ['timed_jobs:', '  - schedule: "*/10 * * * *"', '    prompt: Check the mailbox.'];
  const JOBS_2 = ['timed_jobs:', '  - schedule: every hour', '    prompt: "Read the log.\\nThen report."', '  - schedule: at 09:00', '    prompt: Send the daily note.'];

  it('writes every job from the confirmed handoffs to timed-jobs.yml, mode 0600, and prints them', async () => {
    const t = rig();
    confirm(t, 'worker-1', { extra: JOBS_1 });
    confirm(t, 'worker-2', { extra: JOBS_2 });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    const file = join(t.handoffs, TIMED_JOBS_FILE);
    expect(parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      jobs: [
        { session: 'worker-1', schedule: '*/10 * * * *', prompt: 'Check the mailbox.' },
        { session: 'worker-2', schedule: 'every hour', prompt: 'Read the log.\nThen report.' },
        { session: 'worker-2', schedule: 'at 09:00', prompt: 'Send the daily note.' },
      ],
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(t.out.text()).toMatch(/worker-1: "\*\/10 \* \* \* \*" "Check the mailbox\."/);
    expect(t.out.text()).toMatch(/worker-2: "every hour" "Read the log\.\\nThen report\."/);
  });

  it('writes an empty job list when no session has a timed job', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2');
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(parse(readFileSync(join(t.handoffs, TIMED_JOBS_FILE), 'utf8'))).toEqual({ version: 1, jobs: [] });
    expect(t.out.text()).toMatch(/No timed jobs/);
  });

  it('writes no timed-jobs.yml when the stop is blocked, so the file never holds a partial list', async () => {
    const t = rig();
    confirm(t, 'worker-1', { extra: JOBS_1 });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(existsSync(join(t.handoffs, TIMED_JOBS_FILE))).toBe(false);
  });

  it('writes timed-jobs.yml before any session is signalled', async () => {
    const t = rig();
    confirm(t, 'worker-1', { extra: JOBS_1 });
    confirm(t, 'worker-2');
    const seen: boolean[] = [];
    const kill = t.runner.kill.bind(t.runner);
    t.runner.kill = (pid, signal) => {
      seen.push(existsSync(join(t.handoffs, TIMED_JOBS_FILE)));
      return kill(pid, signal);
    };
    expect(await main(['teardown'], t.deps)).toBe(EXIT_OK);
    expect(seen).toEqual([true, true]);
  });
});

describe('teardown --dry-run', () => {
  function snapshot(t: Rig): { team: string; files: string[] } {
    return {
      team: readFileSync(teamJsonPath(t.env), 'utf8'),
      files: existsSync(t.handoffs) ? readdirSync(t.handoffs).sort() : [],
    };
  }

  it('reads once, waits for nothing, writes nothing, signals nothing, and exits 0', async () => {
    const t = rig({ sessions: ['worker-1', 'worker-2', 'worker-3'] });
    confirm(t, 'worker-1', { extra: ['timed_jobs:', '  - schedule: every hour', '    prompt: Check.'] });
    confirm(t, 'worker-3', { fields: { writing: 'true' } });
    const before = snapshot(t);
    expect(await main(['teardown', '--dry-run'], t.deps)).toBe(EXIT_OK);
    expect(t.sleeps).toEqual([]);
    expect(t.runner.calls).toEqual([]);
    expect(snapshot(t)).toEqual(before);
    expect(t.out.text()).toMatch(/worker-1: confirmed/);
    expect(t.out.text()).toMatch(/worker-2: not confirmed yet/);
    expect(t.out.text()).toMatch(/worker-3: .*write is still in progress/);
    expect(t.out.text()).toMatch(/worker-1: "every hour" "Check\."/);
    expect(t.out.text()).toMatch(/would not stop the team/);
    expect(t.out.text()).toMatch(/worker-2/);
  });

  it('says it would stop the team when every session confirmed, and still signals and writes nothing', async () => {
    const t = rig();
    confirm(t, 'worker-1', { extra: ['timed_jobs:', '  - schedule: every hour', '    prompt: Check.'] });
    confirm(t, 'worker-2');
    const before = snapshot(t);
    expect(await main(['teardown', '--dry-run'], t.deps)).toBe(EXIT_OK);
    expect(t.runner.calls).toEqual([]);
    expect(snapshot(t)).toEqual(before);
    expect(existsSync(join(t.handoffs, TIMED_JOBS_FILE))).toBe(false);
    expect(t.out.text()).toMatch(/would write 1 timed job/);
    expect(t.out.text()).toContain(join(t.handoffs, TIMED_JOBS_FILE));
    expect(t.out.text()).toMatch(/would stop the team/);
    expect(t.out.text()).not.toMatch(/would not stop/);
  });

  it('creates no handoff folder when it is missing', async () => {
    const t = rig();
    expect(await main(['teardown', '--dry-run'], t.deps)).toBe(EXIT_OK);
    expect(existsSync(t.handoffs)).toBe(false);
    expect(existsSync(join(t.project, '.crew'))).toBe(false);
    expect(t.runner.calls).toEqual([]);
  });

  it('skips the stale check, so a handoff written before the dry run still shows as confirmed', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2', { fields: { written: '2025-12-31T12:00:00Z' } });
    expect(await main(['teardown', '--dry-run'], t.deps)).toBe(EXIT_OK);
    expect(t.out.text()).toMatch(/The stale check is skipped/);
    expect(t.out.text()).toMatch(/worker-2: confirmed/);
    expect(t.out.text()).toMatch(/a real run would stop the team/);
    expect(t.runner.calls).toEqual([]);
  });

  it('says a real run would stop the team for handoffs with real file times from before the dry run', async () => {
    // The files get real change times now. The dry run starts an hour later, on a real clock.
    const t = rig({ start: Date.now() + 60 * 60 * 1000 });
    const written = new Date().toISOString();
    confirm(t, 'worker-1', { fields: { written } });
    confirm(t, 'worker-2', { fields: { written } });
    expect(await main(['teardown', '--dry-run'], t.deps)).toBe(EXIT_OK);
    expect(t.out.text()).toMatch(/worker-1: confirmed/);
    expect(t.out.text()).toMatch(/worker-2: confirmed/);
    expect(t.out.text()).toMatch(/a real run would stop the team/);
    expect(t.runner.calls).toEqual([]);
    expect(existsSync(join(t.handoffs, TIMED_JOBS_FILE))).toBe(false);
  });

  it('a real run on the same real-time files counts them as stale and stops nothing', async () => {
    const t = rig({ start: Date.now() + 60 * 60 * 1000 });
    const written = new Date().toISOString();
    confirm(t, 'worker-1', { fields: { written } });
    confirm(t, 'worker-2', { fields: { written } });
    expect(await main(['teardown'], t.deps)).toBe(EXIT_RUNTIME);
    expect(t.out.text()).toMatch(/from an earlier run/);
    expect(t.runner.calls.filter((c) => c.kind === 'kill')).toEqual([]);
  });

  it('prints the head in a dry run, so the operator can check it', async () => {
    const t = rig();
    confirm(t, 'worker-1');
    confirm(t, 'worker-2');
    expect(await main(['teardown', '--dry-run'], t.deps)).toBe(EXIT_OK);
    expect(t.out.text()).toContain(HEAD_SHA1);
  });
});

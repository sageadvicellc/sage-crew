import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CrewError } from '../src/crew/schema.ts';
import { loadHandoff, MAX_HANDOFF_BYTES, MAX_TIMED_JOBS, parseHandoff } from '../src/teardown/handoff.ts';
import { lineContaining, makeFifo, quoted } from './helpers/crew.ts';
import { makeFixtureHome } from './helpers/env.ts';
import { HANDOFF_BODY, HEAD_SHA1, HEAD_SHA256, handoffText, type HandoffParts } from './helpers/handoff.ts';

const FILE = 'worker-1.md';
const SESSION = 'worker-1';

function errorsOf(text: string): CrewError[] {
  const result = parseHandoff(text, FILE, SESSION);
  return result.ok ? [] : result.errors;
}

function textOf(parts: HandoffParts): string {
  return handoffText(SESSION, parts);
}

/** Fails unless the text is rejected with an error on this field whose reason matches. */
function expectError(text: string, field: string, reason: RegExp, line?: number): void {
  const errors = errorsOf(text);
  const match = errors.filter((e) => e.field === field && reason.test(e.reason));
  expect(match.length, `expected ${field} ${reason} in:\n${text}\ngot ${JSON.stringify(errors)}`).toBeGreaterThan(0);
  if (line !== undefined) expect(match.map((e) => e.line), JSON.stringify(match)).toContain(line);
}

function expectValid(text: string): void {
  const result = parseHandoff(text, FILE, SESSION);
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

describe('handoff: a valid file', () => {
  it('parses every field', () => {
    const text = textOf({
      fields: { written: '2026-01-02T03:04:05Z' },
      extra: [
        'timed_jobs:',
        '  - schedule: "*/10 * * * *"',
        '    prompt: Check the mailbox.',
        '  - schedule: every hour',
        `    prompt: ${quoted('Read the log.\nThen report.')}`,
      ],
    });
    expect(parseHandoff(text, FILE, SESSION)).toEqual({
      ok: true,
      handoff: {
        version: 1,
        session: 'worker-1',
        status: 'done',
        writing: false,
        push: 'pushed',
        branch: 'feat/example',
        head: HEAD_SHA1,
        timed_jobs: [
          { schedule: '*/10 * * * *', prompt: 'Check the mailbox.' },
          { schedule: 'every hour', prompt: 'Read the log.\nThen report.' },
        ],
        written: '2026-01-02T03:04:05Z',
      },
    });
  });

  it('takes nothing-to-push with a null branch and head, and no timed jobs', () => {
    const result = parseHandoff(textOf({ fields: { push: 'nothing-to-push', branch: 'null', head: 'null' } }), FILE, SESSION);
    expect(result.ok && result.handoff).toMatchObject({ push: 'nothing-to-push', branch: null, head: null, timed_jobs: [] });
  });

  it('treats a missing branch and head as null', () => {
    const result = parseHandoff(textOf({ fields: { push: 'failed', branch: null, head: null } }), FILE, SESSION);
    expect(result.ok && result.handoff).toMatchObject({ push: 'failed', branch: null, head: null });
  });

  it('accepts a 64-character head', () => {
    expectValid(textOf({ fields: { head: HEAD_SHA256 } }));
  });

  it('keeps a status other than done, which means not confirmed yet', () => {
    const result = parseHandoff(textOf({ fields: { status: 'working' } }), FILE, SESSION);
    expect(result.ok && result.handoff.status).toBe('working');
  });

  it('keeps writing: true', () => {
    const result = parseHandoff(textOf({ fields: { writing: 'true' } }), FILE, SESSION);
    expect(result.ok && result.handoff.writing).toBe(true);
  });

  it.each(['2026-01-02T03:04:05Z', '2026-01-02T03:04:05.123Z', '2026-01-02T03:04:05+02:00', '2026-01-02T03:04Z'])(
    'accepts the written time %s',
    (written) => {
      expectValid(textOf({ fields: { written } }));
    },
  );

  it(`accepts ${MAX_TIMED_JOBS} timed jobs`, () => {
    const jobs = Array.from({ length: MAX_TIMED_JOBS }, (_, i) => [`  - schedule: every ${i + 1} minutes`, '    prompt: Check.']).flat();
    expectValid(textOf({ extra: ['timed_jobs:', ...jobs] }));
  });

  it('accepts a body with text between the headings and no final newline', () => {
    expectValid(textOf({ body: '## Open items\n- a\n## Live state\n- b\n## Next step\n- c' }));
  });
});

describe('handoff: the front matter frame', () => {
  it('fails a file that does not start with a --- line', () => {
    expectError(`version: 1\n${HANDOFF_BODY}`, '(file)', /start with a --- line/, 1);
  });

  it('fails a file with no closing --- line', () => {
    expectError('---\nversion: 1\nsession: worker-1\n', '(file)', /closing --- line/, 1);
  });

  it('fails an empty file', () => {
    expectError('', '(file)', /start with a --- line/, 1);
  });

  it('fails front matter that is not a map', () => {
    expectError(`---\n- a\n- b\n---\n${HANDOFF_BODY}`, '(file)', /map/);
  });

  it('reports a YAML syntax error on the line of the whole file', () => {
    const text = `---\nversion: 1\nsession: [unclosed\n---\n${HANDOFF_BODY}`;
    const errors = errorsOf(text);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.field === '(file)' && e.file === FILE)).toBe(true);
    expect(errors.some((e) => e.line >= 3)).toBe(true);
  });

  it('fails a repeated key', () => {
    const text = textOf({ extra: ['status: done'] });
    expect(errorsOf(text).some((e) => e.field === '(file)' && e.line === lineContaining(text, 'status:', 2))).toBe(true);
  });

  it('fails an alias and does not expand it', () => {
    const text = textOf({ fields: { branch: '&b feat/example' }, extra: ['written: *b'] });
    expect(errorsOf(text).some((e) => /alias/i.test(e.reason))).toBe(true);
  });

  it('fails a tag outside the YAML core schema', () => {
    const text = textOf({ fields: { branch: '!foo feat/example' } });
    expect(errorsOf(text).some((e) => /tag/i.test(e.reason) && e.line === lineContaining(text, 'branch:'))).toBe(true);
  });

  it('fails an unknown field, at its line in the file', () => {
    const text = textOf({ extra: ['colour: blue'] });
    expectError(text, 'colour', /unknown field/, lineContaining(text, 'colour:'));
  });
});

describe('handoff: the fields', () => {
  it.each(['version', 'session', 'status', 'writing', 'push'])('%s is required', (field) => {
    expectError(textOf({ fields: { [field]: null } }), field, /required/);
  });

  it.each(['2', '"1"', 'one'])('version %s fails: it must be 1', (version) => {
    expectError(textOf({ fields: { version } }), 'version', /must be 1/);
  });

  it('session must equal the session the file is named for', () => {
    const text = textOf({ fields: { session: 'worker-2' } });
    expectError(text, 'session', /"worker-2".*"worker-1"/, lineContaining(text, 'session:'));
  });

  it.each(['""', '5', quoted('done\nnow')])('status %s fails', (status) => {
    expectError(textOf({ fields: { status } }), 'status', /non-empty|control character/);
  });

  it.each(['"true"', 'yes', '1', 'null'])('writing %s fails: it must be a boolean', (writing) => {
    expectError(textOf({ fields: { writing } }), 'writing', /boolean/);
  });

  it.each(['done', 'Pushed', '""', '1'])('push %s fails', (push) => {
    expectError(textOf({ fields: { push } }), 'push', /pushed, nothing-to-push, failed/);
  });

  it('push: pushed needs a branch', () => {
    expectError(textOf({ fields: { branch: 'null' } }), 'branch', /push: pushed needs/);
    expectError(textOf({ fields: { branch: null } }), 'branch', /push: pushed needs/);
  });

  it('push: pushed needs a head', () => {
    expectError(textOf({ fields: { head: 'null' } }), 'head', /push: pushed needs/);
    expectError(textOf({ fields: { head: null } }), 'head', /push: pushed needs/);
  });

  it.each(['""', '5', quoted('-x'), quoted('feat\u001bx'), quoted('feat\nx')])('branch %s fails', (branch) => {
    expectError(textOf({ fields: { branch } }), 'branch', /non-empty|control character|must not start/);
  });

  it.each(['abc', HEAD_SHA1.slice(1), `${HEAD_SHA1}0`, HEAD_SHA1.toUpperCase(), `g${HEAD_SHA1.slice(1)}`, '5'])(
    'head %s fails',
    (head) => {
      expectError(textOf({ fields: { head: quoted(head) } }), 'head', /40 or 64/);
    },
  );

  it.each(['yesterday', '2026-01-02', '2026-13-02T03:04:05Z', '5', '"2026-01-02 03:04:05"'])('written %s fails', (written) => {
    expectError(textOf({ fields: { written } }), 'written', /ISO 8601/);
  });
});

describe('handoff: timed_jobs', () => {
  function jobs(...lines: string[]): string {
    return textOf({ extra: ['timed_jobs:', ...lines] });
  }

  it('must be a list', () => {
    expectError(textOf({ extra: ['timed_jobs: every hour'] }), 'timed_jobs', /list/);
  });

  it('each entry must be a map', () => {
    expectError(jobs('  - every hour'), 'timed_jobs[0]', /map/);
  });

  it('fails an unknown key on an entry', () => {
    expectError(jobs('  - schedule: every hour', '    prompt: Check.', '    owner: someone'), 'timed_jobs[0].owner', /unknown field/);
  });

  it('schedule and prompt are required', () => {
    expectError(jobs('  - prompt: Check.'), 'timed_jobs[0].schedule', /required/);
    expectError(jobs('  - schedule: every hour'), 'timed_jobs[0].prompt', /required/);
  });

  it('schedule is single-line, non-empty text', () => {
    expectError(jobs(`  - schedule: ${quoted('every\nhour')}`, '    prompt: Check.'), 'timed_jobs[0].schedule', /control character/);
    expectError(jobs('  - schedule: ""', '    prompt: Check.'), 'timed_jobs[0].schedule', /non-empty/);
  });

  it('prompt is non-empty text, and may hold a newline', () => {
    expectError(jobs('  - schedule: every hour', '    prompt: ""'), 'timed_jobs[0].prompt', /non-empty/);
    expectError(jobs('  - schedule: every hour', `    prompt: ${quoted('a\u0007b')}`), 'timed_jobs[0].prompt', /control character/);
  });

  it(`fails more than ${MAX_TIMED_JOBS} entries`, () => {
    const lines = Array.from({ length: MAX_TIMED_JOBS + 1 }, () => ['  - schedule: every hour', '    prompt: Check.']).flat();
    expectError(jobs(...lines), 'timed_jobs', new RegExp(`at most ${MAX_TIMED_JOBS}`));
  });
});

describe('handoff: the body', () => {
  it.each(['## Open items', '## Live state', '## Next step'])('fails a body with no "%s" heading', (heading) => {
    const body = HANDOFF_BODY.replace(heading, '## Something else');
    expectError(textOf({ body }), '(body)', new RegExp(heading));
  });

  it('fails a body whose headings are out of order', () => {
    const body = '## Live state\n\n- a\n\n## Open items\n\n- b\n\n## Next step\n\n- c\n';
    expectError(textOf({ body }), '(body)', /in this order/);
  });

  it('fails an empty body', () => {
    expectError(textOf({ body: '' }), '(body)', /## Open items/);
  });

  it('reports front matter and body problems together', () => {
    const errors = errorsOf(textOf({ fields: { writing: 'maybe' }, body: '' }));
    expect(errors.map((e) => e.field).sort()).toEqual(['(body)', 'writing']);
  });
});

describe('loadHandoff', () => {
  function tempDir(): string {
    return mkdtempSync(join(makeFixtureHome(), 'handoffs-'));
  }

  it('reads and parses one file', () => {
    const file = join(tempDir(), 'worker-1.md');
    writeFileSync(file, handoffText(SESSION));
    const loaded = loadHandoff(file, SESSION);
    expect(loaded.state).toBe('ok');
    if (loaded.state === 'ok') expect(loaded.handoff.session).toBe(SESSION);
  });

  it('reports a missing file as missing, not as an error', () => {
    expect(loadHandoff(join(tempDir(), 'worker-1.md'), SESSION)).toEqual({ state: 'missing' });
  });

  it('reports a file in a missing folder as missing', () => {
    expect(loadHandoff(join(tempDir(), 'no-such-folder', 'worker-1.md'), SESSION)).toEqual({ state: 'missing' });
  });

  it('names the path in every parse error', () => {
    const file = join(tempDir(), 'worker-1.md');
    writeFileSync(file, handoffText(SESSION, { fields: { version: '2' } }));
    const loaded = loadHandoff(file, SESSION);
    expect(loaded.state).toBe('invalid');
    if (loaded.state === 'invalid') expect(loaded.errors.every((e) => e.file === file)).toBe(true);
  });

  it('refuses a symbolic link and does not follow it', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'real.md'), handoffText(SESSION));
    symlinkSync(join(dir, 'real.md'), join(dir, 'worker-1.md'));
    const loaded = loadHandoff(join(dir, 'worker-1.md'), SESSION);
    expect(loaded.state).toBe('invalid');
    if (loaded.state === 'invalid') expect(loaded.errors[0]?.reason).toMatch(/symbolic link/);
  });

  it('refuses a dangling symbolic link as a link, not as a missing file', () => {
    const dir = tempDir();
    symlinkSync(join(dir, 'nowhere.md'), join(dir, 'worker-1.md'));
    expect(loadHandoff(join(dir, 'worker-1.md'), SESSION).state).toBe('invalid');
  });

  it('refuses a folder as not a regular file', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'worker-1.md'));
    const loaded = loadHandoff(join(dir, 'worker-1.md'), SESSION);
    expect(loaded.state === 'invalid' && loaded.errors[0]?.reason).toMatch(/not a regular file/);
  });

  it('refuses a FIFO promptly', { timeout: 2000 }, (context) => {
    const fifo = join(tempDir(), 'worker-1.md');
    if (!makeFifo(fifo)) context.skip();
    const loaded = loadHandoff(fifo, SESSION);
    expect(loaded.state === 'invalid' && loaded.errors[0]?.reason).toMatch(/not a regular file/);
  });

  it(`passes a file of ${MAX_HANDOFF_BYTES} bytes and refuses one byte more`, () => {
    const dir = tempDir();
    const base = handoffText(SESSION);
    const pad = (bytes: number) => `${base}${'x'.repeat(bytes - base.length - 1)}\n`;
    writeFileSync(join(dir, 'worker-1.md'), pad(MAX_HANDOFF_BYTES));
    expect(loadHandoff(join(dir, 'worker-1.md'), SESSION).state).toBe('ok');
    writeFileSync(join(dir, 'worker-1.md'), pad(MAX_HANDOFF_BYTES + 1));
    const loaded = loadHandoff(join(dir, 'worker-1.md'), SESSION);
    expect(loaded.state === 'invalid' && loaded.errors[0]?.reason).toMatch(/larger than/);
  });
});

import { closeSync, mkdtempSync, openSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCrewYml, parseCrewYml, readCapped } from '../src/crew/load.ts';
import { MAX_FILE_BYTES, type CrewError } from '../src/crew/schema.ts';
import { makeFixtureHome } from './helpers/env.ts';
import {
  CREW_FILE,
  crewWithRole,
  crewYml,
  DEFAULT_ROLES,
  GIT_HTTPS,
  GIT_SCP,
  GIT_SSH,
  lineContaining,
  makeFifo,
  paddedToBytes,
  quoted,
} from './helpers/crew.ts';

function errorsOf(text: string): CrewError[] {
  const result = parseCrewYml(text, CREW_FILE);
  return result.ok ? [] : result.errors;
}

/** Fails unless the text is rejected with an error on this field whose reason matches. */
function expectError(text: string, field: string, reason: RegExp, line?: number): void {
  const errors = errorsOf(text);
  const match = errors.filter((e) => e.field === field && reason.test(e.reason));
  expect(match.length, `expected ${field} ${reason} in:\n${text}\ngot ${JSON.stringify(errors)}`).toBeGreaterThan(0);
  if (line !== undefined) expect(match.map((e) => e.line), JSON.stringify(match)).toContain(line);
}

function expectValid(text: string): void {
  const result = parseCrewYml(text, CREW_FILE);
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

describe('crew.yml: a valid file', () => {
  it('parses to a checked config', () => {
    const result = parseCrewYml(crewYml({ require: ['AGENTS.md'] }), CREW_FILE);
    expect(result).toEqual({
      ok: true,
      config: {
        version: 1,
        harness: 'claude-code',
        crew: { path: '../example-crew' },
        require: ['AGENTS.md'],
        front: 'lead',
        roles: [
          { role: 'lead', permission_mode: 'manual', restricted: false, lanes: 1 },
          { role: 'worker', permission_mode: 'manual', restricted: false, lanes: 3 },
          { role: 'reviewer', permission_mode: 'manual', restricted: false, lanes: 1 },
        ],
      },
    });
  });

  it('carries the defaults: permission_mode manual, restricted false, lanes 1', () => {
    const result = parseCrewYml(crewWithRole('role: lead'), CREW_FILE);
    expect(result.ok && result.config.roles[0]).toEqual({
      role: 'lead',
      permission_mode: 'manual',
      restricted: false,
      lanes: 1,
    });
    expect(result.ok && result.config.require).toEqual([]);
  });

  it('keeps every optional field it is given', () => {
    const text = crewYml({
      crew: [`git: ${GIT_HTTPS}`, 'ref: main'],
      front: 'lead',
      roles: [['role: lead', 'model: example-model', 'name: boss', 'permission_mode: plan', 'restricted: true']],
    });
    const result = parseCrewYml(text, CREW_FILE);
    expect(result.ok && result.config.crew).toEqual({ git: GIT_HTTPS, ref: 'main' });
    expect(result.ok && result.config.roles[0]).toEqual({
      role: 'lead',
      model: 'example-model',
      name: 'boss',
      permission_mode: 'plan',
      restricted: true,
      lanes: 1,
    });
  });

  it('does not touch the file system for a valid file', () => {
    expectValid(crewYml({ crew: ['path: /nowhere/that/exists'], require: ['no-such-file.md'] }));
  });
});

describe('crew.yml: version and harness', () => {
  it('a missing version fails at the line of the top-level map', () => {
    expectError(crewYml({ version: null }), 'version', /required/, 1);
  });

  it('a missing harness fails at the line of the top-level map', () => {
    expectError(crewYml({ harness: null }), 'harness', /required/, 1);
  });

  it.each(['2', '0', '"1"', '1.5', 'one'])('a version of %s fails: it must be 1', (version) => {
    const text = crewYml({ version });
    expectError(text, 'version', /must be 1/, lineContaining(text, 'version:'));
  });

  it('harness claude-code passes', () => {
    expectValid(crewYml({ harness: 'claude-code' }));
  });

  it.each(['codex', 'cursor'])('harness %s fails with "not built yet"', (harness) => {
    const text = crewYml({ harness });
    expectError(text, 'harness', /not built yet/, lineContaining(text, 'harness:'));
  });

  it.each(['gemini', 'auto', '""', '42'])('harness %s fails as unknown', (harness) => {
    const text = crewYml({ harness });
    expectError(text, 'harness', /unknown harness/, lineContaining(text, 'harness:'));
  });
});

describe('crew.yml: unknown fields', () => {
  it('fails at the top level', () => {
    const text = crewYml({ extra: ['colour: blue'] });
    expectError(text, 'colour', /unknown field/, lineContaining(text, 'colour:'));
  });

  it('fails under crew', () => {
    const text = crewYml({ crew: ['path: ../example-crew', 'branch: main'] });
    expectError(text, 'crew.branch', /unknown field/, lineContaining(text, 'branch:'));
  });

  it('fails on a role entry', () => {
    const text = crewWithRole('role: lead', 'colour: blue');
    expectError(text, 'roles[0].colour', /unknown field/, lineContaining(text, 'colour:'));
  });

  it('treats harness on a role entry as an unknown field', () => {
    const text = crewWithRole('role: lead', 'harness: claude-code');
    expectError(text, 'roles[0].harness', /unknown field/, lineContaining(text, 'harness: claude-code', 2));
  });
});

describe('crew.yml: crew.path and crew.git', () => {
  it('fails when both are set, at the line of the crew map', () => {
    const text = crewYml({ crew: ['path: ../example-crew', `git: ${GIT_HTTPS}`] });
    expectError(text, 'crew', /exactly one/, lineContaining(text, 'path:'));
  });

  it('fails when neither is set', () => {
    const text = crewYml({ crew: ['ref: main'] });
    expectError(text, 'crew', /exactly one/, lineContaining(text, 'ref:'));
  });

  it('fails when crew is missing', () => {
    expectError(crewYml({ crew: null }), 'crew', /required/, 1);
  });

  it('fails when crew is not a map', () => {
    expectError('version: 1\nharness: claude-code\ncrew: nope\nfront: lead\nroles:\n  - role: lead\n', 'crew', /map/, 3);
  });

  it.each([GIT_HTTPS, GIT_SSH, GIT_SCP])('crew.git accepts %s', (url) => {
    expectValid(crewYml({ crew: [`git: ${url}`] }));
  });

  it.each([
    'http://example.com/owner/my-crew.git',
    'git://example.com/owner/my-crew.git',
    'file:///tmp/my-crew',
    'ftp://example.com/my-crew.git',
    'example.com/owner/my-crew.git',
    'git@example.com',
    'https://',
    '../my-crew',
    '-o',
  ])('crew.git rejects %s', (url) => {
    const text = crewYml({ crew: [`git: ${quoted(url)}`] });
    expectError(text, 'crew.git', /https:\/\/|ssh:\/\/|git@/, lineContaining(text, 'git:'));
  });

  it('crew.git rejects a URL with a space or a control character', () => {
    for (const url of [`${GIT_HTTPS} x`, `${GIT_HTTPS}\u0007`]) {
      expectError(crewYml({ crew: [`git: ${quoted(url)}`] }), 'crew.git', /https:\/\/|ssh:\/\/|git@|control character/);
    }
  });

  it('crew.path must be a non-empty string', () => {
    for (const value of ['""', '5', '[a]']) {
      expectError(crewYml({ crew: [`path: ${value}`] }), 'crew.path', /non-empty/);
    }
  });

  it('crew.ref must be a non-empty string when set', () => {
    for (const value of ['""', '5']) {
      expectError(crewYml({ crew: [`path: ../example-crew`, `ref: ${value}`] }), 'crew.ref', /non-empty/);
    }
  });
});

describe('crew.yml: require', () => {
  it('is optional and holds non-empty strings', () => {
    expectValid(crewYml({ require: ['AGENTS.md', 'docs/notes.md'] }));
  });

  it('fails when it is not a list', () => {
    expectError(crewYml({ extra: ['require: AGENTS.md'] }), 'require', /list/);
  });

  it('fails on an empty or non-string item', () => {
    expectError(crewYml({ require: ['""'] }), 'require[0]', /non-empty/);
    expectError(crewYml({ require: ['AGENTS.md', '7'] }), 'require[1]', /non-empty/);
  });
});

describe('crew.yml: front', () => {
  it('a missing front fails', () => {
    expectError(crewYml({ front: null }), 'front', /required/, 1);
  });

  it('a front that names no entry fails', () => {
    const text = crewYml({ front: 'nobody' });
    expectError(text, 'front', /names no entry/, lineContaining(text, 'front:'));
  });

  it('a front that matches two entries is ambiguous', () => {
    const text = crewYml({ roles: [['role: lead'], ['role: lead', 'name: second']], front: 'lead' });
    expectError(text, 'front', /ambiguous/, lineContaining(text, 'front:'));
  });

  it('a front entry cannot have lanes above 1', () => {
    const text = crewYml({ roles: [['role: lead', 'lanes: 2']], front: 'lead' });
    expectError(text, 'front', /lanes/, lineContaining(text, 'front:'));
  });

  it('a front entry may set lanes to 1', () => {
    expectValid(crewYml({ roles: [['role: lead', 'lanes: 1']], front: 'lead' }));
  });

  it('a front can name a builtin entry by its builtin value', () => {
    expectValid(crewYml({ roles: [['builtin: lead', 'kickoff: Run the crew.'], ['role: worker']], front: 'lead' }));
  });

  it('a role value and a builtin value that match make the front ambiguous', () => {
    const roles = [['role: lead'], ['builtin: lead', 'kickoff: Run the crew.']];
    expectError(crewYml({ roles, front: 'lead' }), 'front', /ambiguous/);
  });

  it('a front that is not text fails', () => {
    expectError(crewYml({ front: '[lead]' }), 'front', /non-empty/);
  });
});

describe('crew.yml: role and builtin', () => {
  it('a role entry with neither fails, at the line of the entry', () => {
    const text = crewYml({ roles: [['role: lead'], ['lanes: 2']] });
    expectError(text, 'roles[1]', /exactly one of role and builtin/, lineContaining(text, 'lanes: 2'));
  });

  it('a role entry with both fails', () => {
    const text = crewYml({ roles: [['role: lead', 'builtin: lead', 'kickoff: Go.']] });
    expectError(text, 'roles[0]', /exactly one of role and builtin/);
  });

  it('a role entry that is not a map fails', () => {
    expectError(crewYml({ roles: [['lead']] }), 'roles[0]', /map/);
  });

  it('roles must be a non-empty list', () => {
    expectError(crewYml({ roles: null }), 'roles', /required/, 1);
    expectError(crewYml({ roles: null, extra: ['roles: []'] }), 'roles', /at least one/);
  });

  it.each(['lead', 'standby', 'auditor', 'reporting-chain'])('builtin %s passes', (builtin) => {
    expectValid(crewYml({ roles: [[`builtin: ${builtin}`, 'kickoff: Go.']], front: builtin }));
  });

  it.each(['worker', 'Lead', 'researcher', '""'])('builtin %s fails', (builtin) => {
    const text = crewYml({ roles: [[`builtin: ${builtin}`, 'kickoff: Go.']], front: 'lead' });
    expectError(text, 'roles[0].builtin', /lead, standby, auditor, reporting-chain/, lineContaining(text, 'builtin:'));
  });

  it('a builtin entry needs a kickoff', () => {
    const text = crewYml({ roles: [['builtin: lead']], front: 'lead' });
    expectError(text, 'roles[0].kickoff', /required/, lineContaining(text, 'builtin:'));
  });

  it.each(['""', '"   "', '5'])('a builtin entry rejects the kickoff %s', (kickoff) => {
    const text = crewYml({ roles: [['builtin: lead', `kickoff: ${kickoff}`]], front: 'lead' });
    expectError(text, 'roles[0].kickoff', /non-empty/, lineContaining(text, 'kickoff:'));
  });

  it('a role entry cannot set kickoff', () => {
    const text = crewWithRole('role: lead', 'kickoff: Go.');
    expectError(text, 'roles[0].kickoff', /builtin/, lineContaining(text, 'kickoff:'));
  });
});

describe('crew.yml: restricted, lanes, permission_mode, model', () => {
  it.each(['true', 'false'])('restricted %s passes', (value) => {
    expectValid(crewWithRole('role: lead', `restricted: ${value}`));
  });

  it.each(['"true"', 'yes', '1', 'null'])('restricted %s fails: it must be a boolean', (value) => {
    const text = crewWithRole('role: lead', `restricted: ${value}`);
    expectError(text, 'roles[0].restricted', /boolean/, lineContaining(text, 'restricted:'));
  });

  it.each([1, 5, 10])('lanes %i passes', (lanes) => {
    expectValid(crewYml({ roles: [['role: lead'], ['role: worker', `lanes: ${lanes}`]] }));
  });

  it.each(['0', '11', '1.5', '"3"', '-1', 'many'])('lanes %s fails', (lanes) => {
    const text = crewYml({ roles: [['role: lead'], ['role: worker', `lanes: ${lanes}`]] });
    expectError(text, 'roles[1].lanes', /integer from 1 to 10/, lineContaining(text, 'lanes:'));
  });

  it.each(['manual', 'acceptEdits', 'auto', 'dontAsk', 'plan'])('permission_mode %s passes', (mode) => {
    const result = parseCrewYml(crewWithRole('role: lead', `permission_mode: ${mode}`), CREW_FILE);
    expect(result.ok && result.config.roles[0]?.permission_mode).toBe(mode);
  });

  it('permission_mode bypassPermissions fails with a reason that names it', () => {
    const text = crewWithRole('role: lead', 'permission_mode: bypassPermissions');
    expectError(text, 'roles[0].permission_mode', /bypassPermissions/, lineContaining(text, 'permission_mode:'));
  });

  it.each(['yolo', 'Manual', '""', '3'])('permission_mode %s fails', (mode) => {
    const text = crewWithRole('role: lead', `permission_mode: ${mode}`);
    expectError(text, 'roles[0].permission_mode', /manual, acceptEdits, auto, dontAsk, plan/);
  });

  it('model is an optional non-empty string', () => {
    expectValid(crewWithRole('role: lead', 'model: example-model'));
    expectError(crewWithRole('role: lead', 'model: ""'), 'roles[0].model', /non-empty/);
    expectError(crewWithRole('role: lead', 'model: 5'), 'roles[0].model', /non-empty/);
  });
});

describe('crew.yml: the path-safe name rule', () => {
  const BAD_NAMES: Array<[string, string]> = [
    ['a traversal', '../../.ssh'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a dot', '.'],
    ['two dots', '..'],
    ['a leading dot', '.hidden'],
    ['a leading hyphen', '-x'],
    ['two leading hyphens', '--x'],
    ['an upper-case letter', 'Name'],
    ['a space', 'a b'],
    ['a bell character', 'a\u0007b'],
    ['a newline', 'a\nb'],
    ['a Cyrillic a alone', 'а'],
    ['a Cyrillic a inside', 'aаb'],
    ['a full-width hyphen', 'a－b'],
    ['a leading full-width hyphen', '－x'],
    ['an empty name', ''],
  ];

  it.each(BAD_NAMES)('roles[].name rejects %s', (_label, name) => {
    const text = crewWithRole('role: lead', `name: ${quoted(name)}`);
    expectError(text, 'roles[0].name', /a-z, 0-9|empty/, lineContaining(text, 'name:'));
  });

  it.each(BAD_NAMES)('roles[].role rejects %s', (_label, name) => {
    const text = crewYml({ roles: [[`role: ${quoted(name)}`]], front: quoted(name) });
    expectError(text, 'roles[0].role', /a-z, 0-9|empty/, lineContaining(text, 'role:'));
  });

  it.each(['lead', 'worker-2', '0abc', 'a', '9-9'])('accepts %s', (name) => {
    expectValid(crewYml({ roles: [[`role: ${name}`, `name: ${name}`]], front: name }));
  });

  it('a name of 40 characters passes and 41 fails, for name and for role', () => {
    const at = 'a'.repeat(40);
    const over = 'a'.repeat(41);
    expectValid(crewWithRole('role: lead', `name: ${at}`));
    expectError(crewWithRole('role: lead', `name: ${over}`), 'roles[0].name', /at most 40/);
    expectValid(crewYml({ roles: [[`role: ${at}`]], front: at }));
    expectError(crewYml({ roles: [[`role: ${over}`]], front: over }), 'roles[0].role', /at most 40/);
  });
});

describe('crew.yml: error shape', () => {
  it('every error has exactly file, line, field, and reason', () => {
    const text = crewYml({ version: '2', harness: 'codex', extra: ['colour: blue'] });
    const errors = errorsOf(text);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    for (const error of errors) {
      expect(Object.keys(error).sort()).toEqual(['field', 'file', 'line', 'reason']);
      expect(error.file).toBe(CREW_FILE);
      expect(Number.isInteger(error.line) && error.line >= 1).toBe(true);
      expect(error.field.length).toBeGreaterThan(0);
      expect(error.reason.length).toBeGreaterThan(0);
    }
  });

  it('reports one error per problem, each at its own line', () => {
    const text = crewYml({ version: '2', harness: 'codex' });
    const errors = errorsOf(text);
    expect(errors.find((e) => e.field === 'version')?.line).toBe(1);
    expect(errors.find((e) => e.field === 'harness')?.line).toBe(2);
  });

  it('a YAML syntax error reports its line and the field (file)', () => {
    const text = 'version: 1\nharness: claude-code\ncrew: [unclosed\nfront: lead\n';
    const errors = errorsOf(text);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.field === '(file)' && e.file === CREW_FILE)).toBe(true);
    expect(errors.some((e) => e.line >= 3)).toBe(true);
  });

  it('a repeated key is a YAML error on its line', () => {
    const text = crewYml({ extra: ['harness: claude-code'] });
    const errors = errorsOf(text);
    expect(errors.some((e) => e.field === '(file)' && e.line === lineContaining(text, 'harness:', 2))).toBe(true);
  });

  it.each(['', '   \n', '# only a comment\n', '- a\n- b\n', 'just text\n'])('a file that is not a map fails: %j', (text) => {
    const errors = errorsOf(text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: CREW_FILE, field: '(file)', line: 1 });
    expect(errors[0]?.reason).toMatch(/map/);
  });

  it('echoes a control character in a field name as an escape', () => {
    const text = crewYml({ extra: [`${quoted('bad\u0007key')}: 1`] });
    const errors = errorsOf(text);
    expect(errors.some((e) => e.field.includes('\\x07') && !e.field.includes('\u0007'))).toBe(true);
  });

  it('does not change the roles it is given', () => {
    const before = JSON.stringify(DEFAULT_ROLES);
    parseCrewYml(crewYml(), CREW_FILE);
    expect(JSON.stringify(DEFAULT_ROLES)).toBe(before);
  });
});

describe('loadCrewYml', () => {
  it('reads the one file and parses it', () => {
    const dir = mkdtempSync(join(makeFixtureHome(), 'crew-'));
    const file = join(dir, 'crew.yml');
    writeFileSync(file, crewYml());
    const result = loadCrewYml(file);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.front).toBe('lead');
  });

  it('names the path it was given in every error', () => {
    const dir = mkdtempSync(join(makeFixtureHome(), 'crew-'));
    const file = join(dir, 'crew.yml');
    writeFileSync(file, crewYml({ version: '3' }));
    const result = loadCrewYml(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((e) => e.file === file)).toBe(true);
    }
  });

  it('reports a file that cannot be read as one error on line 1', () => {
    const dir = mkdtempSync(join(makeFixtureHome(), 'crew-'));
    const file = join(dir, 'missing.yml');
    const result = loadCrewYml(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ file, line: 1, field: '(file)' });
      expect(result.errors[0]?.reason).toMatch(/does not exist/);
    }
  });
});

describe('crew.yml: text fields hold no control character', () => {
  const ESC = '\u001b';
  const NUL = '\u0000';
  // label, a valid base value, builds a file around a value, the field the error names
  const FIELDS: Array<[string, string, (value: string) => string, string]> = [
    ['crew.path', 'a', (v) => crewYml({ crew: [`path: ${quoted(v)}`] }), 'crew.path'],
    ['crew.ref', 'a', (v) => crewYml({ crew: ['path: ../example-crew', `ref: ${quoted(v)}`] }), 'crew.ref'],
    ['crew.git', GIT_HTTPS, (v) => crewYml({ crew: [`git: ${quoted(v)}`] }), 'crew.git'],
    ['require item', 'a', (v) => crewYml({ require: [quoted(v)] }), 'require[0]'],
    ['front', 'lead', (v) => crewYml({ front: quoted(v) }), 'front'],
    ['model', 'a', (v) => crewWithRole('role: lead', `model: ${quoted(v)}`), 'roles[0].model'],
    ['name', 'a', (v) => crewWithRole('role: lead', `name: ${quoted(v)}`), 'roles[0].name'],
    ['role', 'a', (v) => crewYml({ roles: [[`role: ${quoted(v)}`]], front: quoted(v) }), 'roles[0].role'],
    [
      'kickoff',
      'Go.',
      (v) => crewYml({ roles: [['builtin: lead', `kickoff: ${quoted(v)}`]], front: 'lead' }),
      'roles[0].kickoff',
    ],
  ];
  const CASES = FIELDS.flatMap(([label, base, build, field]) =>
    [ESC, NUL].map((c) => [label, base, c, build, field] as const),
  );

  it.each(CASES)('%s rejects a control character (%#)', (_label, base, control, build, field) => {
    expectError(build(`${base}${control}`), field, /./);
  });

  it('single-line fields reject a newline and a tab', () => {
    expectError(crewYml({ crew: [`path: ${quoted('a\nb')}`] }), 'crew.path', /control character/);
    expectError(crewYml({ crew: ['path: ../example-crew', `ref: ${quoted('a\tb')}`] }), 'crew.ref', /control character/);
    expectError(crewWithRole('role: lead', `model: ${quoted('a\nb')}`), 'roles[0].model', /control character/);
    expectError(crewYml({ require: [quoted('a\nb')] }), 'require[0]', /control character/);
  });

  it('kickoff keeps a newline and a tab', () => {
    const text = crewYml({ roles: [['builtin: lead', `kickoff: ${quoted('Go.\n\tThen wait.')}`]], front: 'lead' });
    const result = parseCrewYml(text, CREW_FILE);
    expect(result.ok && result.config.roles[0]?.kickoff).toBe('Go.\n\tThen wait.');
  });

  it.each(['-x', '--upload-pack=x', '-'])('crew.ref and model reject %j: a leading hyphen', (value) => {
    expectError(crewYml({ crew: ['path: ../example-crew', `ref: ${quoted(value)}`] }), 'crew.ref', /must not start with/);
    expectError(crewWithRole('role: lead', `model: ${quoted(value)}`), 'roles[0].model', /must not start with/);
  });

  it.each(['a-b', 'v1-2'])('crew.ref and model accept %j', (value) => {
    expectValid(crewYml({ crew: ['path: ../example-crew', `ref: ${quoted(value)}`] }));
    expectValid(crewWithRole('role: lead', `model: ${quoted(value)}`));
  });
});

describe('crew.yml: names that are not text or end in a newline', () => {
  it('role: 123 is a number and fails as "must be text"', () => {
    expectError(crewYml({ roles: [['role: 123']], front: 'lead' }), 'roles[0].role', /must be text/);
  });

  it('a name of "lead\\n" fails, for name and for role', () => {
    expectError(crewWithRole('role: lead', `name: ${quoted('lead\n')}`), 'roles[0].name', /a-z, 0-9/);
    const text = crewYml({ roles: [[`role: ${quoted('lead\n')}`]], front: quoted('lead\n') });
    expectError(text, 'roles[0].role', /a-z, 0-9/);
  });
});

describe('crew.yml: tags, warnings, and aliases', () => {
  it.each(['!foo lead', '!!js/function lead', '!!binary lead', '!!set {}'])('the tag in "role: %s" fails', (value) => {
    const text = crewWithRole(`role: ${value}`);
    const errors = errorsOf(text);
    expect(errors.some((e) => /tag/i.test(e.reason) && e.line === lineContaining(text, 'role:')), JSON.stringify(errors)).toBe(true);
  });

  it('a YAML core tag on a value still passes', () => {
    expectValid(crewYml({ roles: [['role: !!str lead'], ['role: worker', 'lanes: !!int 2']], front: 'lead' }));
  });

  it('a plain file passes with no warning', () => {
    expectValid(crewYml());
  });

  it('an alias in a role name fails and is not expanded', () => {
    const text = crewYml({ roles: [['role: &r lead'], ['role: *r']], front: 'lead' });
    const errors = errorsOf(text);
    expect(errors.some((e) => /alias/i.test(e.reason) && e.line === lineContaining(text, '*r')), JSON.stringify(errors)).toBe(true);
  });

  it('an alias as a whole role entry fails', () => {
    const text = 'version: 1\nharness: claude-code\ncrew:\n  path: ../example-crew\nfront: lead\nroles:\n  - &entry\n    role: lead\n  - *entry\n';
    const errors = errorsOf(text);
    expect(errors.some((e) => /alias/i.test(e.reason) && e.line === 9), JSON.stringify(errors)).toBe(true);
    expect(errors.some((e) => e.field === 'roles[1]')).toBe(true);
  });

  it('a << merge key is an unknown field, and its alias fails', () => {
    const text = crewYml({ roles: [['role: lead', '<<: *base']], front: 'lead', extra: ['base: &base', '  lanes: 2'] });
    expectError(text, 'roles[0].<<', /unknown field/);
    expect(errorsOf(text).some((e) => /alias/i.test(e.reason))).toBe(true);
  });

  it('an anchor on its own changes nothing', () => {
    const plain = parseCrewYml(crewYml(), CREW_FILE);
    const anchored = parseCrewYml(crewYml({ roles: [['role: &r lead'], ['role: worker', 'lanes: 3'], ['role: reviewer']] }), CREW_FILE);
    expect(anchored).toEqual(plain);
    expect(plain.ok).toBe(true);
  });
});

describe('crew.yml: several problems at once', () => {
  it('lists every independent error and drops none', () => {
    const text = crewYml({
      roles: [
        ['role: 123'],
        ['role: a', 'builtin: lead', 'kickoff: Go.'],
        ['role: worker', 'permission_mode: yolo'],
        ['role: reviewer', 'lanes: 0'],
      ],
      front: 'lead',
      extra: ['colour: blue'],
    });
    const result = parseCrewYml(text, CREW_FILE);
    expect(result.ok).toBe(false);
    const fields = (result.ok ? [] : result.errors.map((e) => e.field)).sort();
    expect(fields).toEqual(
      ['colour', 'roles[0].role', 'roles[1]', 'roles[2].permission_mode', 'roles[3].lanes'].sort(),
    );
  });

  it('does not add "names no entry" when a role entry was rejected', () => {
    const errors = errorsOf(crewYml({ roles: [['role: 123']], front: 'lead' }));
    expect(errors.map((e) => e.field)).toEqual(['roles[0].role']);
  });

  it('still reports an ambiguous front and a front with lanes above 1 next to other errors', () => {
    const ambiguous = crewYml({ roles: [['role: lead'], ['role: lead', 'name: other'], ['role: 123']], front: 'lead' });
    expectError(ambiguous, 'front', /ambiguous/);
    const lanes = crewYml({ roles: [['role: lead', 'lanes: 2'], ['role: 123']], front: 'lead' });
    expectError(lanes, 'front', /lanes/);
  });
});

describe('crew.yml: error wording', () => {
  it('escapes a newline in an unknown key, so the field is one line', () => {
    const errors = errorsOf(crewYml({ extra: [`${quoted('bad\nkey')}: 1`] }));
    const error = errors.find((e) => e.field.startsWith('bad'));
    expect(error?.field).toBe('bad\\nkey');
    expect(error?.reason).not.toMatch(/\n/);
  });

  it('a file with two YAML documents gets one plain reason', () => {
    const errors = errorsOf(`${crewYml()}---\nversion: 1\n`);
    expect(errors.some((e) => e.field === '(file)' && e.reason === 'the file must hold one YAML document')).toBe(true);
  });
});

describe('loadCrewYml: the file itself', () => {
  function tempFile(name: string, content: string): string {
    const file = join(mkdtempSync(join(makeFixtureHome(), 'crew-')), name);
    writeFileSync(file, content);
    return file;
  }

  it('passes a file of exactly the size cap', () => {
    const result = loadCrewYml(tempFile('crew.yml', paddedToBytes(crewYml(), MAX_FILE_BYTES)));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('refuses a file one byte over the cap, and says so', () => {
    const file = tempFile('crew.yml', paddedToBytes(crewYml(), MAX_FILE_BYTES + 1));
    const result = loadCrewYml(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ file, line: 1, field: '(file)' });
      expect(result.errors[0]?.reason).toMatch(/larger than/);
    }
  });

  it('refuses a directory as "not a regular file"', () => {
    const dir = mkdtempSync(join(makeFixtureHome(), 'crew-'));
    const result = loadCrewYml(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.reason).toMatch(/not a regular file/);
  });

  it('gives a human reason for a missing file, not a bare code', () => {
    const dir = mkdtempSync(join(makeFixtureHome(), 'crew-'));
    const result = loadCrewYml(join(dir, 'missing.yml'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.reason).toMatch(/does not exist/);
      expect(result.errors[0]?.reason).not.toBe('ENOENT');
    }
  });
});

describe('loadCrewYml: one open, no swap between check and read', () => {
  function tempDir(): string {
    return mkdtempSync(join(makeFixtureHome(), 'crew-'));
  }

  function reasonOf(path: string): string | undefined {
    const result = loadCrewYml(path);
    return result.ok ? undefined : result.errors[0]?.reason;
  }

  it('refuses a symbolic link to a valid file, and says so', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'real.yml'), crewYml());
    symlinkSync(join(dir, 'real.yml'), join(dir, 'crew.yml'));
    expect(reasonOf(join(dir, 'crew.yml'))).toMatch(/symbolic link/);
  });

  it('refuses a FIFO as not a regular file, and returns promptly', { timeout: 2000 }, (context) => {
    const fifo = join(tempDir(), 'crew.yml');
    if (!makeFifo(fifo)) context.skip();
    expect(reasonOf(fifo)).toMatch(/not a regular file/);
  });

  it('still refuses a directory and a missing file with their own reasons', () => {
    const dir = tempDir();
    expect(reasonOf(dir)).toMatch(/not a regular file/);
    expect(reasonOf(join(dir, 'missing.yml'))).toMatch(/does not exist/);
  });

  it('an empty file still reaches the YAML check', () => {
    const file = join(tempDir(), 'crew.yml');
    writeFileSync(file, '');
    const result = loadCrewYml(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.reason).toMatch(/map/);
  });

  describe('readCapped', () => {
    function readWith(content: string | Buffer, cap: number): ReturnType<typeof readCapped> {
      const file = join(tempDir(), 'data.txt');
      writeFileSync(file, content);
      const fd = openSync(file, 'r');
      try {
        return readCapped(fd, cap);
      } finally {
        closeSync(fd);
      }
    }

    it('returns the text of a file at exactly the cap', () => {
      expect(readWith('a'.repeat(10), 10)).toEqual({ tooLarge: false, text: 'a'.repeat(10) });
    });

    it('returns the empty text of an empty file', () => {
      expect(readWith('', 10)).toEqual({ tooLarge: false, text: '' });
    });

    it('reports a file one byte over the cap as too large', () => {
      expect(readWith('a'.repeat(11), 10)).toEqual({ tooLarge: true });
    });

    it('stops at the cap on a huge file without reading it all', () => {
      const file = join(tempDir(), 'sparse.bin');
      writeFileSync(file, '');
      truncateSync(file, 4 * 1024 * 1024 * 1024);
      const fd = openSync(file, 'r');
      try {
        expect(readCapped(fd, 1024)).toEqual({ tooLarge: true });
      } finally {
        closeSync(fd);
      }
    });

    it('decodes multi-byte text by bytes, not characters', () => {
      expect(readWith('é'.repeat(6), 10)).toEqual({ tooLarge: true });
      expect(readWith('é'.repeat(5), 10)).toEqual({ tooLarge: false, text: 'é'.repeat(5) });
    });
  });
});

describe('crew.yml: the teardown block', () => {
  function withTeardown(...lines: string[]): string {
    return crewYml({ extra: ['teardown:', ...lines.map((line) => `  ${line}`)] });
  }

  it('is optional, and a file without it has no teardown field', () => {
    const result = parseCrewYml(crewYml(), CREW_FILE);
    expect(result.ok && 'teardown' in result.config).toBe(false);
  });

  it('parses handoffs and timeout', () => {
    const result = parseCrewYml(withTeardown('handoffs: .crew/handoffs', 'timeout: 60'), CREW_FILE);
    expect(result.ok && result.config.teardown).toEqual({ handoffs: '.crew/handoffs', timeout: 60 });
  });

  it('defaults timeout to 300 seconds', () => {
    const result = parseCrewYml(withTeardown('handoffs: .crew/handoffs'), CREW_FILE);
    expect(result.ok && result.config.teardown).toEqual({ handoffs: '.crew/handoffs', timeout: 300 });
  });

  it.each([10, 3600])('timeout %i passes', (timeout) => {
    expectValid(withTeardown('handoffs: handoffs', `timeout: ${timeout}`));
  });

  it.each(['9', '3601', '0', '-5', '1.5', '"300"', 'soon', 'null'])('timeout %s fails', (timeout) => {
    const text = withTeardown('handoffs: handoffs', `timeout: ${timeout}`);
    expectError(text, 'teardown.timeout', /whole number of seconds from 10 to 3600/, lineContaining(text, 'timeout:'));
  });

  it('handoffs is required inside the block, at the line of the block', () => {
    const text = withTeardown('timeout: 60');
    expectError(text, 'teardown.handoffs', /required/, lineContaining(text, 'timeout:'));
  });

  it('fails when teardown is not a map', () => {
    const text = crewYml({ extra: ['teardown: .crew/handoffs'] });
    expectError(text, 'teardown', /map/, lineContaining(text, 'teardown:'));
  });

  it('fails an unknown field inside the block', () => {
    const text = withTeardown('handoffs: handoffs', 'force: true');
    expectError(text, 'teardown.force', /unknown field/, lineContaining(text, 'force:'));
  });

  it.each([
    ['an empty value', '""', /non-empty/],
    ['a number', '5', /non-empty/],
    ['an absolute path', '/var/handoffs', /relative/],
    ['a .. part', '../handoffs', /\.\./],
    ['a .. part inside', 'a/../../b', /\.\./],
    ['a leading hyphen', '-handoffs', /must not start with/],
    ['a control character', quoted('hand\u001boffs'), /control character/],
    ['a newline', quoted('hand\noffs'), /control character/],
  ])('handoffs fails on %s', (_label, value, reason) => {
    const text = withTeardown(`handoffs: ${value}`);
    expectError(text, 'teardown.handoffs', reason, lineContaining(text, 'handoffs:'));
  });

  it.each(['handoffs', '.crew/handoffs', 'a/b/c', 'hand..offs'])('handoffs accepts %s', (value) => {
    expectValid(withTeardown(`handoffs: ${value}`));
  });

  it('a bad teardown block fails the whole file', () => {
    const result = parseCrewYml(withTeardown('handoffs: /abs'), CREW_FILE);
    expect(result.ok).toBe(false);
  });
});

describe('crew.yml: later slices', () => {
  // Two sessions with one name fail. That check needs the session list, which slice 4 builds.
  it.skip('two sessions with one name fail', () => {
    // turns on in slice 4
  });
});

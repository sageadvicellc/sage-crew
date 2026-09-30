import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
  type Document,
  type Pair,
  type YAMLMap,
} from 'yaml';
import { hasParentPart } from '../mailbox/folder.ts';
import { hasControlCharacter, printable } from '../printable.ts';
import {
  BUILT_HARNESSES,
  BUILTIN_ROLES,
  CORE_YAML_TAGS,
  CREW_HARNESSES,
  CREW_SCHEMA_VERSION,
  DEFAULT_LANES,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TEARDOWN_TIMEOUT,
  isAcceptedGitUrl,
  isTeardownTimeout,
  LANES_MAX,
  LANES_MIN,
  MAX_FILE_BYTES,
  pathSafeNameProblem,
  PERMISSION_MODES,
  REFUSED_PERMISSION_MODE,
  TEARDOWN_TIMEOUT_MAX,
  TEARDOWN_TIMEOUT_MIN,
  type BuiltHarness,
  type BuiltinRole,
  type CrewConfig,
  type CrewError,
  type CrewParseResult,
  type CrewRole,
  type CrewSource,
  type CrewTeardown,
  type PermissionMode,
} from './schema.ts';

const TOP_KEYS = new Set(['version', 'harness', 'crew', 'require', 'front', 'roles', 'teardown']);
const CREW_KEYS = new Set(['path', 'git', 'ref']);
const ROLE_KEYS = new Set(['role', 'builtin', 'kickoff', 'name', 'model', 'permission_mode', 'restricted', 'lanes']);
const TEARDOWN_KEYS = new Set(['handoffs', 'timeout']);

/**
 * Collects errors for one file, with the line of the node each one points
 * at. `lineOffset` is the count of file lines before the parsed text, as
 * for front matter that starts after a `---` line.
 */
export class Checker {
  readonly errors: CrewError[] = [];
  readonly file: string;
  private readonly counter: LineCounter;
  private readonly lineOffset: number;

  constructor(file: string, counter: LineCounter, lineOffset = 0) {
    this.file = file;
    this.counter = counter;
    this.lineOffset = lineOffset;
  }

  /** The 1-based line a node starts on. A pair points at its key. Unknown position: line 1. */
  line(node: unknown): number {
    const target = isPair(node) ? node.key : node;
    const start = isNode(target) ? target.range?.[0] : undefined;
    return this.lineAt(start);
  }

  /** The line of a character offset. Unknown offset: line 1. */
  lineAt(offset: number | undefined): number {
    return (offset === undefined ? 1 : this.counter.linePos(offset).line) + this.lineOffset;
  }

  fail(node: unknown, field: string, reason: string): void {
    this.errors.push({ file: this.file, line: this.line(node), field, reason });
  }
}

export function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

/** The node a value sits on, so an error points at the value and not the key. */
export function valueNode(pair: Pair): unknown {
  return isScalar(pair.value) || isMap(pair.value) || isSeq(pair.value) ? pair.value : pair;
}

export function scalarOf(pair: Pair): unknown {
  return isScalar(pair.value) ? pair.value.value : undefined;
}

/** A value as it is echoed in a reason, with control characters escaped. */
export function shown(value: unknown): string {
  return JSON.stringify(printable(typeof value === 'string' ? value : String(value)));
}

export function checkUnknownKeys(c: Checker, map: YAMLMap, allowed: Set<string>, prefix: string): void {
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (key !== undefined && allowed.has(key)) continue;
    // JSON-escaped, so a newline or tab in a key cannot break the line.
    const name = JSON.stringify(printable(key ?? '?')).slice(1, -1);
    c.fail(pair, `${prefix}${name}`, `unknown field "${name}"`);
  }
}

/** The pair for a required key. A missing one is reported on the line of its parent map. */
export function requiredPair(c: Checker, map: YAMLMap, key: string, field: string): Pair | undefined {
  const pair = pairOf(map, key);
  if (!pair) c.fail(map, field, `${key} is required`);
  return pair;
}

export interface TextOptions {
  /** Allow a newline and a tab, as a prompt does. Other control characters still fail. */
  multiline?: boolean;
  /** Refuse a leading `-`, which a command could read as an option. */
  noLeadingHyphen?: boolean;
}

/** A non-empty string value, or undefined after reporting why the value is not one. */
export function nonEmptyText(c: Checker, pair: Pair, field: string, key: string, options: TextOptions = {}): string | undefined {
  return checkedText(c, valueNode(pair), scalarOf(pair), field, key, options);
}

/** The same check for a value that is not on a pair, such as a list item. `node` is where an error points. */
export function checkedText(c: Checker, node: unknown, value: unknown, field: string, key: string, options: TextOptions = {}): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    c.fail(node, field, `${key} must be a non-empty text value`);
    return undefined;
  }
  const badCharacter = options.multiline ? hasControlCharacter(value) : hasControlCharacter(value) || /[\n\t]/.test(value);
  if (badCharacter) {
    const allowed = options.multiline ? ' other than newline and tab' : ', a newline, or a tab';
    c.fail(node, field, `${key} must not hold a control character${allowed}`);
    return undefined;
  }
  if (options.noLeadingHyphen && value.trimStart().startsWith('-')) {
    c.fail(node, field, `${key} must not start with "-", which a command could read as an option`);
    return undefined;
  }
  return value;
}

/** A name that follows the path-safe name rule, or undefined after reporting why it does not. */
function pathSafeName(c: Checker, pair: Pair, field: string, key: string): string | undefined {
  const value = scalarOf(pair);
  if (typeof value !== 'string') {
    c.fail(valueNode(pair), field, `${key} must be text`);
    return undefined;
  }
  const problem = pathSafeNameProblem(value);
  if (problem === undefined) return value;
  c.fail(valueNode(pair), field, `${key} ${shown(value)} ${problem}`);
  return undefined;
}

function checkVersion(c: Checker, root: YAMLMap): void {
  const pair = requiredPair(c, root, 'version', 'version');
  if (pair && scalarOf(pair) !== CREW_SCHEMA_VERSION) {
    c.fail(valueNode(pair), 'version', `version must be ${CREW_SCHEMA_VERSION}`);
  }
}

function checkHarness(c: Checker, root: YAMLMap): BuiltHarness | undefined {
  const pair = requiredPair(c, root, 'harness', 'harness');
  if (!pair) return undefined;
  const value = scalarOf(pair);
  const built = BUILT_HARNESSES.find((id) => id === value);
  if (built) return built;
  if (CREW_HARNESSES.some((id) => id === value)) {
    c.fail(valueNode(pair), 'harness', `harness ${shown(value)} is not built yet; use ${BUILT_HARNESSES.join(', ')}`);
  } else {
    c.fail(valueNode(pair), 'harness', `unknown harness ${shown(value)}; use ${BUILT_HARNESSES.join(', ')}`);
  }
  return undefined;
}

function checkCrewSource(c: Checker, root: YAMLMap): CrewSource | undefined {
  const pair = requiredPair(c, root, 'crew', 'crew');
  if (!pair) return undefined;
  const map = pair.value;
  if (!isMap(map)) {
    c.fail(valueNode(pair), 'crew', 'crew must be a map with path or git');
    return undefined;
  }
  const before = c.errors.length;
  checkUnknownKeys(c, map, CREW_KEYS, 'crew.');
  const source: CrewSource = {};
  const pathPair = pairOf(map, 'path');
  const gitPair = pairOf(map, 'git');
  const refPair = pairOf(map, 'ref');
  if (pathPair) source.path = nonEmptyText(c, pathPair, 'crew.path', 'path');
  if (refPair) source.ref = nonEmptyText(c, refPair, 'crew.ref', 'ref', { noLeadingHyphen: true });
  if (gitPair) source.git = checkGitUrl(c, gitPair);
  if (Boolean(pathPair) === Boolean(gitPair)) {
    c.fail(map, 'crew', 'crew must set exactly one of path and git');
  }
  return c.errors.length === before ? source : undefined;
}

function checkGitUrl(c: Checker, pair: Pair): string | undefined {
  const git = nonEmptyText(c, pair, 'crew.git', 'git');
  if (git === undefined || isAcceptedGitUrl(git)) return git;
  c.fail(valueNode(pair), 'crew.git', 'git must be an https:// or ssh:// URL, or a git@host:path form');
  return undefined;
}

function checkRequire(c: Checker, root: YAMLMap): string[] {
  const pair = pairOf(root, 'require');
  if (!pair) return [];
  if (!isSeq(pair.value)) {
    c.fail(valueNode(pair), 'require', 'require must be a list of file names');
    return [];
  }
  const files: string[] = [];
  pair.value.items.forEach((item, index) => {
    const file = checkedText(c, item, isScalar(item) ? item.value : undefined, `require[${index}]`, 'require item');
    if (file !== undefined) files.push(file);
  });
  return files;
}

interface RoleDraft {
  /** Set when the entry passed every check. */
  role: CrewRole | undefined;
  /** The `role` or `builtin` value the `front` field is matched against. */
  matchValue: string | undefined;
  lanes: number;
}

function checkLanes(c: Checker, map: YAMLMap, field: string): number | undefined {
  const pair = pairOf(map, 'lanes');
  if (!pair) return DEFAULT_LANES;
  const value = scalarOf(pair);
  if (typeof value === 'number' && Number.isInteger(value) && value >= LANES_MIN && value <= LANES_MAX) return value;
  c.fail(valueNode(pair), field, `lanes must be an integer from ${LANES_MIN} to ${LANES_MAX}`);
  return undefined;
}

function checkPermissionMode(c: Checker, map: YAMLMap, field: string): PermissionMode | undefined {
  const pair = pairOf(map, 'permission_mode');
  if (!pair) return DEFAULT_PERMISSION_MODE;
  const value = scalarOf(pair);
  const mode = PERMISSION_MODES.find((known) => known === value);
  if (mode) return mode;
  const reason =
    value === REFUSED_PERMISSION_MODE
      ? `permission_mode ${REFUSED_PERMISSION_MODE} is never allowed, because the CLI never starts a session that skips permission checks`
      : `permission_mode must be one of ${PERMISSION_MODES.join(', ')}`;
  c.fail(valueNode(pair), field, reason);
  return undefined;
}

function checkRestricted(c: Checker, map: YAMLMap, field: string): boolean | undefined {
  const pair = pairOf(map, 'restricted');
  if (!pair) return false;
  const value = scalarOf(pair);
  if (typeof value === 'boolean') return value;
  c.fail(valueNode(pair), field, 'restricted must be true or false (a boolean)');
  return undefined;
}

/** Checks `role` and `builtin`: exactly one is set. Returns the module name or built-in role. */
function checkRoleKind(c: Checker, map: YAMLMap, at: string): { role?: string; builtin?: BuiltinRole; match?: string } {
  const rolePair = pairOf(map, 'role');
  const builtinPair = pairOf(map, 'builtin');
  if (Boolean(rolePair) === Boolean(builtinPair)) {
    c.fail(map, at, 'a role entry must set exactly one of role and builtin');
    return {};
  }
  if (rolePair) {
    const role = pathSafeName(c, rolePair, `${at}.role`, 'role');
    return role === undefined ? { match: nameOf(rolePair) } : { role, match: role };
  }
  if (!builtinPair) return {};
  const value = scalarOf(builtinPair);
  const builtin = BUILTIN_ROLES.find((known) => known === value);
  if (builtin) return { builtin, match: builtin };
  c.fail(valueNode(builtinPair), `${at}.builtin`, `builtin must be one of ${BUILTIN_ROLES.join(', ')}`);
  return { match: nameOf(builtinPair) };
}

function nameOf(pair: Pair): string | undefined {
  const value = scalarOf(pair);
  return typeof value === 'string' ? value : undefined;
}

/** A builtin entry needs a kickoff, and a role entry cannot set one. */
function checkKickoff(c: Checker, map: YAMLMap, at: string, kind: { role?: string; builtin?: BuiltinRole }): string | undefined {
  const pair = pairOf(map, 'kickoff');
  if (kind.role !== undefined) {
    if (pair) c.fail(pair, `${at}.kickoff`, 'kickoff belongs to a builtin entry only');
    return undefined;
  }
  if (kind.builtin === undefined) return undefined;
  if (!pair) {
    c.fail(map, `${at}.kickoff`, 'kickoff is required on a builtin entry');
    return undefined;
  }
  return nonEmptyText(c, pair, `${at}.kickoff`, 'kickoff', { multiline: true });
}

function checkRole(c: Checker, node: unknown, index: number): RoleDraft {
  const at = `roles[${index}]`;
  if (!isMap(node)) {
    c.fail(node, at, 'each role entry must be a map with role or builtin');
    return { role: undefined, matchValue: undefined, lanes: DEFAULT_LANES };
  }
  const before = c.errors.length;
  checkUnknownKeys(c, node, ROLE_KEYS, `${at}.`);
  const kind = checkRoleKind(c, node, at);
  const kickoff = checkKickoff(c, node, at, kind);
  const namePair = pairOf(node, 'name');
  const name = namePair ? pathSafeName(c, namePair, `${at}.name`, 'name') : undefined;
  const modelPair = pairOf(node, 'model');
  const model = modelPair ? nonEmptyText(c, modelPair, `${at}.model`, 'model', { noLeadingHyphen: true }) : undefined;
  const permissionMode = checkPermissionMode(c, node, `${at}.permission_mode`);
  const restricted = checkRestricted(c, node, `${at}.restricted`);
  const lanes = checkLanes(c, node, `${at}.lanes`);

  const matchValue = kind.match;
  if (c.errors.length > before || permissionMode === undefined || restricted === undefined || lanes === undefined) {
    return { role: undefined, matchValue, lanes: lanes ?? DEFAULT_LANES };
  }
  const role: CrewRole = { permission_mode: permissionMode, restricted, lanes };
  if (kind.role !== undefined) role.role = kind.role;
  if (kind.builtin !== undefined) role.builtin = kind.builtin;
  if (kickoff !== undefined) role.kickoff = kickoff;
  if (name !== undefined) role.name = name;
  if (model !== undefined) role.model = model;
  return { role, matchValue, lanes };
}

function checkRoles(c: Checker, root: YAMLMap): RoleDraft[] | undefined {
  const pair = requiredPair(c, root, 'roles', 'roles');
  if (!pair) return undefined;
  if (!isSeq(pair.value)) {
    c.fail(valueNode(pair), 'roles', 'roles must be a list of role entries');
    return undefined;
  }
  if (pair.value.items.length === 0) {
    c.fail(valueNode(pair), 'roles', 'roles must list at least one entry');
    return undefined;
  }
  return pair.value.items.map((item, index) => checkRole(c, item, index));
}

/** `front` names exactly one entry, by its `role` or `builtin` value, and that entry has one lane. */
function checkFront(c: Checker, root: YAMLMap, drafts: RoleDraft[] | undefined): string | undefined {
  const pair = requiredPair(c, root, 'front', 'front');
  if (!pair) return undefined;
  const front = nonEmptyText(c, pair, 'front', 'front');
  if (front === undefined || drafts === undefined) return front;
  const matches = drafts.filter((draft) => draft.matchValue === front);
  const [only] = matches;
  if (matches.length === 0) {
    // A rejected entry may be the one meant, so "names no entry" would mislead.
    if (drafts.every((draft) => draft.role !== undefined)) {
      c.fail(valueNode(pair), 'front', `front ${shown(front)} names no entry in roles`);
    }
  } else if (matches.length > 1) {
    c.fail(valueNode(pair), 'front', `front ${shown(front)} is ambiguous: ${matches.length} entries have that role or builtin value`);
  } else if (only && only.lanes > 1) {
    c.fail(valueNode(pair), 'front', `front ${shown(front)} names an entry with lanes above 1; the front role has one lane`);
  }
  return front;
}

/** A handoff folder path: relative, with no `..` part and no leading `-`. */
function checkHandoffs(c: Checker, map: YAMLMap): string | undefined {
  const pair = requiredPair(c, map, 'handoffs', 'teardown.handoffs');
  if (!pair) return undefined;
  const handoffs = nonEmptyText(c, pair, 'teardown.handoffs', 'handoffs', { noLeadingHyphen: true });
  if (handoffs === undefined) return undefined;
  if (isAbsolute(handoffs)) {
    c.fail(valueNode(pair), 'teardown.handoffs', 'handoffs must be a relative path, read from the folder that holds crew.yml');
    return undefined;
  }
  if (hasParentPart(handoffs)) {
    c.fail(valueNode(pair), 'teardown.handoffs', 'handoffs must not hold a .. part');
    return undefined;
  }
  return handoffs;
}

function checkTeardownTimeout(c: Checker, map: YAMLMap): number | undefined {
  const pair = pairOf(map, 'timeout');
  if (!pair) return DEFAULT_TEARDOWN_TIMEOUT;
  const value = scalarOf(pair);
  if (isTeardownTimeout(value)) return value;
  c.fail(valueNode(pair), 'teardown.timeout', `timeout must be a whole number of seconds from ${TEARDOWN_TIMEOUT_MIN} to ${TEARDOWN_TIMEOUT_MAX}`);
  return undefined;
}

/** The optional `teardown` block. Undefined when it is absent or fails a check. */
function checkTeardown(c: Checker, root: YAMLMap): CrewTeardown | undefined {
  const pair = pairOf(root, 'teardown');
  if (!pair) return undefined;
  const map = pair.value;
  if (!isMap(map)) {
    c.fail(valueNode(pair), 'teardown', 'teardown must be a map with handoffs and an optional timeout');
    return undefined;
  }
  checkUnknownKeys(c, map, TEARDOWN_KEYS, 'teardown.');
  const handoffs = checkHandoffs(c, map);
  const timeout = checkTeardownTimeout(c, map);
  return handoffs === undefined || timeout === undefined ? undefined : { handoffs, timeout };
}

interface YamlProblem {
  message: string;
  code: string;
  pos: [number, number];
}

export function yamlProblems(c: Checker, problems: readonly YamlProblem[]): void {
  for (const problem of problems) {
    const reason =
      problem.code === 'MULTIPLE_DOCS'
        ? 'the file must hold one YAML document'
        : (problem.message.split('\n')[0] ?? 'the YAML cannot be read');
    c.errors.push({ file: c.file, line: c.lineAt(problem.pos[0]), field: '(file)', reason });
  }
}

/** Fails an alias and any explicit tag outside the YAML core schema. An anchor alone is harmless. */
export function checkTagsAndAliases(c: Checker, doc: Document): void {
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      c.fail(node, '(file)', `an alias (*${node.source}) is not allowed; write the value out`);
    } else if ((isScalar(node) || isCollection(node)) && node.tag !== undefined && !CORE_YAML_TAGS.includes(node.tag)) {
      c.fail(node, '(file)', `the tag ${shown(node.tag)} is not allowed; only YAML core tags are`);
    }
  });
}

/**
 * Checks the text of a `crew.yml`. Pure: it reads no file. Every error names
 * the file, the 1-based line, the field, and the reason.
 */
export function parseCrewYml(text: string, file: string): CrewParseResult {
  const counter = new LineCounter();
  // No merge key and YAML 1.2 core rules. No alias ever expands: the checks read the
  // node tree, never `toJS`, and `checkTagsAndAliases` fails every alias node.
  // (`maxAliasCount` is a `toJS` option in this library, not a parse option.)
  const doc = parseDocument(text, {
    lineCounter: counter,
    prettyErrors: true,
    uniqueKeys: true,
    merge: false,
    version: '1.2',
  });
  const c = new Checker(file, counter);
  if (doc.errors.length > 0) {
    yamlProblems(c, doc.errors);
    return { ok: false, errors: c.errors };
  }
  yamlProblems(c, doc.warnings);
  checkTagsAndAliases(c, doc);
  const root = doc.contents;
  if (!isMap(root)) {
    c.errors.push({ file, line: 1, field: '(file)', reason: 'the file must be a map with version, harness, crew, front, and roles' });
    return { ok: false, errors: c.errors };
  }

  checkUnknownKeys(c, root, TOP_KEYS, '');
  checkVersion(c, root);
  const harness = checkHarness(c, root);
  const crew = checkCrewSource(c, root);
  const require = checkRequire(c, root);
  const drafts = checkRoles(c, root);
  const front = checkFront(c, root, drafts);
  const teardown = checkTeardown(c, root);

  const roles = drafts?.map((draft) => draft.role);
  if (c.errors.length > 0 || !harness || !crew || front === undefined || !roles || roles.some((role) => !role)) {
    return { ok: false, errors: c.errors };
  }
  const config: CrewConfig = {
    version: CREW_SCHEMA_VERSION,
    harness,
    crew,
    require,
    front,
    roles: roles.filter((role): role is CrewRole => role !== undefined),
  };
  if (teardown !== undefined) config.teardown = teardown;
  return { ok: true, config };
}

/** A human reason for a failed read or stat, with the system code kept in brackets. */
export function readProblem(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  switch (code) {
    case 'ENOENT':
      return 'the file does not exist';
    case 'EACCES':
    case 'EPERM':
      return 'the file cannot be read: permission denied';
    case 'ELOOP':
      return 'the path is a symbolic link, which is not followed';
    case 'EISDIR':
      return 'the path is not a regular file: it is a folder';
    default:
      return `the file cannot be read${code === undefined ? '' : ` (${code})`}`;
  }
}

function fileError(path: string, reason: string): CrewParseResult {
  return { ok: false, errors: [{ file: path, line: 1, field: '(file)', reason }] };
}

export type CappedRead = { tooLarge: true } | { tooLarge: false; text: string };

/**
 * Reads an open file from its current position, at most `cap + 1` bytes. More
 * than `cap` bytes means the file is too large, even when it grew after a
 * size check. Knows no path, and never holds more than `cap + 1` bytes.
 */
export function readCapped(fd: number, cap: number): CappedRead {
  const buffer = Buffer.allocUnsafe(cap + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null);
    if (count === 0) break;
    length += count;
  }
  if (length > cap) return { tooLarge: true };
  return { tooLarge: false, text: buffer.toString('utf8', 0, length) };
}

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A file read once. A failed read keeps the system code, such as `ENOENT`, when there is one. */
export type OnceRead = { text: string; ctimeMs: number } | { reason: string; code?: string };

/**
 * Opens the path once. Every check and the read use that one handle, so a
 * file swapped after the open changes nothing. No symbolic link is followed,
 * and O_NONBLOCK keeps a FIFO from hanging the open. The file must be a
 * regular file of at most `cap` bytes. The change time comes from the
 * same handle, so it belongs to the file that was read.
 */
export function readOnce(path: string, cap: number = MAX_FILE_BYTES): OnceRead {
  let fd: number | undefined;
  try {
    fd = openSync(path, OPEN_FLAGS);
    const info = fstatSync(fd);
    if (!info.isFile()) return { reason: 'the path is not a regular file' };
    const tooLarge = { reason: `the file is larger than ${cap} bytes (${cap / 1024} KiB)` };
    if (info.size > cap) return tooLarge;
    const read = readCapped(fd, cap);
    return read.tooLarge ? tooLarge : { text: read.text, ctimeMs: info.ctimeMs };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
    return code === undefined ? { reason: readProblem(error) } : { reason: readProblem(error), code };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Reads the one file at `path` and checks it. It touches no other file. The
 * file must be a regular file of at most `MAX_FILE_BYTES`.
 */
export function loadCrewYml(path: string): CrewParseResult {
  const read = readOnce(path);
  return 'text' in read ? parseCrewYml(read.text, path) : fileError(path, read.reason);
}

/** One error as a printed line: file, line, field, and reason, with control characters escaped. */
export function formatCrewError(error: CrewError): string {
  return printable(`${error.file}:${error.line}: ${error.field}: ${error.reason}`);
}

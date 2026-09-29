import { readFileSync } from 'node:fs';
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, type Node, type Pair, type YAMLMap } from 'yaml';
import { printable } from '../printable.ts';
import {
  BUILT_HARNESSES,
  BUILTIN_ROLES,
  CREW_HARNESSES,
  CREW_SCHEMA_VERSION,
  DEFAULT_LANES,
  DEFAULT_PERMISSION_MODE,
  isAcceptedGitUrl,
  LANES_MAX,
  LANES_MIN,
  pathSafeNameProblem,
  PERMISSION_MODES,
  REFUSED_PERMISSION_MODE,
  type BuiltHarness,
  type BuiltinRole,
  type CrewConfig,
  type CrewError,
  type CrewParseResult,
  type CrewRole,
  type CrewSource,
  type PermissionMode,
} from './schema.ts';

const TOP_KEYS = new Set(['version', 'harness', 'crew', 'require', 'front', 'roles']);
const CREW_KEYS = new Set(['path', 'git', 'ref']);
const ROLE_KEYS = new Set(['role', 'builtin', 'kickoff', 'name', 'model', 'permission_mode', 'restricted', 'lanes']);

type AnyNode = Node | Pair | null | undefined;

/** Collects errors for one file, with the line of the node each one points at. */
class Checker {
  readonly errors: CrewError[] = [];
  readonly file: string;
  private readonly counter: LineCounter;

  constructor(file: string, counter: LineCounter) {
    this.file = file;
    this.counter = counter;
  }

  /** The 1-based line a node starts on. A pair points at its key. Unknown position: line 1. */
  line(node: AnyNode): number {
    const target: unknown = node && 'key' in node ? node.key : node;
    const start = isNode(target) ? target.range?.[0] : undefined;
    return start === undefined ? 1 : this.counter.linePos(start).line;
  }

  fail(node: AnyNode, field: string, reason: string): void {
    this.errors.push({ file: this.file, line: this.line(node), field, reason });
  }
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

/** The node a value sits on, so an error points at the value and not the key. */
function valueNode(pair: Pair): AnyNode {
  return isScalar(pair.value) || isMap(pair.value) || isSeq(pair.value) ? pair.value : pair;
}

function scalarOf(pair: Pair): unknown {
  return isScalar(pair.value) ? pair.value.value : undefined;
}

/** A value as it is echoed in a reason, with control characters escaped. */
function shown(value: unknown): string {
  return JSON.stringify(printable(typeof value === 'string' ? value : String(value)));
}

function checkUnknownKeys(c: Checker, map: YAMLMap, allowed: Set<string>, prefix: string): void {
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (key !== undefined && allowed.has(key)) continue;
    const name = printable(key ?? '?');
    c.fail(pair, `${prefix}${name}`, `unknown field "${name}"`);
  }
}

/** The pair for a required key. A missing one is reported on the line of its parent map. */
function requiredPair(c: Checker, map: YAMLMap, key: string, field: string): Pair | undefined {
  const pair = pairOf(map, key);
  if (!pair) c.fail(map, field, `${key} is required`);
  return pair;
}

/** A non-empty string value, or undefined after reporting why the value is not one. */
function nonEmptyText(c: Checker, pair: Pair, field: string, key: string): string | undefined {
  const value = scalarOf(pair);
  if (typeof value === 'string' && value.trim() !== '') return value;
  c.fail(valueNode(pair), field, `${key} must be a non-empty text value`);
  return undefined;
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
  if (refPair) source.ref = nonEmptyText(c, refPair, 'crew.ref', 'ref');
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
    const value = isScalar(item) ? item.value : undefined;
    if (typeof value === 'string' && value.trim() !== '') files.push(value);
    else c.fail(item as Node, `require[${index}]`, 'require items must be non-empty text values');
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
  c.fail(builtinPair.value as Node, `${at}.builtin`, `builtin must be one of ${BUILTIN_ROLES.join(', ')}`);
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
  return nonEmptyText(c, pair, `${at}.kickoff`, 'kickoff');
}

function checkRole(c: Checker, node: unknown, index: number): RoleDraft {
  const at = `roles[${index}]`;
  if (!isMap(node)) {
    c.fail(node as Node, at, 'each role entry must be a map with role or builtin');
    return { role: undefined, matchValue: undefined, lanes: DEFAULT_LANES };
  }
  const before = c.errors.length;
  checkUnknownKeys(c, node, ROLE_KEYS, `${at}.`);
  const kind = checkRoleKind(c, node, at);
  const kickoff = checkKickoff(c, node, at, kind);
  const namePair = pairOf(node, 'name');
  const name = namePair ? pathSafeName(c, namePair, `${at}.name`, 'name') : undefined;
  const modelPair = pairOf(node, 'model');
  const model = modelPair ? nonEmptyText(c, modelPair, `${at}.model`, 'model') : undefined;
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
  if (matches.length === 0) {
    c.fail(valueNode(pair), 'front', `front ${shown(front)} names no entry in roles`);
  } else if (matches.length > 1) {
    c.fail(valueNode(pair), 'front', `front ${shown(front)} is ambiguous: ${matches.length} entries have that role or builtin value`);
  } else if ((matches[0] as RoleDraft).lanes > 1) {
    c.fail(valueNode(pair), 'front', `front ${shown(front)} names an entry with lanes above 1; the front role has one lane`);
  }
  return front;
}

function yamlErrors(c: Checker, errors: readonly { message: string; linePos?: [{ line: number }, ...unknown[]] }[]): void {
  for (const error of errors) {
    const reason = error.message.split('\n')[0] ?? 'the YAML cannot be read';
    c.errors.push({ file: c.file, line: error.linePos?.[0].line ?? 1, field: '(file)', reason });
  }
}

/**
 * Checks the text of a `crew.yml`. Pure: it reads no file. Every error names
 * the file, the 1-based line, the field, and the reason.
 */
export function parseCrewYml(text: string, file: string): CrewParseResult {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: true, uniqueKeys: true });
  const c = new Checker(file, counter);
  if (doc.errors.length > 0) {
    yamlErrors(c, doc.errors);
    return { ok: false, errors: c.errors };
  }
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
  return { ok: true, config };
}

/** Reads the one file at `path` and checks it. It touches no other file. */
export function loadCrewYml(path: string): CrewParseResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
    return { ok: false, errors: [{ file: path, line: 1, field: '(file)', reason: `cannot read the file (${code})` }] };
  }
  return parseCrewYml(text, path);
}

import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type Pair, type YAMLMap } from 'yaml';
import {
  CLAUDE_AUTOCOMPACT_MAX,
  CLAUDE_AUTOCOMPACT_MIN,
  CLAUDE_EFFORTS,
  CLOCK_PATTERN,
  EFFORT_PATTERN,
  HARNESS_IDS,
  isHarnessId,
  kickoffLooksLikeOption,
  MODEL_PATTERN,
  NAME_PATTERN,
  OPERATOR,
  parseAutocompact,
  ROLES,
  SCHEMA_VERSION,
  TRANSPORTS,
  UNBUILT_TRANSPORTS,
  type HarnessId,
  type HarnessSetting,
  type Role,
  type RolesConfig,
  type Session,
  type TaskProfile,
  type TransportSetting,
} from './schema.ts';
import { hasParentPart } from '../mailbox/folder.ts';
import { hasControlCharacter, printable } from '../printable.ts';

export interface RolesError {
  /** The 1-based line in the roles file. */
  line: number;
  message: string;
}

export type ValidateResult = { ok: true; config: RolesConfig } | { ok: false; errors: RolesError[] };

export interface ValidateOptions {
  /** The chosen harness. Its bounds apply. Unset: the file's own harness, when named. */
  harness?: HarnessId;
}

const TOP_KEYS = new Set(['version', 'harness', 'transport', 'mailbox', 'operator', 'task_profiles', 'sessions']);
const SESSION_KEYS = new Set([
  'name',
  'role',
  'reports_to',
  'workers',
  'clock',
  'kickoff',
  'autocompact',
  'model',
  'effort',
]);

type AnyNode = Node | Pair | null | undefined;

class Checker {
  readonly errors: RolesError[] = [];
  private readonly counter: LineCounter;
  constructor(counter: LineCounter) {
    this.counter = counter;
  }

  line(node: AnyNode, fallback = 1): number {
    const range = node && 'range' in node ? node.range : undefined;
    if (!range) return fallback;
    return this.counter.linePos(range[0]).line;
  }

  fail(node: AnyNode, message: string, fallback = 1): void {
    this.errors.push({ line: this.line(node, fallback), message });
  }
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function keyNode(pair: Pair | undefined): Node | undefined {
  return pair && isScalar(pair.key) ? pair.key : undefined;
}

function valueNode(pair: Pair | undefined): Node | undefined {
  const value = pair?.value;
  return value && typeof value === 'object' && 'range' in value ? (value as Node) : undefined;
}

function scalarString(pair: Pair | undefined): string | undefined {
  const value = pair?.value;
  if (!isScalar(value)) return undefined;
  return typeof value.value === 'string' ? value.value : undefined;
}

function checkUnknownKeys(c: Checker, map: YAMLMap, allowed: Set<string>, where: string): void {
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (key === undefined || !allowed.has(key)) {
      c.fail(keyNode(pair) ?? (pair.key as Node), `unknown field "${key ?? '?'}" in ${where}`);
    }
  }
}

function checkOptionalString(c: Checker, map: YAMLMap, key: string, fallback: number): string | undefined {
  const pair = pairOf(map, key);
  if (!pair) return undefined;
  const value = scalarString(pair);
  if (value === undefined || value.trim() === '') {
    c.fail(keyNode(pair), `${key} must be a non-empty text value`, fallback);
    return undefined;
  }
  if (hasControlCharacter(value)) {
    c.fail(keyNode(pair), `${key} must not hold a control character`, fallback);
    return undefined;
  }
  return value;
}

function checkEffort(c: Checker, node: AnyNode, effort: string, where: string, harness: HarnessId | undefined): boolean {
  if (harness === 'claude-code' && !(CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
    c.fail(node, `${where}: effort on Claude Code must be one of ${CLAUDE_EFFORTS.join(', ')}, not "${effort}"`);
    return false;
  }
  if (!EFFORT_PATTERN.test(effort)) {
    c.fail(node, `${where}: effort must start with a letter or digit and use only letters, digits, _ and -`);
    return false;
  }
  return true;
}

function checkModel(c: Checker, node: AnyNode, model: string, where: string): boolean {
  if (MODEL_PATTERN.test(model)) return true;
  c.fail(node, `${where}: model must start with a letter or digit, use only letters, digits, and . _ : / @ [ ] -, and be at most 128 characters`);
  return false;
}

function checkTaskProfiles(c: Checker, map: YAMLMap, harness: HarnessId | undefined): Record<string, TaskProfile> {
  // No prototype, so a profile name can never reach Object.prototype.
  const profiles = Object.create(null) as Record<string, TaskProfile>;
  const pair = pairOf(map, 'task_profiles');
  if (!pair || pair.value === null) return profiles;
  if (!isMap(pair.value)) {
    c.fail(keyNode(pair), 'task_profiles must be a map from a profile name to its model and effort');
    return profiles;
  }
  for (const entry of pair.value.items) {
    const name = isScalar(entry.key) ? String(entry.key.value) : '';
    const at = keyNode(entry);
    if (!NAME_PATTERN.test(name) || name in Object.prototype) {
      c.fail(at, `task profile name "${name}" must use lowercase letters, digits, and hyphens, start with a letter, and not be a reserved name`);
      continue;
    }
    if (!isMap(entry.value)) {
      c.fail(at, `task profile "${name}" must set model, effort, or both`);
      continue;
    }
    checkUnknownKeys(c, entry.value, new Set(['model', 'effort']), `task profile "${name}"`);
    const model = checkOptionalString(c, entry.value, 'model', c.line(at));
    const effort = checkOptionalString(c, entry.value, 'effort', c.line(at));
    if (model === undefined && effort === undefined) {
      c.fail(at, `task profile "${name}" must set model, effort, or both`);
      continue;
    }
    if (effort !== undefined) checkEffort(c, at, effort, `task profile "${name}"`, harness);
    if (model !== undefined) checkModel(c, at, model, `task profile "${name}"`);
    profiles[name] = { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
  }
  return profiles;
}

interface SessionDraft {
  session: Session;
  node: YAMLMap;
  pairs: Record<string, Pair | undefined>;
  valid: boolean;
}

function checkSession(c: Checker, node: unknown, harness: HarnessId | undefined): SessionDraft | undefined {
  if (!isMap(node)) {
    c.fail(node as Node, 'each session must be a map with name, role, reports_to, and kickoff');
    return undefined;
  }
  checkUnknownKeys(c, node, SESSION_KEYS, 'a session');
  const pairs: SessionDraft['pairs'] = {};
  for (const key of SESSION_KEYS) pairs[key] = pairOf(node, key);
  const at = c.line(node);
  let valid = true;

  const name = scalarString(pairs.name);
  if (name === undefined) {
    c.fail(keyNode(pairs.name), 'a session needs a name', at);
    valid = false;
  } else if (!NAME_PATTERN.test(name)) {
    c.fail(valueNode(pairs.name), `session name "${name}" must use lowercase letters, digits, and hyphens, and start with a letter`, at);
    valid = false;
  }
  const label = `session "${name ?? '?'}"`;

  const role = scalarString(pairs.role);
  if (role === undefined || !(ROLES as readonly string[]).includes(role)) {
    const message =
      role === undefined
        ? `${label}: role must be one of ${ROLES.join(', ')}`
        : `${label}: role ${JSON.stringify(printable(role))} is not a role in this build. Use one of ${ROLES.join(', ')}`;
    c.fail(valueNode(pairs.role) ?? keyNode(pairs.role), message, at);
    valid = false;
  }

  const reportsTo = scalarString(pairs.reports_to);
  if (reportsTo === undefined) {
    c.fail(keyNode(pairs.reports_to), `${label}: reports_to must name a session or ${OPERATOR}`, at);
    valid = false;
  } else if (hasControlCharacter(reportsTo)) {
    c.fail(keyNode(pairs.reports_to), `${label}: reports_to must not hold a control character`, at);
    valid = false;
  }

  const kickoff = scalarString(pairs.kickoff);
  if (kickoff === undefined || kickoff.trim() === '') {
    c.fail(keyNode(pairs.kickoff), `${label}: kickoff must be a non-empty message`, at);
    valid = false;
  } else if (hasControlCharacter(kickoff)) {
    c.fail(keyNode(pairs.kickoff), `${label}: kickoff must not hold a control character other than newline and tab`, at);
    valid = false;
  } else if (kickoffLooksLikeOption(kickoff)) {
    c.fail(keyNode(pairs.kickoff), `${label}: kickoff must not start with "-", which a harness could read as an option`, at);
    valid = false;
  }

  let workers: string[] | undefined;
  if (pairs.workers) {
    if (role !== 'lead') {
      c.fail(keyNode(pairs.workers), `${label}: workers belongs to a lead only`);
      valid = false;
    } else if (!isSeq(pairs.workers.value) || !pairs.workers.value.items.every((i) => isScalar(i) && typeof i.value === 'string')) {
      c.fail(keyNode(pairs.workers), `${label}: workers must be a list of session names`);
      valid = false;
    } else {
      workers = pairs.workers.value.items.map((i) => String((i as { value: unknown }).value));
    }
  }

  let clock: string | undefined;
  if (pairs.clock) {
    const value = scalarString(pairs.clock);
    if (role !== 'auditor') {
      c.fail(keyNode(pairs.clock), `${label}: clock belongs to an auditor only`);
      valid = false;
    } else if (value === undefined || !CLOCK_PATTERN.test(value)) {
      c.fail(keyNode(pairs.clock), `${label}: clock must be an interval such as 30m`);
      valid = false;
    } else {
      clock = value;
    }
  }

  let autocompact: string | undefined;
  if (pairs.autocompact) {
    const raw = isScalar(pairs.autocompact.value) ? pairs.autocompact.value.value : undefined;
    const parsed = parseAutocompact(raw);
    if (!parsed.ok) {
      c.fail(keyNode(pairs.autocompact), `${label}: autocompact must be auto or a token count such as 400k`);
      valid = false;
    } else {
      autocompact = parsed.text;
      if (
        harness === 'claude-code' &&
        parsed.tokens !== 'auto' &&
        (parsed.tokens < CLAUDE_AUTOCOMPACT_MIN || parsed.tokens > CLAUDE_AUTOCOMPACT_MAX)
      ) {
        c.fail(keyNode(pairs.autocompact), `${label}: autocompact on Claude Code must be auto or 100k to 1M, not ${parsed.text}`);
        valid = false;
      }
    }
  }

  const model = checkOptionalString(c, node, 'model', at);
  const effort = checkOptionalString(c, node, 'effort', at);
  if (effort !== undefined && !checkEffort(c, keyNode(pairs.effort), effort, label, harness)) valid = false;
  if (model !== undefined && !checkModel(c, keyNode(pairs.model), model, label)) valid = false;

  // An invalid session still joins the team checks under its name, so one
  // mistake does not cascade into errors about the sessions that name it.
  if (name === undefined) return undefined;
  const session: Session = { name, role: role as Role, reports_to: reportsTo ?? '', kickoff: kickoff ?? '' };
  if (workers) session.workers = workers;
  if (clock) session.clock = clock;
  if (autocompact) session.autocompact = autocompact;
  if (model) session.model = model;
  if (effort) session.effort = effort;
  return { session, node, pairs, valid };
}

function checkTeam(c: Checker, drafts: SessionDraft[], sessionsKey: AnyNode): void {
  const seen = new Map<string, SessionDraft>();
  for (const draft of drafts) {
    if (seen.has(draft.session.name)) {
      c.fail(valueNode(draft.pairs.name), `session name "${draft.session.name}" repeats`);
    } else {
      seen.set(draft.session.name, draft);
    }
  }

  for (const draft of drafts) {
    const target = draft.session.reports_to;
    if (target === '') continue;
    if (target === draft.session.name) {
      c.fail(valueNode(draft.pairs.reports_to), `session "${target}" reports_to itself`);
    } else if (target !== OPERATOR && !seen.has(target)) {
      c.fail(valueNode(draft.pairs.reports_to), `session "${draft.session.name}": reports_to "${target}" names no session and is not ${OPERATOR}`);
    }
  }

  const chains = drafts.filter((d) => d.session.role === 'reporting-chain');
  if (chains.length === 0) {
    c.fail(sessionsKey, 'the team needs exactly one reporting-chain session, and has none');
  }
  for (const extra of chains.slice(1)) {
    c.fail(valueNode(extra.pairs.role), `the team needs exactly one reporting-chain session; "${extra.session.name}" is a second`);
  }

  const owners = new Map<string, string[]>();
  for (const lead of drafts.filter((d) => d.session.role === 'lead')) {
    for (const worker of lead.session.workers ?? []) {
      const target = seen.get(worker);
      if (!target) {
        c.fail(keyNode(lead.pairs.workers), `lead "${lead.session.name}": worker "${worker}" names no session`);
      } else if (target.session.role !== 'standby') {
        c.fail(keyNode(lead.pairs.workers), `lead "${lead.session.name}": worker "${worker}" is not a standby session`);
      } else {
        owners.set(worker, [...(owners.get(worker) ?? []), lead.session.name]);
      }
    }
  }
  for (const draft of drafts.filter((d) => d.session.role === 'standby')) {
    const leads = owners.get(draft.session.name) ?? [];
    if (leads.length !== 1) {
      const count = leads.length === 0 ? 'no lead' : `${leads.length} leads (${leads.join(', ')})`;
      c.fail(valueNode(draft.pairs.name), `worker "${draft.session.name}" must be owned by exactly one lead, and has ${count}`);
    }
  }
}

/** Validates a roles file's text. Every error carries the line it points at. */
export function validateRoles(text: string, options: ValidateOptions): ValidateResult {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: true, uniqueKeys: true });
  const c = new Checker(counter);
  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      c.errors.push({ line: error.linePos?.[0].line ?? 1, message: `YAML: ${error.message.split('\n')[0]}` });
    }
    return { ok: false, errors: c.errors };
  }
  const root = doc.contents;
  if (!isMap(root)) {
    return { ok: false, errors: [{ line: 1, message: 'the roles file must be a map with version and sessions' }] };
  }
  checkUnknownKeys(c, root, TOP_KEYS, 'the roles file');

  const versionPair = pairOf(root, 'version');
  const version = isScalar(versionPair?.value) ? versionPair.value.value : undefined;
  if (version !== SCHEMA_VERSION) {
    c.fail(keyNode(versionPair), `version must be ${SCHEMA_VERSION}`);
  }

  let harness: HarnessSetting = 'auto';
  const harnessPair = pairOf(root, 'harness');
  if (harnessPair) {
    const value = scalarString(harnessPair);
    if (value === undefined || (value !== 'auto' && !isHarnessId(value))) {
      c.fail(keyNode(harnessPair), `harness must be auto or one of ${HARNESS_IDS.join(', ')}`);
    } else {
      harness = value;
    }
  }
  const bounds = options.harness ?? (harness === 'auto' ? undefined : harness);

  let transport: TransportSetting = 'auto';
  const transportPair = pairOf(root, 'transport');
  if (transportPair) {
    const value = scalarString(transportPair);
    if (value !== undefined && (UNBUILT_TRANSPORTS as readonly string[]).includes(value)) {
      c.fail(keyNode(transportPair), `transport ${value} is not in this build; use file-mailbox or auto`);
    } else if (value === undefined || !(TRANSPORTS as readonly string[]).includes(value)) {
      c.fail(keyNode(transportPair), `transport must be one of ${TRANSPORTS.join(', ')}`);
    } else {
      transport = value as TransportSetting;
    }
  }

  let mailbox = checkOptionalString(c, root, 'mailbox', 1);
  if (mailbox !== undefined && hasParentPart(mailbox)) {
    const pair = pairOf(root, 'mailbox');
    if (pair) c.fail(keyNode(pair), `mailbox ${JSON.stringify(mailbox)} must not hold a .. part. Name the folder with no .. in it`, 1);
    mailbox = undefined;
  }
  const operator = checkOptionalString(c, root, 'operator', 1);
  const taskProfiles = checkTaskProfiles(c, root, bounds);

  const sessionsPair = pairOf(root, 'sessions');
  const drafts: SessionDraft[] = [];
  if (!sessionsPair || !isSeq(sessionsPair.value) || sessionsPair.value.items.length === 0) {
    c.fail(keyNode(sessionsPair), 'sessions must list at least one session');
  } else {
    for (const item of sessionsPair.value.items) {
      const draft = checkSession(c, item, bounds);
      if (draft) drafts.push(draft);
    }
    checkTeam(c, drafts, keyNode(sessionsPair));
  }

  if (c.errors.length > 0) {
    c.errors.sort((a, b) => a.line - b.line);
    return { ok: false, errors: c.errors };
  }
  const config: RolesConfig = {
    version: SCHEMA_VERSION,
    harness,
    transport,
    task_profiles: taskProfiles,
    sessions: drafts.map((d) => d.session),
  };
  if (mailbox !== undefined) config.mailbox = mailbox;
  if (operator !== undefined) config.operator = operator;
  return { ok: true, config };
}

/** Prints each error as `file:line: message`, followed by that line of the file. */
export function formatRolesErrors(errors: readonly RolesError[], text: string, file: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const error of errors) {
    // A message or line can quote a control character from the file, so each is escaped.
    out.push(printable(`${file}:${error.line}: ${error.message}`));
    const source = lines[error.line - 1];
    if (source !== undefined) out.push(printable(`  ${String(error.line).padStart(4)} | ${source}`));
  }
  return out;
}

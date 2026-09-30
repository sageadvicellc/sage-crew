import { isMap, isScalar, isSeq, LineCounter, parseDocument, type YAMLMap } from 'yaml';
import {
  Checker,
  checkTagsAndAliases,
  checkUnknownKeys,
  nonEmptyText,
  pairOf,
  readOnce,
  requiredPair,
  scalarOf,
  shown,
  valueNode,
  yamlProblems,
} from '../crew/load.ts';
import type { CrewError } from '../crew/schema.ts';

/** The handoff format version this build reads. */
export const HANDOFF_VERSION = 1;

/** The largest handoff file the loader reads: 64 KiB. */
export const MAX_HANDOFF_BYTES = 64 * 1024;

/** The most timed jobs one handoff may list. */
export const MAX_TIMED_JOBS = 20;

/** The status that confirms a session is done. Any other status means not yet. */
export const DONE_STATUS = 'done';

/** What a session did with its branch. */
export const PUSH_OUTCOMES = ['pushed', 'nothing-to-push', 'failed'] as const;
export type PushOutcome = (typeof PUSH_OUTCOMES)[number];

/** The body headings a handoff must hold, in this order. */
export const HANDOFF_HEADINGS = ['## Open items', '## Live state', '## Next step'] as const;

const HANDOFF_KEYS = new Set(['version', 'session', 'status', 'writing', 'push', 'branch', 'head', 'timed_jobs', 'written']);
const JOB_KEYS = new Set(['schedule', 'prompt']);

/** A commit id: 40 hex characters for SHA-1, or 64 for SHA-256, in lower case as git prints them. */
const HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** An ISO 8601 date and time with a zone: `Z` or an offset such as `+02:00`. */
const WRITTEN_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** One job that lives only inside a session, so the start sequence can create it again. */
export interface TimedJob {
  schedule: string;
  prompt: string;
}

/** A checked handoff file's front matter. */
export interface Handoff {
  version: typeof HANDOFF_VERSION;
  session: string;
  status: string;
  /** True while the session still has a write in progress. It blocks the stop. */
  writing: boolean;
  push: PushOutcome;
  branch: string | null;
  head: string | null;
  timed_jobs: TimedJob[];
  /** When the session wrote the file, in ISO 8601 with a zone. */
  written: string;
}

export type HandoffParseResult = { ok: true; handoff: Handoff } | { ok: false; errors: CrewError[] };

/**
 * A handoff as the loader found it. A missing file is a session that has
 * not confirmed yet. A stale file is valid but was written before this
 * teardown started, so it is from an earlier run and confirms nothing.
 */
export type HandoffLoad =
  | { state: 'missing' }
  | { state: 'invalid'; errors: CrewError[] }
  | { state: 'stale'; handoff: Handoff; notBefore: string }
  | { state: 'ok'; handoff: Handoff };

export interface LoadHandoffOptions {
  /**
   * The time this teardown started, in milliseconds. A handoff written
   * before the start of that second is stale. The whole second counts,
   * because a session often writes the time to the second only.
   */
  notBefore?: number;
  /** The parser. Tests pass a stand-in. */
  parse?: typeof parseHandoff;
}

function checkVersion(c: Checker, root: YAMLMap): void {
  const pair = requiredPair(c, root, 'version', 'version');
  if (pair && scalarOf(pair) !== HANDOFF_VERSION) c.fail(valueNode(pair), 'version', `version must be ${HANDOFF_VERSION}`);
}

function checkSession(c: Checker, root: YAMLMap, expected: string): string | undefined {
  const pair = requiredPair(c, root, 'session', 'session');
  if (!pair) return undefined;
  const session = nonEmptyText(c, pair, 'session', 'session');
  if (session === undefined || session === expected) return session;
  c.fail(valueNode(pair), 'session', `session ${shown(session)} does not match the file name, which names session ${shown(expected)}`);
  return undefined;
}

function checkWriting(c: Checker, root: YAMLMap): boolean | undefined {
  const pair = requiredPair(c, root, 'writing', 'writing');
  if (!pair) return undefined;
  const value = scalarOf(pair);
  if (typeof value === 'boolean') return value;
  c.fail(valueNode(pair), 'writing', 'writing must be true or false (a boolean)');
  return undefined;
}

function checkPush(c: Checker, root: YAMLMap): PushOutcome | undefined {
  const pair = requiredPair(c, root, 'push', 'push');
  if (!pair) return undefined;
  const value = scalarOf(pair);
  const push = PUSH_OUTCOMES.find((known) => known === value);
  if (push) return push;
  c.fail(valueNode(pair), 'push', `push must be one of ${PUSH_OUTCOMES.join(', ')}`);
  return undefined;
}

/** An optional field that is text or null. A missing field is null. */
function textOrNull(c: Checker, root: YAMLMap, key: 'branch' | 'head'): string | null | undefined {
  const pair = pairOf(root, key);
  if (!pair || (isScalar(pair.value) && pair.value.value === null)) return null;
  const text = nonEmptyText(c, pair, key, key, { noLeadingHyphen: true });
  if (text === undefined || key !== 'head' || HEAD_PATTERN.test(text)) return text;
  c.fail(valueNode(pair), 'head', 'head must be a commit id of 40 or 64 lowercase hex characters, or null');
  return undefined;
}

/** `push: pushed` names what was pushed, so a start script can check it. */
function checkPushed(c: Checker, root: YAMLMap, push: PushOutcome | undefined, branch: string | null | undefined, head: string | null | undefined): void {
  if (push !== 'pushed') return;
  if (branch === null) c.fail(pairOf(root, 'branch') ?? root, 'branch', 'push: pushed needs the branch that was pushed');
  if (head === null) c.fail(pairOf(root, 'head') ?? root, 'head', 'push: pushed needs the head commit that was pushed');
}

function checkJob(c: Checker, node: unknown, index: number): TimedJob | undefined {
  const at = `timed_jobs[${index}]`;
  if (!isMap(node)) {
    c.fail(node, at, 'each timed job must be a map with schedule and prompt');
    return undefined;
  }
  const before = c.errors.length;
  checkUnknownKeys(c, node, JOB_KEYS, `${at}.`);
  const schedulePair = requiredPair(c, node, 'schedule', `${at}.schedule`);
  const promptPair = requiredPair(c, node, 'prompt', `${at}.prompt`);
  const schedule = schedulePair ? nonEmptyText(c, schedulePair, `${at}.schedule`, 'schedule') : undefined;
  const prompt = promptPair ? nonEmptyText(c, promptPair, `${at}.prompt`, 'prompt', { multiline: true }) : undefined;
  if (c.errors.length > before || schedule === undefined || prompt === undefined) return undefined;
  return { schedule, prompt };
}

function checkTimedJobs(c: Checker, root: YAMLMap): TimedJob[] {
  const pair = pairOf(root, 'timed_jobs');
  if (!pair) return [];
  if (!isSeq(pair.value)) {
    c.fail(valueNode(pair), 'timed_jobs', 'timed_jobs must be a list of maps with schedule and prompt');
    return [];
  }
  if (pair.value.items.length > MAX_TIMED_JOBS) {
    c.fail(valueNode(pair), 'timed_jobs', `timed_jobs must list at most ${MAX_TIMED_JOBS} entries`);
    return [];
  }
  return pair.value.items.map((item, index) => checkJob(c, item, index)).filter((job): job is TimedJob => job !== undefined);
}

function checkWritten(c: Checker, root: YAMLMap): string | undefined {
  const pair = requiredPair(c, root, 'written', 'written');
  if (!pair) return undefined;
  const value = scalarOf(pair);
  if (typeof value === 'string' && WRITTEN_PATTERN.test(value) && !Number.isNaN(Date.parse(value))) return value;
  c.fail(valueNode(pair), 'written', 'written must be an ISO 8601 date and time with a zone, such as 2026-01-02T03:04:05Z');
  return undefined;
}

/** Checks that the body holds the three headings, each on its own line, in order. */
function checkBody(c: Checker, lines: readonly string[], firstLine: number): void {
  const body = lines.map((line) => line.trimEnd());
  let cursor = 0;
  for (const heading of HANDOFF_HEADINGS) {
    const found = body.indexOf(heading, cursor);
    if (found >= 0) {
      cursor = found + 1;
      continue;
    }
    const reason = body.includes(heading)
      ? `the body must hold the headings ${HANDOFF_HEADINGS.map((h) => `"${h}"`).join(', ')} in this order`
      : `the body must hold the heading "${heading}"`;
    c.errors.push({ file: c.file, line: firstLine, field: '(body)', reason });
    return;
  }
}

/** Splits the text at its `---` lines, or returns the error that says why the frame is wrong. */
function splitFrontMatter(text: string, file: string): { yaml: string; body: string[]; bodyLine: number } | CrewError {
  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    return { file, line: 1, field: '(file)', reason: 'the file must start with a --- line, then the front matter' };
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (close < 0) return { file, line: 1, field: '(file)', reason: 'the front matter has no closing --- line' };
  return { yaml: lines.slice(1, close).join('\n'), body: lines.slice(close + 1), bodyLine: close + 2 };
}

/**
 * Checks the text of one handoff file. Pure: it reads no file. The file is
 * YAML front matter between `---` lines, then a Markdown body with the three
 * headings. `expectedSession` is the session the file is named for. Every
 * error names the file, the 1-based line, the field, and the reason.
 */
export function parseHandoff(text: string, file: string, expectedSession: string): HandoffParseResult {
  const frame = splitFrontMatter(text, file);
  if ('reason' in frame) return { ok: false, errors: [frame] };
  const counter = new LineCounter();
  // The same rules as crew.yml: no merge key, YAML 1.2 core, and every alias fails.
  const doc = parseDocument(frame.yaml, {
    lineCounter: counter,
    prettyErrors: true,
    uniqueKeys: true,
    merge: false,
    version: '1.2',
  });
  // The front matter starts on line 2, after the opening --- line.
  const c = new Checker(file, counter, 1);
  if (doc.errors.length > 0) {
    yamlProblems(c, doc.errors);
    return { ok: false, errors: c.errors };
  }
  yamlProblems(c, doc.warnings);
  checkTagsAndAliases(c, doc);
  const root = doc.contents;
  if (!isMap(root)) {
    c.errors.push({ file, line: 2, field: '(file)', reason: 'the front matter must be a map with version, session, status, writing, and push' });
    return { ok: false, errors: c.errors };
  }
  checkUnknownKeys(c, root, HANDOFF_KEYS, '');
  checkVersion(c, root);
  const session = checkSession(c, root, expectedSession);
  const statusPair = requiredPair(c, root, 'status', 'status');
  const status = statusPair ? nonEmptyText(c, statusPair, 'status', 'status') : undefined;
  const writing = checkWriting(c, root);
  const push = checkPush(c, root);
  const branch = textOrNull(c, root, 'branch');
  const head = textOrNull(c, root, 'head');
  checkPushed(c, root, push, branch, head);
  const timedJobs = checkTimedJobs(c, root);
  const written = checkWritten(c, root);
  checkBody(c, frame.body, frame.bodyLine);

  if (
    c.errors.length > 0 ||
    session === undefined ||
    status === undefined ||
    writing === undefined ||
    push === undefined ||
    branch === undefined ||
    head === undefined ||
    written === undefined
  ) {
    return { ok: false, errors: c.errors };
  }
  return { ok: true, handoff: { version: HANDOFF_VERSION, session, status, writing, push, branch, head, timed_jobs: timedJobs, written } };
}

/** The start of the second that holds `ms`, so a time written to the second still counts. */
function startOfSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/**
 * Reads one handoff file and checks it, with the same safety as crew.yml:
 * one open, no symbolic link followed, a regular file of at most 64 KiB.
 * A missing file, or a file in a missing folder, is `missing`. With
 * `notBefore`, a file written before the second of that time is `stale`.
 * A throw from the parser makes the file `invalid`, never a crash.
 */
export function loadHandoff(path: string, expectedSession: string, options: LoadHandoffOptions = {}): HandoffLoad {
  const read = readOnce(path, MAX_HANDOFF_BYTES);
  if (!('text' in read)) {
    if (read.code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', errors: [{ file: path, line: 1, field: '(file)', reason: read.reason }] };
  }
  let parsed: HandoffParseResult;
  try {
    parsed = (options.parse ?? parseHandoff)(read.text, path, expectedSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: 'invalid', errors: [{ file: path, line: 1, field: '(file)', reason: `the file cannot be checked: ${message}` }] };
  }
  if (!parsed.ok) return { state: 'invalid', errors: parsed.errors };
  const { notBefore } = options;
  if (notBefore !== undefined && Date.parse(parsed.handoff.written) < startOfSecond(notBefore)) {
    return { state: 'stale', handoff: parsed.handoff, notBefore: new Date(startOfSecond(notBefore)).toISOString() };
  }
  return { state: 'ok', handoff: parsed.handoff };
}

/** True when a handoff confirms the session is done and holds no write in progress. */
export function isSettled(handoff: Handoff): boolean {
  return handoff.status === DONE_STATUS && !handoff.writing;
}


import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { envFromProcess } from '../env.ts';
import { printable } from '../printable.ts';
import { createRunner, type Runner, type RunResult } from '../runner.ts';
import {
  parseAllowlist,
  parseDenyList,
  scanPath,
  scanText,
  type AllowEntry,
  type DenyList,
  type Finding,
} from './checks.ts';

export const DENYLIST_VAR = 'SANITIZE_DENYLIST';
export const REQUIRE_VAR = 'SANITIZE_REQUIRE_DENYLIST';
export const RANGE_VAR = 'SANITIZE_RANGE';
/** The committed allowlist of reviewed false positives, at the repository root. */
export const ALLOWLIST_FILE = '.sanitize-allow';

export type UnsetPolicy = 'fail' | 'warn';

/**
 * What an unset SANITIZE_DENYLIST does when SANITIZE_REQUIRE_DENYLIST is not
 * 1. A local run warns and still runs the other three checks, as the plan's
 * decision 15 settled. CI and prepublishOnly set SANITIZE_REQUIRE_DENYLIST=1,
 * so there an unset deny-list fails. Changing this one value to 'fail' makes
 * every run fail.
 */
export const UNSET_DENYLIST_POLICY: UnsetPolicy = 'warn';

export interface SanitizeOptions {
  cwd: string;
  runner: Runner;
  vars: Readonly<Record<string, string | undefined>>;
  /** The commit range whose messages are scanned, such as `base..head`. */
  range?: string;
  out: (line: string) => void;
  err: (line: string) => void;
  unsetPolicy?: UnsetPolicy;
}

interface Git {
  (args: readonly string[]): Promise<{ ok: boolean; stdout: string }>;
}

function makeGit(runner: Runner, cwd: string, vars: SanitizeOptions['vars']): Git {
  return async (args) => {
    const result = await runner.run('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: vars });
    return { ok: result.code === 0, stdout: result.stdout };
  };
}

/** The commit fields scanned as identities, in `git log` format order. */
const IDENTITY_FIELDS = ['author name', 'author email', 'committer name', 'committer email'] as const;

/** A full SHA-1 or SHA-256 commit id. Nothing else reaches git as a commit. */
const COMMIT_ID = /^[0-9a-f]{40,64}$/;

interface StagedFile {
  path: string;
  lines: string[];
  lineNumbers: number[];
}

/**
 * Reads the added lines of a `git diff --unified=0` into files with real
 * line numbers. Each `@@` header gives the hunk's old and new line counts,
 * so a line inside a hunk is always content, even one that reads like
 * `+++ /dev/null`. A `+++` line counts as a file header only between hunks.
 */
export function parseStagedDiff(diff: string): StagedFile[] {
  const files: StagedFile[] = [];
  let current: StagedFile | undefined;
  let next = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+') && newLeft > 0) {
        current?.lines.push(line.slice(1));
        current?.lineNumbers.push(next);
        next += 1;
        newLeft -= 1;
      } else if (line.startsWith('-') && oldLeft > 0) {
        oldLeft -= 1;
      } else if (line.startsWith(' ')) {
        next += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      // A `\ No newline at end of file` line counts toward neither side.
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      current = target === '/dev/null' ? undefined : { path: target.replace(/^b\//, ''), lines: [], lineNumbers: [] };
      if (current) files.push(current);
      continue;
    }
    if (line.startsWith('diff ')) {
      current = undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      next = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return files.filter((file) => file.lines.length > 0);
}

/** Marks a file or blob the sanitizer cannot read or decode. It fails the run. */
export const CANNOT_READ = Symbol('cannot read');

/**
 * Decodes a file's bytes as text. UTF-8 is the default. A UTF-16 file,
 * with a byte-order mark or with a zero byte in every other place, is
 * decoded as UTF-16, because its zero bytes would otherwise mark it as
 * binary and skip it. Any other file with a zero byte is binary, and
 * returns undefined. A file that looks like UTF-16 but has an odd number
 * of bytes cannot be decoded whole, so it returns CANNOT_READ.
 */
export function decodeText(buffer: Buffer): string | undefined | typeof CANNOT_READ {
  const bom = buffer[0] === 0xff && buffer[1] === 0xfe ? 'le' : buffer[0] === 0xfe && buffer[1] === 0xff ? 'be' : undefined;
  const sample = buffer.subarray(0, 8000);
  if (bom === undefined && !sample.includes(0)) return buffer.toString('utf8');
  const order = bom ?? utf16Order(sample.subarray(0, sample.length - (sample.length % 2)));
  if (order === undefined) return undefined;
  if (buffer.length % 2 !== 0) return CANNOT_READ;
  const body = Buffer.from(buffer.subarray(bom === undefined ? 0 : 2));
  return (order === 'be' ? body.swap16() : body).toString('utf16le');
}

/**
 * Names UTF-16 text with no byte-order mark, or returns undefined for a
 * binary. Mostly-ASCII UTF-16 has zero bytes in all odd places (LE) or
 * all even places (BE). Other UTF-16, such as CJK text, has fewer zero
 * bytes, so the parity with more zero bytes picks the byte order, and the
 * sample must then decode as valid text.
 */
function utf16Order(sample: Buffer): 'le' | 'be' | undefined {
  if (sample.length < 2) return undefined;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      if (i % 2 === 0) evenZeros += 1;
      else oddZeros += 1;
    }
  }
  const pairs = sample.length / 2;
  if (evenZeros === 0 && oddZeros >= pairs * 0.9) return 'le';
  if (oddZeros === 0 && evenZeros >= pairs * 0.9) return 'be';
  if (oddZeros === evenZeros) return undefined;
  const order = oddZeros > evenZeros ? 'le' : 'be';
  return validUtf16(order === 'le' ? sample : Buffer.from(sample).swap16()) ? order : undefined;
}

/**
 * True when little-endian UTF-16 code units form valid text: no NUL, no C0
 * control except tab, newline, form feed, and carriage return, no C1
 * control, no U+FFFE or U+FFFF, and every surrogate in a valid pair. A
 * high surrogate may end the sample, because the sample can cut a pair.
 */
function validUtf16(units: Buffer): boolean {
  for (let i = 0; i + 1 < units.length; i += 2) {
    const unit = units.readUInt16LE(i);
    if (unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0c && unit !== 0x0d) return false;
    if ((unit >= 0x7f && unit <= 0x9f) || unit === 0xfffe || unit === 0xffff) return false;
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 3 >= units.length) return true;
      const next = units.readUInt16LE(i + 2);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 2;
    }
  }
  return true;
}

/**
 * Reads one tracked path as text: a symlink's target, or a file's content.
 * Returns undefined for a binary file or a submodule folder, which hold no
 * text to scan, and CANNOT_READ when the path is missing or unreadable.
 */
function readTracked(abs: string): string | undefined | typeof CANNOT_READ {
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return readlinkSync(abs);
    if (!stat.isFile()) return undefined;
    return decodeText(readFileSync(abs));
  } catch {
    return CANNOT_READ;
  }
}

/** How much of a blob is read first, to tell text from binary. It matches the sample that decodeText checks. */
const SAMPLE_BYTES = 8000;

/** The most of a command's error text that a failure line quotes. */
const STDERR_LIMIT = 200;

/** A command's error text on one line, escaped, and cut to STDERR_LIMIT characters. */
function errorText(text: string): string {
  const line = printable(text.trim().replace(/\s*\n\s*/g, ' '));
  return line.length > STDERR_LIMIT ? `${line.slice(0, STDERR_LIMIT)}...` : line;
}

/** Why a `git cat-file` run failed, or undefined when it read the blob. */
function catFileFailure(result: RunResult): string | undefined {
  if (result.truncated === true) return undefined;
  if (result.error !== undefined) return `git cat-file could not run: ${errorText(result.error)}`;
  if (result.code === 0 && result.bytes !== undefined) return undefined;
  const exit = result.timedOut ? 'timed out' : result.code === null ? 'ended with no exit code' : `exit code ${result.code}`;
  const detail = errorText(result.stderr);
  return `git cat-file failed: ${exit}${detail === '' ? '' : `: ${detail}`}`;
}

type BlobRead = { ok: true; text: string | undefined } | { ok: false; reason: string };

function decoded(bytes: Buffer): BlobRead {
  const text = decodeText(bytes);
  return text === CANNOT_READ ? { ok: false, reason: 'it looks like UTF-16 but has an odd number of bytes' } : { ok: true, text };
}

/**
 * Reads one git blob through the runner, such as `:path` for the index or
 * `<sha>:path`, and decodes it. The first SAMPLE_BYTES bytes are read
 * first. A blob that they show to be binary is skipped and never read
 * whole, so a large binary cannot fail the run. Returns the text, or
 * undefined for a binary. A failure returns the reason.
 */
async function readBlob(runner: Runner, root: string, vars: SanitizeOptions['vars'], spec: string): Promise<BlobRead> {
  const args = ['cat-file', 'blob', '--end-of-options', spec];
  const head = await runner.run('git', args, { cwd: root, env: vars, bytes: true, maxBytes: SAMPLE_BYTES });
  const headFailure = catFileFailure(head);
  if (headFailure !== undefined || head.bytes === undefined) return { ok: false, reason: headFailure ?? 'git cat-file returned no output' };
  if (head.truncated !== true) return decoded(head.bytes);
  if (decodeText(head.bytes) === undefined) return { ok: true, text: undefined };
  const whole = await runner.run('git', args, { cwd: root, env: vars, bytes: true });
  const wholeFailure = catFileFailure(whole);
  if (wholeFailure !== undefined || whole.bytes === undefined) return { ok: false, reason: wholeFailure ?? 'git cat-file returned no output' };
  return decoded(whole.bytes);
}

/** The paths that `git ... --numstat -z` lists as binary, shown as `-\t-\t<path>`. */
function binaryPaths(numstat: string): string[] {
  return numstat
    .split('\0')
    .filter((entry) => entry.startsWith('-\t-\t'))
    .map((entry) => entry.slice(4));
}

interface DenyLoad {
  list: DenyList | undefined;
  /** The deny-list's repo-relative path when it sits inside the repository. */
  selfPath: string | undefined;
}

function loadDenyList(opts: SanitizeOptions, root: string, failures: string[]): DenyLoad {
  const named = opts.vars[DENYLIST_VAR];
  if (named === undefined || named === '') {
    const policy = opts.vars[REQUIRE_VAR] === '1' ? 'fail' : (opts.unsetPolicy ?? UNSET_DENYLIST_POLICY);
    const message = `${DENYLIST_VAR} is unset, so the deny-list check cannot run. Point ${DENYLIST_VAR} at your deny-list file.`;
    if (policy === 'fail') failures.push(message);
    else opts.err(`sanitize: warning: ${message} The other three checks still run.`);
    return { list: undefined, selfPath: undefined };
  }
  const path = isAbsolute(named) ? named : resolve(opts.cwd, named);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    failures.push(`cannot read the deny-list file that ${DENYLIST_VAR} names`);
    return { list: undefined, selfPath: undefined };
  }
  const parsed = parseDenyList(text);
  failures.push(...parsed.errors);
  if (parsed.list.terms.length === 0) failures.push(`the deny-list file that ${DENYLIST_VAR} names holds no terms`);
  let selfPath: string | undefined;
  const real = realpathSync(path);
  if (real.startsWith(root + sep)) selfPath = relative(root, real).split(sep).join('/');
  return { list: parsed.list, selfPath };
}

function loadAllowlist(root: string, failures: string[]): AllowEntry[] {
  const path = join(root, ALLOWLIST_FILE);
  if (!existsSync(path)) return [];
  const parsed = parseAllowlist(readFileSync(path, 'utf8'));
  failures.push(...parsed.errors.map((e) => `${ALLOWLIST_FILE}: ${e}`));
  return parsed.entries;
}

async function resolveRange(opts: SanitizeOptions, git: Git): Promise<string | undefined> {
  const asked = opts.range ?? opts.vars[RANGE_VAR];
  const usable = asked !== undefined && asked !== '' && !/^0+\.\./.test(asked) && !/\.\.$/.test(asked);
  if (usable) {
    if (asked.startsWith('-')) {
      opts.err(`sanitize: warning: ignoring a range that starts with "-"`);
    } else if ((await git(['rev-list', '--max-count=1', '--end-of-options', asked, '--'])).ok) {
      return asked;
    } else {
      opts.err(`sanitize: warning: cannot read the commit range ${asked}, so the default range is used`);
    }
  }
  if ((await git(['rev-parse', '--verify', '--quiet', '--end-of-options', 'origin/main'])).ok) return 'origin/main..HEAD';
  return undefined;
}

function print(findings: Finding[], err: (line: string) => void): void {
  for (const f of findings) {
    const at = f.line > 0 ? `${f.where}:${f.line}` : f.where;
    err(`sanitize: ${f.cls}: ${at}: ${f.detail}`);
  }
}

/** Runs every check on tracked files, the staged diff, and each commit's message, author, committer, and added lines. Returns the exit code. */
export async function runSanitize(opts: SanitizeOptions): Promise<number> {
  const top = await opts.runner.run('git', ['rev-parse', '--show-toplevel'], { cwd: opts.cwd, env: opts.vars });
  if (top.code !== 0) {
    opts.err('sanitize: not inside a git repository');
    return 1;
  }
  const root = realpathSync(top.stdout.trim());
  const git = makeGit(opts.runner, root, opts.vars);
  const failures: string[] = [];
  const findings: Finding[] = [];

  const deny = loadDenyList(opts, root, failures);
  const allow = loadAllowlist(root, failures);

  const listed = await git(['ls-files', '-z']);
  if (!listed.ok) failures.push('cannot list tracked files');
  const tracked = listed.stdout.split('\0').filter((p) => p !== '' && p !== deny.selfPath);
  for (const path of tracked) {
    findings.push(...scanPath(path, { ...(deny.list ? { deny: deny.list } : {}), allow }));
    const text = readTracked(join(root, path));
    if (text === CANNOT_READ) {
      // A file the scan cannot read is a failure, never a silent pass.
      failures.push(`cannot read ${path}`);
      continue;
    }
    if (text === undefined) continue;
    findings.push(...scanText(text, { where: path, path, ...(deny.list ? { deny: deny.list } : {}), allow }));
  }

  const diff = await git(['diff', '--cached', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames']);
  if (!diff.ok) failures.push('cannot read the staged diff');
  const staged = parseStagedDiff(diff.stdout).filter((file) => file.path !== deny.selfPath);
  for (const file of staged) {
    findings.push(
      ...scanText(file.lines.join('\n'), {
        where: `${file.path} (staged)`,
        path: file.path,
        lineNumbers: file.lineNumbers,
        ...(deny.list ? { deny: deny.list } : {}),
        allow,
      }),
    );
  }

  // A file git calls binary shows no lines in a diff. Each one is read from
  // git and decoded, so UTF-16 text is scanned too. A real binary is skipped.
  const scanBinaries = async (list: readonly string[], specFor: (path: string) => string, label: string): Promise<void> => {
    const listed = await git(list);
    if (!listed.ok) {
      failures.push(`cannot list the binary files in ${label}`);
      return;
    }
    for (const path of binaryPaths(listed.stdout)) {
      if (path === deny.selfPath) continue;
      const where = `${path} (${label})`;
      const blob = await readBlob(opts.runner, root, opts.vars, specFor(path));
      if (!blob.ok) failures.push(`cannot read ${where}: ${blob.reason}`);
      else if (blob.text !== undefined) findings.push(...scanText(blob.text, { where, path, ...(deny.list ? { deny: deny.list } : {}), allow }));
    }
  };
  const BINARY_LIST = ['--numstat', '-z', '--no-renames', '--diff-filter=ACMRT'];
  await scanBinaries(['diff', '--cached', ...BINARY_LIST], (path) => `:${path}`, 'staged');

  // Each commit in the range is read by its own id. No git output is split
  // on a byte that commit content can hold, and only a checked hex id ever
  // reaches git as an argument, after --end-of-options.
  const range = await resolveRange(opts, git);
  let messages = 0;
  let commitsScanned = 0;
  if (range === undefined) {
    opts.out('sanitize: no commit range and no origin/main, so no commit messages were scanned');
  } else {
    const ids = await git(['log', '-z', '--format=%H', '--end-of-options', range, '--']);
    if (!ids.ok) failures.push(`cannot list the commits in ${range}`);
    const shas = ids.stdout.split('\0').map((id) => id.replace(/^\n/, '')).filter((id) => id !== '');
    if (!shas.every((sha) => COMMIT_ID.test(sha))) {
      failures.push(`the commit list for ${range} holds a value that is not a commit id, so no commit was scanned`);
      shas.length = 0;
    }
    for (const sha of shas) {
      const short = sha.slice(0, 7);
      // The author and committer names and emails, then the message, split
      // on NUL. None of the four fields can hold a NUL.
      const commit = await git(['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', '--end-of-options', sha, '--']);
      const fields = commit.stdout.split('\0');
      if (!commit.ok || fields.length < IDENTITY_FIELDS.length + 1) {
        failures.push(`cannot read the message and authors of commit ${short}`);
      } else {
        IDENTITY_FIELDS.forEach((field, index) => {
          const found = scanText(fields[index] as string, {
            where: `commit ${short} ${field}`,
            identity: true,
            ...(deny.list ? { deny: deny.list } : {}),
          });
          // A field is one value, so a finding names the field and no line.
          findings.push(...found.map((finding) => ({ ...finding, line: 0 })));
        });
        messages += 1;
        findings.push(
          ...scanText(fields.slice(IDENTITY_FIELDS.length).join('\0').trimEnd(), {
            where: `commit ${short} message`,
            ...(deny.list ? { deny: deny.list } : {}),
          }),
        );
      }

      // The added lines. A leak added in one commit and removed in a later
      // one stays in history, so the tree scan misses it.
      const patch = await git(['diff-tree', '-r', '-p', '--no-commit-id', '--root', '--diff-merges=first-parent', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', '--end-of-options', sha]);
      if (!patch.ok) failures.push(`cannot read the added lines of commit ${short}`);
      commitsScanned += 1;
      const files = parseStagedDiff(patch.stdout).filter((file) => file.path !== deny.selfPath);
      for (const file of files) {
        findings.push(
          ...scanText(file.lines.join('\n'), {
            where: `${file.path} (commit ${short})`,
            path: file.path,
            lineNumbers: file.lineNumbers,
            ...(deny.list ? { deny: deny.list } : {}),
            allow,
          }),
        );
      }
      await scanBinaries(
        ['diff-tree', '-r', '--no-commit-id', '--root', '--diff-merges=first-parent', ...BINARY_LIST, '--end-of-options', sha],
        (path) => `${sha}:${path}`,
        `commit ${short}`,
      );
    }
  }

  print(findings, opts.err);
  for (const failure of failures) opts.err(`sanitize: ${failure}`);
  if (findings.length > 0 || failures.length > 0) {
    opts.err(`sanitize: failed. ${findings.length} finding(s), ${failures.length} setup error(s).`);
    return 1;
  }
  opts.out(
    `sanitize: clean. ${tracked.length} tracked files, ${staged.length} staged files, ${messages} commit messages and authors, and the added lines of ${commitsScanned} commits${range ? ` in ${range}` : ''}.`,
  );
  return 0;
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  let range: string | undefined;
  try {
    const { values } = parseArgs({ options: { range: { type: 'string' } }, strict: true });
    range = values.range;
  } catch (error) {
    process.stderr.write(`sanitize: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const env = envFromProcess();
  process.exitCode = await runSanitize({
    cwd: env.cwd,
    runner: createRunner(),
    vars: env.vars,
    ...(range === undefined ? {} : { range }),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { envFromProcess } from '../env.ts';
import { createRunner, type Runner } from '../runner.ts';
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

/** Names UTF-16 text with no byte-order mark: zero bytes in all odd places (LE) or all even places (BE). */
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
  return undefined;
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

/** Reads one git blob as raw bytes, such as `:path` for the index or `<sha>:path`. Undefined when git cannot read it. */
function gitBlob(root: string, vars: SanitizeOptions['vars'], spec: string): Buffer | undefined {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value;
  const result = spawnSync('git', ['cat-file', 'blob', spec], { cwd: root, env, maxBuffer: 512 * 1024 * 1024 });
  return result.error || result.status !== 0 ? undefined : result.stdout;
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
    } else if ((await git(['rev-list', '--max-count=1', asked, '--'])).ok) {
      return asked;
    } else {
      opts.err(`sanitize: warning: cannot read the commit range ${asked}, so the default range is used`);
    }
  }
  if ((await git(['rev-parse', '--verify', '--quiet', 'origin/main'])).ok) return 'origin/main..HEAD';
  return undefined;
}

function print(findings: Finding[], err: (line: string) => void): void {
  for (const f of findings) {
    const at = f.line > 0 ? `${f.where}:${f.line}` : f.where;
    err(`sanitize: ${f.cls}: ${at}: ${f.detail}`);
  }
}

/** Runs every check on tracked files, the staged diff, and commit messages. Returns the exit code. */
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
      const blob = gitBlob(root, opts.vars, specFor(path));
      const text = blob === undefined ? CANNOT_READ : decodeText(blob);
      if (text === CANNOT_READ) failures.push(`cannot read ${where}`);
      else if (text !== undefined) findings.push(...scanText(text, { where, path, ...(deny.list ? { deny: deny.list } : {}), allow }));
    }
  };
  const BINARY_LIST = ['--numstat', '-z', '--no-renames', '--diff-filter=ACMRT'];
  await scanBinaries(['diff', '--cached', ...BINARY_LIST], (path) => `:${path}`, 'staged');

  const range = await resolveRange(opts, git);
  let messages = 0;
  if (range === undefined) {
    opts.out('sanitize: no commit range and no origin/main, so no commit messages were scanned');
  } else {
    const log = await git(['log', '--format=%H%x1f%B%x1e', range, '--']);
    if (!log.ok) failures.push(`cannot read the commit messages in ${range}`);
    for (const record of log.stdout.split('\x1e')) {
      const [sha, body] = record.replace(/^\n/, '').split('\x1f');
      if (!sha || body === undefined) continue;
      messages += 1;
      findings.push(
        ...scanText(body.trimEnd(), {
          where: `commit ${sha.slice(0, 7)} message`,
          ...(deny.list ? { deny: deny.list } : {}),
        }),
      );
    }
  }

  // The added lines of each commit in the range. A leak added in one commit
  // and removed in a later one stays in history, so the tree scan misses it.
  let commitsScanned = 0;
  if (range !== undefined) {
    const history = await git(['log', '-p', '--diff-merges=first-parent', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', '--format=%x1e%H', range, '--']);
    if (!history.ok) failures.push(`cannot read the added lines of the commits in ${range}`);
    for (const record of history.stdout.split('\x1e')) {
      const newline = record.indexOf('\n');
      const sha = (newline === -1 ? record : record.slice(0, newline)).trim();
      if (sha === '') continue;
      commitsScanned += 1;
      const files = parseStagedDiff(newline === -1 ? '' : record.slice(newline + 1)).filter((file) => file.path !== deny.selfPath);
      for (const file of files) {
        findings.push(
          ...scanText(file.lines.join('\n'), {
            where: `${file.path} (commit ${sha.slice(0, 7)})`,
            path: file.path,
            lineNumbers: file.lineNumbers,
            ...(deny.list ? { deny: deny.list } : {}),
            allow,
          }),
        );
      }
      await scanBinaries(
        ['diff-tree', '-r', '--no-commit-id', '--root', '--diff-merges=first-parent', ...BINARY_LIST, sha],
        (path) => `${sha}:${path}`,
        `commit ${sha.slice(0, 7)}`,
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
    `sanitize: clean. ${tracked.length} tracked files, ${staged.length} staged files, ${messages} commit messages and the added lines of ${commitsScanned} commits${range ? ` in ${range}` : ''}.`,
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

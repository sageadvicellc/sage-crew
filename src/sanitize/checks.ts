/**
 * The sanitizer's five check classes. Every pattern here is written so that
 * this file's own text does not match it.
 */

export type FindingClass = 'secret' | 'deny-list' | 'private-path' | 'ticket-link' | 'session-link';

export interface Finding {
  cls: FindingClass;
  /** A file path, a staged file, or a commit message. */
  where: string;
  /** The 1-based line within `where`, or 0 for the path itself. */
  line: number;
  /** What was found. Never the leaked text itself. */
  detail: string;
}

/** The only repository this project may link tickets to. */
export const OWN_REPO = 'sageadvicellc/trellis-crew';

export interface DenyTerm {
  /** The 1-based line of the term in the deny-list file. */
  entry: number;
  /** The term, lowercased. Used to match allowances. */
  key: string;
  pattern: RegExp;
}

export interface Allowance {
  path: string;
  key: string;
}

export interface DenyList {
  terms: DenyTerm[];
  /** `allow <path> <term>` lines: one term cleared in one file. */
  allowances: Allowance[];
  /** `allow @author <term>` lines: the lowercased terms cleared in commit author and committer fields only. */
  authorAllowances: string[];
}

/** The word in `allow @author <term>`. It is a keyword, never a file path. */
export const AUTHOR_ALLOW = '@author';

/** One reviewed false positive from the committed allowlist. */
export interface AllowEntry {
  path: string;
  cls: Exclude<FindingClass, 'deny-list'>;
}

export interface ScanContext {
  /** The label printed in a finding. */
  where: string;
  /** The repo-relative file path. Unset for a commit message. */
  path?: string;
  deny?: DenyList;
  allow?: readonly AllowEntry[];
  /** The real line number of each scanned line, for a diff. Defaults to 1, 2, 3... */
  lineNumbers?: readonly number[];
  /** True for a commit author or committer field. Only `allow @author` lines apply to it. */
  identity?: boolean;
}

interface Pattern {
  cls: Exclude<FindingClass, 'deny-list'>;
  detail: string;
  regex: RegExp;
  /** Returns false to drop a match that is not a leak. */
  keep?: (match: RegExpExecArray) => boolean;
}

function notOwnRepo(owner: string | undefined, repo: string | undefined): boolean {
  if (owner === undefined || repo === undefined) return false;
  const name = `${owner}/${repo.replace(/\.git$/, '')}`.toLowerCase();
  return name !== OWN_REPO;
}

const PATTERNS: readonly Pattern[] = [
  { cls: 'secret', detail: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { cls: 'secret', detail: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { cls: 'secret', detail: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { cls: 'secret', detail: 'OpenAI-style API key', regex: /\bsk-(?:proj-)?(?!ant-)[A-Za-z0-9_-]{32,}/g },
  { cls: 'secret', detail: 'AWS access key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { cls: 'secret', detail: 'Slack token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { cls: 'secret', detail: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}/g },
  { cls: 'secret', detail: 'npm token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { cls: 'secret', detail: 'GitLab token', regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { cls: 'secret', detail: 'Stripe live key', regex: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { cls: 'secret', detail: 'private-key block', regex: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g },
  {
    cls: 'secret',
    detail: 'credential in a URL',
    // A scheme, a user, a password, and a host, where the password is not a
    // <placeholder> or a ${variable}.
    regex: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@'"`<>]+:(?![<${])[^\s/@'"`<>]+@[^\s/'"`]/g,
  },
  {
    cls: 'private-path',
    detail: 'absolute home path',
    regex: /(?<![\w.-])\/(?:Users|home)\/[A-Za-z0-9._-]+/g,
  },
  { cls: 'private-path', detail: 'absolute home path', regex: /\b[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+\\/g },
  {
    cls: 'private-path',
    detail: 'socket path',
    regex: /(?<![\w.-])\/(?:[\w.@+-]+\/)*[\w.@+-]+\.sock(?:et)?\b/g,
  },
  {
    cls: 'private-path',
    detail: 'socket path',
    regex: /(?<![\w.-])\/(?:private\/tmp|tmp|var\/run|run)\/[\w.@+-]*sock(?:s|ets?)?\b/g,
  },
  {
    cls: 'ticket-link',
    detail: 'ticket link to another repository',
    regex: /(?<![\w.-])(?:api\.)?github\.com\/(?:repos\/)?([\w.-]+)\/([\w.-]+)\/(?:issues|pulls?|discussions)\b/g,
    keep: (m) => notOwnRepo(m[1], m[2]),
  },
  {
    cls: 'ticket-link',
    detail: 'ticket link to another repository',
    regex: /(?<![\w./:-])([A-Za-z0-9][\w.-]*)\/([\w.-]+)#\d+\b/g,
    keep: (m) => notOwnRepo(m[1], m[2]),
  },
  {
    cls: 'ticket-link',
    detail: 'link to a private tracker',
    regex: /\b[\w-]+\.atlassian\.net\/(?:browse|jira)\/|\blinear\.app\/[\w-]+\/issue\//g,
  },
  // A Claude Code session link or id points at a private conversation.
  { cls: 'session-link', detail: 'Claude session link', regex: /\bclaude\.ai\/code\/session/g },
  {
    cls: 'session-link',
    detail: 'Claude session id',
    // The id is `session_` and 24 or more letters and digits, so code
    // names such as a `session_id` field do not match.
    regex: /\bsession_[0-9A-Za-z]{24,}\b/g,
  },
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds a case-insensitive whole-word pattern for one deny-list term. */
function termPattern(term: string): RegExp {
  const body = term.split(/\s+/).map(escapeRegex).join('\\s+');
  return new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, 'i');
}

/**
 * Parses the deny-list file. One term per line, matched case-insensitively
 * as a whole word. A line starting with `#` is a comment. A line
 * `allow <repo-relative path> <term>` clears that one term in that one file.
 * A line `allow @author <term>` clears that one term in commit author and
 * committer fields, and nowhere else. It never applies to a file path, even
 * a file named `@author`.
 */
export function parseDenyList(text: string): { list: DenyList; errors: string[] } {
  const list: DenyList = { terms: [], allowances: [], authorAllowances: [] };
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const allow = /^allow\s+(\S+)\s+(\S.*)$/.exec(line);
    if (allow && allow[1] === AUTHOR_ALLOW) {
      list.authorAllowances.push((allow[2] as string).trim().toLowerCase());
      return;
    }
    if (allow) {
      list.allowances.push({ path: allow[1] as string, key: (allow[2] as string).trim().toLowerCase() });
      return;
    }
    if (/^allow(\s|$)/.test(line)) {
      errors.push(`deny-list line ${index + 1}: an allowance needs a path and a term`);
      return;
    }
    list.terms.push({ entry: index + 1, key: line.toLowerCase(), pattern: termPattern(line) });
  });
  return { list, errors };
}

const ALLOW_CLASSES = new Set<string>(['secret', 'private-path', 'ticket-link']);

/**
 * Parses the committed allowlist. Each line is `<repo-relative path> <class>`,
 * where the class is secret, private-path, or ticket-link. The deny-list class
 * is refused: its allowances live with the deny-list, outside the repository.
 */
export function parseAllowlist(text: string): { entries: AllowEntry[]; errors: string[] } {
  const entries: AllowEntry[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const parts = line.split(/\s+/);
    const [path, cls] = parts;
    if (parts.length !== 2 || path === undefined || cls === undefined || !ALLOW_CLASSES.has(cls)) {
      errors.push(
        `allowlist line ${index + 1}: expected "<path> <class>", where the class is secret, private-path, or ticket-link`,
      );
      return;
    }
    entries.push({ path, cls: cls as AllowEntry['cls'] });
  });
  return { entries, errors };
}

function allowed(ctx: ScanContext, cls: FindingClass): boolean {
  if (ctx.path === undefined || ctx.allow === undefined) return false;
  return ctx.allow.some((entry) => entry.path === ctx.path && entry.cls === cls);
}

function denyAllowed(ctx: ScanContext, term: DenyTerm): boolean {
  if (ctx.deny === undefined) return false;
  if (ctx.identity) return ctx.deny.authorAllowances.includes(term.key);
  if (ctx.path === undefined) return false;
  return ctx.deny.allowances.some((a) => a.path === ctx.path && a.key === term.key);
}

function scanLine(text: string, lineNo: number, ctx: ScanContext, out: Finding[]): void {
  for (const pattern of PATTERNS) {
    if (allowed(ctx, pattern.cls)) continue;
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      if (pattern.keep === undefined || pattern.keep(match)) {
        out.push({ cls: pattern.cls, where: ctx.where, line: lineNo, detail: pattern.detail });
        break;
      }
    }
  }
  for (const term of ctx.deny?.terms ?? []) {
    if (term.pattern.test(text) && !denyAllowed(ctx, term)) {
      out.push({
        cls: 'deny-list',
        where: ctx.where,
        line: lineNo,
        detail: `deny-listed term, deny-list line ${term.entry}`,
      });
    }
  }
}

/** Scans text line by line. */
export function scanText(text: string, ctx: ScanContext): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    scanLine(line, ctx.lineNumbers?.[index] ?? index + 1, ctx, findings);
  });
  return findings;
}

const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

/** Checks a file's path: a committed .env file, or a deny-listed term in the name. */
export function scanPath(path: string, ctx: Omit<ScanContext, 'where' | 'path'>): Finding[] {
  const findings: Finding[] = [];
  const base = path.split('/').pop() ?? path;
  const isEnv = base === '.env' || (base.startsWith('.env.') && !ENV_TEMPLATES.has(base));
  if (isEnv && !allowed({ ...ctx, where: path, path }, 'secret')) {
    findings.push({ cls: 'secret', where: path, line: 0, detail: 'committed .env file' });
  }
  for (const term of ctx.deny?.terms ?? []) {
    if (term.pattern.test(path) && !denyAllowed({ ...ctx, where: path, path }, term)) {
      findings.push({
        cls: 'deny-list',
        where: path,
        line: 0,
        detail: `deny-listed term in the file name, deny-list line ${term.entry}`,
      });
    }
  }
  return findings;
}

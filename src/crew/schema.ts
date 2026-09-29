import { hasControlCharacter } from '../printable.ts';

/** The `crew.yml` schema version this build reads. */
export const CREW_SCHEMA_VERSION = 1;

/** Every harness name a `crew.yml` may give. */
export const CREW_HARNESSES = ['claude-code', 'codex', 'cursor'] as const;
export type CrewHarness = (typeof CREW_HARNESSES)[number];

/** The harnesses with an adapter. The others fail the harness check until their slice lands. */
export const BUILT_HARNESSES = ['claude-code'] as const;
export type BuiltHarness = (typeof BUILT_HARNESSES)[number];

export const BUILTIN_ROLES = ['lead', 'standby', 'auditor', 'reporting-chain'] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/** `bypassPermissions` is not here on purpose: the CLI never starts a session that skips checks. */
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'manual';
export const REFUSED_PERMISSION_MODE = 'bypassPermissions';

export const LANES_MIN = 1;
export const LANES_MAX = 10;
export const DEFAULT_LANES = 1;

/** The length cap for a base name (question Q13, default A). */
export const NAME_MAX_LENGTH = 40;

/**
 * The path-safe name rule: `a` to `z`, `0` to `9`, and `-`, starting with a
 * letter or a digit, so a name can never reach a command as an option.
 */
export const PATH_SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The reason a name breaks the path-safe name rule, or undefined when it holds. */
export function pathSafeNameProblem(name: string): string | undefined {
  if (name.length === 0) return 'must not be empty';
  if (name.length > NAME_MAX_LENGTH) return `must be at most ${NAME_MAX_LENGTH} characters`;
  if (!PATH_SAFE_NAME_PATTERN.test(name)) {
    return 'must use only a-z, 0-9, and -, and start with a letter or a digit';
  }
  return undefined;
}

/** A git remote form `crew.git` accepts: `https://`, `ssh://`, or `git@host:path`. Host and ref rules are slice 5. */
const GIT_URL_PATTERNS = [/^https:\/\/\S+$/, /^ssh:\/\/\S+$/, /^git@[^\s:@/]+:\S+$/];

export function isAcceptedGitUrl(url: string): boolean {
  return !hasControlCharacter(url) && GIT_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export interface CrewSource {
  path?: string;
  git?: string;
  ref?: string;
}

export interface CrewRole {
  /** A role module folder name. Set when `builtin` is not. */
  role?: string;
  /** A built-in role. Set when `role` is not. */
  builtin?: BuiltinRole;
  /** The first prompt of a built-in role. */
  kickoff?: string;
  /** The session name prefix. The default, the `role` or `builtin` value, is applied in slice 4. */
  name?: string;
  model?: string;
  permission_mode: PermissionMode;
  restricted: boolean;
  lanes: number;
}

export interface CrewConfig {
  version: typeof CREW_SCHEMA_VERSION;
  harness: BuiltHarness;
  crew: CrewSource;
  require: string[];
  front: string;
  roles: CrewRole[];
}

export interface CrewError {
  file: string;
  /** The 1-based line in the file. */
  line: number;
  /** The field path, such as `roles[1].lanes`, or `(file)` for a whole-file problem. */
  field: string;
  reason: string;
}

export type CrewParseResult = { ok: true; config: CrewConfig } | { ok: false; errors: CrewError[] };

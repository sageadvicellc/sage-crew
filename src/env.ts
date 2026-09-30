import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Everything the CLI reads from its surroundings. This module is the only
 * reader of HOME, PATH, CLAUDE_CONFIG_DIR, and CODEX_HOME. Every other
 * module takes an Env, so a test can hand it a fixture home.
 */
export interface Env {
  /** The operator's home folder. */
  readonly home: string;
  /** The PATH used to find harness binaries. */
  readonly path: string;
  /** CLAUDE_CONFIG_DIR, when set. */
  readonly claudeConfigDir: string | undefined;
  /** CODEX_HOME, when set. */
  readonly codexHome: string | undefined;
  /** The folder the CLI runs in. */
  readonly cwd: string;
  /** True when standard input is a terminal, so the CLI may ask a question. */
  readonly stdinIsTTY: boolean;
  /** The environment handed to child processes. */
  readonly vars: Readonly<Record<string, string | undefined>>;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Builds the Env from the running process. */
export function envFromProcess(): Env {
  const vars = { ...process.env };
  return {
    home: nonEmpty(process.env.HOME) ?? homedir(),
    path: process.env.PATH ?? '',
    claudeConfigDir: nonEmpty(process.env.CLAUDE_CONFIG_DIR),
    codexHome: nonEmpty(process.env.CODEX_HOME),
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY === true,
    vars,
  };
}

/** The Claude Code configuration folder. */
export function claudeDir(env: Env): string {
  return env.claudeConfigDir ?? join(env.home, '.claude');
}

/** The Codex CLI configuration folder. */
export function codexDir(env: Env): string {
  return env.codexHome ?? join(env.home, '.codex');
}

/** The CLI's own state folder, which holds install.yml and team.json. */
export function stateDir(env: Pick<Env, 'home'>): string {
  return join(env.home, '.trellis-crew');
}

/** Expands a leading `~` or `~/` against the Env home. Other paths pass through. */
export function expandHome(path: string, env: Env): string {
  if (path === '~') return env.home;
  if (path.startsWith('~/')) return join(env.home, path.slice(2));
  return path;
}

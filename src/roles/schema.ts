/** The roles-file schema version this build reads. */
export const SCHEMA_VERSION = 1;

/** The harness names a roles file may give. */
export const HARNESS_IDS = ['claude-code', 'qwen-code', 'hermes', 'codex', 'amp', 'opencode'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export type HarnessSetting = 'auto' | HarnessId;

/**
 * The transports a roles file may give. The MCP mailbox is not in this
 * build: tiers two and three use the file mailbox (plan decision 16).
 */
export const TRANSPORTS = ['auto', 'native', 'a2a', 'file-mailbox'] as const;
export type TransportSetting = (typeof TRANSPORTS)[number];
export type Transport = Exclude<TransportSetting, 'auto'>;
/** A transport the spec names that this build does not carry. */
export const UNBUILT_TRANSPORTS = ['mcp-mailbox'] as const;

export const ROLES = ['lead', 'standby', 'auditor', 'researcher', 'reporting-chain'] as const;
export type Role = (typeof ROLES)[number];

/** A session name: lowercase letters, digits, and hyphens, starting with a letter. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The `reports_to` value for the person every decision goes to. */
export const OPERATOR = 'operator';

/** The effort levels Claude Code's `--effort` flag takes. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** The range Claude Code's `--autocompact` flag takes, in tokens. */
export const CLAUDE_AUTOCOMPACT_MIN = 100_000;
export const CLAUDE_AUTOCOMPACT_MAX = 1_000_000;

/** An auditor's check interval, such as `30m`. */
export const CLOCK_PATTERN = /^[1-9][0-9]*[smhd]$/;

export interface Session {
  name: string;
  role: Role;
  reports_to: string;
  kickoff: string;
  workers?: string[];
  clock?: string;
  /** `auto` or a token count as written, such as `400k`. */
  autocompact?: string;
  model?: string;
  effort?: string;
}

export interface TaskProfile {
  model?: string;
  effort?: string;
}

export interface RolesConfig {
  version: typeof SCHEMA_VERSION;
  harness: HarnessSetting;
  transport: TransportSetting;
  mailbox?: string;
  operator?: string;
  task_profiles: Record<string, TaskProfile>;
  sessions: Session[];
}

export type AutocompactResult = { ok: true; tokens: 'auto' | number; text: string } | { ok: false };

const MULTIPLIERS: Record<string, number> = { '': 1, k: 1_000, K: 1_000, m: 1_000_000, M: 1_000_000 };

/** Parses `auto` or a token count such as `400k`, `1M`, or `250000`. */
export function parseAutocompact(value: unknown): AutocompactResult {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? { ok: true, tokens: value, text: String(value) } : { ok: false };
  }
  if (typeof value !== 'string') return { ok: false };
  if (value === 'auto') return { ok: true, tokens: 'auto', text: value };
  const match = /^([0-9]+(?:\.[0-9]+)?)([kKmM]?)$/.exec(value);
  if (!match) return { ok: false };
  const tokens = Math.round(Number(match[1]) * (MULTIPLIERS[match[2] as string] ?? 1));
  return tokens > 0 ? { ok: true, tokens, text: value } : { ok: false };
}

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

import { isAbsolute } from 'node:path';
import { printable } from '../printable.ts';
import { ROLES, type Role } from '../roles/schema.ts';
import { roleInstructionsArgs } from './codex-instructions.ts';
import type { Adapter } from './types.ts';

/** The key of the one `-c` that carries the role instructions. */
const ROLE_KEY = 'developer_instructions=';

/**
 * The verified launch flag for each launch field on Codex CLI. None is
 * verified yet, so every launch flag is refused.
 */
export const CODEX_FLAGS: Adapter['flags'] = {};

/**
 * The fixed sandbox arguments. Read from the local `codex exec --help` of
 * codex-cli 0.157.0: `-s, --sandbox <SANDBOX_MODE>` takes read-only,
 * workspace-write, or danger-full-access, and `-c, --config <key=value>`
 * overrides one configuration value, "parsed as TOML". The help does not
 * list the keys under `sandbox_workspace_write`. The names `network_access`
 * and `writable_roots` appear as fields beside that key in the same
 * binary, so they are this build's names, and a later build must check
 * them again. trellis-crew never passes danger-full-access or
 * `--dangerously-bypass-approvals-and-sandbox`.
 */
const SANDBOX_FIXED: readonly string[] = ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false'];
const ROOTS_KEY = 'sandbox_workspace_write.writable_roots=';

/** The `codex exec` subcommands that the help lists. A bare one is never a launch argument. */
const SUBCOMMANDS: ReadonlySet<string> = new Set(['resume', 'fork', 'review', 'help']);

// The characters a TOML basic string cannot hold, and that can hide text on a terminal.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The sandbox arguments for one session: workspace-write, network access
 * off, and the mailbox folder as the one extra writable root. The file
 * mailbox sits outside the workspace, so without the root a session could
 * not write to it. The root list replaces any list from the user's config,
 * so with no mailbox it is empty. The path is quoted with JSON.stringify,
 * which gives a TOML basic string once control characters are refused.
 * Throws when the mailbox path is not absolute or holds a control
 * character.
 */
export function codexSandboxArgs(mailbox: string | undefined): string[] {
  if (mailbox !== undefined) {
    if (CONTROL.test(mailbox)) {
      throw new Error(`the mailbox folder path holds a control character, so Codex CLI cannot be given it: ${printable(mailbox)}`);
    }
    if (!isAbsolute(mailbox)) throw new Error(`the mailbox folder must be an absolute path, not ${printable(mailbox)}`);
  }
  const roots = mailbox === undefined ? [] : [mailbox];
  return [...SANDBOX_FIXED, '-c', `${ROOTS_KEY}${JSON.stringify(roots)}`];
}

/** The flag names that are verified for `codex exec`. */
function verifiedFlagNames(): ReadonlySet<string> {
  return new Set(Object.values(CODEX_FLAGS).filter((flag): flag is string => flag !== undefined));
}

/**
 * Returns why launch arguments are refused on Codex CLI, or undefined when
 * none is. The arguments come in pairs, a flag name and its value. A name
 * must be a verified flag, and none is today. A value is checked apart
 * from its name, so a model name never trips the name check. A value must
 * not start with `-`, which codex could read as another flag, and it must
 * not hold a control character.
 */
export function refusedCodexFlag(flagArgs: readonly string[], verified: ReadonlySet<string> = verifiedFlagNames()): string | undefined {
  for (let i = 0; i < flagArgs.length; i += 2) {
    const name = flagArgs[i] as string;
    if (!name.startsWith('-')) {
      const why = SUBCOMMANDS.has(name) ? 'it is a codex exec subcommand' : 'it is not a flag';
      return `the launch argument "${printable(name)}" is refused on Codex CLI, because ${why}.`;
    }
    if (!verified.has(name)) {
      return `the launch flag "${printable(name)}" is refused on Codex CLI, because no Codex launch flag is verified. trellis-crew sets the sandbox itself.`;
    }
    const value = flagArgs[i + 1];
    const refusedValue = (why: string) => `the value "${printable(value ?? '')}" of the launch flag "${name}" is refused on Codex CLI, because ${why}.`;
    if (value === undefined) return `the launch flag "${name}" is refused on Codex CLI, because it has no value.`;
    if (value.startsWith('-')) return refusedValue('it starts with -');
    if (CONTROL.test(value)) return refusedValue('it holds a control character');
  }
  return undefined;
}

/**
 * The arguments for one `codex exec` session. Codex documents no flag to
 * name a session, so the kickoff names it. The help shows the prompt as
 * the trailing `[PROMPT]` argument, so the kickoff follows `--`, and a
 * kickoff that starts with `-` is never read as an option. After the
 * sandbox arguments and before `--` comes exactly one
 * `-c developer_instructions=<TOML string>`, the role's shipped skill.
 * Throws when a launch argument or the mailbox path is refused, and
 * RoleInstructionsError when the role skill cannot be read.
 */
export function codexExecArgs(flagArgs: readonly string[], kickoff: string, mailbox: string | undefined, role: Role): string[] {
  const refused = refusedCodexFlag(flagArgs);
  if (refused !== undefined) throw new Error(refused);
  return ['exec', ...flagArgs, ...codexSandboxArgs(mailbox), ...roleInstructionsArgs(role), '--', kickoff];
}

/** How many arguments the role instructions take: `-c` and its value. */
const ROLE_ARGS = 2;

/** How many arguments follow the launch flags: the sandbox arguments, the role instructions, `--`, and the kickoff. */
const TAIL = SANDBOX_FIXED.length + 2 + ROLE_ARGS + 2;

/**
 * Returns why a full `codex exec` argument list is refused, or undefined.
 * The supervisor runs this before it starts each child. The list must be
 * `exec`, launch flags that pass the flag check, the exact sandbox
 * arguments for at most one writable root, one role-instructions `-c`,
 * `--`, and the kickoff.
 *
 * The one `-c` this allows is `-c developer_instructions=<value>`, just
 * before `--`, and only when it equals the value built fresh here from the
 * shipped skill for `role`. It never allows `-c` in general. Any other
 * `-c`, `--config`, `--config=...`, joined `-c...`, or second
 * developer_instructions either breaks the fixed positions checked here or
 * falls in the launch flags, which the flag check refuses. `role` comes
 * from the job file, so it is checked against the four roles first.
 */
export function execArgsProblem(args: readonly string[], role: Role): string | undefined {
  if (!(ROLES as readonly string[]).includes(role)) return `the role "${printable(String(role))}" is not one of ${ROLES.join(', ')}`;
  const wrong = 'the arguments are not the sandbox arguments that trellis-crew sets';
  if (args[0] !== 'exec' || args.length < 1 + TAIL || args.at(-2) !== '--') return wrong;
  const [flag, value] = args.slice(-2 - ROLE_ARGS, -2);
  if (flag !== '-c' || value === undefined || !value.startsWith(`${ROLE_KEY}"`)) {
    return 'the arguments do not end with the role instructions that trellis-crew sets';
  }
  let expectedRole: string[];
  try {
    expectedRole = roleInstructionsArgs(role);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (value !== expectedRole[1]) return `the developer_instructions value is not the shipped skill for the ${role} role`;
  const sandbox = args.slice(-TAIL, -2 - ROLE_ARGS);
  const rootsArg = sandbox.at(-1) ?? '';
  if (!rootsArg.startsWith(ROOTS_KEY)) return wrong;
  let roots: unknown;
  try {
    roots = JSON.parse(rootsArg.slice(ROOTS_KEY.length));
  } catch {
    return wrong;
  }
  if (!Array.isArray(roots) || roots.length > 1 || !roots.every((root) => typeof root === 'string')) return wrong;
  let expected: string[];
  try {
    expected = codexSandboxArgs(roots[0] as string | undefined);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (expected.length !== sandbox.length || !expected.every((arg, i) => arg === sandbox[i])) return wrong;
  return refusedCodexFlag(args.slice(1, -TAIL));
}

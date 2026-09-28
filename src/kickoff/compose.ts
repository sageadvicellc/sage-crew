import { OPERATOR, type HarnessId, type Role, type RolesConfig, type Session, type Transport } from '../roles/schema.ts';

/** The heading that opens the start-up block the CLI adds to every kickoff. */
export const START_UP_HEADING = '## trellis-crew start-up';

/**
 * Claude Code's default cap on concurrent subagents per session. No other
 * harness documents a comparable cap, so no other harness gets a figure.
 */
export const CLAUDE_SUBAGENT_CAP = 20;

export const CHAIN_START_UP = 'I am the reporting chain. Send me one line per change. Decisions go to the operator through me.';
export const LEAD_NO_WORK = 'No work yet; wait for a hand-off addressed to you.';

const ROLE_LABELS: Record<Role, string> = {
  lead: 'the lead',
  standby: 'a worker',
  auditor: 'the auditor',
  'reporting-chain': 'the reporting chain',
};

export interface ComposeContext {
  harness: HarnessId;
  transport: Transport;
  /** The file mailbox folder, for the file-mailbox transport. */
  mailboxPath?: string;
}

function reportsToLine(config: RolesConfig, session: Session): string {
  if (session.reports_to === OPERATOR) {
    return config.operator ? `You report to ${config.operator}, the operator.` : 'You report to the operator.';
  }
  return `You report to ${session.reports_to}.`;
}

function messagingLine(ctx: ComposeContext): string {
  switch (ctx.transport) {
    case 'native':
      return ctx.harness === 'claude-code'
        ? 'Messaging: list your peers with ListAgents, and send plain text to one by name with SendMessage.'
        : 'Messaging: use the harness cross-session messaging, and address each peer by name.';
    case 'a2a':
      return "Messaging: A2A through each machine's gateway, with the peer URLs and keys the roles file names.";
    case 'file-mailbox':
      return `Messaging: the shared file mailbox at ${ctx.mailboxPath ?? '(no folder given)'}. Each session reads and writes its own file in that folder.`;
  }
}

function capacityLine(config: RolesConfig, session: Session, ctx: ComposeContext): string | undefined {
  if (ctx.harness !== 'claude-code') return undefined;
  if (session.role === 'standby') {
    return `Capacity: you may run up to ${CLAUDE_SUBAGENT_CAP} subagents at once.`;
  }
  if (session.role === 'lead') {
    const workers = session.workers?.length ?? 0;
    return `Capacity: you may run up to ${workers * CLAUDE_SUBAGENT_CAP} subagents at once, your ${workers} workers times ${CLAUDE_SUBAGENT_CAP}.`;
  }
  return undefined;
}

function startUpMessage(session: Session, ready: string): string {
  switch (session.role) {
    case 'reporting-chain':
      return `Start-up message: ${ready}, send this to every session: "${CHAIN_START_UP}"`;
    case 'lead':
      return `Start-up message: ${ready}, send each of your workers (${(session.workers ?? []).join(', ')}) the hand-off contract's three parts for the first unit of work, or "${LEAD_NO_WORK}"`;
    case 'auditor':
      return `Start-up message: ${ready}, send this to ${session.reports_to}: "Auditor clock started at <time>, interval ${session.clock ?? '<clock>'}. First check at <time>." Read the clock for each time.`;
    case 'standby':
      return 'Start-up message: none. Wait for a hand-off addressed to you by name.';
  }
}

function profileLines(config: RolesConfig): string[] {
  const names = Object.keys(config.task_profiles);
  if (names.length === 0) return ["Task profiles: none. A hand-off runs on the worker's own model and effort."];
  return [
    'Task profiles, named by the lead in a hand-off. The worker runs that unit through subagents with this model and effort:',
    ...names.map((name) => {
      const profile = config.task_profiles[name] ?? {};
      return `- ${name}: model ${profile.model ?? 'unset'}, effort ${profile.effort ?? 'unset'}`;
    }),
  ];
}

/** The session's first prompt: its roles-file kickoff, then the start-up block. */
export function composeKickoff(config: RolesConfig, session: Session, ctx: ComposeContext): string {
  const team = config.sessions.map((s) => `${s.name} (${ROLE_LABELS[s.role]})`).join(', ');
  const ready = ctx.transport === 'native' ? 'once every session appears in the peer list' : 'once every session has started';
  const lines = [
    START_UP_HEADING,
    `You are ${session.name}, ${ROLE_LABELS[session.role]}. ${reportsToLine(config, session)}`,
    `Team: ${team}.`,
    messagingLine(ctx),
  ];
  const capacity = capacityLine(config, session, ctx);
  if (capacity) lines.push(capacity);
  if (session.role === 'lead' || session.role === 'standby') lines.push(...profileLines(config));
  lines.push(startUpMessage(session, ready));
  return `${session.kickoff.trimEnd()}\n\n${lines.join('\n')}\n`;
}

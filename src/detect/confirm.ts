import { createInterface } from 'node:readline/promises';
import type { HarnessId } from '../roles/schema.ts';
import { HARNESSES, TIER_LABELS, type Candidate, type HarnessInfo } from './probe.ts';

/**
 * Each harness's install page. Gap: the spec documents none of them yet, so
 * every entry is unset and the CLI prints "not documented yet" instead of a
 * guessed address. TODO: fill each one once the maintainer verifies it.
 */
export const INSTALL_PAGES: Readonly<Record<HarnessId, string | undefined>> = {
  'claude-code': undefined,
  'qwen-code': undefined,
  hermes: undefined,
  codex: undefined,
  amp: undefined,
  opencode: undefined,
};

export interface ConfirmOptions {
  candidates: readonly Candidate[];
  /** The --harness value. */
  harnessFlag?: string;
  /** The --non-interactive flag. */
  nonInteractive: boolean;
  /** True when standard input is a terminal. */
  isTTY: boolean;
  /** Asks one question and returns the answer. */
  ask: (question: string) => Promise<string>;
  out: (line: string) => void;
}

export type ConfirmResult =
  | { ok: true; harness: HarnessInfo; candidate?: Candidate }
  | { ok: false; code: 1 | 2; lines: string[] };

/** The line printed for one candidate. */
export function candidateLine(candidate: Candidate): string {
  const { harness } = candidate;
  const tier = TIER_LABELS[harness.tier];
  if (candidate.binaryPath === undefined) {
    return `Found ${harness.displayName} configuration at ${candidate.configPath ?? '?'} (${tier}). Its binary is not on PATH.`;
  }
  const version = candidate.version === undefined ? '' : ` ${candidate.version}`;
  return `Found ${harness.displayName}${version} at ${candidate.binaryPath} (${tier}).`;
}

/** The lines printed when no harness is found. */
export function noCandidateLines(): string[] {
  return [
    'No supported agent harness was found on this machine. Install one, then run trellis-crew install again.',
    ...HARNESSES.map((h) => `${h.displayName} (${h.binary}): install page: ${INSTALL_PAGES[h.id] ?? 'not documented yet'}`),
  ];
}

function lookup(name: string): HarnessInfo | undefined {
  const wanted = name.trim().toLowerCase();
  return HARNESSES.find((h) => h.id === wanted || h.displayName.toLowerCase() === wanted || h.binary === wanted);
}

function unknown(name: string): ConfirmResult {
  return {
    ok: false,
    code: 2,
    lines: [`unknown harness "${name}". Use one of ${HARNESSES.map((h) => h.id).join(', ')}.`],
  };
}

function chosen(harness: HarnessInfo, candidates: readonly Candidate[]): ConfirmResult {
  const candidate = candidates.find((c) => c.harness.id === harness.id);
  return candidate ? { ok: true, harness, candidate } : { ok: true, harness };
}

/** Shows the candidates and settles the harness: by flag, by default, or by asking. */
export async function confirmHarness(options: ConfirmOptions): Promise<ConfirmResult> {
  const { candidates, out } = options;
  if (options.harnessFlag !== undefined) {
    const harness = lookup(options.harnessFlag);
    if (!harness) return unknown(options.harnessFlag);
    out(`Using ${harness.displayName}, from --harness.`);
    return chosen(harness, candidates);
  }
  const best = candidates[0];
  if (best === undefined) return { ok: false, code: 1, lines: noCandidateLines() };

  for (const candidate of candidates) out(candidateLine(candidate));

  if (options.nonInteractive || !options.isTTY) {
    const why = options.nonInteractive ? 'from --non-interactive' : 'because no terminal can answer a question';
    out(`Using ${best.harness.displayName}, the best candidate, ${why}.`);
    return chosen(best.harness, candidates);
  }

  const answer = (await options.ask(`Use ${best.harness.displayName}? [Y/n/other] `)).trim().toLowerCase();
  if (answer === '' || answer === 'y' || answer === 'yes') return chosen(best.harness, candidates);
  if (answer === 'n' || answer === 'no') {
    return { ok: false, code: 1, lines: ['No harness chosen. Nothing was installed.'] };
  }
  const name =
    answer === 'other' || answer === 'o'
      ? await options.ask(`Which harness? (${HARNESSES.map((h) => h.id).join(', ')}) `)
      : answer;
  const harness = lookup(name);
  return harness ? chosen(harness, candidates) : unknown(name);
}

/** A terminal question asker for real runs. */
export function terminalAsk(): (question: string) => Promise<string> {
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

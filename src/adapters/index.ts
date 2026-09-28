import type { HarnessId } from '../roles/schema.ts';
import { ampAdapter } from './amp.ts';
import { claudeCodeAdapter } from './claude-code.ts';
import { codexAdapter } from './codex.ts';
import { openCodeAdapter } from './generic.ts';
import { hermesAdapter } from './hermes.ts';
import { qwenCodeAdapter } from './qwen-code.ts';
import type { Adapter } from './types.ts';

/** The adapter for each harness. A test can override any of them. */
export const BUILT_ADAPTERS: Partial<Record<HarnessId, Adapter>> = {
  'claude-code': claudeCodeAdapter,
  'qwen-code': qwenCodeAdapter,
  hermes: hermesAdapter,
  codex: codexAdapter,
  amp: ampAdapter,
  opencode: openCodeAdapter,
};

export function adapterFor(
  harness: HarnessId,
  overrides: Partial<Record<HarnessId, Adapter>> = {},
): Adapter | undefined {
  return overrides[harness] ?? BUILT_ADAPTERS[harness];
}

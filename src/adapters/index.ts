import type { HarnessId } from '../roles/schema.ts';
import { claudeCodeAdapter } from './claude-code.ts';
import { qwenCodeAdapter } from './qwen-code.ts';
import type { Adapter } from './types.ts';

/** The adapters this build carries. The other harnesses arrive in plan steps 12 to 16. */
export const BUILT_ADAPTERS: Partial<Record<HarnessId, Adapter>> = {
  'claude-code': claudeCodeAdapter,
  'qwen-code': qwenCodeAdapter,
};

export function adapterFor(
  harness: HarnessId,
  overrides: Partial<Record<HarnessId, Adapter>> = {},
): Adapter | undefined {
  return overrides[harness] ?? BUILT_ADAPTERS[harness];
}

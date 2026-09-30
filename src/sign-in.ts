import type { Env } from './env.ts';

const API_KEY_NAME = 'ANTHROPIC_API_KEY';

/**
 * Trellis never offers, handles, or brokers a claude.ai login. It starts
 * the user's installed claude under the user's own sign-in, and v0.7 runs
 * on an Anthropic API key. This file holds the one check of that key. It
 * asks only whether the variable is set. It never keeps the value.
 */
export const API_KEY_WARNING = `warning: ${API_KEY_NAME} is not set. Trellis runs your installed Claude Code under your own sign-in. Use an Anthropic API key.`;

/** True when the variable is set to a non-empty value. */
export function hasApiKey(env: Env): boolean {
  return env.vars[API_KEY_NAME] !== undefined && env.vars[API_KEY_NAME] !== '';
}

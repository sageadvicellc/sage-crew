import type { Env } from './env.ts';

const API_KEY_NAME = 'ANTHROPIC_API_KEY';
/** Set when Claude Code runs on a cloud provider, which needs no Anthropic API key. */
const PROVIDER_NAMES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] as const;

/**
 * Trellis never offers, handles, or brokers a claude.ai login. It starts
 * the user's installed claude under the user's own sign-in, and v0.7 runs
 * on an Anthropic API key. This file holds the one check of that key. It
 * asks only whether a variable is set. It never keeps a value.
 */
export const API_KEY_WARNING = `warning: ${API_KEY_NAME} is not set. Trellis runs your installed Claude Code under your own sign-in. Use an Anthropic API key. If you sign in another way, you can ignore this.`;

/** True when the variable holds something other than white space. */
function isSet(env: Env, name: string): boolean {
  return (env.vars[name] ?? '').trim() !== '';
}

/** True when the warning applies: no key, and no cloud provider chosen. */
export function shouldWarnAboutApiKey(env: Env): boolean {
  return !isSet(env, API_KEY_NAME) && !PROVIDER_NAMES.some((name) => isSet(env, name));
}

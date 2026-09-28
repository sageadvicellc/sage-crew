import type { Tier } from './detect/probe.ts';
import type { Transport, TransportSetting } from './roles/schema.ts';

export interface TransportOptions {
  /** The --transport value. It wins over everything else. */
  flag?: Transport;
  /**
   * True when the roles file names each A2A peer's URL and key. TODO: the
   * roles schema has no field for these yet, so callers pass false.
   */
  a2aConfigured?: boolean;
}

/**
 * Settles the transport. `auto` follows the tier: tier one uses native
 * messaging, tier two uses A2A when configured, and tiers two and three
 * otherwise use the file mailbox (plan decision 16).
 */
export function resolveTransport(setting: TransportSetting, tier: Tier, options: TransportOptions): Transport {
  if (options.flag !== undefined) return options.flag;
  if (setting !== 'auto') return setting;
  if (tier === 1) return 'native';
  if (tier === 2 && options.a2aConfigured === true) return 'a2a';
  return 'file-mailbox';
}

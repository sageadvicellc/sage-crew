import type { Session } from '../roles/schema.ts';
import { LAUNCH_FIELDS, type Adapter, type LaunchValues } from './types.ts';

/** A session's launch values: its roles-file fields, with any override on top. */
export function launchValues(session: Session, overrides: LaunchValues = {}): LaunchValues {
  const values: LaunchValues = {};
  for (const field of LAUNCH_FIELDS) {
    const value = overrides[field] ?? session[field];
    if (value !== undefined) values[field] = value;
  }
  return values;
}

/** The warning printed for a set field the harness has no verified flag for. */
export function ignoredFieldWarning(session: string, field: string, displayName: string): string {
  return `warning: ${session}: ${field} ignored. ${displayName} has no verified flag for it.`;
}

/**
 * Maps set launch values to the harness's flags, in the order autocompact,
 * model, effort. Each set field with no flag gives one warning instead.
 */
export function buildLaunchFlags(
  session: string,
  values: LaunchValues,
  adapter: Pick<Adapter, 'flags' | 'displayName'>,
): { args: string[]; warnings: string[] } {
  const args: string[] = [];
  const warnings: string[] = [];
  for (const field of LAUNCH_FIELDS) {
    const value = values[field];
    if (value === undefined) continue;
    const flag = adapter.flags[field];
    if (flag === undefined) warnings.push(ignoredFieldWarning(session, field, adapter.displayName));
    else args.push(flag, value);
  }
  return { args, warnings };
}

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { stateDir, type Env } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { isHarnessId, TRANSPORTS, type HarnessId, type Transport } from '../roles/schema.ts';

/** What `install` chose, reused until `install --reconfigure`. */
export interface InstallRecord {
  harness: HarnessId;
  transport: Transport;
  /** The installed plugin version, or null when no plugin install ran. */
  plugin_version: string | null;
  /** The CLI version that last wrote this file. */
  cli_version?: string;
}

export type ReadResult<T> = { ok: true; record: T | undefined } | { ok: false; message: string };

export function installYmlPath(env: Env): string {
  return join(stateDir(env), 'install.yml');
}

function isTransport(value: unknown): value is Transport {
  return typeof value === 'string' && value !== 'auto' && (TRANSPORTS as readonly string[]).includes(value);
}

/** Reads install.yml. A missing file is no record. A damaged file is an error, never a guess. */
export function readInstallRecord(env: Env): ReadResult<InstallRecord> {
  const path = installYmlPath(env);
  if (!existsSync(path)) return { ok: true, record: undefined };
  let data: unknown;
  try {
    data = parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, message: `${path}: cannot read or parse the install record` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, message: `${path}: the install record is not a map` };
  }
  const { harness, transport, plugin_version: pluginVersion, cli_version: cliVersion } = data as Record<string, unknown>;
  if (
    typeof harness !== 'string' ||
    !isHarnessId(harness) ||
    !isTransport(transport) ||
    !(pluginVersion === null || typeof pluginVersion === 'string') ||
    !(cliVersion === undefined || typeof cliVersion === 'string')
  ) {
    return { ok: false, message: `${path}: the install record needs a known harness, a transport, and a plugin_version` };
  }
  const record: InstallRecord = { harness, transport, plugin_version: pluginVersion };
  if (cliVersion !== undefined) record.cli_version = cliVersion;
  return { ok: true, record };
}

/** Writes install.yml atomically, creating the state folder when needed. */
export function writeInstallRecord(env: Env, record: InstallRecord): void {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  const body = stringify({
    harness: record.harness,
    transport: record.transport,
    plugin_version: record.plugin_version,
    ...(record.cli_version === undefined ? {} : { cli_version: record.cli_version }),
  });
  writeFileAtomic(installYmlPath(env), `# Written by trellis-crew install. Rerun with --reconfigure to change it.\n${body}`, 0o600);
}

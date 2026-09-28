import { adapterFor } from '../adapters/index.ts';
import type { TransportFlag } from '../args.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { confirmHarness, terminalAsk } from '../detect/confirm.ts';
import { findBinary, HARNESSES, probeHarnesses, type HarnessInfo } from '../detect/probe.ts';
import { ensureMailboxFolder, mailboxPath } from '../mailbox/folder.ts';
import { loadTeam } from '../roles/load.ts';
import type { Transport } from '../roles/schema.ts';
import { setInboundAccept } from '../settings/inbound.ts';
import { readInstallRecord, writeInstallRecord } from '../store/install-yml.ts';
import { resolveTransport } from '../transport.ts';
import { bundledPluginVersion, cliVersion } from '../versions.ts';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface InstallOptions {
  harness?: string;
  nonInteractive: boolean;
  reconfigure: boolean;
  transport?: TransportFlag;
}

async function chooseHarness(options: InstallOptions, deps: CliDeps): Promise<{ ok: true; harness: HarnessInfo; stored?: Transport } | { ok: false; code: number }> {
  const stored = readInstallRecord(deps.env);
  if (!stored.ok && !options.reconfigure) {
    deps.err(stored.message);
    deps.err('Run trellis-crew install --reconfigure to write it again.');
    return { ok: false, code: EXIT_RUNTIME };
  }
  const record = stored.ok ? stored.record : undefined;
  if (record && !options.reconfigure && options.harness === undefined) {
    const harness = HARNESSES.find((h) => h.id === record.harness) as HarnessInfo;
    deps.out(`Using ${harness.displayName}, stored in install.yml. Run trellis-crew install --reconfigure to choose again.`);
    return { ok: true, harness, stored: record.transport };
  }
  const candidates = options.harness === undefined ? await probeHarnesses(deps.env, deps.runner) : [];
  const result = await confirmHarness({
    candidates,
    ...(options.harness === undefined ? {} : { harnessFlag: options.harness }),
    nonInteractive: options.nonInteractive,
    isTTY: deps.env.stdinIsTTY,
    ask: deps.ask ?? terminalAsk(),
    out: deps.out,
  });
  if (!result.ok) {
    for (const line of result.lines) deps.err(line);
    return { ok: false, code: result.code };
  }
  return { ok: true, harness: result.harness };
}

/**
 * Detects and confirms the harness, installs the plugin, sets the inbound
 * setting on Claude Code, writes install.yml, and creates the mailbox
 * folder for the file transport.
 */
export async function runInstall(options: InstallOptions, deps: CliDeps): Promise<number> {
  const chosen = await chooseHarness(options, deps);
  if (!chosen.ok) return chosen.code;
  const { harness } = chosen;

  const transport: Transport = options.transport ?? chosen.stored ?? resolveTransport('auto', harness.tier, {});
  if (transport === 'native' && harness.tier !== 1) {
    deps.err(`${harness.displayName} has no native peer messaging. Use --transport file.`);
    return EXIT_USAGE;
  }

  let complete = true;
  let pluginVersion: string | null = null;
  const adapter = adapterFor(harness.id, deps.adapters);
  const binaryPath = findBinary(harness.binary, deps.env.path);
  if (adapter?.installPlugin === undefined) {
    deps.err(`The plugin install on ${harness.displayName} is not built yet, so no plugin was installed.`);
    complete = false;
  } else if (binaryPath === undefined) {
    deps.err(`${harness.displayName} is not on PATH, so the plugin cannot be installed.`);
    return EXIT_RUNTIME;
  } else {
    const installed = await adapter.installPlugin({ env: deps.env, runner: deps.runner, binaryPath, out: deps.out });
    if (installed.ok) {
      pluginVersion = bundledPluginVersion();
      deps.out(`Installed the trellis-crew plugin ${pluginVersion} on ${harness.displayName}.`);
    } else if (installed.skipped) {
      deps.err(`No plugin was installed on ${harness.displayName}: ${installed.message}`);
      complete = false;
    } else {
      deps.err(`The plugin install failed: ${installed.message}`);
      return EXIT_RUNTIME;
    }
  }

  const target = adapter?.inboundTarget?.(deps.env);
  if (target !== undefined) {
    const folder = dirname(target.settingsPath);
    if (!existsSync(folder)) {
      deps.err(`The ${harness.displayName} configuration folder ${folder} does not exist yet. Run ${harness.displayName} once, then run install again.`);
      return EXIT_RUNTIME;
    }
    const inbound = setInboundAccept(target, { now: deps.now?.() ?? new Date(), out: deps.out });
    if (!inbound.ok) {
      deps.err(inbound.message);
      return EXIT_RUNTIME;
    }
  }

  writeInstallRecord(deps.env, { harness: harness.id, transport, plugin_version: pluginVersion, cli_version: cliVersion() });
  deps.out(`Recorded ${harness.displayName} with the ${transport} transport in install.yml.`);

  if (transport === 'file-mailbox') {
    const team = loadTeam({ env: deps.env });
    const folder = ensureMailboxFolder(mailboxPath(team.ok ? team.config : {}, deps.env));
    if (!folder.ok) {
      deps.err(folder.message);
      return EXIT_RUNTIME;
    }
    deps.out(`Mailbox folder: ${folder.path}`);
  }
  return complete ? EXIT_OK : EXIT_RUNTIME;
}

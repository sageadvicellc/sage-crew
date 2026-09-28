import { readFileSync } from 'node:fs';

function readVersion(url: URL): string {
  const data = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
  if (typeof data.version !== 'string') throw new Error(`${url.pathname} names no version`);
  return data.version;
}

/** This CLI's own version, from package.json. */
export function cliVersion(): string {
  return readVersion(new URL('../package.json', import.meta.url));
}

/** The plugin version this CLI carries, from .claude-plugin/plugin.json. */
export function bundledPluginVersion(): string {
  return readVersion(new URL('../.claude-plugin/plugin.json', import.meta.url));
}

/** Compares two versions by their major, minor, and patch numbers. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

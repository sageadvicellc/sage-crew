/** The package name on the npm registry. */
export const PACKAGE_NAME = 'trellis-crew';

/** The npm registry's document for the latest published version of a package. */
const REGISTRY_LATEST = (name: string) => `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;

export type LatestVersion =
  | { status: 'ok'; version: string }
  | { status: 'not-published' }
  | { status: 'error'; message: string };

/** Reads the latest published version. Tests pass a stand-in, so no test reaches the network. */
export type FetchLatest = (name: string) => Promise<LatestVersion>;

export const npmFetchLatest: FetchLatest = async (name) => {
  try {
    const response = await fetch(REGISTRY_LATEST(name), { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return { status: 'not-published' };
    if (!response.ok) return { status: 'error', message: `registry answered ${response.status}` };
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string'
      ? { status: 'ok', version: body.version }
      : { status: 'error', message: 'the registry answer holds no version' };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
};

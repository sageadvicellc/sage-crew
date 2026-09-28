import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, found from this file's own location. */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The fixture bin folder that forms the whole PATH of the test Env. */
export const fixtureBin = join(repoRoot, 'test', 'fixtures', 'bin');

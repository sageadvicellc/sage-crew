import { homedir } from 'node:os';
import { afterEach, beforeEach, inject } from 'vitest';
import { assertIsolatedHome } from './home-guard.ts';

const tempHome = inject('tempHome');

// Load-time check: a failure here fails every test in the file.
assertIsolatedHome(process.env, homedir(), tempHome);

// Per-test checks: a test that moves HOME, or leaves it moved, fails.
beforeEach(() => {
  assertIsolatedHome(process.env, homedir(), tempHome);
});

afterEach(() => {
  assertIsolatedHome(process.env, homedir(), tempHome);
});

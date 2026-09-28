import { homedir } from 'node:os';
import { afterEach, beforeEach, inject } from 'vitest';
import { assertIsolatedHome } from './home-guard.ts';

const tempHome = inject('tempHome');

// No test reaches the network. A call that tries fails loudly.
globalThis.fetch = () => Promise.reject(new Error('network is off in tests: inject a fetch stand-in'));

// Load-time check: a failure here fails every test in the file.
assertIsolatedHome(process.env, homedir(), tempHome);

// Per-test checks: a test that moves HOME, or leaves it moved, fails.
beforeEach(() => {
  assertIsolatedHome(process.env, homedir(), tempHome);
});

afterEach(() => {
  assertIsolatedHome(process.env, homedir(), tempHome);
});

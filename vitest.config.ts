import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Makes a temp home and points every home variable into it before any
    // test file loads. See test/setup/global-home.ts.
    globalSetup: ['test/setup/global-home.ts'],
    // Fails the run when a home variable, or os.homedir(), leaves that home.
    setupFiles: ['test/setup/guard-setup.ts'],
    pool: 'forks',
    testTimeout: 20000,
  },
});

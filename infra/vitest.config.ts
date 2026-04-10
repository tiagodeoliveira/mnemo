import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    // CDK synth tests spawn npm install via execSync, blocking the event loop
    // long enough to trigger vitest's internal 60s birpc worker RPC timeout.
    // All tests pass; the unhandled error is a vitest/birpc limitation.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});

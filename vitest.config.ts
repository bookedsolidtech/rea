import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
    // Codex round 2 R2-15: bash-tier corpus expanded with 186+ new
    // fixtures, each spawning a bash hook (avg 400-600ms). The default
    // 5s test/teardown timeouts plus default RPC budget can cause
    // vitest's worker-RPC heartbeat to time out at peak. Raise the
    // budget so test runs complete cleanly.
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/**/types.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});

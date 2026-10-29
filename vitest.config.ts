import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // Tests never touch the network or the real LLM.
    env: { LOG_LEVEL: 'silent', NODE_NO_WARNINGS: '1' },
  },
});

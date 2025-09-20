import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/*.spec.ts'],
    environment: 'node',
  },
  coverage: {
    provider: 'v8',
    reporter: ['text', 'json', 'lcov'],
    include: ['src/**/*.{ts,tsx}'],
  },
});

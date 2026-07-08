/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      enabled: process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true',
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/**',
      ],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      provider: 'v8',
    },
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});

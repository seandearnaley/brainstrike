import { defineConfig } from 'vitest/config';

// Root Vitest config for the monorepo.
// Uses the modern `test.projects` API to aggregate package/app projects.
// This replaces separate vitest.workspace.* files and avoids editor warnings.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov', 'json'],
      include: ['packages/**/src/**/*.{ts,tsx}', 'apps/**/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/*.{config,config.*}',
        '**/vitest.*',
        'apps/desktop/src/main.ts',
        'apps/desktop/src/preload.ts',
      ],
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});

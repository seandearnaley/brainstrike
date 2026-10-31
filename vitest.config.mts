import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

// Root Vitest config for the monorepo.
// Uses the modern `test.projects` API to aggregate package/app projects.
// This replaces separate vitest.workspace.* files and avoids editor warnings.
// CI runs tests per package through Turbo; the coverage settings here apply only
// to local aggregate runs.
export default defineConfig({
  test: {
    coverage: {
      enabled: coverageEnabled,
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
      include: ['packages/**/src/**/*.{ts,tsx}', 'apps/**/src/**/*.{ts,tsx}'],
      // Local aggregate coverage only. CI ignores this and relies on per‑package reporters.
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
      // Minimum thresholds for local aggregate runs.
      thresholds: {
        branches: 62,
        functions: 62,
        lines: 72,
        statements: 72,
      },
    },
    // Disable CSS processing for faster unit test execution
    css: false,
    // Enable dependency optimization for better performance
    deps: {
      optimizer: {
        client: { enabled: true },
      },
    },
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    projects: ['packages/*', 'apps/*'],
  },
});

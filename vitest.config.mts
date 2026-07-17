import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

// Root Vitest config for the monorepo.
// Uses the modern `test.projects` API to aggregate package/app projects.
// This replaces separate vitest.workspace.* files and avoids editor warnings.
// NOTE (coverage & CI):
// - This config is primarily for local developer convenience to run all projects together.
// - CI runs tests per-package via Turbo; each package writes coverage/coverage-final.json.
// - CI then merges coverage with scripts/merge-coverage.js and generates ./coverage/lcov.info
//   via `pnpm coverage:report` for Codecov upload. Thresholds are enforced per-package by
//   scripts/enforce-coverage.mjs. As a result, the coverage settings in this file do NOT
//   affect CI uploads or gating; keep them roughly aligned with package configs for local runs.
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
      // CI thresholds are enforced per‑package in scripts/enforce-coverage.mjs.
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
    projects: ['packages/*', 'apps/*'],
  },
});

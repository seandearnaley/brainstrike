'use strict';
// @ts-check
const config = {
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.mutation.config.ts',
  },
  checkers: ['typescript'],
  mutate: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
    '!src/**/*.d.ts',
  ],
  coverageAnalysis: 'perTest',
  concurrency: 2,
  reporters: ['html', 'clear-text', 'progress'],
  timeoutMS: 120_000,
  htmlReporter: {
    fileName: 'reports/mutation/file-system/index.html',
  },
  thresholds: {
    high: 80,
    low: 65,
    break: 50,
  },
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', 'reports/**'],
  tsconfigFile: 'tsconfig.json',
};

module.exports = config;

// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.mutation.config.ts',
  },
  checkers: ['typescript'],
  mutate: [
    '*.ts',
    '!*.test.ts',
    '!__tests__/**',
    '!__mocks__/**',
    '!test-helpers.ts',
  ],
  coverageAnalysis: 'perTest',
  concurrency: 2,
  reporters: ['html', 'clear-text', 'progress'],
  timeoutMS: 120000,
  htmlReporter: {
    fileName: 'reports/mutation/workers/index.html',
  },
  thresholds: {
    high: 80,
    low: 65,
    break: 50,
  },
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', 'reports/**'],
  tsconfigFile: 'tsconfig.json',
};

export default config;

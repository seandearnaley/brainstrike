// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  checkers: ['typescript'],
  concurrency: 2,
  coverageAnalysis: 'perTest',
  htmlReporter: {
    fileName: 'reports/mutation/workers/index.html',
  },
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', 'reports/**'],
  mutate: ['*.ts', '!*.test.ts', '!__tests__/**', '!__mocks__/**', '!test-helpers.ts'],
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'vitest',
  thresholds: {
    break: 50,
    high: 80,
    low: 65,
  },
  timeoutMS: 120_000,
  tsconfigFile: 'tsconfig.json',
  vitest: {
    configFile: 'vitest.mutation.config.ts',
  },
};

export default config;

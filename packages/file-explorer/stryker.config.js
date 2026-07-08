// @ts-check
const config = {
  // Use the TypeScript checker to skip mutants that break type checking
  checkers: ['typescript'],

  // Reduce concurrency to avoid resource contention with complex async code
  concurrency: 2,

  // Configure coverage analysis for best performance
  coverageAnalysis: 'perTest',

  // Configure HTML report output directory (using new fileName option)
  htmlReporter: {
    fileName: 'reports/mutation/file-explorer/index.html',
  },

  // Ignore specific files or patterns
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', 'reports/**'],

  // Specify which files to mutate (only source files, exclude tests and problematic async files)
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
    '!src/persistence/worker-storage.worker.js',
    '!src/persistence/worker-storage.ts',
    '!src/persistence/worker-init.ts',
  ],
  // Specify which plugins to load
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],

  // Configure reporters
  reporters: ['html', 'clear-text', 'progress'],

  // Use the Vitest runner for executing tests
  testRunner: 'vitest',

  // Configure thresholds for mutation score
  thresholds: {
    break: 50,
    high: 80,
    low: 65,
  },

  // Set timeout for test runs (in milliseconds) - increased for complex async code
  timeoutMS: 120_000,

  // TypeScript checker configuration
  tsconfigFile: 'tsconfig.json',

  // Configure Vitest-specific options
  vitest: {
    // Point to the mutation-specific Vitest config
    configFile: 'vitest.mutation.config.ts',
  },
};

module.exports = config;

// @ts-check
const config = {
  // Specify which plugins to load
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],

  // Use the Vitest runner for executing tests
  testRunner: 'vitest',

  // Configure Vitest-specific options
  vitest: {
    // Point to the mutation-specific Vitest config
    configFile: 'vitest.mutation.config.ts',
  },

  // Use the TypeScript checker to skip mutants that break type checking
  checkers: ['typescript'],

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

  // Configure coverage analysis for best performance
  coverageAnalysis: 'perTest',

  // Reduce concurrency to avoid resource contention with complex async code
  concurrency: 2,

  // Configure reporters
  reporters: ['html', 'clear-text', 'progress'],

  // Set timeout for test runs (in milliseconds) - increased for complex async code
  timeoutMS: 120_000,

  // Configure HTML report output directory (using new fileName option)
  htmlReporter: {
    fileName: 'reports/mutation/file-explorer/index.html',
  },

  // Configure thresholds for mutation score
  thresholds: {
    high: 80,
    low: 65,
    break: 50,
  },

  // Ignore specific files or patterns
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', 'reports/**'],

  // TypeScript checker configuration
  tsconfigFile: 'tsconfig.json',
};

module.exports = config;

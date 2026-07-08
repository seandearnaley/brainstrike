// @ts-check
const config = {
  // Use the TypeScript checker to skip mutants that break type checking
  checkers: ['typescript'],

  // Configure coverage analysis for best performance
  coverageAnalysis: 'perTest',

  // Configure HTML report output directory
  htmlReporter: {
    fileName: 'reports/mutation/selection-rules/index.html',
  },

  // Ignore specific files or patterns
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', 'reports/**'],

  // Specify which files to mutate (only source files, exclude tests and index)
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/index.ts', // Re-exports only
  ],
  // Specify which plugins to load
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],

  // Configure reporters
  reporters: ['html', 'clear-text', 'progress'],

  // Use the Vitest runner for executing tests
  testRunner: 'vitest',

  // Configure thresholds for mutation score
  thresholds: {
    break: null, // Don't fail on initial run
    high: 80,
    low: 60,
  },

  // Set timeout for test runs (in milliseconds)
  timeoutMS: 60_000,

  // TypeScript checker configuration
  tsconfigFile: 'tsconfig.json',

  // Configure Vitest-specific options
  vitest: {
    configFile: 'vitest.config.ts',
  },
};

module.exports = config;

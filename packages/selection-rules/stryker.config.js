// @ts-check
const config = {
  // Specify which plugins to load
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],

  // Use the Vitest runner for executing tests
  testRunner: 'vitest',

  // Configure Vitest-specific options
  vitest: {
    configFile: 'vitest.config.ts',
  },

  // Use the TypeScript checker to skip mutants that break type checking
  checkers: ['typescript'],

  // Specify which files to mutate (only source files, exclude tests and index)
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/index.ts', // Re-exports only
  ],

  // Configure coverage analysis for best performance
  coverageAnalysis: 'perTest',

  // Configure reporters
  reporters: ['html', 'clear-text', 'progress'],

  // Set timeout for test runs (in milliseconds)
  timeoutMS: 60_000,

  // Configure HTML report output directory
  htmlReporter: {
    fileName: 'reports/mutation/selection-rules/index.html',
  },

  // Configure thresholds for mutation score
  thresholds: {
    high: 80,
    low: 60,
    break: null, // Don't fail on initial run
  },

  // Ignore specific files or patterns
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', 'reports/**'],

  // TypeScript checker configuration
  tsconfigFile: 'tsconfig.json',
};

module.exports = config;

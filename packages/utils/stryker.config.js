// @ts-check
const config = {
  // Specify which plugins to load
  plugins: [
    '@stryker-mutator/vitest-runner',
    '@stryker-mutator/typescript-checker'
  ],
  
  // Use the Vitest runner for executing tests
  testRunner: 'vitest',
  
  // Configure Vitest-specific options
  vitest: {
    // Point to the mutation-specific Vitest config that excludes problematic tests
    configFile: 'vitest.mutation.config.ts'
  },
  
  // Use the TypeScript checker to skip mutants that break type checking
  checkers: ['typescript'],
  
  // Specify which files to mutate (only source files, exclude tests)
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**'
  ],
  
  // Configure coverage analysis for best performance
  coverageAnalysis: 'perTest',
  
  // Configure reporters
  reporters: ['html', 'clear-text', 'progress'],
  
  // Set timeout for test runs (in milliseconds)
  timeoutMS: 60000,
  
  // Configure HTML report output directory (using new fileName option)
  htmlReporter: {
    fileName: 'reports/mutation/utils/index.html'
  },
  
  // Configure thresholds for mutation score
  thresholds: {
    high: 80,
    low: 60,
    break: 50
  },
  
  // Ignore specific files or patterns
  ignorePatterns: [
    'dist/**',
    'node_modules/**',
    'coverage/**',
    'reports/**'
  ],
  
  // TypeScript checker configuration
  tsconfigFile: 'tsconfig.json'
};

module.exports = config; 

/**
 * Standardized test timeouts across the monorepo
 */

export const TEST_TIMEOUTS = {
  // Unit tests - fast, isolated tests
  unit: 10000, // 10 seconds

  // Integration tests - tests involving multiple components
  integration: 15000, // 15 seconds

  // Database tests - tests involving database operations
  database: 20000, // 20 seconds

  // UI component tests - tests involving rendering and interactions
  uiComponent: 15000, // 15 seconds

  // E2E tests - full application tests
  e2e: 60000, // 60 seconds

  // Performance tests - performance measurement tests
  performance: 120000, // 2 minutes

  // Heavy/slow tests - computationally intensive tests
  heavy: 30000, // 30 seconds
} as const;

/**
 * Get the appropriate timeout for a test type
 */
export const getTestTimeout = (type: keyof typeof TEST_TIMEOUTS): number => {
  return TEST_TIMEOUTS[type];
};

/**
 * Environment-specific timeout multipliers
 */
export const getTimeoutMultiplier = (): number => {
  if (process.env['CI']) {
    return 2; // Double timeouts in CI
  }
  if (process.env['DEBUG']) {
    return 5; // 5x timeouts when debugging
  }
  return 1; // Default multiplier
};

/**
 * Get adjusted timeout based on environment
 */
export const getAdjustedTimeout = (type: keyof typeof TEST_TIMEOUTS): number => {
  return TEST_TIMEOUTS[type] * getTimeoutMultiplier();
};

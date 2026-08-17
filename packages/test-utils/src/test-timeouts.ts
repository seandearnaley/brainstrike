/**
 * Standardized test timeouts across the monorepo
 */

export const TEST_TIMEOUTS = {
  // Database tests - tests involving database operations
  database: 20_000, // 20 seconds

  // E2E tests - full application tests
  e2e: 60_000, // 60 seconds

  // Heavy/slow tests - computationally intensive tests
  heavy: 30_000, // 30 seconds

  // Integration tests - tests involving multiple components
  integration: 15_000, // 15 seconds

  // Performance tests - performance measurement tests
  performance: 120_000, // 2 minutes

  // UI component tests - tests involving rendering and interactions
  uiComponent: 15_000, // 15 seconds
  // Unit tests - fast, isolated tests
  unit: 10_000, // 10 seconds
} as const;

/**
 * Get the appropriate timeout for a test type
 */
export const getTestTimeout = (type: keyof typeof TEST_TIMEOUTS): number => TEST_TIMEOUTS[type];

const MAX_TEST_TIMEOUT_MULTIPLIER = 10;

/**
 * Environment-specific timeout multipliers
 */
export const getTimeoutMultiplier = (): number => {
  const configuredMultiplier = process.env['TEST_TIMEOUT_MULTIPLIER'];
  if (configuredMultiplier !== undefined) {
    // Keep this grammar deliberately narrower than Number(...): whitespace,
    // signs, exponents, hex, Infinity, and an empty string are configuration
    // mistakes, not alternative spellings to accept silently.
    const isPositiveDecimal = /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/.test(configuredMultiplier);
    const multiplier = Number(configuredMultiplier);
    if (
      !(
        isPositiveDecimal &&
        Number.isFinite(multiplier) &&
        multiplier > 0 &&
        multiplier <= MAX_TEST_TIMEOUT_MULTIPLIER
      )
    ) {
      throw new Error(
        `Invalid TEST_TIMEOUT_MULTIPLIER ${JSON.stringify(configuredMultiplier)}; expected a positive decimal number no greater than ${MAX_TEST_TIMEOUT_MULTIPLIER}.`
      );
    }
    return multiplier;
  }
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
export const getAdjustedTimeout = (type: keyof typeof TEST_TIMEOUTS): number =>
  TEST_TIMEOUTS[type] * getTimeoutMultiplier();

/**
 * Base budget for @testing-library/dom's async utilities (`waitFor`,
 * `waitForElementToBeRemoved`, every `findBy*`), in milliseconds.
 *
 * Deliberately @testing-library/dom's OWN default. This is not a test-type
 * timeout — it is a poll-loop ceiling INSIDE a test — so it stays out of
 * TEST_TIMEOUTS, whose keys answer "how long may this kind of test run".
 *
 * WHY THE LIBRARY DEFAULT AND NOT SOMETHING LARGER: the budget is only ever
 * paid in full when the awaited condition NEVER becomes true, i.e. on a
 * genuine failure — a satisfied `waitFor` returns on the next poll. Raising
 * the base therefore buys nothing for passing tests and makes every real
 * failure slower to report. The defect being fixed is not that 1s is wrong at
 * rest; it is that a loaded CI runner needs proportionally more, and this repo
 * already spells "this environment is slower" TEST_TIMEOUT_MULTIPLIER. Holding
 * the base at the library default means the multiplier — not a fresh
 * hard-coded number — sets the budget: 1x local 1000ms (unchanged from today),
 * 2x CI 2000ms, 5x DEBUG 5000ms.
 */
export const ASYNC_UTIL_TIMEOUT = 1000;

/**
 * The multiplier-scaled @testing-library/dom async-utility budget.
 *
 * Node/jsdom/happy-dom lanes call this directly from the shared Vitest setup.
 * Browser-mode lanes CANNOT (`process` is undefined inside the browser page):
 * there it is evaluated in the Vitest config process and handed to the page
 * via `test.provide` — see `createBrowserProject` in @brainstrike/config.
 */
export const getAsyncUtilTimeout = (): number => ASYNC_UTIL_TIMEOUT * getTimeoutMultiplier();

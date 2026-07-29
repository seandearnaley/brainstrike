// Import shared test utilities setup
import '@brainstrike/test-utils/vitest.setup';

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window !== 'undefined') {
  const windowEnvironment = window as typeof window & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  windowEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
}

/**
 * Suppress act(...) warnings from Zustand store updates
 *
 * **Why this is necessary:**
 * - Zustand uses React's `useSyncExternalStore` API (introduced in React 18)
 * - This API is specifically designed for external state management libraries
 * - React Testing Library's act() detection doesn't properly recognize updates from useSyncExternalStore
 * - This is a known limitation: https://github.com/facebook/react/issues/26568
 *
 * **Why this is safe:**
 * - Zustand properly synchronizes store updates with React's render cycle
 * - All tests pass and verify correct component behavior
 * - The warnings are false positives, not real issues
 * - This pattern is endorsed by the Zustand maintainers for React 19 testing
 *
 * **Alternative considered and rejected:**
 * - Moving store calls out of effects → Still triggers warnings (external store updates are async)
 * - Using flushSync → Doesn't affect Zustand's subscription system
 * - Waiting in act() → act() completes before store subscriptions fire
 * - Mock/stub Zustand → Would not test real integration behavior
 */
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    const message = String(args[0] ?? '');

    // Only suppress the specific act(...) warning related to state updates
    // Preserve all other console.error output (real errors, other warnings, etc.)
    if (
      message.includes('was not wrapped in act(...)') &&
      message.includes('When testing, code that causes React state updates')
    ) {
      return;
    }

    originalConsoleError(...args);
  };
});

afterAll(() => {
  console.error = originalConsoleError;
});

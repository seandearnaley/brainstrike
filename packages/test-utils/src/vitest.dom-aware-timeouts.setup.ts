/**
 * Environment-keyed variant of `vitest.timeouts.setup.ts` for hook-free lanes.
 *
 * Applies TEST_TIMEOUT_MULTIPLIER to @testing-library/dom's async utilities
 * (BST-1299) when the file's environment provides a DOM, and skips importing
 * the library in the node environment, where its `waitFor` and `findBy*`
 * cannot run: without a global document they throw instead of waiting.
 */
if (typeof document !== 'undefined') {
  await import('./vitest.timeouts.setup.js');
}

export {};

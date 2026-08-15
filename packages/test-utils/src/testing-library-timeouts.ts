import { configure } from '@testing-library/dom';

/**
 * The key `createBrowserProject` (@brainstrike/config) publishes through
 * `test.provide`, and `vitest.browser.setup.ts` reads back through `inject`.
 * Shared so the two ends cannot drift apart silently.
 */
export const ASYNC_UTIL_TIMEOUT_PROVIDE_KEY = 'asyncUtilTimeout';

/**
 * Applies an async-utility budget to @testing-library/dom.
 *
 * The DOM Testing Library keeps `asyncUtilTimeout` in module state, so this
 * MUST run in the same runtime (and against the same module instance) as the
 * tests it governs — hence a Vitest setup file rather than Vitest config.
 * There is no config-level knob for it: `configure()` is the only entry point.
 *
 * Throws rather than falling back on a malformed budget: a silently ignored
 * timeout is exactly the failure mode this plumbing exists to remove.
 */
export function configureAsyncUtilTimeout(asyncUtilTimeout: unknown): number {
  if (typeof asyncUtilTimeout !== 'number' || !Number.isFinite(asyncUtilTimeout)) {
    throw new TypeError(
      `Expected a finite asyncUtilTimeout in milliseconds, received ${JSON.stringify(asyncUtilTimeout)}. Browser-mode projects must publish it via test.provide.${ASYNC_UTIL_TIMEOUT_PROVIDE_KEY} (see createBrowserProject in @brainstrike/config).`
    );
  }
  if (asyncUtilTimeout <= 0) {
    throw new RangeError(
      `Expected a positive asyncUtilTimeout in milliseconds, received ${asyncUtilTimeout}.`
    );
  }
  configure({ asyncUtilTimeout });
  return asyncUtilTimeout;
}

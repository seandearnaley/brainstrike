/**
 * Browser-lane half of the TEST_TIMEOUT_MULTIPLIER plumbing for
 * @testing-library/dom's async utilities.
 *
 * Browser-mode tests execute in a real page where `process` is undefined, so
 * `getTimeoutMultiplier()` cannot be evaluated here. `createBrowserProject`
 * (@brainstrike/config) evaluates it in the Vitest config process and
 * publishes the resolved budget through `test.provide`; this setup file reads
 * it back with `inject` and applies it. A project that wires this setup file
 * without the matching `provide` entry gets a loud failure, not a 1s default.
 *
 * The shared Node setup (`vitest.setup.ts`) cannot be reused in browser mode —
 * it imports node:buffer / node:fs — which is why the browser lane had no
 * setup file at all, and therefore no way for the multiplier to reach
 * `waitFor` (BST-1299).
 */
import { inject } from 'vitest';
import {
  ASYNC_UTIL_TIMEOUT_PROVIDE_KEY,
  configureAsyncUtilTimeout,
} from './testing-library-timeouts.js';
import './vitest-provided-context.js';

configureAsyncUtilTimeout(inject(ASYNC_UTIL_TIMEOUT_PROVIDE_KEY));

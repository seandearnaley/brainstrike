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
import { beforeEach, inject } from 'vitest';
import {
  ASYNC_UTIL_TIMEOUT_PROVIDE_KEY,
  configureAsyncUtilTimeout,
} from './testing-library-timeouts.js';
import './vitest-provided-context.js';

configureAsyncUtilTimeout(inject(ASYNC_UTIL_TIMEOUT_PROVIDE_KEY));

// A real browser delivers input as events, so React schedules what an input
// causes the way the shipped app does. React's act environment is on only
// inside `act`, which Testing Library turns on for its own scopes, as in
// Vitest's own React renderer. Held open around an input, an act scope keeps
// back the very updates the browser waits on before it can deliver that input.
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false);
});

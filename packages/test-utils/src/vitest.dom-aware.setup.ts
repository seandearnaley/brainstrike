/**
 * Environment-keyed variant of `vitest.setup.ts`.
 *
 * In a DOM environment (jsdom, happy-dom) this loads exactly what
 * `vitest.setup.ts` loads: jest-dom matchers, the Testing Library async-util
 * timeout (BST-1299), React Testing Library cleanup and the window mocks. In the
 * node environment it skips that half, which saves every pure-logic file the
 * cost of importing the libraries. The hooks, polyfills and fetch wrapper in
 * `shared-test-setup.ts` apply in both.
 *
 * The rule follows the environment each file actually runs in (package default
 * or `// @vitest-environment` docblock), not a list of files, so DOM setup
 * cannot be dropped from a file that has a DOM. A node-environment file that
 * reaches for DOM testing fails loudly instead of passing vacuously: `render`
 * and `renderHook` throw on the missing `document`, `screen` queries and
 * `waitFor` throw because no global document is available, and jest-dom
 * matchers such as `toBeInTheDocument` are not registered, so Vitest reports an
 * invalid assertion.
 */
import { installSharedTestSetup } from './shared-test-setup.js';

const domCleanup =
  typeof document === 'undefined' ? undefined : (await import('./dom-test-setup.js')).cleanup;

installSharedTestSetup(domCleanup);

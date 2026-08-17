/**
 * Node-lane (jsdom / happy-dom) half of the TEST_TIMEOUT_MULTIPLIER plumbing
 * for @testing-library/dom's async utilities.
 *
 * `vitest.setup.ts` already imports this, so every project on the shared setup
 * gets it for free. Projects that deliberately run WITHOUT the shared setup
 * load '@brainstrike/test-utils/vitest.timeouts.setup' on its own — this module
 * registers no hooks and touches no globals beyond @testing-library/dom's own
 * config, which is the whole reason it is a separate file. Today that is
 * packages/settings-ui and packages/app-state (neither wants the shared
 * beforeEach/afterEach hooks) and packages/db (whose own vitest.setup.ts
 * imports it). A lane whose tests call waitFor/findBy* and loads NEITHER setup
 * is back on the library's unscalable 1s default — the BST-1299 defect.
 *
 * Browser-mode projects must NOT use this file — it reads `process.env`, which
 * does not exist in the browser page. They use `vitest.browser.setup.ts`.
 */
import { getAsyncUtilTimeout } from './test-timeouts.js';
import { configureAsyncUtilTimeout } from './testing-library-timeouts.js';

configureAsyncUtilTimeout(getAsyncUtilTimeout());

/**
 * Node-lane (jsdom / happy-dom) half of the TEST_TIMEOUT_MULTIPLIER plumbing
 * for @testing-library/dom's async utilities.
 *
 * `vitest.setup.ts` already imports this, so every project on the shared setup
 * gets it for free. Projects that deliberately run WITHOUT the shared setup
 * (`setupFiles: []`) can add '@brainstrike/test-utils/vitest.timeouts.setup'
 * on its own: this module registers no hooks and touches no globals beyond
 * @testing-library/dom's own config.
 *
 * Browser-mode projects must NOT use this file — it reads `process.env`, which
 * does not exist in the browser page. They use `vitest.browser.setup.ts`.
 */
import { getAsyncUtilTimeout } from './test-timeouts.js';
import { configureAsyncUtilTimeout } from './testing-library-timeouts.js';

configureAsyncUtilTimeout(getAsyncUtilTimeout());

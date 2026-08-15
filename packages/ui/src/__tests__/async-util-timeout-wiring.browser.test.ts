/**
 * BST-1299 — proves TEST_TIMEOUT_MULTIPLIER actually reaches
 * @testing-library/dom's `waitFor` inside this package's browser page.
 *
 * The twin of packages/assistant-ui's file, and deliberately not a substitute
 * for it: the hazard is a SECOND @testing-library/dom instance created by one
 * lane's Vite dependency optimizer, so the proof only covers the lane it runs
 * in. This package curates its own `optimizeDeps.include` (vitest.config.mts),
 * which is exactly the knob that can produce that split — `canvas-frame.browser
 * .test.tsx`'s `waitFor` calls would then keep the 1s default in silence.
 *
 * See `registerAsyncUtilTimeoutProof` for why the assertions time a failing
 * `waitFor` rather than only reading the config back.
 */
import { registerAsyncUtilTimeoutProof } from '@brainstrike/test-utils/async-util-timeout-proof';
// Imported through @testing-library/react on purpose: that is the entry point
// the real suites in this package use, and both symbols delegate straight to
// @testing-library/dom. If the setup file configured a different DOM Testing
// Library copy than the one behind this import, these assertions fail.
import { getConfig, waitFor } from '@testing-library/react';
import { describe, inject } from 'vitest';
// Types `inject('asyncUtilTimeout')`; Vitest's ProvidedContext is empty until
// something augments it, and the augmentation is owned by the publisher.
import '@brainstrike/test-utils/vitest-provided-context';

describe('browser-lane waitFor budget', () => {
  registerAsyncUtilTimeoutProof({
    getConfig,
    getInjectedBudget: () => inject('asyncUtilTimeout'),
    waitFor,
  });
});

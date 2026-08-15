/**
 * BST-1299 — proves TEST_TIMEOUT_MULTIPLIER actually reaches
 * @testing-library/dom's `waitFor` inside a real browser page.
 *
 * The assertions live in @brainstrike/test-utils so every browser lane proves
 * the same thing; see `registerAsyncUtilTimeoutProof` for why they time a
 * failing `waitFor` rather than only reading the config back. This lane's twin
 * is packages/ui/src/__tests__/async-util-timeout-wiring.browser.test.ts.
 *
 * It matters here because this is the lane the defect bit
 * (follow-up-queue-repin, a ResizeObserver -> layout -> scroll round-trip that
 * expired at 1s on a loaded runner), but the wiring under test is shared:
 * `createBrowserProject` in @brainstrike/config.
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

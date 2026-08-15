/**
 * BST-1299 — proves TEST_TIMEOUT_MULTIPLIER actually reaches
 * @testing-library/dom's `waitFor` inside a real browser page.
 *
 * A config edit like this is easy to make and easy to get wrong invisibly: the
 * budget can be applied to a DIFFERENT @testing-library/dom module instance
 * than the one the tests import (Vite pre-bundles some importers and not
 * others), in which case `configure()` runs, nothing throws, and every
 * `waitFor` in the lane quietly keeps the 1s default. So this file does not
 * stop at reading the config back — it times a `waitFor` that can never
 * succeed and checks the wall clock against it.
 *
 * It lives in assistant-ui because this is the lane the defect bit
 * (follow-up-queue-repin, a ResizeObserver -> layout -> scroll round-trip that
 * expired at 1s on a loaded runner), but the wiring under test is shared:
 * `createBrowserProject` in @brainstrike/config.
 */
// Imported through @testing-library/react on purpose: that is the entry point
// the real suites in this package use, and both symbols delegate straight to
// @testing-library/dom. If the setup file configured a different DOM Testing
// Library copy than the one behind this import, these assertions fail.
import { getConfig, waitFor } from '@testing-library/react';
import { describe, expect, inject, it } from 'vitest';
// Types `inject('asyncUtilTimeout')`; Vitest's ProvidedContext is empty until
// something augments it, and the augmentation is owned by the publisher.
import '@brainstrike/test-utils/vitest-provided-context';

describe('browser-lane waitFor budget', () => {
  it('carries the budget the Vitest config resolved from the multiplier', () => {
    // `inject` reads what createBrowserProject published via test.provide.
    // Equality here means the browser setup file ran AND reached the same
    // @testing-library/dom instance this test file imports.
    expect(getConfig().asyncUtilTimeout).toBe(inject('asyncUtilTimeout'));
  });

  it('governs how long a failing waitFor actually polls', async () => {
    const budget = getConfig().asyncUtilTimeout;
    const start = performance.now();

    await expect(
      waitFor(() => {
        throw new Error('condition that is never satisfied');
      })
    ).rejects.toThrow('condition that is never satisfied');

    const elapsed = performance.now() - start;
    // Lower bound only, and slack for timer granularity: the claim under test
    // is "waitFor read the budget we configured", not "it is punctual".
    expect(elapsed).toBeGreaterThanOrEqual(budget * 0.8);
    expect(elapsed).toBeLessThan(budget * 3);
  });
});

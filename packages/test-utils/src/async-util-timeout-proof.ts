/**
 * The BST-1299 browser-lane proof, shared so every browser project asserts the
 * SAME thing instead of drifting copies.
 *
 * A config edit like this is easy to make and easy to get wrong invisibly: the
 * budget can be applied to a DIFFERENT @testing-library/dom module instance
 * than the one the tests import (Vite pre-bundles some importers and not
 * others), in which case `configure()` runs, nothing throws, and every
 * `waitFor` in the lane quietly keeps the 1s default. So this does not stop at
 * reading the config back — it times a `waitFor` that can never succeed and
 * checks the wall clock against it.
 *
 * The lane passes in its OWN `getConfig`/`waitFor`, imported the way its real
 * suites import them. That is the load-bearing part: if this module imported
 * @testing-library itself, it would prove a fact about test-utils' copy rather
 * than about the copy the lane's tests actually call, which is precisely the
 * failure mode being ruled out.
 */
import { expect, it } from 'vitest';

export interface AsyncUtilTimeoutProofDeps {
  /** The lane's own `getConfig`, from the entry point its suites import. */
  getConfig: () => { asyncUtilTimeout: number };
  /** Reads `inject('asyncUtilTimeout')`; deferred so it runs inside a test. */
  getInjectedBudget: () => number;
  /** The lane's own `waitFor`, from the same entry point as `getConfig`. */
  waitFor: (callback: () => void) => Promise<unknown>;
}

/**
 * Registers the two assertions inside the caller's `describe` block.
 *
 * Call from a `*.browser.test.ts(x)` file in every browser project — a lane
 * without it can drop its `setupFiles` wiring and no test will notice.
 */
export function registerAsyncUtilTimeoutProof(deps: AsyncUtilTimeoutProofDeps): void {
  const { getConfig, getInjectedBudget, waitFor } = deps;

  it('carries the budget the Vitest config resolved from the multiplier', () => {
    // `inject` reads what createBrowserProject published via test.provide.
    // Equality here means the browser setup file ran AND reached the same
    // @testing-library/dom instance the calling test file imports.
    expect(getConfig().asyncUtilTimeout).toBe(getInjectedBudget());
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
}

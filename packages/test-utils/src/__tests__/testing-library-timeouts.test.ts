import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASYNC_UTIL_TIMEOUT, getAsyncUtilTimeout } from '../test-timeouts.js';
import {
  ASYNC_UTIL_TIMEOUT_PROVIDE_KEY,
  configureAsyncUtilTimeout,
} from '../testing-library-timeouts.js';

/**
 * Captured at module-evaluation time, i.e. AFTER this package's own
 * `setupFiles` ran and BEFORE any test below reconfigures the library. It is
 * the load-bearing observation in this file: it reads the REAL
 * @testing-library/dom config of the lane currently executing, so it fails if
 * the shared Vitest setup ever stops applying the budget — which is exactly
 * the defect BST-1299 fixed (nothing scaled `asyncUtilTimeout` at all).
 */
const budgetAppliedByTheSharedSetup = getConfig().asyncUtilTimeout;

describe('async-utility timeout wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Reflect.deleteProperty(process.env, 'CI');
    Reflect.deleteProperty(process.env, 'DEBUG');
    Reflect.deleteProperty(process.env, 'TEST_TIMEOUT_MULTIPLIER');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    // Leave the lane's own budget as the setup file left it.
    configureAsyncUtilTimeout(budgetAppliedByTheSharedSetup);
  });

  describe('getAsyncUtilTimeout', () => {
    it('returns the library default when no multiplier is configured', () => {
      expect(getAsyncUtilTimeout()).toBe(ASYNC_UTIL_TIMEOUT);
      expect(ASYNC_UTIL_TIMEOUT).toBe(1000);
    });

    it('scales with an explicit TEST_TIMEOUT_MULTIPLIER', () => {
      process.env['TEST_TIMEOUT_MULTIPLIER'] = '2';
      expect(getAsyncUtilTimeout()).toBe(2000);
    });

    it('scales with the implicit CI and DEBUG multipliers', () => {
      process.env['CI'] = 'true';
      expect(getAsyncUtilTimeout()).toBe(2000);

      Reflect.deleteProperty(process.env, 'CI');
      process.env['DEBUG'] = 'true';
      expect(getAsyncUtilTimeout()).toBe(5000);
    });

    it('stays well under the unit test timeout so waitFor reports first', () => {
      process.env['TEST_TIMEOUT_MULTIPLIER'] = '10';
      // Both sides scale by the same multiplier, so checking the extreme is
      // enough: waitFor must lose the race to Vitest's own timeout at NO
      // setting, or its "last failed assertion" message is replaced by a bare
      // "test timed out".
      expect(getAsyncUtilTimeout()).toBeLessThan(10_000 * 10);
    });
  });

  describe('configureAsyncUtilTimeout', () => {
    it('reaches the @testing-library/dom config that waitFor reads', () => {
      configureAsyncUtilTimeout(4321);
      expect(getConfig().asyncUtilTimeout).toBe(4321);
    });

    it('applies the unscaled budget at the default multiplier', () => {
      configureAsyncUtilTimeout(getAsyncUtilTimeout());
      expect(getConfig().asyncUtilTimeout).toBe(1000);
    });

    it('applies the scaled budget under a multiplier', () => {
      process.env['TEST_TIMEOUT_MULTIPLIER'] = '2';
      configureAsyncUtilTimeout(getAsyncUtilTimeout());
      expect(getConfig().asyncUtilTimeout).toBe(2000);
    });

    it.each([undefined, null, Number.NaN, '2000', {}])(
      'throws instead of falling back for %j',
      (invalid) => {
        expect(() => configureAsyncUtilTimeout(invalid)).toThrow(TypeError);
      }
    );

    it.each([0, -1])('throws for the non-positive budget %d', (invalid) => {
      expect(() => configureAsyncUtilTimeout(invalid)).toThrow(RangeError);
    });

    it('names the provide key browser projects must publish', () => {
      expect(ASYNC_UTIL_TIMEOUT_PROVIDE_KEY).toBe('asyncUtilTimeout');
      expect(() => configureAsyncUtilTimeout(undefined)).toThrow(
        /test\.provide\.asyncUtilTimeout/u
      );
    });
  });

  describe('the Node-lane setup file', () => {
    it('applied the multiplier-scaled budget to this very lane', () => {
      // Restored env: getAsyncUtilTimeout() here sees the same CI /
      // TEST_TIMEOUT_MULTIPLIER the setup file saw at load time.
      process.env = { ...originalEnv };
      expect(budgetAppliedByTheSharedSetup).toBe(getAsyncUtilTimeout());
    });

    it('scales with TEST_TIMEOUT_MULTIPLIER when re-evaluated under one', async () => {
      process.env['TEST_TIMEOUT_MULTIPLIER'] = '3';
      vi.resetModules();

      await import('../vitest.timeouts.setup.js');

      // @testing-library/dom is externalized, so the re-evaluated setup module
      // configures the SAME library instance this file imported — which is the
      // point: a budget applied to a duplicate copy would not be observable
      // here, and would not reach waitFor either.
      expect(getConfig().asyncUtilTimeout).toBe(3000);
    });

    it('is reached through the shared vitest.setup entry point', async () => {
      // Guards the one-line side-effect import in vitest.setup.ts: without it
      // every jsdom/happy-dom project in the repo silently keeps the
      // unscalable 1s default, which is how BST-1299 went unnoticed. Locally
      // (multiplier 1) the ambient assertion above cannot see that, because
      // the scaled budget and the library default coincide — this one can.
      //
      // STATIC on purpose. vitest.setup.ts is not a pure module: re-evaluating
      // it here would attach its beforeEach(resetStore)/afterEach(cleanup)
      // hooks to the root suite for every test that follows, re-run
      // expect.extend, re-apply its DOM polyfills, and double-wrap
      // globalThis.fetch (the `nativeFetch` capture would bind the already
      // wrapped one). The test above already proves the timeouts module works
      // when re-evaluated; all that is left to check is that vitest.setup
      // reaches it, and that is a fact about the source text.
      // A plain path, not `new URL(..., import.meta.url)`: this lane runs on
      // happy-dom, whose global `URL` is not node:fs's `URL`, so readFile
      // rejects it with "The URL must be of scheme file".
      const source = await readFile(join(import.meta.dirname, '..', 'vitest.setup.ts'), 'utf8');

      expect(source).toMatch(/^import '\.\/vitest\.timeouts\.setup\.js';$/mu);
    });
  });
});

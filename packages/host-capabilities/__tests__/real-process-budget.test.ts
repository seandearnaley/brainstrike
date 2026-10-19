/**
 * The package's Vitest hook and test timeouts scale with the real-process step
 * budget (BST-2157). At every supported multiplier, a cleanup's sequential
 * budgeted waits finish inside `hookTimeout`, so a cleanup that runs out fails
 * with its own error rather than Vitest's hook timeout.
 */
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';

// Loaded at run time, as Vitest loads it. A config is not part of this
// package's TypeScript program, and its imports name real `.ts` extensions.
const configUrl = pathToFileURL(`${import.meta.dirname}/../vitest.config.mts`).href;

/** The budget module and the package config, evaluated under the current env. */
async function load() {
  vi.resetModules();
  const budget = await import('./fixtures/real-process-budget.js');
  const { default: config }: { default: ViteUserConfig } = await import(configUrl);
  return { budget, config };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test.each(['1', '2', '10'])(
  'at TEST_TIMEOUT_MULTIPLIER=%s, hookTimeout covers cleanup and both timeouts scale together',
  async (multiplier) => {
    vi.stubEnv('TEST_TIMEOUT_MULTIPLIER', multiplier);
    const { budget, config } = await load();
    const step = 15_000 * Number(multiplier);
    expect(budget.REAL_PROCESS_TIMEOUT_MS).toBe(step);
    expect(config.test?.hookTimeout).toBe(budget.HOOK_TIMEOUT_MS);
    expect(config.test?.testTimeout).toBe(budget.TEST_TIMEOUT_MS);
    // The cleanup's worst case, with a whole step to spare.
    expect(budget.HOOK_TIMEOUT_MS).toBeGreaterThanOrEqual((budget.CLEANUP_STEPS + 1) * step);
    // A test runs several steps; it is never bounded below one.
    expect(budget.TEST_TIMEOUT_MS).toBeGreaterThan(step);
  }
);

test('DEBUG scales the same budgets', async () => {
  vi.stubEnv('TEST_TIMEOUT_MULTIPLIER', undefined);
  vi.stubEnv('CI', undefined);
  vi.stubEnv('DEBUG', '1');
  const { budget, config } = await load();
  expect(budget.REAL_PROCESS_TIMEOUT_MS).toBe(75_000);
  expect(config.test?.hookTimeout).toBeGreaterThanOrEqual(
    (budget.CLEANUP_STEPS + 1) * budget.REAL_PROCESS_TIMEOUT_MS
  );
});

import { vi } from 'vitest';

/**
 * Flushes pending microtasks. Call multiple times when effects schedule nested microtasks.
 */
export async function flushMicrotasks(times = 1) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/**
 * Runs all timers and then flushes microtasks. Useful with fake timers + React updates.
 */
export async function flushAllTimersAndMicrotasks(microtasks = 2) {
  await vi.runAllTimersAsync();
  await flushMicrotasks(microtasks);
}

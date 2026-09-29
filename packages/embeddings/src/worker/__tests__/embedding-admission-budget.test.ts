import { describe, expect, it } from 'vitest';
import { createEmbeddingAdmissionBudget } from '../embedding-admission-budget.js';

describe('embedding admission budget', () => {
  it('grants a partial batch atomically and returns permits only after release', async (): Promise<void> => {
    const budget = await createEmbeddingAdmissionBudget(3);
    expect(await budget.tryReserve(2)).toBe(2);
    expect(await budget.tryReserve(3)).toBe(1);
    expect(await budget.inFlight()).toBe(3);
    expect(await budget.tryReserve(1)).toBe(0);
    await budget.release(1);
    expect(await budget.tryReserve(3)).toBe(1);
    await budget.release(3);
    expect(await budget.inFlight()).toBe(0);
  });

  it('cancels a capacity wait without granting a permit', async (): Promise<void> => {
    const budget = await createEmbeddingAdmissionBudget(1);
    expect(await budget.tryReserve(1)).toBe(1);
    const stop = new AbortController();
    const waiting = budget.waitForAvailable(stop.signal);
    stop.abort(new Error('worker stopped'));
    await expect(waiting).rejects.toThrow('worker stopped');
    expect(await budget.inFlight()).toBe(1);
    await budget.release(1);
    expect(await budget.inFlight()).toBe(0);
  });

  it('commits concurrent partial reservations without exceeding capacity', async (): Promise<void> => {
    const budget = await createEmbeddingAdmissionBudget(4);
    const granted = await Promise.all(
      Array.from({ length: 16 }, (): Promise<number> => budget.tryReserve(3))
    );
    expect(granted.reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(granted.some((count) => count > 0 && count < 3)).toBe(true);
    expect(await budget.inFlight()).toBe(4);
    await budget.release(4);
  });

  it('wakes an availability wait only when a held permit returns', async (): Promise<void> => {
    const budget = await createEmbeddingAdmissionBudget(1);
    const stop = new AbortController();
    expect(await budget.tryReserve(1)).toBe(1);
    let woke = false;
    const waiting = budget.waitForAvailable(stop.signal).then((): void => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(false);
    await budget.release(1);
    await waiting;
    expect(woke).toBe(true);
    expect(await budget.inFlight()).toBe(0);
  });

  it('rejects over-release instead of silently capping the semaphore', async (): Promise<void> => {
    const budget = await createEmbeddingAdmissionBudget(2);
    await expect(budget.release(1)).rejects.toThrow('Invalid embedding in-flight budget release');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitRootRegistration,
  notifyRootRegistered,
  resetRootRegistrationEventsForTests,
} from '../roots/root-registration-events';

// BST-1400: the await-root-registration seam `use-roots-reconciliation.ts`
// publishes to and `use-workspace-bar.ts` awaits, replacing the 20x250ms
// database poll. Exercised standalone here — no React, no DB mock — because
// the contract is pure: a key becomes registered, and any waiter (before or
// after) learns about it, or is told LOUDLY that it never did.

describe('root-registration-events', () => {
  beforeEach(() => {
    resetRootRegistrationEventsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately for a key already registered before the wait starts', async () => {
    notifyRootRegistered(['adapter-1', '/ws/docs']);

    await expect(awaitRootRegistration('/ws/docs', { timeoutMs: 50 })).resolves.toBeUndefined();
    await expect(awaitRootRegistration('adapter-1', { timeoutMs: 50 })).resolves.toBeUndefined();
  });

  it('resolves a waiter that subscribed before the notification arrives, with no polling', async () => {
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { timeoutMs: 5000 });
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });

    // No interval churn: nothing about the waiter itself is time-driven until
    // either the notification arrives or the bounded timeout below fires.
    await vi.advanceTimersByTimeAsync(4000);
    expect(settled).toBe(false);

    notifyRootRegistered(['/ws/docs']);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(waiter).resolves.toBeUndefined();
  });

  it('wakes every waiter subscribed to the same key', async () => {
    const first = awaitRootRegistration('/ws/docs', { timeoutMs: 1000 });
    const second = awaitRootRegistration('/ws/docs', { timeoutMs: 1000 });

    notifyRootRegistered(['/ws/docs']);

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('never wakes a waiter for a different key', async () => {
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { timeoutMs: 200 });
    const outcome = waiter.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );

    notifyRootRegistered(['/ws/other']);
    await vi.advanceTimersByTimeAsync(200);

    expect(await outcome).toBe('rejected');
  });

  it('rejects loudly on timeout instead of hanging silently', async () => {
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/never', { timeoutMs: 1000 });
    const assertion = expect(waiter).rejects.toThrow(/Timed out after 1000ms.*\/ws\/never/);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('a later notification does not resolve a waiter that already timed out', async () => {
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { timeoutMs: 100 });
    const rejection = expect(waiter).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await rejection;

    // Should not throw or resurrect the settled promise.
    expect(() => notifyRootRegistered(['/ws/docs'])).not.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitRootRegistration,
  notifyRootRegistered,
  resetRootRegistrationEventsForTests,
  rootRegistrationSeq,
} from '../roots/root-registration-events';

// BST-1400: the await-root-registration seam `use-roots-reconciliation.ts`
// publishes to and `use-workspace-bar.ts` awaits, replacing the 20x250ms
// database poll. Exercised standalone here — no React, no DB mock — because
// the contract is pure: a key becomes registered, and any waiter (before or
// after) learns about it, or is told LOUDLY that it never did.
//
// EPOCH, not membership (post-review fix): a plain "was this key ever
// registered?" flag cannot tell a STALE registration from a fresh one, and a
// path CAN register twice in a session (remove a root, then re-add it —
// `use-workspace-bar.ts`'s docblock covers why that mints a fresh
// registration rather than a no-op). So every test below that models a
// waiter observing "not yet registered" passes an explicit `since` — usually
// `rootRegistrationSeq(key)` read at the same point a real caller's failed
// DB read would sit — rather than a bare `0`, and the re-registration tests
// are the ones that would have caught the membership-set bug.

describe('root-registration-events', () => {
  beforeEach(() => {
    resetRootRegistrationEventsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the generation observed is already behind the current one', async () => {
    notifyRootRegistered(['adapter-1', '/ws/docs']);

    await expect(
      awaitRootRegistration('/ws/docs', { since: 0, timeoutMs: 50 })
    ).resolves.toBeUndefined();
    await expect(
      awaitRootRegistration('adapter-1', { since: 0, timeoutMs: 50 })
    ).resolves.toBeUndefined();
  });

  it('resolves a waiter that subscribed before the notification arrives', async () => {
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { since: 0, timeoutMs: 5000 });
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });

    // Not settled while nothing has notified yet — this alone does not prove
    // there is no polling underneath (a setInterval re-checking the same
    // unregistered key would look identical from the outside); the real
    // no-interval-churn proof lives in use-workspace-bar.test.tsx, which
    // counts actual database reads during an equivalent window.
    await vi.advanceTimersByTimeAsync(4000);
    expect(settled).toBe(false);

    notifyRootRegistered(['/ws/docs']);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(waiter).resolves.toBeUndefined();
  });

  it('wakes every waiter subscribed to the same key', async () => {
    const first = awaitRootRegistration('/ws/docs', { since: 0, timeoutMs: 1000 });
    const second = awaitRootRegistration('/ws/docs', { since: 0, timeoutMs: 1000 });

    notifyRootRegistered(['/ws/docs']);

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('never wakes a waiter for a different key', async () => {
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { since: 0, timeoutMs: 200 });
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
    const waiter = awaitRootRegistration('/ws/never', { since: 0, timeoutMs: 1000 });
    const assertion = expect(waiter).rejects.toThrow(/Timed out after 1000ms.*\/ws\/never/);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('a later notification does not resolve a waiter that already timed out', async () => {
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { since: 0, timeoutMs: 100 });
    const rejection = expect(waiter).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await rejection;

    // Should not throw or resurrect the settled promise.
    expect(() => notifyRootRegistered(['/ws/docs'])).not.toThrow();
  });

  // --- Re-registration (the reviewed bug: remove-then-re-add a root) ---

  it('rootRegistrationSeq starts at 0 and strictly increases on each notification', () => {
    expect(rootRegistrationSeq('/ws/docs')).toBe(0);
    notifyRootRegistered(['/ws/docs']);
    expect(rootRegistrationSeq('/ws/docs')).toBe(1);
    notifyRootRegistered(['/ws/docs']);
    expect(rootRegistrationSeq('/ws/docs')).toBe(2);
  });

  it('does NOT resolve a waiter whose since already reflects the current generation — the exact membership-set bug', async () => {
    // First registration (models the original Add folder).
    notifyRootRegistered(['/ws/docs']);
    const since = rootRegistrationSeq('/ws/docs');
    expect(since).toBe(1);

    // A caller reads the current generation, THEN fails its own DB read (the
    // row was since removed), and now waits for a NEWER registration. A
    // membership-set implementation would have resolved this instantly off
    // the FIRST (stale) registration — that is precisely the bug this test
    // catches.
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { since, timeoutMs: 5000 });
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    // The re-add: a SECOND registration of the same path.
    notifyRootRegistered(['/ws/docs']);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(waiter).resolves.toBeUndefined();
  });

  it('resolves immediately for a since captured before a registration that already happened', async () => {
    // since=0 (nothing registered yet), but by the time awaitRootRegistration
    // is actually called, a registration already landed — the late-subscriber
    // case `recordAddedAsSecondary` depends on.
    notifyRootRegistered(['/ws/docs']);
    await expect(
      awaitRootRegistration('/ws/docs', { since: 0, timeoutMs: 50 })
    ).resolves.toBeUndefined();
  });

  it('a stale generation survives a resetRootRegistrationEventsForTests-style wipe the same way a factory reset would', async () => {
    // Models: register (gen 1) -> factory reset wipes the roots table but NOT
    // this module's counters (there is deliberately no resetter wired into
    // factory reset; see the module docblock) -> re-add mints a fresh
    // registration (gen 2). A waiter whose `since` reflects the PRE-reset
    // generation must still only resolve on the POST-reset registration, not
    // treat the pre-reset fact as good enough.
    notifyRootRegistered(['/ws/docs']);
    const preResetSeq = rootRegistrationSeq('/ws/docs');

    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { since: preResetSeq, timeoutMs: 5000 });
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    notifyRootRegistered(['/ws/docs']); // the post-"reset" re-registration
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});

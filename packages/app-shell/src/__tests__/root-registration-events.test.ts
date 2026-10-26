import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  notifyRootRegistered,
  onRootRegistered,
  resetRootRegistrationEventsForTests,
  rootRegistrationSeq,
} from '../roots/root-registration-events';

// BST-1400: the root-registration seam `use-roots-reconciliation.ts`
// publishes to and the root-scoped surfaces wait on. Exercised standalone
// here — no React, no DB mock — because the contract is pure: a key becomes
// registered, and any waiter (before or after) learns about it. Event-only:
// there is no deadline, so nothing here advances a clock.
//
// EPOCH, not membership (post-review fix): a plain "was this key ever
// registered?" flag cannot tell a STALE registration from a fresh one, and a
// path CAN register twice in a session (remove a root, then re-add it). So
// every test below that models a waiter observing "not yet registered" passes
// an explicit `since` — usually `rootRegistrationSeq(key)` read at the same
// point a real caller's failed request would sit — rather than a bare `0`,
// and the re-registration tests are the ones that would have caught the
// membership-set bug.

describe('root-registration-events', () => {
  beforeEach(() => {
    resetRootRegistrationEventsForTests();
  });

  it('wakes immediately when the generation observed is already behind the current one', () => {
    notifyRootRegistered(['adapter-1', '/ws/docs']);
    const wakePath = vi.fn();
    const wakeAdapter = vi.fn();

    onRootRegistered('/ws/docs', 0, wakePath);
    onRootRegistered('adapter-1', 0, wakeAdapter);

    expect(wakePath).toHaveBeenCalledTimes(1);
    expect(wakeAdapter).toHaveBeenCalledTimes(1);
  });

  it('wakes a waiter that subscribed before the notification arrives, exactly once', () => {
    const wake = vi.fn();
    onRootRegistered('/ws/docs', 0, wake);
    expect(wake).not.toHaveBeenCalled();

    notifyRootRegistered(['/ws/docs']);
    expect(wake).toHaveBeenCalledTimes(1);

    notifyRootRegistered(['/ws/docs']);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('wakes every waiter subscribed to the same key', () => {
    const first = vi.fn();
    const second = vi.fn();
    onRootRegistered('/ws/docs', 0, first);
    onRootRegistered('/ws/docs', 0, second);

    notifyRootRegistered(['/ws/docs']);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('never wakes a waiter for a different key', () => {
    const wake = vi.fn();
    onRootRegistered('/ws/docs', 0, wake);

    notifyRootRegistered(['/ws/other']);

    expect(wake).not.toHaveBeenCalled();
  });

  it('never wakes a waiter that was cancelled first', () => {
    const wake = vi.fn();
    const cancel = onRootRegistered('/ws/docs', 0, wake);

    cancel();
    notifyRootRegistered(['/ws/docs']);

    expect(wake).not.toHaveBeenCalled();
  });

  // --- Re-registration (the reviewed bug: remove-then-re-add a root) ---

  it('rootRegistrationSeq starts at 0 and strictly increases on each notification', () => {
    expect(rootRegistrationSeq('/ws/docs')).toBe(0);
    notifyRootRegistered(['/ws/docs']);
    expect(rootRegistrationSeq('/ws/docs')).toBe(1);
    notifyRootRegistered(['/ws/docs']);
    expect(rootRegistrationSeq('/ws/docs')).toBe(2);
  });

  // This is the SAME shape a post-factory-reset re-add takes (a stale `since`
  // must not be satisfied by a registration that predates it) — see
  // `register-factory-reset-session-stores.test.ts` for the test that drives
  // the REAL reset pipeline end to end and confirms this module's counters
  // are untouched by it, which is what makes a stale `since` here honestly
  // "pre-reset" rather than just "earlier this test".
  it('does NOT wake a waiter whose since already reflects the current generation — the exact membership-set bug', () => {
    // First registration (models the original Add folder).
    notifyRootRegistered(['/ws/docs']);
    const since = rootRegistrationSeq('/ws/docs');
    expect(since).toBe(1);

    // A caller reads the current generation, THEN fails its own request (the
    // row was since removed), and now waits for a NEWER registration. A
    // membership-set implementation would have woken this instantly off the
    // FIRST (stale) registration — that is precisely the bug this test
    // catches.
    const wake = vi.fn();
    onRootRegistered('/ws/docs', since, wake);
    expect(wake).not.toHaveBeenCalled();

    // The re-add: a SECOND registration of the same path.
    notifyRootRegistered(['/ws/docs']);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('wakes immediately for a since captured before a registration that already happened', () => {
    // since=0 (nothing registered yet), but by the time onRootRegistered is
    // actually called, a registration already landed — the late-subscriber
    // case a request racing reconciliation depends on.
    notifyRootRegistered(['/ws/docs']);
    const wake = vi.fn();
    onRootRegistered('/ws/docs', 0, wake);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

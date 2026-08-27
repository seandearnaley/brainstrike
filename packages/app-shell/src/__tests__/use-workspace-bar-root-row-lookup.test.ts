import type { DbHandle } from '@brainstrike/db/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRootIdAfterReconciliation } from '../hooks/use-workspace-bar-root-row-lookup';
import {
  notifyRootRegistered,
  resetRootRegistrationEventsForTests,
} from '../roots/root-registration-events';

// PR #2685 review (P2): `database.query` rejecting is NOT the same outcome as
// an authoritative "no live row" result. The original version of this lookup
// caught EVERY error the same way and sent the caller into the
// registration-event wait — correct for a genuine miss, wrong for a query
// failure, since no registration event is coming to wake a wait for a row
// that may already exist. These tests pin the distinction directly against
// the extracted pure function, no React involved.

const CANDIDATE = { displayName: 'docs', path: '/ws/docs' };
const NOT_CANCELLED = () => false;

describe('resolveRootIdAfterReconciliation — transient query failures', () => {
  beforeEach(() => {
    resetRootRegistrationEventsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient query rejection and resolves without ever waiting for registration', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ rows: [{ id: 'db-docs' }] });
    const database = { query } as unknown as DbHandle;

    await expect(
      resolveRootIdAfterReconciliation(database, CANDIDATE, NOT_CANCELLED)
    ).resolves.toEqual({ kind: 'resolved', rootId: 'db-docs' });
    // Exactly 2 calls: the failed attempt, then the retry that succeeded — no
    // extra reads, and critically no registration wait was ever entered (that
    // would need a `notifyRootRegistered` call to resolve, which this test
    // never makes).
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('surfaces a persistent query failure immediately instead of waiting out the registration-event timeout', async () => {
    vi.useFakeTimers();
    const persistentFailure = new Error('database unavailable');
    const query = vi.fn().mockRejectedValue(persistentFailure);
    const database = { query } as unknown as DbHandle;

    const lookup = resolveRootIdAfterReconciliation(database, CANDIDATE, NOT_CANCELLED);
    // Settles WITHOUT advancing the fake clock at all — proof this took the
    // fail-loud path, not the 5s registration wait (which would need either a
    // notifyRootRegistered call or a timer advance to resolve).
    await expect(lookup).resolves.toEqual({ error: persistentFailure, kind: 'unresolved' });
    // Bounded: the retry loop tried a fixed number of times and gave up,
    // rather than retrying forever or falling through to the wait.
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('still takes the registration-event wait for an authoritative row-absent result', async () => {
    // No rows: resolveAssistantOperatingRootBinding throws
    // AssistantOperatingRootRowNotFoundError, the ONE error this lookup may
    // treat as "not there yet, wait for a registration".
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'db-docs' }] });
    const database = { query } as unknown as DbHandle;

    const lookup = resolveRootIdAfterReconciliation(database, CANDIDATE, NOT_CANCELLED);
    // `since` is captured synchronously before this function's first await,
    // so announcing the registration right away (rather than after some
    // number of ticks) still satisfies the epoch-based wait once it runs —
    // the whole point of comparing generations instead of polling.
    notifyRootRegistered([CANDIDATE.path]);

    await expect(lookup).resolves.toEqual({ kind: 'resolved', rootId: 'db-docs' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

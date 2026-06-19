import { describe, expect, it } from 'vitest';
import {
  isBenignBackfillShutdownError,
  isDesktopShuttingDown,
  markDesktopShuttingDown,
} from '../desktop-shutdown-state';

const EMBEDDING_BACKFILL_CANCELED_MESSAGE = 'Embedding backfill was canceled.';

describe('isBenignBackfillShutdownError', () => {
  it('treats host/worker teardown signatures as benign shutdown stops', () => {
    // pino thread-stream emits this when its worker transport is torn down at
    // shutdown — the error that previously surfaced as "backfill failed".
    expect(isBenignBackfillShutdownError(new Error('the worker is ending'))).toBe(true);
    expect(isBenignBackfillShutdownError(new Error('embedding worker stopped'))).toBe(true);
    expect(isBenignBackfillShutdownError(new Error('worker terminated unexpectedly'))).toBe(true);
  });

  it('does NOT classify real backfill failures or cancellations as benign', () => {
    expect(isBenignBackfillShutdownError(new Error(EMBEDDING_BACKFILL_CANCELED_MESSAGE))).toBe(
      false
    );
    expect(isBenignBackfillShutdownError(new Error('embedding generation failed: OOM'))).toBe(
      false
    );
    expect(isBenignBackfillShutdownError(new Error('DB host request timed out'))).toBe(false);
    expect(isBenignBackfillShutdownError('the worker is ending')).toBe(false);
    expect(isBenignBackfillShutdownError(null)).toBe(false);
  });
});

describe('desktop shutdown flag', () => {
  // markDesktopShuttingDown is intentionally one-way (the process exits), so this
  // ordering — read default, then mark — must stay in this sequence.
  it('defaults to not shutting down, then latches on once marked', () => {
    expect(isDesktopShuttingDown()).toBe(false);
    markDesktopShuttingDown();
    expect(isDesktopShuttingDown()).toBe(true);
    markDesktopShuttingDown();
    expect(isDesktopShuttingDown()).toBe(true);
  });
});

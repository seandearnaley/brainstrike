import { describe, expect, it } from 'vitest';
import {
  isBenignBackfillShutdownError,
  isDesktopShuttingDown,
  isExpectedBackfillTeardown,
  markDesktopShuttingDown,
} from '../desktop-shutdown-state';

const EMBEDDING_BACKFILL_CANCELED_MESSAGE = 'Embedding backfill was canceled.';

describe('isBenignBackfillShutdownError', () => {
  it('treats ONLY the pino logger thread-stream teardown as benign anytime', () => {
    // pino thread-stream emits this when its worker transport is torn down — a
    // logging-infra artifact, never an embedding-worker failure.
    expect(isBenignBackfillShutdownError(new Error('the worker is ending'))).toBe(true);
  });

  it('does NOT treat a real embedding-worker crash as a benign logger teardown', () => {
    // "worker terminated"/"stopped" can be a REAL mid-session crash (e.g.
    // "Embedding worker terminated during an active stream"). Outside shutdown it
    // must surface as a failure, not be silenced by the benign pattern.
    expect(isBenignBackfillShutdownError(new Error('embedding worker stopped'))).toBe(false);
    expect(
      isBenignBackfillShutdownError(
        new Error('Embedding worker terminated during an active stream')
      )
    ).toBe(false);
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

// Runs BEFORE markDesktopShuttingDown() below — the one-way flag is still false
// here (see the ordering note on the shutdown-flag suite).
describe('isExpectedBackfillTeardown (app NOT shutting down)', () => {
  it('treats the logger thread-stream teardown as an expected stop', () => {
    expect(isExpectedBackfillTeardown(new Error('the worker is ending'))).toBe(true);
  });

  it('does NOT treat a real mid-session worker crash as expected outside shutdown', () => {
    // The regression the reviewers flagged: a real crash outside shutdown must
    // surface as a failure (logged error + UI error), not be silenced.
    expect(
      isExpectedBackfillTeardown(new Error('Embedding worker terminated during an active stream'))
    ).toBe(false);
    expect(isExpectedBackfillTeardown(new Error('embedding generation failed: OOM'))).toBe(false);
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

// Runs AFTER markDesktopShuttingDown() above — the flag is now latched on, so
// any backfill teardown error is an expected stop during the quit.
describe('isExpectedBackfillTeardown (app shutting down)', () => {
  it('treats any backfill teardown error as expected once shutting down', () => {
    expect(
      isExpectedBackfillTeardown(new Error('Embedding worker terminated during an active stream'))
    ).toBe(true);
    expect(isExpectedBackfillTeardown(new Error('embedding generation failed: OOM'))).toBe(true);
    expect(isExpectedBackfillTeardown(new Error('the worker is ending'))).toBe(true);
  });
});

import { BoundaryFailureError, fault, refusal } from '@brainstrike/assistant-contract';
import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import { describe, expect, it } from 'vitest';
import {
  isDesktopShuttingDown,
  isExpectedShutdownRefusal,
  isRetirementRefusal,
  markDesktopShuttingDown,
  RESET_REOPEN_CANCELLED,
} from '../desktop-shutdown-state';

// What a quit leaves waiting work with (ADR-0015), and what it never covers.
const retirements = {
  'a closed native index': new NativeIndexRefusalError(
    { kind: 'closed', reason: 'root-data-deletion' },
    'Native index activation is closed for terminal retirement.'
  ),
  'a lost host connection': new BoundaryFailureError(
    fault({ category: 'availability', code: 'host.connection-lost', message: 'Lost.' })
  ),
  'the reset reopen cancelled by quit': new BoundaryFailureError(RESET_REOPEN_CANCELLED),
};
const unrelated = {
  'a plain failure': new Error('Native index activation is closed for terminal retirement.'),
  'an indexer still transitioning': new NativeIndexRefusalError(
    { kind: 'transitioning' },
    'Native index is transitioning.'
  ),
  'another refusal': new BoundaryFailureError(
    refusal({ category: 'availability', code: 'host.busy', message: 'Busy.' })
  ),
};

describe('isRetirementRefusal', () => {
  it.each(Object.entries(retirements))('recognizes %s', (_name, error) => {
    expect(isRetirementRefusal(error)).toBe(true);
  });

  it.each(Object.entries(unrelated))('does not recognize %s', (_name, error) => {
    expect(isRetirementRefusal(error)).toBe(false);
  });
});

// Before markDesktopShuttingDown(): a retirement refusal is still a failure.
describe('isExpectedShutdownRefusal (app NOT shutting down)', () => {
  it.each(Object.entries(retirements))('keeps %s a failure', (_name, error) => {
    expect(isExpectedShutdownRefusal(error)).toBe(false);
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

// After markDesktopShuttingDown(): only the exact terminal cancellation is expected.
describe('isExpectedShutdownRefusal (app shutting down)', () => {
  it.each(Object.entries(retirements))('expects %s', (_name, error) => {
    expect(isExpectedShutdownRefusal(error)).toBe(true);
  });

  it.each(Object.entries(unrelated))('keeps %s a failure', (_name, error) => {
    expect(isExpectedShutdownRefusal(error)).toBe(false);
  });
});

import { BoundaryFailureError, fault, refusal } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  HOST_LEASE_CLOSED,
  isDesktopShuttingDown,
  isExpectedShutdownRefusal,
  isRetirementRefusal,
  markDesktopShuttingDown,
  PROFILE_CLOSED_FOR_QUIT,
  PROFILE_CLOSED_FOR_RESET,
  RESET_REOPEN_CANCELLED,
  RendererExitedError,
} from '../desktop-shutdown-state';

// What a quit leaves waiting work with (ADR-0015), and what it never covers.
const retirements = {
  'a host lease owner that closed': new BoundaryFailureError(HOST_LEASE_CLOSED),
  'a host profile closed for a reset': new BoundaryFailureError(PROFILE_CLOSED_FOR_RESET),
  'a host profile closed for quit': new BoundaryFailureError(PROFILE_CLOSED_FOR_QUIT),
  'a lost host connection': new BoundaryFailureError(
    fault({ category: 'availability', code: 'host.connection-lost', message: 'Lost.' })
  ),
  // BST-2285: a signal to Main's process group ends the renderers before their unload ACK.
  'a renderer that exited before acknowledging its producers': new RendererExitedError(
    'Renderer closed before acknowledging its producers'
  ),
  'the reset reopen cancelled by quit': new BoundaryFailureError(RESET_REOPEN_CANCELLED),
};
const unrelated = {
  'a plain failure': new Error('The app is quitting, so the agent host does not start.'),
  'a plain failure with the closing message': new Error('Desktop host lease owner is closing'),
  'a plain failure with the renderer exit message': new Error(
    'Renderer closed before acknowledging its producers'
  ),
  'a plain failure with the reset message': new Error('Local data is being reset.'),
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

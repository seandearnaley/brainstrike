import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottledSetState, createThrottledStateRef } from '../../src/throttled-state.js';

describe('throttled-state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createThrottledSetState', () => {
    it('emits first update immediately when no recent emit', () => {
      const setState = vi.fn();
      const throttled = createThrottledSetState(setState, { intervalMs: 100 });

      throttled.update('first');

      expect(setState).toHaveBeenCalledTimes(1);
      expect(setState).toHaveBeenCalledWith('first');
    });

    it('batches rapid updates within interval', () => {
      const setState = vi.fn();
      const throttled = createThrottledSetState(setState, { intervalMs: 100 });

      throttled.update('first');
      expect(setState).toHaveBeenCalledTimes(1);

      // These should be batched
      throttled.update('second');
      throttled.update('third');
      throttled.update('fourth');

      // Still only one call
      expect(setState).toHaveBeenCalledTimes(1);

      // Advance time past interval
      vi.advanceTimersByTime(100);

      // Now the last value should be emitted
      expect(setState).toHaveBeenCalledTimes(2);
      expect(setState).toHaveBeenLastCalledWith('fourth');
    });

    it('emits immediately after interval has passed', () => {
      const setState = vi.fn();
      const throttled = createThrottledSetState(setState, { intervalMs: 100 });

      throttled.update('first');
      expect(setState).toHaveBeenCalledTimes(1);

      // Advance time past interval
      vi.advanceTimersByTime(150);

      // Next update should emit immediately
      throttled.update('second');
      expect(setState).toHaveBeenCalledTimes(2);
      expect(setState).toHaveBeenLastCalledWith('second');
    });

    it('flush forces immediate emit of pending value', () => {
      const setState = vi.fn();
      const throttled = createThrottledSetState(setState, { intervalMs: 100 });

      throttled.update('first');
      throttled.update('second');
      throttled.update('third');

      expect(setState).toHaveBeenCalledTimes(1);

      throttled.flush();

      expect(setState).toHaveBeenCalledTimes(2);
      expect(setState).toHaveBeenLastCalledWith('third');
    });

    it('cancel discards pending update', () => {
      const setState = vi.fn();
      const throttled = createThrottledSetState(setState, { intervalMs: 100 });

      throttled.update('first');
      throttled.update('second');

      throttled.cancel();

      // Advance time - should not emit canceled value
      vi.advanceTimersByTime(200);

      expect(setState).toHaveBeenCalledTimes(1);
      expect(setState).toHaveBeenCalledWith('first');
    });

    it('getPending returns pending value', () => {
      const setState = vi.fn();
      const throttled = createThrottledSetState(setState, { intervalMs: 100 });

      expect(throttled.getPending()).toBeUndefined();

      throttled.update('first');
      // First is emitted immediately, no pending
      expect(throttled.getPending()).toBeUndefined();

      throttled.update('second');
      expect(throttled.getPending()).toBe('second');

      throttled.flush();
      expect(throttled.getPending()).toBeUndefined();
    });

    it('handles functional updates', () => {
      const setState = vi.fn();
      const throttled = createThrottledSetState<number>(setState, { intervalMs: 100 });

      throttled.update(0);
      expect(setState).toHaveBeenCalledWith(0);

      // Functional updates should chain on pending value
      throttled.update((prev) => (prev ?? 0) + 1);
      throttled.update((prev) => (prev ?? 0) + 1);
      throttled.update((prev) => (prev ?? 0) + 1);

      throttled.flush();

      // Should have chained: 0 -> 1 -> 2 -> 3
      expect(setState).toHaveBeenLastCalledWith(3);
    });
  });

  describe('createThrottledStateRef', () => {
    it('provides cleanup function that flushes and cancels', () => {
      const setState = vi.fn();
      const throttled = createThrottledStateRef(setState, { intervalMs: 100 });

      throttled.update('first');
      throttled.update('second');

      expect(setState).toHaveBeenCalledTimes(1);

      throttled.cleanup();

      // Flush should have been called
      expect(setState).toHaveBeenCalledTimes(2);
      expect(setState).toHaveBeenLastCalledWith('second');

      // After cleanup, no more updates should occur
      vi.advanceTimersByTime(200);
      expect(setState).toHaveBeenCalledTimes(2);
    });
  });
});

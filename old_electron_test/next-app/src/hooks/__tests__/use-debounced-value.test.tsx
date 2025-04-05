import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from '../use-debounced-value';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('should return the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('initial', 300));
    expect(result.current).toBe('initial');
  });

  it('should debounce value updates', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'first' },
    });

    // Initial value should be set immediately
    expect(result.current).toBe('first');

    // Update to a second value
    rerender({ value: 'second' });
    expect(result.current).toBe('first'); // Should still be first

    // Fast forward time
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe('second');
  });

  it('should handle multiple rapid changes', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'first' },
    });

    // Multiple rapid changes
    rerender({ value: 'second' });
    rerender({ value: 'third' });
    rerender({ value: 'fourth' });

    // Should still be first since no time has passed
    expect(result.current).toBe('first');

    // Advance time partially
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(result.current).toBe('first');

    // Complete the delay
    act(() => {
      jest.advanceTimersByTime(150);
    });
    // Should only have the final value
    expect(result.current).toBe('fourth');
  });

  it('should work with different delay values', () => {
    // Test with a short delay
    const { result: shortResult, rerender: shortRerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 50),
      { initialProps: { value: 'first' } }
    );

    shortRerender({ value: 'second' });
    act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(shortResult.current).toBe('second');

    // Test with a longer delay
    const { result: longResult, rerender: longRerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 1000),
      { initialProps: { value: 'first' } }
    );

    longRerender({ value: 'second' });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(longResult.current).toBe('first');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(longResult.current).toBe('second');
  });

  it('should handle cleanup on unmount', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'first' },
    });

    rerender({ value: 'second' });
    unmount();

    // Advance timers - no errors should occur
    act(() => {
      jest.advanceTimersByTime(300);
    });
  });

  it('should handle edge cases', () => {
    // Zero delay
    const { result: zeroResult } = renderHook(() => useDebouncedValue('test', 0));
    expect(zeroResult.current).toBe('test');

    // No changes after initial render
    const { result: stableResult } = renderHook(() => useDebouncedValue('stable', 300));
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(stableResult.current).toBe('stable');

    // Extremely small delay
    const { result: smallResult, rerender: smallRerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 1),
      { initialProps: { value: 'first' } }
    );
    smallRerender({ value: 'second' });
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(smallResult.current).toBe('second');
  });
});

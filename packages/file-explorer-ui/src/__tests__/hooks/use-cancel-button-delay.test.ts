import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCancelButtonDelay } from '../../hooks/use-cancel-button-delay';

describe('useCancelButtonDelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return false initially when not loading', () => {
    const { result } = renderHook(() => useCancelButtonDelay(false, false, false));

    expect(result.current).toBe(false);
  });

  it('should return false initially when loading but not cancellable', () => {
    const { result } = renderHook(() => useCancelButtonDelay(true, false, false));

    expect(result.current).toBe(false);
  });

  it('should return false initially when cancelling', () => {
    const { result } = renderHook(() => useCancelButtonDelay(true, true, true));

    expect(result.current).toBe(false);
  });

  it('should show cancel button after 2 second delay when loading and cancellable', () => {
    const { result } = renderHook(() => useCancelButtonDelay(true, true, false));

    // Initially should be false
    expect(result.current).toBe(false);

    // Advance time by 1.9 seconds - still should be false
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(result.current).toBe(false);

    // Advance time to 2 seconds - should now be true
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(true);
  });

  it('should hide cancel button when loading stops', () => {
    const { result, rerender } = renderHook(
      ({ isLoading, cancellable, isCancelling }) =>
        useCancelButtonDelay(isLoading, cancellable, isCancelling),
      { initialProps: { cancellable: true, isCancelling: false, isLoading: true } }
    );

    // Wait for button to appear
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(true);

    // Stop loading
    rerender({ cancellable: true, isCancelling: false, isLoading: false });
    expect(result.current).toBe(false);
  });

  it('should hide cancel button when cancelling starts', () => {
    const { result, rerender } = renderHook(
      ({ isLoading, cancellable, isCancelling }) =>
        useCancelButtonDelay(isLoading, cancellable, isCancelling),
      { initialProps: { cancellable: true, isCancelling: false, isLoading: true } }
    );

    // Wait for button to appear
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(true);

    // Start cancelling
    rerender({ cancellable: true, isCancelling: true, isLoading: true });
    expect(result.current).toBe(false);
  });

  it('should clear timer when cancellable becomes false', () => {
    const { result, rerender } = renderHook(
      ({ isLoading, cancellable, isCancelling }) =>
        useCancelButtonDelay(isLoading, cancellable, isCancelling),
      { initialProps: { cancellable: true, isCancelling: false, isLoading: true } }
    );

    // Advance part way
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Make not cancellable
    rerender({ cancellable: false, isCancelling: false, isLoading: true });

    // Advance past what would have been the delay
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // Should still be false because timer was cleared
    expect(result.current).toBe(false);
  });

  it('should restart timer when conditions change back to loading and cancellable', () => {
    const { result, rerender } = renderHook(
      ({ isLoading, cancellable, isCancelling }) =>
        useCancelButtonDelay(isLoading, cancellable, isCancelling),
      { initialProps: { cancellable: true, isCancelling: false, isLoading: false } }
    );

    expect(result.current).toBe(false);

    // Start loading
    rerender({ cancellable: true, isCancelling: false, isLoading: true });

    // Advance time
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current).toBe(true);
  });
});

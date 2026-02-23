import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEventCallback } from '../use-event-callback';

describe('useEventCallback', () => {
  it('returns a stable function identity across rerenders', () => {
    const callback = vi.fn();
    const { result, rerender } = renderHook(() => useEventCallback(callback));

    const initialHandler = result.current;
    rerender();

    expect(result.current).toBe(initialHandler);
  });

  it('invokes the latest callback after rerender', () => {
    const initialCallback = vi.fn((_value: string) => 'initial');
    const updatedCallback = vi.fn((_value: string) => 'updated');

    const { result, rerender } = renderHook(
      ({ callback }: { callback: (value: string) => string }) => useEventCallback(callback),
      { initialProps: { callback: initialCallback } }
    );

    rerender({ callback: updatedCallback });

    let returnValue = '';
    act(() => {
      returnValue = result.current('next');
    });

    expect(returnValue).toBe('updated');
    expect(updatedCallback).toHaveBeenCalledWith('next');
    expect(initialCallback).not.toHaveBeenCalled();
  });
});

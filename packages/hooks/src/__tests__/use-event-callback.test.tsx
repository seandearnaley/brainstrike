import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEventCallback } from '../use-event-callback.js';

describe('useEventCallback', () => {
  it('returns a stable function that invokes the initial callback', () => {
    const callback = vi.fn(() => 42);
    const { result, rerender } = renderHook(() => useEventCallback(callback));

    const first = result.current;

    let returnValue: number | undefined;
    act(() => {
      returnValue = result.current();
    });

    expect(returnValue).toBe(42);
    expect(callback).toHaveBeenCalledTimes(1);

    // Reference identity must be stable across rerenders
    rerender();
    expect(result.current).toBe(first);
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

  it('forwards arguments to the underlying callback', () => {
    const callback = vi.fn((a: number, b: string) => `${a}-${b}`);
    const { result } = renderHook(() => useEventCallback(callback));

    let ret: string | undefined;
    act(() => {
      ret = result.current(1, 'x');
    });

    expect(ret).toBe('1-x');
    expect(callback).toHaveBeenCalledWith(1, 'x');
  });
});

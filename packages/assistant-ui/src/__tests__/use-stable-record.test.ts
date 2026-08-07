import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStableRecord } from '../use-stable-record';

describe('useStableRecord', () => {
  it('returns the previous identity when the record is shallow-equal', () => {
    const { rerender, result } = renderHook(({ value }) => useStableRecord(value), {
      initialProps: { value: { a: 1, b: 2 } as Record<string, number> },
    });
    const first = result.current;

    rerender({ value: { a: 1, b: 2 } });
    expect(result.current).toBe(first);
  });

  it('returns the new record when a value changed', () => {
    const { rerender, result } = renderHook(({ value }) => useStableRecord(value), {
      initialProps: { value: { a: 1 } as Record<string, number> },
    });
    const first = result.current;

    rerender({ value: { a: 2 } });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ a: 2 });
  });

  it('returns the new record when keys were added or removed', () => {
    const { rerender, result } = renderHook(({ value }) => useStableRecord(value), {
      initialProps: { value: { a: 1 } as Record<string, number> },
    });

    rerender({ value: { a: 1, b: 2 } });
    expect(result.current).toEqual({ a: 1, b: 2 });

    const withB = result.current;
    rerender({ value: { a: 1 } });
    expect(result.current).not.toBe(withB);
    expect(result.current).toEqual({ a: 1 });
  });
});

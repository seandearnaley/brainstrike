import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStableSet } from '../use-stable-set';

describe('useStableSet', () => {
  it('returns the first set by identity', () => {
    const initial = new Set(['alpha']);

    const { result } = renderHook(() => useStableSet(initial));

    expect(result.current).toBe(initial);
  });

  it('retains the previous identity for equal membership', () => {
    const initial = new Set(['alpha', 'beta']);
    const equalWithDifferentInsertionOrder = new Set(['beta', 'alpha']);
    const { rerender, result } = renderHook(
      ({ value }: { value: Set<string> }) => useStableSet(value),
      { initialProps: { value: initial } }
    );

    rerender({ value: equalWithDifferentInsertionOrder });

    expect(result.current).toBe(initial);
  });

  it('advances identity when membership changes and retains that identity afterward', () => {
    const initial = new Set(['alpha']);
    const changed = new Set(['alpha', 'beta']);
    const equalToChanged = new Set(['beta', 'alpha']);
    const { rerender, result } = renderHook(
      ({ value }: { value: Set<string> }) => useStableSet(value),
      { initialProps: { value: initial } }
    );

    rerender({ value: changed });
    expect(result.current).toBe(changed);

    rerender({ value: equalToChanged });
    expect(result.current).toBe(changed);
  });

  it('does not add an extra render pass when membership changes', () => {
    let renderCount = 0;
    const initial = new Set(['alpha']);
    const changed = new Set(['alpha', 'beta']);
    const { rerender } = renderHook(
      ({ value }: { value: Set<string> }) => {
        renderCount += 1;
        return useStableSet(value);
      },
      { initialProps: { value: initial } }
    );
    const rendersBeforeMembershipChange = renderCount;

    rerender({ value: changed });

    expect(renderCount).toBe(rendersBeforeMembershipChange + 1);
  });
});

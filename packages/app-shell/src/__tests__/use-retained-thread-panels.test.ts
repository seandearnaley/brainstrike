import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRetainedThreadPanels } from '../use-retained-thread-panels';

const THREADS: ReadonlyMap<string, unknown> = new Map([
  ['a', {}],
  ['b', {}],
  ['c', {}],
]);

interface Props {
  readonly open: readonly string[];
  readonly resourceId: string;
}

function renderRetained(initial: Props) {
  return renderHook(
    ({ open, resourceId }: Props) => useRetainedThreadPanels(resourceId, open, THREADS),
    { initialProps: initial }
  );
}

/**
 * The close event: the store drops the tab and the workspace reports the removed
 * ids in the same batch, so one render sees both (an effect-based latch would
 * unmount the panel first).
 */
function closeRunningThreadB(
  result: ReturnType<typeof renderRetained>['result'],
  rerender: ReturnType<typeof renderRetained>['rerender'],
  resourceId: string
): void {
  act(() => {
    result.current.onRunningChange('b', true);
  });
  act(() => {
    result.current.onTabsRemoved(['b']);
    rerender({ open: ['a'], resourceId });
  });
}

describe('useRetainedThreadPanels', () => {
  it('retains the panel of a running thread whose tab was removed', () => {
    const { rerender, result } = renderRetained({ open: ['a', 'b'], resourceId: 'r1' });

    closeRunningThreadB(result, rerender, 'r1');

    expect(result.current.mountedThreadIds).toEqual(['a', 'b']);
  });

  it('drops a retained thread from the set once it is reopened', () => {
    const { rerender, result } = renderRetained({ open: ['a', 'b'], resourceId: 'r1' });
    closeRunningThreadB(result, rerender, 'r1');

    rerender({ open: ['a', 'b'], resourceId: 'r1' });
    // A removal that never passes through `onTabsRemoved` (a direct store close
    // action, a delete): with the reopened thread still in the set, its tabless
    // panel would stay mounted, hidden, forever.
    rerender({ open: ['a'], resourceId: 'r1' });

    expect(result.current.mountedThreadIds).toEqual(['a']);
  });

  it('keeps a retained thread through tab changes that do not reopen it', () => {
    const { rerender, result } = renderRetained({ open: ['a', 'b'], resourceId: 'r1' });
    closeRunningThreadB(result, rerender, 'r1');

    rerender({ open: ['a', 'c'], resourceId: 'r1' });

    expect(result.current.mountedThreadIds).toEqual(['a', 'b', 'c']);
  });

  it('resets the retained set when the resource changes', () => {
    const { rerender, result } = renderRetained({ open: ['a', 'b'], resourceId: 'r1' });
    closeRunningThreadB(result, rerender, 'r1');

    rerender({ open: ['a'], resourceId: 'r2' });

    expect(result.current.mountedThreadIds).toEqual(['a']);
  });
});

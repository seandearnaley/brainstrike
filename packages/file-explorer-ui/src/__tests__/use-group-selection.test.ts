import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useGroupSelection } from '../hooks/use-group-selection';
import type { GroupedData } from '../utils/grouping-configs';

interface Item {
  id: string;
}

const itemA: Item = { id: 'a' };
const itemB: Item = { id: 'b' };
const itemC: Item = { id: 'c' };

const group1: GroupedData<Item> = {
  count: 2,
  groupKey: 'g1',
  groupLabel: 'Group 1',
  items: [itemA, itemB],
  totalSize: 0,
  totalTokens: 0,
};

const allItems = [itemA, itemB, itemC];

function useTestHook(initial: string[] = []) {
  const [selections, setSelections] = useState(new Set(initial));
  return {
    selections,
    ...useGroupSelection<Item>({
      getItemKey: (item) => item.id,
      onSelectionChange: setSelections,
      selections,
    }),
  };
}

describe('useGroupSelection', () => {
  it('handles group and item selection/deselection', () => {
    const { result } = renderHook(() => useTestHook());

    act(() => {
      result.current.handleGroupSelectAll(group1);
    });
    expect(Array.from(result.current.selections)).toEqual(['a', 'b']);

    act(() => {
      result.current.toggleItemSelection('c', true);
    });
    expect(Array.from(result.current.selections)).toEqual(['a', 'b', 'c']);

    act(() => {
      result.current.handleGroupDeselectAll(group1);
    });
    expect(Array.from(result.current.selections)).toEqual(['c']);

    act(() => {
      result.current.toggleItemSelection('c', false);
    });
    expect(result.current.selections.size).toBe(0);
  });

  it('correctly reports group selection state and all selected', () => {
    const { result } = renderHook(() => useTestHook());

    expect(result.current.isGroupFullySelected(group1)).toBe(false);
    expect(result.current.isGroupPartiallySelected(group1)).toBe(false);
    expect(result.current.isAllSelected(allItems)).toBe(false);

    act(() => {
      result.current.toggleItemSelection('a', true);
    });
    expect(result.current.isGroupFullySelected(group1)).toBe(false);
    expect(result.current.isGroupPartiallySelected(group1)).toBe(true);
    expect(result.current.isAllSelected(allItems)).toBe(false);

    act(() => {
      result.current.toggleItemSelection('b', true);
    });
    act(() => {
      result.current.toggleItemSelection('c', true);
    });
    expect(result.current.isGroupFullySelected(group1)).toBe(true);
    expect(result.current.isGroupPartiallySelected(group1)).toBe(false);
    expect(result.current.isAllSelected(allItems)).toBe(true);
  });

  it('selectAll, selectAllOnPage and deselectAll update selections', () => {
    const { result } = renderHook(() => useTestHook());

    act(() => {
      result.current.selectAllOnPage([itemA, itemB]);
    });
    expect(Array.from(result.current.selections)).toEqual(['a', 'b']);

    act(() => {
      result.current.selectAll(allItems);
    });
    expect(Array.from(result.current.selections)).toEqual(['a', 'b', 'c']);

    act(() => {
      result.current.deselectAll();
    });
    expect(result.current.selections.size).toBe(0);
  });

  it('handles empty group correctly', () => {
    const emptyGroup: GroupedData<Item> = {
      count: 0,
      groupKey: 'empty',
      groupLabel: 'Empty',
      items: [],
      totalSize: 0,
      totalTokens: 0,
    };

    const { result } = renderHook(() => useTestHook());

    expect(result.current.isGroupFullySelected(emptyGroup)).toBe(false);
    expect(result.current.isGroupPartiallySelected(emptyGroup)).toBe(false);
  });

  it('handles empty items list for isAllSelected', () => {
    const { result } = renderHook(() => useTestHook());

    expect(result.current.isAllSelected([])).toBe(false);
  });

  it('selectAllOnPage preserves existing selections', () => {
    const { result } = renderHook(() => useTestHook(['c']));

    act(() => {
      result.current.selectAllOnPage([itemA, itemB]);
    });

    expect(Array.from(result.current.selections).sort()).toEqual(['a', 'b', 'c']);
  });

  it('handleGroupSelectAll preserves existing selections', () => {
    const { result } = renderHook(() => useTestHook(['c']));

    act(() => {
      result.current.handleGroupSelectAll(group1);
    });

    expect(Array.from(result.current.selections).sort()).toEqual(['a', 'b', 'c']);
  });

  it('toggleItemSelection handles repeated operations', () => {
    const { result } = renderHook(() => useTestHook());

    act(() => {
      result.current.toggleItemSelection('a', true);
    });
    expect(result.current.selections.has('a')).toBe(true);

    act(() => {
      result.current.toggleItemSelection('a', true);
    });
    expect(result.current.selections.has('a')).toBe(true);

    act(() => {
      result.current.toggleItemSelection('a', false);
    });
    expect(result.current.selections.has('a')).toBe(false);

    act(() => {
      result.current.toggleItemSelection('a', false);
    });
    expect(result.current.selections.has('a')).toBe(false);
  });

  it('isGroupPartiallySelected returns false when all selected', () => {
    const { result } = renderHook(() => useTestHook(['a', 'b']));

    expect(result.current.isGroupPartiallySelected(group1)).toBe(false);
    expect(result.current.isGroupFullySelected(group1)).toBe(true);
  });

  it('selectAll replaces existing selection completely', () => {
    const { result } = renderHook(() => useTestHook(['a', 'b', 'c']));

    act(() => {
      result.current.selectAll([itemA]);
    });

    expect(Array.from(result.current.selections)).toEqual(['a']);
  });

  it('handleGroupDeselectAll only removes group items', () => {
    const { result } = renderHook(() => useTestHook(['a', 'b', 'c']));

    act(() => {
      result.current.handleGroupDeselectAll(group1);
    });

    expect(Array.from(result.current.selections)).toEqual(['c']);
  });
});

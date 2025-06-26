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
  groupKey: 'g1',
  groupLabel: 'Group 1',
  items: [itemA, itemB],
  count: 2,
  totalTokens: 0,
  totalSize: 0,
};

const allItems = [itemA, itemB, itemC];

function useTestHook(initial: string[] = []) {
  const [selections, setSelections] = useState(new Set(initial));
  return {
    selections,
    ...useGroupSelection<Item>({
      selections,
      onSelectionChange: setSelections,
      getItemKey: (item) => item.id,
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
});

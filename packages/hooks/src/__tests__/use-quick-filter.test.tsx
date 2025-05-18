import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useQuickFilter } from '../use-quick-filter';
import type { IFileNode } from '@brainstrike/types';

// Mock the debounced hook to return the filter immediately
vi.mock('../use-debounced-value', () => ({
  useDebouncedValue: (value: string) => value,
}));

describe('useQuickFilter', () => {
  const mockTree: IFileNode[] = [
    {
      type: 'directory',
      name: 'src',
      path: 'src',
      children: [
        { type: 'file', name: 'foo.txt', path: 'src/foo.txt' },
        { type: 'file', name: 'bar.txt', path: 'src/bar.txt' },
      ],
    },
  ];

  it('returns original tree when filter is empty', () => {
    const { result } = renderHook(() => useQuickFilter(mockTree));
    expect(result.current.filteredTree).toEqual(mockTree);
  });

  it('filters by include term', () => {
    const { result } = renderHook(() => useQuickFilter(mockTree));
    act(() => {
      result.current.setQuickFilter('foo');
    });
    const filtered = result.current.filteredTree;
    expect(filtered).toHaveLength(1);
    const srcNode = filtered[0];
    const children = srcNode.children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0].name).toBe('foo.txt');
  });

  it('handles multiple include terms (OR logic)', () => {
    const { result } = renderHook(() => useQuickFilter(mockTree));
    act(() => {
      result.current.setQuickFilter('foo bar');
    });
    const children = result.current.filteredTree[0].children ?? [];
    expect(children).toHaveLength(2);
  });

  it('handles exclusion patterns', () => {
    const { result } = renderHook(() => useQuickFilter(mockTree));
    act(() => {
      result.current.setQuickFilter('-bar');
    });
    const children = result.current.filteredTree[0].children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0].name).toBe('foo.txt');
  });

  it('clears the filter', () => {
    const { result } = renderHook(() => useQuickFilter(mockTree));
    act(() => {
      result.current.setQuickFilter('foo');
    });
    expect(result.current.quickFilter).toBe('foo');
    act(() => {
      result.current.clearFilter();
    });
    expect(result.current.quickFilter).toBe('');
    expect(result.current.filteredTree).toEqual(mockTree);
  });
});

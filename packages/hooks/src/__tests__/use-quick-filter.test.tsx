import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useQuickFilter } from '../use-quick-filter';

// Mock the debounced hook to return the filter immediately
vi.mock('../use-debounced-value', () => ({
  useDebouncedValue: (value: string) => value,
}));

describe('useQuickFilter', () => {
  const dummyHandle = {} as FileSystemFileHandle;
  const dummyDirHandle = {} as FileSystemDirectoryHandle;
  const fileNode = (name: string, path: string): IFileNode => ({
    type: 'file',
    name,
    path,
    handle: dummyHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
  });
  const dirNode = (name: string, path: string, children: IFileNode[]): IFileNode => ({
    type: 'directory',
    name,
    path,
    handle: dummyDirHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    children,
  });
  const mockTree: IFileNode[] = [
    dirNode('src', 'src', [fileNode('foo.txt', 'src/foo.txt'), fileNode('bar.txt', 'src/bar.txt')]),
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

  it('performs quickly on large trees', () => {
    const largeChildren = Array.from({ length: 5000 }, (_, i) =>
      fileNode(`file${i}.txt`, `src/file${i}.txt`)
    );
    const largeTree: IFileNode[] = [dirNode('src', 'src', largeChildren)];

    const { result } = renderHook(() => useQuickFilter(largeTree));

    const start = performance.now();
    act(() => {
      result.current.setQuickFilter('file4999');
    });
    const duration = performance.now() - start;

    const children = result.current.filteredTree[0].children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0].name).toBe('file4999.txt');
    expect(duration).toBeLessThan(200);
  });
});

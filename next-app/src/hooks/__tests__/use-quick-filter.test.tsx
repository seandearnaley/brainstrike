import type { IFileNode } from '@/lib/file/types';
import { createDirectoryNode, createFileNode } from '@/test/factories/file-node';
import { act, renderHook } from '@testing-library/react';
import { useQuickFilter } from '../use-quick-filter';

describe('useQuickFilter', () => {
  let mockFileTree: IFileNode[];

  beforeEach(() => {
    jest.useFakeTimers();
    // Create a fresh copy of the mock tree for each test
    mockFileTree = [
      createDirectoryNode({
        name: 'src',
        path: 'src',
        children: [
          createDirectoryNode({
            name: 'components',
            path: 'src/components',
            children: [
              createFileNode({
                name: 'Button.tsx',
                path: 'src/components/Button.tsx',
              }),
              createFileNode({
                name: 'Button.test.tsx',
                path: 'src/components/Button.test.tsx',
              }),
            ],
          }),
          createDirectoryNode({
            name: 'utils',
            path: 'src/utils',
            children: [
              createFileNode({
                name: 'helper.ts',
                path: 'src/utils/helper.ts',
              }),
            ],
          }),
        ],
      }),
    ];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return unfiltered tree when filter is empty', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));
    expect(result.current.filteredTree).toEqual(mockFileTree);
  });

  it('should filter files based on single term', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('button');
    });

    // Wait for debounce
    act(() => {
      jest.runAllTimers();
    });

    const filteredFiles = result.current.filteredTree[0].children?.[0].children;
    expect(filteredFiles).toHaveLength(2);
    expect(filteredFiles?.[0].name).toBe('Button.tsx');
    expect(filteredFiles?.[1].name).toBe('Button.test.tsx');
  });

  it('should handle multiple terms with OR logic', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('button helper');
    });

    // Wait for debounce
    act(() => {
      jest.runAllTimers();
    });

    // Should find both Button files and helper.ts
    const componentFiles = result.current.filteredTree[0].children?.[0].children;
    const utilFiles = result.current.filteredTree[0].children?.[1].children;

    expect(componentFiles).toHaveLength(2);
    expect(utilFiles).toHaveLength(1);
    expect(utilFiles?.[0].name).toBe('helper.ts');
  });

  it('should handle exclusion patterns', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('button -test');
    });

    // Wait for debounce
    act(() => {
      jest.runAllTimers();
    });

    const filteredFiles = result.current.filteredTree[0].children?.[0].children;
    expect(filteredFiles).toHaveLength(1);
    expect(filteredFiles?.[0].name).toBe('Button.tsx');
  });

  it('should be case insensitive', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('BUTTON');
    });

    // Wait for debounce
    act(() => {
      jest.runAllTimers();
    });

    const filteredFiles = result.current.filteredTree[0].children?.[0].children;
    expect(filteredFiles).toHaveLength(2);
  });

  it('should clear filter', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('button');
    });

    // Wait for debounce
    act(() => {
      jest.runAllTimers();
    });

    act(() => {
      result.current.clearFilter();
    });

    // Wait for debounce after clearing
    act(() => {
      jest.runAllTimers();
    });

    expect(result.current.quickFilter).toBe('');
    expect(result.current.filteredTree).toEqual(mockFileTree);
  });

  it('should preserve directory structure when children match', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('helper');
    });

    // Wait for debounce
    act(() => {
      jest.runAllTimers();
    });

    // Should keep the directory structure intact, but only for matching paths
    const filteredTree = result.current.filteredTree;
    expect(filteredTree[0].name).toBe('src');
    // Only the utils directory should be present since it contains the matching file
    expect(filteredTree[0].children).toHaveLength(1);
    expect(filteredTree[0].children?.[0].name).toBe('utils');
    expect(filteredTree[0].children?.[0].children).toHaveLength(1);
    expect(filteredTree[0].children?.[0].children?.[0].name).toBe('helper.ts');
  });
});

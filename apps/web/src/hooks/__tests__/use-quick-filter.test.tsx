import { useQuickFilter } from '@brainstrike/file-explorer-hooks';
import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryNode, createFileNode } from '../../test/factories/file-node';

// Mock the useDebouncedValue hook
vi.mock('@brainstrike/hooks', () => ({
  useDebouncedValue: vi.fn((value) => value), // Return the value immediately for tests
}));

describe('useQuickFilter', () => {
  let mockFileTree: IFileNode[];

  beforeEach(() => {
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
                name: 'Navbar.jsx',
                path: 'src/components/Navbar.jsx',
              }),
            ],
          }),
          createDirectoryNode({
            name: 'utils',
            path: 'src/utils',
            children: [
              createFileNode({
                name: 'helpers.ts',
                path: 'src/utils/helpers.ts',
              }),
            ],
          }),
        ],
      }),
    ];
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

    const srcDir = result.current.filteredTree[0];
    expect(srcDir).toBeDefined();
    const componentsDir = srcDir?.children?.[0];
    expect(componentsDir).toBeDefined(); // Assert components dir exists
    expect(componentsDir?.children).toBeDefined(); // Assert components children exist
    expect(componentsDir?.children).toHaveLength(1);
    const buttonFile = componentsDir?.children?.[0];
    expect(buttonFile).toBeDefined(); // Assert file exists
    expect(buttonFile?.name).toBe('Button.tsx');
  });

  it('should handle multiple terms with OR logic', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('button navbar');
    });

    // Both Button.tsx and Navbar.jsx should match
    const srcDir = result.current.filteredTree[0];
    expect(srcDir).toBeDefined();
    const componentsDir = srcDir?.children?.[0];
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.children).toBeDefined();
    expect(componentsDir?.children).toHaveLength(2);
  });

  it('should handle exclusion patterns', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('components -button');
    });

    // Should match components directory but exclude Button.tsx
    const srcDir = result.current.filteredTree[0];
    expect(srcDir).toBeDefined();
    const componentsDir = srcDir?.children?.[0];
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.name).toBe('components');
    expect(componentsDir?.children).toBeDefined();
    expect(componentsDir?.children).toHaveLength(1);
    const navbarFile = componentsDir?.children?.[0];
    expect(navbarFile).toBeDefined();
    expect(navbarFile?.name).toBe('Navbar.jsx');
  });

  it('should be case insensitive', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('BUTTON');
    });

    const srcDir = result.current.filteredTree[0];
    expect(srcDir).toBeDefined();
    const componentsDir = srcDir?.children?.[0];
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.children).toBeDefined();
    expect(componentsDir?.children).toHaveLength(1);
    const buttonFile = componentsDir?.children?.[0];
    expect(buttonFile).toBeDefined();
    expect(buttonFile?.name).toBe('Button.tsx');
  });

  it('should clear filter', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('button');
    });

    // Verify filter is applied
    expect(result.current.quickFilter).toBe('button');

    act(() => {
      result.current.clearFilter();
    });

    // Filter should be cleared
    expect(result.current.quickFilter).toBe('');
    expect(result.current.filteredTree).toEqual(mockFileTree);

    act(() => {
      result.current.setQuickFilter('button');
    });

    // Src directory should still be present
    const srcDir = result.current.filteredTree[0];
    expect(srcDir).toBeDefined();
    expect(srcDir?.name).toBe('src');

    // Components directory should be preserved since it has a matching child
    const componentsDir = srcDir?.children?.[0];
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.name).toBe('components');

    // Utils directory should not be included since no children match
    expect(srcDir?.children).toHaveLength(1);
  });

  it('should preserve directory structure when children match', () => {
    const { result } = renderHook(() => useQuickFilter(mockFileTree));

    act(() => {
      result.current.setQuickFilter('button');
    });

    // Src directory should still be present
    const srcDir = result.current.filteredTree[0];
    expect(srcDir).toBeDefined();
    expect(srcDir?.name).toBe('src');

    // Components directory should be preserved since it has a matching child
    const componentsDir = srcDir?.children?.[0];
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.name).toBe('components');

    // Utils directory should not be included since no children match
    expect(srcDir?.children).toHaveLength(1);
  });
});

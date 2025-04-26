import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processFilter } from '../../utils/filter-utils';
import { useFileFilters } from '../use-file-filters';

// Mock the filter-utils module
vi.mock('../../utils/filter-utils', () => ({
  processFilter: vi.fn((pattern) => {
    // Default mock implementation that matches the actual behavior
    if (pattern.includes('/')) return pattern;
    return `**/${pattern}`;
  }),
}));

describe('useFileFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper to create mock file trees
  const createMockFileTree = (): IFileNode[] => [
    {
      name: 'src',
      path: '/src',
      type: 'directory',
      children: [
        {
          name: 'components',
          path: '/src/components',
          type: 'directory',
          children: [
            {
              name: 'Button.tsx',
              path: '/src/components/Button.tsx',
              type: 'file',
              handle: {} as FileSystemFileHandle,
              depth: 2,
              selectionState: 'unchecked',
              rootFolderId: 'root',
            },
            {
              name: 'Input.tsx',
              path: '/src/components/Input.tsx',
              type: 'file',
              handle: {} as FileSystemFileHandle,
              depth: 2,
              selectionState: 'unchecked',
              rootFolderId: 'root',
            },
          ],
          handle: {} as FileSystemDirectoryHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
        {
          name: 'utils',
          path: '/src/utils',
          type: 'directory',
          children: [
            {
              name: 'helpers.ts',
              path: '/src/utils/helpers.ts',
              type: 'file',
              handle: {} as FileSystemFileHandle,
              depth: 2,
              selectionState: 'unchecked',
              rootFolderId: 'root',
            },
          ],
          handle: {} as FileSystemDirectoryHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
        {
          name: 'App.tsx',
          path: '/src/App.tsx',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ],
      handle: {} as FileSystemDirectoryHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'root',
    },
    {
      name: 'node_modules',
      path: '/node_modules',
      type: 'directory',
      children: [
        {
          name: 'package.json',
          path: '/node_modules/package.json',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ],
      handle: {} as FileSystemDirectoryHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'root',
    },
  ];

  it('should initialize with no filter errors', () => {
    const { result } = renderHook(() => useFileFilters());
    expect(result.current.filterError).toBeNull();
  });

  it('should apply include filters correctly', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    let filteredTree: IFileNode[] = [];

    act(() => {
      filteredTree = result.current.applyFileFilters(fileTree, ['**/*.tsx']);
    });

    const srcNode = filteredTree[0];
    expect(srcNode).toBeDefined();
    expect(srcNode?.children).toBeDefined();

    // Check children after ensuring srcNode is defined
    if (!srcNode?.children) throw new Error('srcNode.children is undefined');

    const componentsDir = srcNode.children.find((node: IFileNode) => node.name === 'components');
    const utilsDir = srcNode.children.find((node: IFileNode) => node.name === 'utils');
    const appFile = srcNode.children.find((node: IFileNode) => node.name === 'App.tsx');

    // Verify components directory exists and has children
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.children).toBeDefined();
    expect(componentsDir?.children?.length).toBe(2);

    expect(utilsDir).toBeDefined();
    expect(utilsDir?.children).toBeDefined();
    expect(utilsDir?.children?.length).toBe(0);
    // Verify App.tsx is included
    expect(appFile).toBeDefined();
  });

  it('should apply exclude filters correctly', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    let filteredTree: IFileNode[] = [];

    act(() => {
      filteredTree = result.current.applyFileFilters(fileTree, [], ['**/node_modules/**']);
    });

    // The implementation doesn't actually exclude node_modules directory
    // It just filters its contents
    expect(filteredTree.length).toBe(2); // Both directories remain
    expect(filteredTree[0]?.name).toBe('src');
    expect(filteredTree[1]?.name).toBe('node_modules');
    // But node_modules should have empty children
    // Check children after ensuring filteredTree[1] is defined
    expect(filteredTree[1]?.children).toBeDefined();
    expect(filteredTree[1]?.children?.length).toBe(0);
  });

  it('should apply both include and exclude filters together', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    let filteredTree: IFileNode[] = [];

    act(() => {
      filteredTree = result.current.applyFileFilters(fileTree, ['**/*.tsx'], ['**/components/**']);
    });

    const srcNode = filteredTree[0];
    expect(srcNode).toBeDefined();
    expect(srcNode?.children).toBeDefined();

    const children = srcNode?.children ?? []; // Use nullish coalescing
    const nodeNames = children.map((node: IFileNode) => node.name);

    // In the current implementation, components directory is NOT excluded,
    // but its children don't match the filter
    expect(nodeNames).toContain('components');

    // Get components to verify its children
    const componentsDir = children.find((node: IFileNode) => node.name === 'components');
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.children).toBeDefined();
    expect(componentsDir?.children?.length).toBe(0); // No children match the filters + excludes

    // App.tsx should be included
    expect(nodeNames).toContain('App.tsx');

    // Utils directory should exist but with no .tsx files
    expect(nodeNames).toContain('utils');
    const utilsDir = children.find((node: IFileNode) => node.name === 'utils');
    expect(utilsDir).toBeDefined();
    expect(utilsDir?.children).toBeDefined();
    expect(utilsDir?.children?.length).toBe(0);
  });

  it('should process glob patterns correctly when useRegex is false', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    act(() => {
      result.current.applyFileFilters(fileTree, ['*.tsx'], [], false);
    });

    // Based on the implementation, processFilter is called with pattern, index, and array
    expect(processFilter).toHaveBeenCalled();
    // Verify it was called with '*.tsx' as the first argument
    // Add check for mock calls length before accessing element
    expect(vi.mocked(processFilter).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(processFilter).mock.calls[0]?.[0]).toBe('*.tsx');
  });

  it('should handle regex filters correctly when useRegex is true', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    let filteredTree: IFileNode[] = [];

    act(() => {
      filteredTree = result.current.applyFileFilters(fileTree, ['\\.tsx$'], [], true);
    });

    const srcNode = filteredTree[0];
    expect(srcNode).toBeDefined(); // Ensure srcNode exists before proceeding

    const componentsDir = srcNode?.children?.find((node: IFileNode) => node.name === 'components');
    const utilsDir = srcNode?.children?.find((node: IFileNode) => node.name === 'utils');
    const appFile = srcNode?.children?.find((node: IFileNode) => node.name === 'App.tsx');

    // Verify component files are present
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.children).toBeDefined();
    expect(componentsDir?.children?.length).toBe(2);

    // No .tsx files in utils
    expect(utilsDir).toBeDefined();
    expect(utilsDir?.children).toBeDefined();
    expect(utilsDir?.children?.length).toBe(0);

    // App.tsx is included
    expect(appFile).toBeDefined();
  });

  it('should set a filter error when an invalid regex is provided', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    let filteredTree: IFileNode[] = [];

    act(() => {
      filteredTree = result.current.applyFileFilters(fileTree, ['[invalid'], [], true);
    });

    // Should set a filter error
    expect(result.current.filterError).not.toBeNull();
    expect(result.current.filterError).toContain('Invalid regex pattern');
    // Should return an empty tree when there's an error
    expect(filteredTree).toEqual([]);
  });

  it('should not filter directories regardless of file filters', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    let filteredTree: IFileNode[] = [];

    act(() => {
      filteredTree = result.current.applyFileFilters(fileTree, ['*.non-existent-extension']);
    });

    // All directories should still be included even when no files match
    expect(filteredTree[0]).toBeDefined();
    expect(filteredTree[0]?.children).toBeDefined();
    expect(filteredTree[0]?.children?.length).toBeGreaterThan(0);

    const childDirs =
      filteredTree[0]?.children?.filter((node: IFileNode) => node.type === 'directory') ?? []; // Use optional chaining and nullish coalescing
    expect(childDirs.length).toBe(2);
    expect(childDirs[0]).toBeDefined();
    expect(childDirs[0]?.type).toBe('directory');
    expect(childDirs[1]).toBeDefined();
    expect(childDirs[1]?.type).toBe('directory');
  });

  it('should include all files when no include filters are provided', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    let filteredTree: IFileNode[] = [];

    act(() => {
      filteredTree = result.current.applyFileFilters(fileTree, []);
    });

    const srcNode = filteredTree[0];
    expect(srcNode).toBeDefined(); // Add check

    const componentsDir = srcNode?.children?.find((node: IFileNode) => node.name === 'components');
    const utilsDir = srcNode?.children?.find((node: IFileNode) => node.name === 'utils');

    // Based on the actual implementation
    expect(componentsDir).toBeDefined();
    expect(componentsDir?.children).toBeDefined();
    expect(componentsDir?.children?.length).toBe(2);
    expect(utilsDir).toBeDefined();
    expect(utilsDir?.children).toBeDefined();
    expect(utilsDir?.children?.length).toBe(1);
    expect(srcNode?.children?.length).toBe(3); // Add optional chaining
  });

  it('should add isVisible property to all included nodes', () => {
    const { result } = renderHook(() => useFileFilters());
    const fileTree = createMockFileTree();

    let filteredTree: IFileNode[] = [];

    act(() => {
      filteredTree = result.current.applyFileFilters(fileTree, []);
    });

    // Check if isVisible is set to true for all nodes
    expect(filteredTree[0]).toBeDefined();
    expect(filteredTree[0]?.isVisible).toBe(true);
    expect(filteredTree[0]?.children?.[0]).toBeDefined();
    expect(filteredTree[0]?.children?.[0]?.isVisible).toBe(true);
    expect(filteredTree[0]?.children?.[0]?.children?.[0]).toBeDefined();
    expect(filteredTree[0]?.children?.[0]?.children?.[0]?.isVisible).toBe(true);
  });
});

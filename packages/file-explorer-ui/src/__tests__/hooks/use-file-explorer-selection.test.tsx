import type { IFileNode } from '@brainstrike/types';
import { renderHook } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFileExplorerSelection } from '../../hooks/use-file-explorer-selection';

// Mock the selection manager context
const mockSelectedFilePaths = new Set<string>();
const mockHandleSelectionChange = vi.fn();

vi.mock('../../shell/use-selection-manager-context', () => ({
  useSelectionManager: () => ({
    selectedFilePaths: mockSelectedFilePaths,
    handleSelectionChange: mockHandleSelectionChange,
  }),
}));

// Create a wrapper to provide necessary context
const createWrapper = () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return Wrapper;
};

// Helper to create a mock file node with all required properties
const createMockFileNode = (
  overrides: Partial<IFileNode> & { name: string; path: string; type: 'file' | 'directory' }
): IFileNode => ({
  handle: {} as FileSystemFileHandle,
  depth: 0,
  selectionState: 'unchecked',
  rootFolderId: 'root-1',
  ...overrides,
});

describe('useFileExplorerSelection', () => {
  const createMockParams = (overrides = {}) => ({
    quickFilteredTree: null,
    ...overrides,
  });

  beforeEach(() => {
    mockSelectedFilePaths.clear();
    mockHandleSelectionChange.mockClear();
  });

  it('should return selectedFilePaths from context', () => {
    mockSelectedFilePaths.add('/path/to/file.ts');

    const params = createMockParams();
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.selectedFilePaths).toBe(mockSelectedFilePaths);
  });

  it('should return handleSelectionChange from context', () => {
    const params = createMockParams();
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.handleSelectionChange).toBe(mockHandleSelectionChange);
  });

  it('should return empty displayedFiles when quickFilteredTree is null', () => {
    const params = createMockParams({ quickFilteredTree: null });
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.displayedFiles.size).toBe(0);
  });

  it('should return empty displayedFiles when quickFilteredTree is empty array', () => {
    const params = createMockParams({ quickFilteredTree: [] });
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.displayedFiles.size).toBe(0);
  });

  it('should include visible files in displayedFiles', () => {
    const fileTree: IFileNode[] = [
      createMockFileNode({
        name: 'file1.ts',
        path: '/root/file1.ts',
        type: 'file',
        isVisible: true,
      }),
      createMockFileNode({
        name: 'file2.ts',
        path: '/root/file2.ts',
        type: 'file',
        isVisible: true,
      }),
    ];

    const params = createMockParams({ quickFilteredTree: fileTree });
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.displayedFiles.size).toBe(2);
    expect(result.current.displayedFiles.has('/root/file1.ts')).toBe(true);
    expect(result.current.displayedFiles.has('/root/file2.ts')).toBe(true);
  });

  it('should exclude hidden files from displayedFiles', () => {
    const fileTree: IFileNode[] = [
      createMockFileNode({
        name: 'visible.ts',
        path: '/root/visible.ts',
        type: 'file',
        isVisible: true,
      }),
      createMockFileNode({
        name: 'hidden.ts',
        path: '/root/hidden.ts',
        type: 'file',
        isVisible: false,
      }),
    ];

    const params = createMockParams({ quickFilteredTree: fileTree });
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.displayedFiles.size).toBe(1);
    expect(result.current.displayedFiles.has('/root/visible.ts')).toBe(true);
    expect(result.current.displayedFiles.has('/root/hidden.ts')).toBe(false);
  });

  it('should include files without isVisible property (defaults to visible)', () => {
    const fileTree: IFileNode[] = [
      createMockFileNode({
        name: 'file.ts',
        path: '/root/file.ts',
        type: 'file',
        // isVisible not set, should default to visible
      }),
    ];

    const params = createMockParams({ quickFilteredTree: fileTree });
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.displayedFiles.size).toBe(1);
    expect(result.current.displayedFiles.has('/root/file.ts')).toBe(true);
  });

  it('should traverse nested directories to find files', () => {
    const fileTree: IFileNode[] = [
      createMockFileNode({
        name: 'src',
        path: '/root/src',
        type: 'directory',
        children: [
          createMockFileNode({
            name: 'file1.ts',
            path: '/root/src/file1.ts',
            type: 'file',
            isVisible: true,
            depth: 1,
          }),
          createMockFileNode({
            name: 'components',
            path: '/root/src/components',
            type: 'directory',
            depth: 1,
            children: [
              createMockFileNode({
                name: 'Button.tsx',
                path: '/root/src/components/Button.tsx',
                type: 'file',
                isVisible: true,
                depth: 2,
              }),
            ],
          }),
        ],
      }),
    ];

    const params = createMockParams({ quickFilteredTree: fileTree });
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.displayedFiles.size).toBe(2);
    expect(result.current.displayedFiles.has('/root/src/file1.ts')).toBe(true);
    expect(result.current.displayedFiles.has('/root/src/components/Button.tsx')).toBe(true);
  });

  it('should not include directories in displayedFiles', () => {
    const fileTree: IFileNode[] = [
      createMockFileNode({
        name: 'src',
        path: '/root/src',
        type: 'directory',
        isVisible: true,
        children: [],
      }),
    ];

    const params = createMockParams({ quickFilteredTree: fileTree });
    const { result } = renderHook(() => useFileExplorerSelection(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.displayedFiles.size).toBe(0);
    expect(result.current.displayedFiles.has('/root/src')).toBe(false);
  });

  it('should update displayedFiles when quickFilteredTree changes', () => {
    const initialTree: IFileNode[] = [
      createMockFileNode({
        name: 'file1.ts',
        path: '/root/file1.ts',
        type: 'file',
        isVisible: true,
      }),
    ];

    const { result, rerender } = renderHook(
      ({ quickFilteredTree }) => useFileExplorerSelection({ quickFilteredTree }),
      { initialProps: { quickFilteredTree: initialTree }, wrapper: createWrapper() }
    );

    expect(result.current.displayedFiles.size).toBe(1);

    const newTree: IFileNode[] = [
      createMockFileNode({
        name: 'file1.ts',
        path: '/root/file1.ts',
        type: 'file',
        isVisible: true,
      }),
      createMockFileNode({
        name: 'file2.ts',
        path: '/root/file2.ts',
        type: 'file',
        isVisible: true,
      }),
    ];

    rerender({ quickFilteredTree: newTree });

    expect(result.current.displayedFiles.size).toBe(2);
  });
});

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
    handleSelectionChange: mockHandleSelectionChange,
    selectedFilePaths: mockSelectedFilePaths,
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
  depth: 0,
  handle: {} as FileSystemFileHandle,
  rootFolderId: 'root-1',
  selectionState: 'unchecked',
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
        isVisible: true,
        name: 'file1.ts',
        path: '/root/file1.ts',
        type: 'file',
      }),
      createMockFileNode({
        isVisible: true,
        name: 'file2.ts',
        path: '/root/file2.ts',
        type: 'file',
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
        isVisible: true,
        name: 'visible.ts',
        path: '/root/visible.ts',
        type: 'file',
      }),
      createMockFileNode({
        isVisible: false,
        name: 'hidden.ts',
        path: '/root/hidden.ts',
        type: 'file',
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
        children: [
          createMockFileNode({
            depth: 1,
            isVisible: true,
            name: 'file1.ts',
            path: '/root/src/file1.ts',
            type: 'file',
          }),
          createMockFileNode({
            children: [
              createMockFileNode({
                depth: 2,
                isVisible: true,
                name: 'Button.tsx',
                path: '/root/src/components/Button.tsx',
                type: 'file',
              }),
            ],
            depth: 1,
            name: 'components',
            path: '/root/src/components',
            type: 'directory',
          }),
        ],
        name: 'src',
        path: '/root/src',
        type: 'directory',
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
        children: [],
        isVisible: true,
        name: 'src',
        path: '/root/src',
        type: 'directory',
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
        isVisible: true,
        name: 'file1.ts',
        path: '/root/file1.ts',
        type: 'file',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ quickFilteredTree }) => useFileExplorerSelection({ quickFilteredTree }),
      { initialProps: { quickFilteredTree: initialTree }, wrapper: createWrapper() }
    );

    expect(result.current.displayedFiles.size).toBe(1);

    const newTree: IFileNode[] = [
      createMockFileNode({
        isVisible: true,
        name: 'file1.ts',
        path: '/root/file1.ts',
        type: 'file',
      }),
      createMockFileNode({
        isVisible: true,
        name: 'file2.ts',
        path: '/root/file2.ts',
        type: 'file',
      }),
    ];

    rerender({ quickFilteredTree: newTree });

    expect(result.current.displayedFiles.size).toBe(2);
  });
});

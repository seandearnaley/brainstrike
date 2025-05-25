import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFileTree } from '../use-file-tree-context';
import { FileExplorerTestWrapper } from './test-helpers';

describe('useFileTree (context version)', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
  });

  it('initializes with empty state when handle is null', () => {
    const { result } = renderHook(() => useFileTree(null), { wrapper: FileExplorerTestWrapper });

    expect(result.current.fileTree).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.loadingProgress).toEqual({ loaded: 0, total: 0, phase: 'counting' });
  });

  it('loads a simple directory structure', async () => {
    // Set up the mock file system data
    const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
    mockAdapter.setMockFileSystem(mockFS);

    // Get a proper DirectoryHandle from the adapter
    const handle = await mockAdapter.requestDirectoryAccess();

    // Create a wrapper function that passes the mock adapter
    const TestWrapper = ({ children }: { children: ReactNode }) => {
      return FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });
    };

    const { result } = renderHook(() => useFileTree(handle), {
      wrapper: TestWrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const names = result.current.fileTree.map((n) => n.name);
    expect(names).toEqual(['src', 'package.json', 'README.md']);
    expect(result.current.loadingProgress.loaded).toBeGreaterThan(0);
    expect(result.current.loadingProgress.phase).toBe('loading');

    await act(async () => {
      await expect(result.current.refreshTree()).resolves.not.toThrow();
    });
  });
});

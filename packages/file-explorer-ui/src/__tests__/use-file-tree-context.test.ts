import {
  type DirectoryHandle,
  type MockFileEntry,
  MockFileSystemAdapter,
} from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFileTree } from '../use-file-tree-context';
import { FileExplorerTestWrapper } from './test-helpers';

function createDirectoryHandleFromMockFS(fs: Record<string, MockFileEntry>): DirectoryHandle {
  type MockEntry = MockFileEntry;

  function createDirHandle(
    name: string,
    children: Record<string, MockEntry>
  ): FileSystemDirectoryHandle {
    return {
      kind: 'directory',
      name,
      async *entries() {
        for (const [childName, entry] of Object.entries(children)) {
          if (entry.type === 'directory') {
            yield [childName, createDirHandle(childName, entry.children ?? {})] as [
              string,
              FileSystemHandle,
            ];
          } else {
            yield [childName, { kind: 'file', name: childName } as unknown as FileSystemHandle];
          }
        }
      },
    } as unknown as FileSystemDirectoryHandle;
  }

  const rootInternal = createDirHandle('mock-root', fs as Record<string, MockEntry>);

  return {
    path: 'mock-root',
    name: 'mock-root',
    kind: 'directory',
    platform: 'web',
    _internal: rootInternal,
  };
}

describe('useFileTree (context version)', () => {
  it('initializes with empty state when handle is null', () => {
    const { result } = renderHook(() => useFileTree(null), { wrapper: FileExplorerTestWrapper });

    expect(result.current.fileTree).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.loadingProgress).toEqual({ loaded: 0, total: 0, phase: 'counting' });
  });

  it('loads a simple directory structure', async () => {
    const mockFS = MockFileSystemAdapter.createSimpleFileSystem();
    const handle = createDirectoryHandleFromMockFS(mockFS);

    const { result } = renderHook(() => useFileTree(handle), { wrapper: FileExplorerTestWrapper });

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

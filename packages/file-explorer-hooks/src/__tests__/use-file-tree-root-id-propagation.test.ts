/**
 * Regression coverage for durable RootId propagation across recursive
 * traversal (see docs/agents/workspace-context.md, "DIRECTORY HANDLE
 * `rootId` PROPAGATION"). Split out from use-file-tree.test.ts, which is at
 * the repo's max-lines-per-file cap.
 */
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTree } from '../use-file-tree.js';
import { AdaptersTestWrapper, MockFileSystemAdapter } from './test-helpers.js';

describe('useFileTree rootId propagation across recursive traversal', () => {
  let mockDirectoryHandle: DirectoryHandle;

  beforeEach(() => {
    MockFileSystemAdapter.clearMockData();
    mockDirectoryHandle = {
      kind: 'directory',
      name: 'root',
      path: 'root',
      platform: 'web',
    };
  });

  it('inherits the root handle rootId when a child directory handle is unstamped', async () => {
    const rootWithId: DirectoryHandle = { ...mockDirectoryHandle, rootId: 'outer-root-id' };
    const childDir: IFileNode = {
      children: [],
      depth: 1,
      handle: { kind: 'directory', name: 'directory' } as FileSystemDirectoryHandle,
      name: 'child',
      path: 'child',
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'directory',
    };
    MockFileSystemAdapter.setMockDirectoryData('root', [childDir]);
    MockFileSystemAdapter.setMockDirectoryData('child', []);
    const readDirectorySpy = vi.spyOn(MockFileSystemAdapter.prototype, 'readDirectory');

    const { result } = renderHook(() => useFileTree(rootWithId), {
      wrapper: AdaptersTestWrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(readDirectorySpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'child', rootId: 'outer-root-id' })
    );
  });

  it('forwards canonical web capability and I/O identity when the node path is for display', async () => {
    const rawCapability = { entries: vi.fn() };
    const handle: DirectoryHandle = {
      _internal: rawCapability,
      kind: 'directory',
      name: 'child',
      path: 'root/canonical-child',
      platform: 'web',
      rootId: 'child-root',
    };
    const child: IFileNode = {
      children: [],
      depth: 1,
      handle,
      name: 'child',
      path: 'child',
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'directory',
    };
    const grandchildCapability = { entries: vi.fn() };
    const grandchildHandle: DirectoryHandle = {
      _internal: grandchildCapability,
      kind: 'directory',
      name: 'grandchild',
      path: 'root/canonical-child/canonical-grandchild',
      platform: 'web',
    };
    const grandchild: IFileNode = {
      ...child,
      handle: grandchildHandle,
      name: 'grandchild',
      path: grandchildHandle.path,
    };
    const leaf: IFileNode = {
      depth: 3,
      handle: {
        _internal: { getFile: vi.fn() },
        kind: 'file',
        name: 'leaf.txt',
        path: `${grandchildHandle.path}/leaf.txt`,
        platform: 'web',
      },
      name: 'leaf.txt',
      path: `${grandchildHandle.path}/leaf.txt`,
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'file',
    };
    MockFileSystemAdapter.setMockDirectoryData('root', [child]);
    MockFileSystemAdapter.setMockDirectoryData(handle.path, [grandchild]);
    MockFileSystemAdapter.setMockDirectoryData(grandchildHandle.path, [leaf]);
    const readDirectory = vi.spyOn(MockFileSystemAdapter.prototype, 'readDirectory');
    const rootWithId: DirectoryHandle = { ...mockDirectoryHandle, rootId: 'parent-root' };

    const { result } = renderHook(() => useFileTree(rootWithId), {
      wrapper: AdaptersTestWrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(readDirectory).toHaveBeenCalledWith(handle);
    expect(readDirectory.mock.calls.map(([readHandle]) => readHandle.path)).toEqual([
      'root',
      handle.path,
      grandchildHandle.path,
    ]);
    expect(readDirectory.mock.calls[1]?.[0]._internal).toBe(rawCapability);
    expect(readDirectory).toHaveBeenCalledWith({ ...grandchildHandle, rootId: 'child-root' });
    expect(readDirectory.mock.calls[2]?.[0]._internal).toBe(grandchildCapability);

    const displayedChild = result.current.fileTree[0];
    const displayedGrandchild = displayedChild?.children?.[0];
    const displayedLeaf = displayedGrandchild?.children?.[0];
    expect(displayedChild?.path).toBe('child');
    expect(displayedGrandchild?.path).toBe('child/grandchild');
    expect(displayedLeaf?.path).toBe('child/grandchild/leaf.txt');
    expect(displayedLeaf?.handle).toBe(leaf.handle);
    expect(result.current.error).toBeNull();
  });
});

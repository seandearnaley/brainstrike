/**
 * Tests for read-full-tree utilities
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';

import {
  type DirectoryReadCapability,
  readFullTree,
  readFullTreeWithOptions,
} from '../directory-tree.js';

// Mock the parallel directory walker
vi.mock('../directory-tree-walker.js', () => ({
  walkDirectoryParallel: vi.fn().mockResolvedValue([]),
}));

import { walkDirectoryParallel } from '../directory-tree-walker.js';

const mockWalkDirectoryParallel = vi.mocked(walkDirectoryParallel);

describe('readFullTree', () => {
  const mockFileSystemAdapter: DirectoryReadCapability = {
    readDirectory: vi.fn(async () => []),
  };

  const mockDirectoryHandle: DirectoryHandle = {
    _internal: undefined,
    kind: 'directory',
    name: 'test',
    path: '/test',
    platform: 'electron',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call walkDirectoryParallel with default options', async () => {
    const mockResult: IFileNode[] = [
      {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        name: 'test.txt',
        path: '/test/test.txt',
        rootFolderId: '',
        selectionState: 'unchecked',
        type: 'file',
      } as IFileNode,
    ];
    mockWalkDirectoryParallel.mockResolvedValue(mockResult);

    const result = await readFullTree(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      mockDirectoryHandle
    );

    expect(mockWalkDirectoryParallel).toHaveBeenCalledWith(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      expect.objectContaining({
        abortSignal: undefined,
        concurrency: 10,
        onProgress: undefined,
      })
    );
    expect(result).toEqual(mockResult);
  });

  it('should pass abort signal to walkDirectoryParallel', async () => {
    const abortController = new AbortController();

    await readFullTree(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      mockDirectoryHandle,
      '',
      true,
      abortController.signal
    );

    expect(mockWalkDirectoryParallel).toHaveBeenCalledWith(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      expect.objectContaining({
        abortSignal: abortController.signal,
      })
    );
  });

  it('should pass progress callback to walkDirectoryParallel', async () => {
    const updateProgress = vi.fn();

    await readFullTree(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      mockDirectoryHandle,
      '',
      true,
      undefined,
      updateProgress
    );

    expect(mockWalkDirectoryParallel).toHaveBeenCalledWith(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      expect.objectContaining({
        onProgress: updateProgress,
      })
    );
  });

  it('should pass custom sort function to walkDirectoryParallel', async () => {
    const customSort = (nodes: IFileNode[]) => nodes.reverse();

    await readFullTree(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      mockDirectoryHandle,
      '',
      true,
      undefined,
      undefined,
      customSort
    );

    expect(mockWalkDirectoryParallel).toHaveBeenCalledWith(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      expect.objectContaining({
        sortFileNodes: customSort,
      })
    );
  });
});

describe('readFullTreeWithOptions', () => {
  const mockFileSystemAdapter: DirectoryReadCapability = {
    readDirectory: vi.fn(async () => []),
  };

  const mockDirectoryHandle: DirectoryHandle = {
    _internal: undefined,
    kind: 'directory',
    name: 'test',
    path: '/test',
    platform: 'electron',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call walkDirectoryParallel with provided options', async () => {
    const abortController = new AbortController();
    const updateProgress = vi.fn();
    const sortFileNodes = vi.fn();
    const onTreeSnapshot = vi.fn();
    const entryPolicy = {
      shouldIncludeFile: vi.fn(() => true),
      shouldTraverseDirectory: vi.fn(() => true),
    };
    const onEntrySkipped = vi.fn();

    await readFullTreeWithOptions(mockFileSystemAdapter, mockDirectoryHandle, {
      abortSignal: abortController.signal,
      concurrency: 5,
      entryPolicy,
      onEntrySkipped,
      onTreeSnapshot,
      snapshotIntervalMs: 200,
      sortFileNodes,
      updateProgress,
    });

    expect(mockWalkDirectoryParallel).toHaveBeenCalledWith(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      {
        abortSignal: abortController.signal,
        concurrency: 5,
        entryPolicy,
        onEntrySkipped,
        onProgress: updateProgress,
        onTreeSnapshot,
        snapshotIntervalMs: 200,
        sortFileNodes,
      }
    );
  });

  it('should use default options when none provided', async () => {
    await readFullTreeWithOptions(mockFileSystemAdapter, mockDirectoryHandle);

    expect(mockWalkDirectoryParallel).toHaveBeenCalledWith(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      {
        abortSignal: undefined,
        concurrency: undefined,
        entryPolicy: undefined,
        onEntrySkipped: undefined,
        onProgress: undefined,
        onTreeSnapshot: undefined,
        snapshotIntervalMs: undefined,
        sortFileNodes: undefined,
      }
    );
  });
});

/**
 * Tests for read-full-tree utilities
 */

import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';

import { readFullTree, readFullTreeWithOptions } from '../read-full-tree';

// Mock the parallel directory walker
vi.mock('../parallel-directory-walker', () => ({
  walkDirectoryParallel: vi.fn().mockResolvedValue([]),
}));

import { walkDirectoryParallel } from '../parallel-directory-walker';

const mockWalkDirectoryParallel = vi.mocked(walkDirectoryParallel);

describe('readFullTree', () => {
  const mockFileSystemAdapter: FileSystemAdapter = {
    readDirectory: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn(),
    requestDirectoryAccess: vi.fn(),
  } as unknown as FileSystemAdapter;

  const mockDirectoryHandle: DirectoryHandle = {
    path: '/test',
    name: 'test',
    kind: 'directory',
    platform: 'electron',
    _internal: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call walkDirectoryParallel with default options', async () => {
    const mockResult: IFileNode[] = [
      {
        name: 'test.txt',
        path: '/test/test.txt',
        type: 'file',
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: '',
        handle: {} as FileSystemFileHandle,
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
        concurrency: 10,
        abortSignal: undefined,
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
  const mockFileSystemAdapter: FileSystemAdapter = {
    readDirectory: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn(),
    requestDirectoryAccess: vi.fn(),
  } as unknown as FileSystemAdapter;

  const mockDirectoryHandle: DirectoryHandle = {
    path: '/test',
    name: 'test',
    kind: 'directory',
    platform: 'electron',
    _internal: undefined,
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
      concurrency: 5,
      abortSignal: abortController.signal,
      updateProgress,
      sortFileNodes,
      onTreeSnapshot,
      entryPolicy,
      onEntrySkipped,
      snapshotIntervalMs: 200,
    });

    expect(mockWalkDirectoryParallel).toHaveBeenCalledWith(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      {
        concurrency: 5,
        abortSignal: abortController.signal,
        onProgress: updateProgress,
        sortFileNodes,
        onTreeSnapshot,
        entryPolicy,
        onEntrySkipped,
        snapshotIntervalMs: 200,
      }
    );
  });

  it('should use default options when none provided', async () => {
    await readFullTreeWithOptions(mockFileSystemAdapter, mockDirectoryHandle);

    expect(mockWalkDirectoryParallel).toHaveBeenCalledWith(
      mockFileSystemAdapter,
      mockDirectoryHandle,
      {
        concurrency: undefined,
        abortSignal: undefined,
        onProgress: undefined,
        sortFileNodes: undefined,
        onTreeSnapshot: undefined,
        entryPolicy: undefined,
        onEntrySkipped: undefined,
        snapshotIntervalMs: undefined,
      }
    );
  });
});

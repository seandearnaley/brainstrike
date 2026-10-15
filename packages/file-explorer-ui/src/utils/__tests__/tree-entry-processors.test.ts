// @vitest-environment node
/**
 * Tests for tree entry processing utilities
 *
 * Tests the processFileEntry and processDirectoryEntry functions
 * that handle converting file system entries into IFileNode objects.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';

import { processDirectoryEntry } from '../process-directory-entry';
import { processFileEntry } from '../process-file-entry';

describe('processFileEntry', () => {
  const createMockDirectoryHandle = (platform: 'web' | 'electron'): DirectoryHandle => ({
    _internal: undefined,
    kind: 'directory',
    name: 'root',
    path: '/root',
    platform,
  });

  const createMockFileEntry = (name: string, path: string): IFileNode =>
    ({
      depth: 0,
      handle: {} as FileSystemFileHandle,
      name,
      path,
      rootFolderId: '',
      selectionState: 'unchecked',
      type: 'file',
    }) as IFileNode;

  it('should process a file entry with correct depth', () => {
    const directoryHandle = createMockDirectoryHandle('electron');
    const entry = createMockFileEntry('test.txt', 'test.txt');
    const relativePath = '/root/subdir';

    const result = processFileEntry(entry, relativePath, directoryHandle, 'root-id');

    expect(result.name).toBe('test.txt');
    // For electron platforms, path is the entry.path
    expect(result.path).toBe('test.txt');
    expect(result.depth).toBe(2); // '/root/subdir' splits into ['', 'root', 'subdir'], length 3, minus 1 = 2
    expect(result.selectionState).toBe('unchecked');
    expect(result.rootFolderId).toBe('root-id');
  });

  it('should handle web platform paths', () => {
    const directoryHandle = createMockDirectoryHandle('web');
    const entry = createMockFileEntry('doc.pdf', 'doc.pdf');
    const relativePath = 'folder/subfolder';

    const result = processFileEntry(entry, relativePath, directoryHandle, 'web-root');

    // For web platform, path is the relativePath
    expect(result.path).toBe('folder/subfolder');
    expect(result.depth).toBe(1); // 'folder/subfolder' splits into ['folder', 'subfolder'], length 2, minus 1 = 1
    expect(result.rootFolderId).toBe('web-root');
  });

  it('should calculate depth correctly for root level files', () => {
    const directoryHandle = createMockDirectoryHandle('electron');
    const entry = createMockFileEntry('readme.md', 'readme.md');
    const relativePath = 'root';

    const result = processFileEntry(entry, relativePath, directoryHandle, 'id');

    expect(result.depth).toBe(0); // 'root' splits into ['root'], length 1, minus 1 = 0
  });

  it('should preserve original entry properties while overwriting specific ones', () => {
    const directoryHandle = createMockDirectoryHandle('electron');
    const entry: IFileNode = {
      depth: 99, // Will be overwritten
      handle: {} as FileSystemFileHandle,
      lastModified: 12_345,
      name: 'file.ts',
      path: 'file.ts',
      rootFolderId: 'old-root', // Will be overwritten
      selectionState: 'checked', // Will be overwritten
      size: 1024,
      type: 'file',
    };

    const result = processFileEntry(entry, '/a/b', directoryHandle, 'new-root');

    // Preserved properties
    expect(result.size).toBe(1024);
    expect(result.lastModified).toBe(12_345);
    // Overwritten properties
    expect(result.depth).toBe(2); // '/a/b' splits into ['', 'a', 'b'], length 3, minus 1 = 2
    expect(result.selectionState).toBe('unchecked');
    expect(result.rootFolderId).toBe('new-root');
  });

  it('should handle empty relative path', () => {
    const directoryHandle = createMockDirectoryHandle('web');
    const entry = createMockFileEntry('file.txt', 'file.txt');
    const relativePath = '';

    const result = processFileEntry(entry, relativePath, directoryHandle, 'root');

    expect(result.path).toBe('');
    expect(result.depth).toBe(0); // '' splits into [''], length 1, minus 1 = 0
  });
});

describe('processDirectoryEntry', () => {
  const createMockDirectoryHandle = (platform: 'web' | 'electron'): DirectoryHandle => ({
    _internal: undefined,
    kind: 'directory',
    name: 'root',
    path: '/root',
    platform,
  });

  const createMockDirectoryEntry = (name: string, path: string): IFileNode =>
    ({
      depth: 0,
      handle: { kind: 'directory', name } as unknown as FileSystemDirectoryHandle,
      name,
      path,
      rootFolderId: '',
      selectionState: 'unchecked',
      type: 'directory',
    }) as IFileNode;

  it('should process a directory entry and fetch children', async () => {
    const directoryHandle = createMockDirectoryHandle('electron');
    const entry = createMockDirectoryEntry('subdir', 'subdir');
    const relativePath = '/root';
    const rootHandle = createMockDirectoryHandle('electron');

    const mockChildren: IFileNode[] = [
      {
        depth: 2,
        handle: {} as FileSystemFileHandle,
        name: 'child.txt',
        path: '/root/subdir/child.txt',
        rootFolderId: 'root-id',
        selectionState: 'unchecked',
        type: 'file',
      } as IFileNode,
    ];

    const readTree = vi.fn().mockResolvedValue(mockChildren);
    const sortFileNodes = vi.fn((nodes: IFileNode[]) => nodes);

    const result = await processDirectoryEntry(
      entry,
      relativePath,
      directoryHandle,
      rootHandle,
      'root-id',
      readTree,
      sortFileNodes
    );

    expect(result.type).toBe('directory');
    expect(result.name).toBe('subdir');
    // Path is entry.path for electron platforms
    expect(result.path).toBe('subdir');
    expect(result.children).toEqual(mockChildren);
    expect(result.selectionState).toBe('unchecked');
    expect(result.rootFolderId).toBe('root-id');
    expect(readTree).toHaveBeenCalled();
    expect(sortFileNodes).toHaveBeenCalledWith(mockChildren);
  });

  it('should pass abort signal to readTree', async () => {
    const directoryHandle = createMockDirectoryHandle('electron');
    const entry = createMockDirectoryEntry('folder', 'folder');
    const rootHandle = createMockDirectoryHandle('electron');
    const abortController = new AbortController();

    const readTree = vi.fn().mockResolvedValue([]);
    const sortFileNodes = vi.fn((nodes: IFileNode[]) => nodes);

    await processDirectoryEntry(
      entry,
      '/base',
      directoryHandle,
      rootHandle,
      'root',
      readTree,
      sortFileNodes,
      abortController.signal
    );

    expect(readTree).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'directory', name: 'folder' }),
      rootHandle,
      '/base',
      false,
      abortController.signal
    );
  });

  it('should apply sort function to children', async () => {
    const directoryHandle = createMockDirectoryHandle('web');
    const entry = createMockDirectoryEntry('docs', 'docs');
    const rootHandle = createMockDirectoryHandle('web');

    const unsortedChildren: IFileNode[] = [
      {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        name: 'b.txt',
        path: 'docs/b.txt',
        rootFolderId: '',
        selectionState: 'unchecked',
        type: 'file',
      } as IFileNode,
      {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        name: 'a.txt',
        path: 'docs/a.txt',
        rootFolderId: '',
        selectionState: 'unchecked',
        type: 'file',
      } as IFileNode,
    ];

    const sortedChildren = [...unsortedChildren].reverse();

    const readTree = vi.fn().mockResolvedValue(unsortedChildren);
    const sortFileNodes = vi.fn().mockReturnValue(sortedChildren);

    const result = await processDirectoryEntry(
      entry,
      'root',
      directoryHandle,
      rootHandle,
      'id',
      readTree,
      sortFileNodes
    );

    expect(sortFileNodes).toHaveBeenCalledWith(unsortedChildren);
    expect(result.children).toBe(sortedChildren);
  });

  it('should calculate correct depth from relative path', async () => {
    const directoryHandle = createMockDirectoryHandle('electron');
    const entry = createMockDirectoryEntry('deep', 'deep');
    const rootHandle = createMockDirectoryHandle('electron');
    const relativePath = '/a/b/c/d';

    const readTree = vi.fn().mockResolvedValue([]);
    const sortFileNodes = vi.fn((nodes: IFileNode[]) => nodes);

    const result = await processDirectoryEntry(
      entry,
      relativePath,
      directoryHandle,
      rootHandle,
      'root',
      readTree,
      sortFileNodes
    );

    expect(result.depth).toBe(4); // '/a/b/c/d' splits into ['', 'a', 'b', 'c', 'd'], length 5, minus 1 = 4
  });

  it('should create correct directory handle for children', async () => {
    const directoryHandle = createMockDirectoryHandle('electron');
    const nativePayload = { nativePath: '/native/mydir' };
    const entryHandle: DirectoryHandle = {
      _internal: nativePayload,
      kind: 'directory',
      name: 'mydir',
      path: '/native/mydir',
      platform: 'electron',
    };
    const entry: IFileNode = {
      ...createMockDirectoryEntry('mydir', 'mydir'),
      handle: entryHandle,
    };
    const rootHandle = createMockDirectoryHandle('electron');

    const readTree = vi.fn().mockResolvedValue([]);
    const sortFileNodes = vi.fn((nodes: IFileNode[]) => nodes);

    await processDirectoryEntry(
      entry,
      '/parent',
      directoryHandle,
      rootHandle,
      'root',
      readTree,
      sortFileNodes
    );

    const calledWith = readTree.mock.calls[0]![0] as DirectoryHandle;
    expect(calledWith.name).toBe('mydir');
    expect(calledWith.kind).toBe('directory');
    expect(calledWith.platform).toBe('electron');
    expect(calledWith.path).toBe('/native/mydir');
    expect(calledWith._internal).toBe(nativePayload);
  });

  it('preserves a canonical web directory capability when requesting child traversal', async () => {
    const rawDirectory = { kind: 'directory', name: 'canonical-dir' };
    const descriptor: DirectoryHandle = {
      _internal: rawDirectory,
      kind: 'directory',
      name: 'canonical-dir',
      path: 'root/canonical-dir',
      platform: 'web',
      rootId: 'child-root',
    };
    const entry: IFileNode = {
      ...createMockDirectoryEntry('display-dir', 'display-dir'),
      handle: descriptor,
    };
    const rootHandle = createMockDirectoryHandle('web');
    const readTree = vi.fn().mockResolvedValue([]);

    await processDirectoryEntry(
      entry,
      'display-dir',
      { ...rootHandle, rootId: 'parent-root' },
      rootHandle,
      'selection-root',
      readTree,
      (nodes) => nodes
    );

    expect(readTree).toHaveBeenCalledWith(descriptor, rootHandle, 'display-dir', false, undefined);
    expect(readTree.mock.calls[0]?.[0]._internal).toBe(rawDirectory);
  });

  it('preserves a durable rootId stamped on a child handle', async () => {
    const directoryHandle = createMockDirectoryHandle('electron');
    const entry: IFileNode = {
      ...createMockDirectoryEntry('mydir', 'mydir'),
      handle: {
        kind: 'directory',
        name: 'mydir',
        rootId: 'stamped-child-root-id',
      } as unknown as FileSystemDirectoryHandle,
    };
    const rootHandle = createMockDirectoryHandle('electron');

    const readTree = vi.fn().mockResolvedValue([]);
    const sortFileNodes = vi.fn((nodes: IFileNode[]) => nodes);

    await processDirectoryEntry(
      entry,
      '/parent',
      directoryHandle,
      rootHandle,
      'root',
      readTree,
      sortFileNodes
    );

    const calledWith = readTree.mock.calls[0]![0] as DirectoryHandle;
    expect(calledWith.rootId).toBe('stamped-child-root-id');
  });

  it('inherits the parent directory handle rootId when the child handle is unstamped', async () => {
    const directoryHandle: DirectoryHandle = {
      ...createMockDirectoryHandle('electron'),
      rootId: 'outer-root-id',
    };
    const entry = createMockDirectoryEntry('mydir', 'mydir');
    const rootHandle = createMockDirectoryHandle('electron');

    const readTree = vi.fn().mockResolvedValue([]);
    const sortFileNodes = vi.fn((nodes: IFileNode[]) => nodes);

    await processDirectoryEntry(
      entry,
      '/parent',
      directoryHandle,
      rootHandle,
      'root',
      readTree,
      sortFileNodes
    );

    const calledWith = readTree.mock.calls[0]![0] as DirectoryHandle;
    expect(calledWith.rootId).toBe('outer-root-id');
  });
});

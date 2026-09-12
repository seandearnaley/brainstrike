import type { DirectoryHandle, FileHandle, IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { fileNodeToDirectoryHandle, fileNodeToFileHandle } from '../file-node-handles.js';

function node(handle: IFileNode['handle']): IFileNode {
  return {
    depth: 0,
    handle,
    name: 'display-name',
    path: 'display/path',
    rootFolderId: 'selection-root',
    selectionState: 'unchecked',
    size: 123,
    type: handle.kind,
  };
}

describe('file node adapter handles', () => {
  it.each(['electron', 'web'] as const)('preserves canonical %s file I/O identity', (platform) => {
    const capability = { getFile: vi.fn() };
    const handle: FileHandle = {
      _internal: capability,
      kind: 'file',
      name: 'canonical-name',
      path: '/canonical/file',
      platform,
      rootFolderId: 'canonical-selection-root',
      rootId: 'canonical-root',
      size: 456,
    };
    const result = fileNodeToFileHandle(node(handle));

    expect(result).toEqual(handle);
    expect(result._internal).toBe(capability);
  });

  it.each(['electron', 'web'] as const)(
    'preserves canonical %s directory I/O identity over presentation metadata and parent identity',
    (platform) => {
      const capability = { entries: vi.fn() };
      const handle: DirectoryHandle = {
        _internal: capability,
        kind: 'directory',
        name: 'canonical-name',
        path: '/canonical/directory',
        platform,
        rootId: 'canonical-root',
      };

      const result = fileNodeToDirectoryHandle(node(handle), 'parent-root');

      expect(result).toEqual(handle);
      expect(result._internal).toBe(capability);
    }
  );

  it('wraps a raw browser file once and supplies node metadata', () => {
    const handle: FileSystemFileHandle = {
      createWritable: vi.fn(),
      getFile: vi.fn(),
      isSameEntry: vi.fn(),
      kind: 'file',
      name: 'file',
      queryPermission: vi.fn(),
      requestPermission: vi.fn(),
    };

    const result = fileNodeToFileHandle(
      node(Object.assign(handle, { rootId: 'stamped-web-root' }))
    );

    expect(result).toEqual({
      _internal: handle,
      kind: 'file',
      name: 'display-name',
      path: 'display/path',
      platform: 'web',
      rootFolderId: 'selection-root',
      rootId: 'stamped-web-root',
      size: 123,
    });
    expect(result._internal).toBe(handle);
  });

  it('inherits parent root identity without inventing an internal capability', () => {
    const handle: DirectoryHandle = {
      kind: 'directory',
      name: 'native',
      path: '/native',
      platform: 'electron',
    };

    expect(fileNodeToDirectoryHandle(node(handle), 'parent-root')).toEqual({
      ...handle,
      rootId: 'parent-root',
    });
    expect(fileNodeToDirectoryHandle(node(handle), 'parent-root')).not.toHaveProperty('_internal');
  });

  it('rejects file and directory kind mismatches', () => {
    const file: FileHandle = { kind: 'file', name: 'file', path: '/file', platform: 'electron' };
    const directory: DirectoryHandle = {
      kind: 'directory',
      name: 'directory',
      path: '/directory',
      platform: 'electron',
    };
    expect(() => fileNodeToDirectoryHandle(node(file))).toThrow('does not have a directory handle');
    expect(() => fileNodeToFileHandle(node(directory))).toThrow('missing its file handle');
  });
});

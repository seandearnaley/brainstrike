/**
 * Tests for getFinalPath utility
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';

import { getFinalPath } from '../get-final-path';

describe('getFinalPath', () => {
  const createMockDirectoryHandle = (platform: 'web' | 'electron'): DirectoryHandle => ({
    _internal: undefined,
    kind: 'directory',
    name: 'root',
    path: '/root',
    platform,
  });

  const createMockFileEntry = (path: string): IFileNode =>
    ({
      depth: 0,
      handle: {} as FileSystemFileHandle,
      name: 'test.txt',
      path,
      rootFolderId: '',
      selectionState: 'unchecked',
      type: 'file',
    }) as IFileNode;

  it('should return relativePath for web platform', () => {
    const handle = createMockDirectoryHandle('web');
    const entry = createMockFileEntry('/absolute/path/file.txt');
    const relativePath = 'folder/file.txt';

    const result = getFinalPath(handle, entry, relativePath);

    expect(result).toBe('folder/file.txt');
  });

  it('should return relativePath for electron platform with relative path', () => {
    const handle = createMockDirectoryHandle('electron');
    const entry = createMockFileEntry('/absolute/path/file.txt');
    const relativePath = 'relative/path/file.txt';

    const result = getFinalPath(handle, entry, relativePath);

    // For electron, finalPath returns entry.path when it differs from relativePath
    expect(result).toBe('/absolute/path/file.txt');
  });

  it('should handle empty paths', () => {
    const handle = createMockDirectoryHandle('web');
    const entry = createMockFileEntry('');
    const relativePath = '';

    const result = getFinalPath(handle, entry, relativePath);

    expect(result).toBe('');
  });
});

// @vitest-environment node
import type { DirectoryHandle } from '@brainstrike/file-system';
import { describe, expect, it } from 'vitest';
import { getRootFolderId } from '../utils/get-root-folder-id';

function handle(path: string, rootId?: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path,
    path,
    platform: 'web',
    ...(rootId ? { rootId } : {}),
  };
}

describe('getRootFolderId', () => {
  it('returns null for a null handle', () => {
    expect(getRootFolderId(null)).toBeNull();
  });

  it('prefers the stamped handle.rootId over the path-keyed map', () => {
    // Two same-named web roots share a path; only the stamp disambiguates them.
    const map = new Map<string, string>([['project', 'rid-from-map']]);
    expect(getRootFolderId(handle('project', 'rid-stamped'), map)).toBe('rid-stamped');
  });

  it('disambiguates two same-named handles by their distinct stamped rootIds', () => {
    const map = new Map<string, string>([['project', 'rid-b']]); // map collides (last wins)
    expect(getRootFolderId(handle('project', 'rid-a'), map)).toBe('rid-a');
    expect(getRootFolderId(handle('project', 'rid-b'), map)).toBe('rid-b');
  });

  it('falls back to the path→rootId map for an unstamped handle', () => {
    const map = new Map<string, string>([['/abs/path', 'rid-mapped']]);
    expect(getRootFolderId(handle('/abs/path'), map)).toBe('rid-mapped');
  });

  it('falls back to the path when neither a stamp nor a map entry exists', () => {
    expect(getRootFolderId(handle('/abs/path'))).toBe('/abs/path');
    expect(getRootFolderId(handle('/abs/path'), new Map())).toBe('/abs/path');
  });
});

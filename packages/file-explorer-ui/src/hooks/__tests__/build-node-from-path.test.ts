import { describe, expect, it } from 'vitest';

import { buildNodeFromPath } from '../build-node-from-path';

describe('buildNodeFromPath', () => {
  const directoryHandle = {} as FileSystemDirectoryHandle;

  it('counts depth correctly when stripping a root without a trailing slash', () => {
    const node = buildNodeFromPath('/root/a/b', '/root', 'root-folder', directoryHandle);

    expect(node).toMatchObject({
      name: 'b',
      path: '/root/a/b',
      depth: 1,
      rootFolderId: 'root-folder',
      type: 'directory',
    });
  });

  it('keeps the root node name empty when path equals the root path', () => {
    const node = buildNodeFromPath('/root', '/root', 'root-folder', directoryHandle);

    expect(node.name).toBe('');
    expect(node.depth).toBe(0);
  });

  it('preserves legacy no-op behavior when the root path is not a prefix', () => {
    const node = buildNodeFromPath('/other/workspace/src', '/root', 'root-folder', directoryHandle);

    expect(node.name).toBe('src');
    expect(node.depth).toBe(2);
  });

  it('normalizes a trailing slash before deriving the name and depth', () => {
    const node = buildNodeFromPath('/root/a/b/', '/root', 'root-folder', directoryHandle);

    expect(node.name).toBe('b');
    expect(node.depth).toBe(1);
  });
});

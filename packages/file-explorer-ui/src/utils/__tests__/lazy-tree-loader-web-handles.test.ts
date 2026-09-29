import { WebFileSystemAdapter } from '@brainstrike/file-system';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { expect, it, vi } from 'vitest';
import { loadDirectoryChildren } from '../lazy-tree-loader';

it('expands a canonical web directory through its raw browser capability', async () => {
  const child: FileSystemFileHandle = {
    createWritable: vi.fn(),
    getFile: vi.fn(),
    isSameEntry: vi.fn(),
    kind: 'file',
    name: 'guide.md',
    queryPermission: vi.fn(),
    requestPermission: vi.fn(),
  };
  const entries = vi.fn(async function* (): AsyncGenerator<[string, FileSystemHandle]> {
    yield ['guide.md', child];
  });
  const rawHandle = { entries, kind: 'directory', name: 'docs' };
  const handle: DirectoryHandle = {
    _internal: rawHandle,
    kind: 'directory',
    name: 'docs',
    path: 'workspace/docs',
    platform: 'web',
    rootId: 'durable-root',
  };
  const node: IFileNode = {
    depth: 0,
    handle,
    name: 'docs',
    path: 'docs',
    rootFolderId: 'selection-root',
    selectionState: 'unchecked',
    type: 'directory',
  };
  const adapter = new WebFileSystemAdapter();
  const readDirectory = vi.spyOn(adapter, 'readDirectory');

  const children = await loadDirectoryChildren(adapter, node, {
    includeMetadata: false,
    parentRootId: 'outer-root',
  });

  expect(children).toHaveLength(1);
  expect(children[0]?.name).toBe('guide.md');
  expect(children[0]?.handle).toBe(child);
  expect(entries).toHaveBeenCalledOnce();
  expect(readDirectory).toHaveBeenCalledWith(handle, { includeMetadata: false });
});

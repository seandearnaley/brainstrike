import { WebFileSystemAdapter } from '@brainstrike/file-system';
import type { FileHandle, IFileNode } from '@brainstrike/types';
import { expect, it, vi } from 'vitest';
import { DirectFileContentProcessor } from '../file-content-processor.js';

it('reads a canonical web descriptor through its raw browser capability', async () => {
  const getFile = vi.fn(async () => new File(['# Workspace guide'], 'guide.md'));
  const rawHandle = { getFile, kind: 'file', name: 'guide.md' };
  const handle: FileHandle = {
    _internal: rawHandle,
    kind: 'file',
    name: 'guide.md',
    path: 'workspace/docs/guide.md',
    platform: 'web',
    rootId: 'durable-root',
  };
  const fileNode: IFileNode = {
    depth: 1,
    handle,
    name: 'guide.md',
    path: 'docs/guide.md',
    rootFolderId: 'selection-root',
    selectionState: 'unchecked',
    type: 'file',
  };
  const adapter = new WebFileSystemAdapter();
  const readFile = vi.spyOn(adapter, 'readFile');

  const results = await new DirectFileContentProcessor().processFiles([
    { compositeKey: 'guide', fileNode, fileSystemAdapter: adapter },
  ]);

  expect(results['guide']).toEqual({ content: '# Workspace guide', status: 'accessible' });
  expect(getFile).toHaveBeenCalledOnce();
  expect(readFile).toHaveBeenCalledWith(
    expect.objectContaining({
      _internal: rawHandle,
      path: handle.path,
      platform: 'web',
      rootFolderId: 'selection-root',
      rootId: 'durable-root',
    })
  );
});

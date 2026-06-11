import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { fileNodeToTarget } from '../file-entry-target';

const baseNode: Omit<IFileNode, 'path' | 'rootFolderId' | 'type'> = {
  depth: 1,
  handle: {} as IFileNode['handle'],
  name: 'notes.md',
  selectionState: 'unchecked',
};

describe('fileNodeToTarget', () => {
  it('maps a desktop node (absolute path) to a target with absolutePath', () => {
    const target = fileNodeToTarget({
      ...baseNode,
      path: '/Users/dev/project/docs/notes.md',
      rootFolderId: '/Users/dev/project',
      type: 'file',
    });
    expect(target).toEqual({
      kind: 'file-entry',
      name: 'notes.md',
      relativePath: 'docs/notes.md',
      absolutePath: '/Users/dev/project/docs/notes.md',
      entryType: 'file',
      rootFolderId: '/Users/dev/project',
    });
  });

  it('maps a web node (relative path) to a target with null absolutePath', () => {
    const target = fileNodeToTarget({
      ...baseNode,
      path: 'docs/notes.md',
      rootFolderId: 'root-uuid',
      type: 'file',
    });
    expect(target).toEqual({
      kind: 'file-entry',
      name: 'notes.md',
      relativePath: 'docs/notes.md',
      absolutePath: null,
      entryType: 'file',
      rootFolderId: 'root-uuid',
    });
  });

  it('maps directories', () => {
    const target = fileNodeToTarget({
      ...baseNode,
      name: 'docs',
      path: 'docs',
      rootFolderId: 'root-uuid',
      type: 'directory',
    });
    expect(target?.kind).toBe('file-entry');
    expect(target && target.kind === 'file-entry' ? target.entryType : null).toBe('directory');
  });

  it('returns null for loadMore pseudo-nodes', () => {
    expect(
      fileNodeToTarget({
        ...baseNode,
        name: 'Load more…',
        path: '__load_more__',
        rootFolderId: 'root-uuid',
        type: 'loadMore',
      })
    ).toBeNull();
  });
});

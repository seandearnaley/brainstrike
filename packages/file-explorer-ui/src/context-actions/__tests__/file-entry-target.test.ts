// @vitest-environment node
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
      absolutePath: '/Users/dev/project/docs/notes.md',
      entryType: 'file',
      kind: 'file-entry',
      name: 'notes.md',
      relativePath: 'docs/notes.md',
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
      absolutePath: null,
      entryType: 'file',
      kind: 'file-entry',
      name: 'notes.md',
      relativePath: 'docs/notes.md',
      rootFolderId: 'root-uuid',
    });
  });

  it('resolves a storage-v5 RootId through the explicit desktop root path', () => {
    const target = fileNodeToTarget(
      {
        ...baseNode,
        path: '/Users/dev/project/docs/notes.md',
        rootFolderId: '6d15f31b-cc44-46f7-8eb1-01a1f7b086d8',
        type: 'file',
      },
      '/Users/dev/project'
    );
    expect(target).toMatchObject({
      absolutePath: '/Users/dev/project/docs/notes.md',
      relativePath: 'docs/notes.md',
      rootFolderId: '6d15f31b-cc44-46f7-8eb1-01a1f7b086d8',
    });
  });

  it('does not guess a relative path when an absolute node has only a UUID RootId', () => {
    const target = fileNodeToTarget({
      ...baseNode,
      path: '/Users/dev/project/docs/notes.md',
      rootFolderId: '6d15f31b-cc44-46f7-8eb1-01a1f7b086d8',
      type: 'file',
    });
    expect(target).toMatchObject({
      absolutePath: '/Users/dev/project/docs/notes.md',
      relativePath: null,
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

  it('returns null for truncated pseudo-nodes', () => {
    expect(
      fileNodeToTarget({
        ...baseNode,
        name: 'Showing first 10,000 entries',
        path: '/Users/dev/project/…truncated…',
        rootFolderId: 'root-uuid',
        type: 'truncated',
      })
    ).toBeNull();
  });
});

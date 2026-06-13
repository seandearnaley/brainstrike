import { describe, expect, it } from 'vitest';
import {
  planRootFolderCacheReconciliation,
  validateRootFolderCacheRequest,
} from '../root-folder-cache-reconciliation';

describe('root-folder-cache-reconciliation', () => {
  it('classifies new files for import when no cached row exists', () => {
    const result = planRootFolderCacheReconciliation({
      discoveredFiles: [
        {
          rootId: '/workspace/a',
          relativePath: 'src/new.ts',
          contentHash: 'hash-new',
          size: 10,
          name: 'new.ts',
        },
      ],
      existingFiles: [],
    });

    expect(result.toImport.map((entry) => entry.relativePath)).toEqual(['src/new.ts']);
    expect(result.toReplace).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
  });

  it('classifies unchanged files by collection, root, and relative path identity', () => {
    const result = planRootFolderCacheReconciliation({
      discoveredFiles: [
        {
          rootId: '/workspace/a',
          relativePath: 'src/index.ts',
          contentHash: 'hash-1',
          size: 10,
          name: 'index.ts',
        },
      ],
      existingFiles: [
        {
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
          rootId: '/workspace/a',
          relativePath: 'src/index.ts',
          contentHash: 'hash-1',
        },
      ],
    });

    expect(result.unchanged).toEqual([
      {
        embeddingSetId: 'set-1',
        fileRecordId: 'file-1',
        rootId: '/workspace/a',
        relativePath: 'src/index.ts',
        contentHash: 'hash-1',
      },
    ]);
  });

  it('classifies changed files for replacement when root and relative path match', () => {
    const result = planRootFolderCacheReconciliation({
      discoveredFiles: [
        {
          rootId: '/workspace/a',
          relativePath: 'src/index.ts',
          contentHash: 'hash-new',
          size: 11,
          name: 'index.ts',
        },
      ],
      existingFiles: [
        {
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
          rootId: '/workspace/a',
          relativePath: 'src/index.ts',
          contentHash: 'hash-old',
        },
      ],
    });

    expect(result.toReplace).toHaveLength(1);
    expect(result.toReplace[0]).toMatchObject({
      existingFileRecordId: 'file-1',
      rootId: '/workspace/a',
      relativePath: 'src/index.ts',
      previousContentHash: 'hash-old',
      nextContentHash: 'hash-new',
    });
  });

  it('keeps different roots isolated even when relative path matches', () => {
    const result = planRootFolderCacheReconciliation({
      discoveredFiles: [
        {
          rootId: '/workspace/b',
          relativePath: 'src/index.ts',
          contentHash: 'hash-1',
          size: 10,
          name: 'index.ts',
        },
      ],
      existingFiles: [
        {
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
          rootId: '/workspace/a',
          relativePath: 'src/index.ts',
          contentHash: 'hash-1',
        },
      ],
    });

    expect(result.toImport.map((entry) => entry.rootId)).toEqual(['/workspace/b']);
    expect(result.unchanged).toHaveLength(0);
    expect(result.toReplace).toHaveLength(0);
  });

  it('does not plan deletions for files missing from the current root snapshot', () => {
    const result = planRootFolderCacheReconciliation({
      discoveredFiles: [],
      existingFiles: [
        {
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
          rootId: '/workspace/a',
          relativePath: 'src/index.ts',
          contentHash: 'hash-1',
        },
      ],
    });

    expect(result.toImport).toHaveLength(0);
    expect(result.toReplace).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
  });

  it('fails validation when managed collection or root path is missing', () => {
    expect(
      validateRootFolderCacheRequest({
        managedCollectionId: null,
        rootPath: '/workspace/a',
        dbReady: true,
      })
    ).toEqual({
      ok: false,
      reason: 'No managed collection selected.',
    });

    expect(
      validateRootFolderCacheRequest({
        managedCollectionId: 'set-1',
        rootPath: null,
        dbReady: true,
      })
    ).toEqual({
      ok: false,
      reason: 'No root folder selected.',
    });
  });

  it('fails validation when db is unavailable', () => {
    expect(
      validateRootFolderCacheRequest({
        managedCollectionId: 'set-1',
        rootPath: '/workspace/a',
        dbReady: false,
      })
    ).toEqual({
      ok: false,
      reason: 'Database is not ready.',
    });
  });
});

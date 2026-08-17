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
          contentHash: 'hash-new',
          name: 'new.ts',
          relativePath: 'src/new.ts',
          rootId: '/workspace/a',
          size: 10,
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
          contentHash: 'hash-1',
          name: 'index.ts',
          relativePath: 'src/index.ts',
          rootId: '/workspace/a',
          size: 10,
        },
      ],
      existingFiles: [
        {
          contentHash: 'hash-1',
          embeddingSetId: 'set-1',
          fileRecordId: 'file-1',
          relativePath: 'src/index.ts',
          rootId: '/workspace/a',
        },
      ],
    });

    expect(result.unchanged).toEqual([
      {
        contentHash: 'hash-1',
        embeddingSetId: 'set-1',
        fileRecordId: 'file-1',
        relativePath: 'src/index.ts',
        rootId: '/workspace/a',
      },
    ]);
  });

  it('classifies changed files for replacement when root and relative path match', () => {
    const result = planRootFolderCacheReconciliation({
      discoveredFiles: [
        {
          contentHash: 'hash-new',
          name: 'index.ts',
          relativePath: 'src/index.ts',
          rootId: '/workspace/a',
          size: 11,
        },
      ],
      existingFiles: [
        {
          contentHash: 'hash-old',
          embeddingSetId: 'set-1',
          fileRecordId: 'file-1',
          relativePath: 'src/index.ts',
          rootId: '/workspace/a',
        },
      ],
    });

    expect(result.toReplace).toHaveLength(1);
    expect(result.toReplace[0]).toMatchObject({
      existingFileRecordId: 'file-1',
      nextContentHash: 'hash-new',
      previousContentHash: 'hash-old',
      relativePath: 'src/index.ts',
      rootId: '/workspace/a',
    });
  });

  it('keeps different roots isolated even when relative path matches', () => {
    const result = planRootFolderCacheReconciliation({
      discoveredFiles: [
        {
          contentHash: 'hash-1',
          name: 'index.ts',
          relativePath: 'src/index.ts',
          rootId: '/workspace/b',
          size: 10,
        },
      ],
      existingFiles: [
        {
          contentHash: 'hash-1',
          embeddingSetId: 'set-1',
          fileRecordId: 'file-1',
          relativePath: 'src/index.ts',
          rootId: '/workspace/a',
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
          contentHash: 'hash-1',
          embeddingSetId: 'set-1',
          fileRecordId: 'file-1',
          relativePath: 'src/index.ts',
          rootId: '/workspace/a',
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
        dbReady: true,
        managedCollectionId: null,
        rootPath: '/workspace/a',
      })
    ).toEqual({
      code: 'no-managed-collection',
      ok: false,
      reason: 'No managed collection selected.',
    });

    expect(
      validateRootFolderCacheRequest({
        dbReady: true,
        managedCollectionId: 'set-1',
        rootPath: null,
      })
    ).toEqual({
      code: 'no-root-folder',
      ok: false,
      reason: 'No root folder selected.',
    });
  });

  it('fails validation when db is unavailable', () => {
    expect(
      validateRootFolderCacheRequest({
        dbReady: false,
        managedCollectionId: 'set-1',
        rootPath: '/workspace/a',
      })
    ).toEqual({
      code: 'db-not-ready',
      ok: false,
      reason: 'Database is not ready.',
    });
  });
});

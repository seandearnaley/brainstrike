import { describe, expect, it } from 'vitest';
import { validateRootFolderCacheRequest } from '../root-folder-cache-reconciliation';

describe('root-folder-cache-reconciliation', () => {
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

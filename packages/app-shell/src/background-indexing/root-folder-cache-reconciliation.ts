export interface RootFolderCacheRequestValidation {
  dbReady: boolean;
  managedCollectionId: string | null;
  rootPath: string | null;
}

/**
 * Missing root or collection is incomplete setup (`unconfigured`). The provider
 * waits for database initialization before constructing the service; a missing
 * required database at the service boundary remains an error, as do invalid
 * metadata and failures after initialization.
 */
export type RootFolderCacheValidationFailureCode =
  | 'db-not-ready'
  | 'no-managed-collection'
  | 'no-root-folder';

export type RootFolderCacheValidationResult =
  | { ok: true }
  | {
      code: RootFolderCacheValidationFailureCode;
      ok: false;
      reason: string;
    };

export function buildRootFolderCacheIdentityKey(rootId: string, relativePath: string): string {
  return `${rootId}::${relativePath}`;
}

export function validateRootFolderCacheRequest(
  input: RootFolderCacheRequestValidation
): RootFolderCacheValidationResult {
  if (!input.managedCollectionId) {
    return {
      code: 'no-managed-collection',
      ok: false,
      reason: 'No managed collection selected.',
    };
  }

  if (!input.rootPath) {
    return {
      code: 'no-root-folder',
      ok: false,
      reason: 'No root folder selected.',
    };
  }

  if (!input.dbReady) {
    return {
      code: 'db-not-ready',
      ok: false,
      reason: 'Database is not ready.',
    };
  }

  return {
    ok: true,
  };
}

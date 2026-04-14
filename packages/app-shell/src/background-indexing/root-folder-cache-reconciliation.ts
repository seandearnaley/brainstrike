export interface RootFolderDiscoveredFile {
  contentHash: string;
  name: string;
  relativePath: string;
  size: number;
  sourceRootPath: string;
}

export interface RootFolderCachedFileIdentity {
  contentHash: string;
  embeddingSetId: string;
  fileRecordId: string;
  relativePath: string;
  sourceRootPath: string;
}

export interface RootFolderCacheReplacement extends RootFolderDiscoveredFile {
  existingFileRecordId: string;
  nextContentHash: string;
  previousContentHash: string;
}

export interface RootFolderCacheReconciliationPlan {
  toImport: RootFolderDiscoveredFile[];
  toReplace: RootFolderCacheReplacement[];
  unchanged: RootFolderCachedFileIdentity[];
}

export interface RootFolderCacheRequestValidation {
  collectionModelKey?: string | null;
  dbReady: boolean;
  managedCollectionId: string | null;
  rootPath: string | null;
}

export type RootFolderCacheValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
    };

export interface RootFolderCacheReconciliationInput {
  discoveredFiles: RootFolderDiscoveredFile[];
  existingFiles: RootFolderCachedFileIdentity[];
}

function buildCacheIdentityKey(sourceRootPath: string, relativePath: string): string {
  return `${sourceRootPath}::${relativePath}`;
}

export function validateRootFolderCacheRequest(
  input: RootFolderCacheRequestValidation
): RootFolderCacheValidationResult {
  if (!input.managedCollectionId) {
    return {
      ok: false,
      reason: 'No managed collection selected.',
    };
  }

  if (!input.rootPath) {
    return {
      ok: false,
      reason: 'No root folder selected.',
    };
  }

  if (!input.dbReady) {
    return {
      ok: false,
      reason: 'Database is not ready.',
    };
  }

  if (input.collectionModelKey === null) {
    return {
      ok: false,
      reason: 'Managed collection metadata is invalid.',
    };
  }

  return {
    ok: true,
  };
}

export function planRootFolderCacheReconciliation(
  input: RootFolderCacheReconciliationInput
): RootFolderCacheReconciliationPlan {
  if (input.discoveredFiles.length === 0) {
    return {
      toImport: [],
      toReplace: [],
      unchanged: [],
    };
  }

  const cachedByIdentity = new Map<string, RootFolderCachedFileIdentity>();

  for (const existingFile of input.existingFiles) {
    const cacheIdentity = buildCacheIdentityKey(
      existingFile.sourceRootPath,
      existingFile.relativePath
    );
    cachedByIdentity.set(cacheIdentity, existingFile);
  }

  const toImport: RootFolderDiscoveredFile[] = [];
  const toReplace: RootFolderCacheReplacement[] = [];
  const unchanged: RootFolderCachedFileIdentity[] = [];

  for (const discoveredFile of input.discoveredFiles) {
    const cacheIdentity = buildCacheIdentityKey(
      discoveredFile.sourceRootPath,
      discoveredFile.relativePath
    );
    const existingFile = cachedByIdentity.get(cacheIdentity);

    if (!existingFile) {
      toImport.push(discoveredFile);
      continue;
    }

    if (existingFile.contentHash === discoveredFile.contentHash) {
      unchanged.push(existingFile);
      continue;
    }

    toReplace.push({
      ...discoveredFile,
      existingFileRecordId: existingFile.fileRecordId,
      nextContentHash: discoveredFile.contentHash,
      previousContentHash: existingFile.contentHash,
    });
  }

  return {
    toImport,
    toReplace,
    unchanged,
  };
}

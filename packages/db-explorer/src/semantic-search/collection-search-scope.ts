import type { SearchConfig } from '@brainstrike/ui';

export interface CollectionSearchScope {
  filePaths?: string[];
  selectionSnapshotId?: string;
}

/**
 * Shared collection-search scope resolver.
 * Context Explorer search can reuse this later without depending on DB-panel code paths.
 */
export function resolveCollectionSearchScope(config: SearchConfig): CollectionSearchScope {
  if (config.selectionSnapshotId) {
    return { selectionSnapshotId: config.selectionSnapshotId };
  }
  if (config.filePaths?.length) {
    return { filePaths: [...config.filePaths] };
  }
  return {};
}

/**
 * The selection's token total from the shared token cache (BST-2018): what an
 * export of the selected files will carry. A file the cache has not counted
 * yet is reported as pending, never as zero.
 */
import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useOptionalTokenCacheContext } from '../indexing/token-cache-context';

export interface SelectedTokenTotal {
  /** Selected files the cache has not counted yet. */
  readonly pending: number;
  readonly tokens: number;
}

/**
 * Null where no token cache is mounted. Computed on each render: the cache's
 * context changes whenever it records a count, which re-renders the caller.
 */
export function useSelectedTokenTotal(
  selectedFiles: ReadonlySet<string>
): SelectedTokenTotal | null {
  const cache = useOptionalTokenCacheContext();
  if (!cache) {
    return null;
  }
  let tokens = 0;
  let pending = 0;
  for (const key of selectedFiles) {
    const { folderId, path } = decodeFileSelection(key);
    // Without content this only reads the cache; the background indexer counts.
    const count = cache.getTokenCount(folderId, path);
    if (count === null) {
      pending += 1;
    } else {
      tokens += count;
    }
  }
  return { pending, tokens };
}

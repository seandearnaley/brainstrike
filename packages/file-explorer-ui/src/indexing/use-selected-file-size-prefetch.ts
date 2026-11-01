/**
 * Selected-file SIZE prefetch (extracted from
 * `use-background-token-indexer-integration.ts`, BST-1207).
 *
 * Sizes reach the hot token cache from two places: the background indexer
 * writes them when a batch finishes, and this hook writes them as soon as the
 * selection and the handle sources know them. Without the second path any
 * gating of the indexing path (adaptive debounce, large queue) left the context-explorer size column — and now the Explorer tree
 * grid's Size cell — rendering `—` for a value the tree already had.
 *
 * Writes are idempotent (`use-token-cache` no-ops when the value matches), so
 * re-running on every selection change is cheap. The pair (lookup + effect) is
 * self-contained — it reads only the three latest-value refs the indexing
 * effect already maintains, and that file sits against a pinned 1500-line
 * budget.
 */

import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';
import { useEffect } from 'react';
import { normalizeSelectionPathForTokenCache } from './background-token-indexer-dispatch-helpers';
import type { HandleInfo } from './background-token-indexer-handles';
import type { TokenCacheContextValue } from './token-cache-context';

const logger = createLogger('SelectedFileSizePrefetch');

type IndexGetHandle = (folderId: string, path: string) => HandleInfo | undefined;

export interface SelectedFileSizeLookup {
  readonly fileSize: number;
  readonly folderId: string;
  readonly normalizedPath: string;
}

/**
 * Look up the file size for `compositeKey` from the handle sources the indexing
 * effect already consults — `FileTreeIndex` first (O(1), shared across folders),
 * then the local HandleInfo map built from the current tree. Returns `null` when
 * neither source knows the size yet; the caller re-runs after the FileTreeIndex
 * version bumps or the local map rebuilds.
 *
 * Parking compositeKey decoding / normalization here means the effect body does
 * not branch on path validity, and it can be unit-tested without a render.
 */
export function lookupSelectedFileSize(params: {
  compositeKey: string;
  getHandle: IndexGetHandle | undefined;
  localMap: ReadonlyMap<string, HandleInfo>;
}): SelectedFileSizeLookup | null {
  const { compositeKey, getHandle, localMap } = params;
  let folderId: string;
  let selectionPath: string;
  try {
    const decoded = decodeFileSelection(compositeKey);
    folderId = decoded.folderId;
    selectionPath = decoded.path;
  } catch (error) {
    logger.debug('Failed to decode compositeKey during size prefetch lookup', {
      compositeKey,
      error,
    });
    return null;
  }
  // FileTreeIndex keys by raw tree paths (same as the dispatch classification
  // loop), so use selectionPath here and normalize only once we are committing
  // to a cache write.
  const handleInfo = getHandle?.(folderId, selectionPath) ?? localMap.get(compositeKey);
  if (!handleInfo || typeof handleInfo.fileSize !== 'number') {
    return null;
  }
  let normalizedPath: string;
  try {
    normalizedPath = normalizeSelectionPathForTokenCache(folderId, selectionPath);
  } catch (error) {
    logger.debug('Failed to normalize selection path during size prefetch lookup', {
      error,
      folderId,
      selectionPath,
    });
    return null;
  }
  return { fileSize: handleInfo.fileSize, folderId, normalizedPath };
}

export interface UseSelectedFileSizePrefetchParams {
  /** Local handle map built from the current tree; the FileTreeIndex fallback. */
  fileHandleMapRef: MutableRefObject<Map<string, HandleInfo>>;
  /** Re-arms the effect when the local handle map finishes rebuilding. */
  fileHandleMapSize: number;
  /** Shared FileTreeIndex lookup; present means sizes can be resolved O(1). */
  indexGetHandleRef: MutableRefObject<IndexGetHandle | undefined>;
  /** Bumps when the FileTreeIndex gains entries; re-arms parked keys. */
  indexVersion: number;
  /** Re-arms the effect when the cache becomes usable. */
  isTokenCacheOperational: boolean;
  selectedFiles: ReadonlySet<string>;
  tokenCacheRef: MutableRefObject<TokenCacheContextValue | null>;
}

export function useSelectedFileSizePrefetch({
  fileHandleMapRef,
  fileHandleMapSize,
  indexGetHandleRef,
  indexVersion,
  isTokenCacheOperational,
  selectedFiles,
  tokenCacheRef,
}: UseSelectedFileSizePrefetchParams): void {
  useEffect(() => {
    const cache = tokenCacheRef.current;
    if (!cache?.isOperational || selectedFiles.size === 0) {
      return;
    }
    const getHandle = indexGetHandleRef.current;
    const localMap = fileHandleMapRef.current;
    if (!getHandle && localMap.size === 0) {
      return;
    }
    for (const compositeKey of selectedFiles) {
      const lookup = lookupSelectedFileSize({ compositeKey, getHandle, localMap });
      if (!lookup) {
        continue;
      }
      cache.updateFileSizeCache(lookup.folderId, lookup.normalizedPath, lookup.fileSize);
    }
  }, [
    selectedFiles,
    isTokenCacheOperational,
    fileHandleMapSize,
    fileHandleMapRef,
    indexGetHandleRef,
    indexVersion,
    tokenCacheRef,
  ]);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePersistentTokenCache } from '../indexing/use-persistent-token-cache';
import type { TokenCountingState } from '../indexing/use-token-counting';
import { defaultCollator } from '../utils/file-node-collator';

/** Debounce delay for token version updates (ms) */
const TOKEN_VERSION_DEBOUNCE_MS = 100;

export interface FileItem {
  compositeKey: string;
  folderId: string;
  path: string;
  size?: number;
  tokens?: number;
  type: 'file';
}

// Pre-compiled Intl.Collator is ~40x faster than inline localeCompare
// while preserving localeCompare() default behavior.
const pathCollator = defaultCollator;

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export interface UsePreviewPanelStateProps {
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  fileContents: Record<string, string>;
  fileSizes?: Record<string, number> | undefined;
  loadingFiles: Set<string>;
  selectedFiles: Set<string>;
  tokenCounting: TokenCountingState;
}

// Helper function to get file size from metadata with fallback to persistent cache
function getFileSizeFromMetadata(
  compositeKey: string,
  fileSizes: Record<string, number> | undefined,
  persistentCacheGetFileSize: (compositeKey: string) => number | undefined
): number | undefined {
  // Try primary source first (from fileNodeCache via fileSizes prop)
  const fromMetadata = fileSizes?.[compositeKey];
  if (fromMetadata !== undefined) {
    return fromMetadata;
  }
  // Fallback to persistent cache (available even when fileTree hasn't loaded)
  return persistentCacheGetFileSize(compositeKey);
}

/**
 * Ascending path order inside one folder bucket. Ties never happen — composite
 * keys are unique per (folder, path) — so this is a total order.
 */
function comparePathsAscending(a: FileItem, b: FileItem): number {
  return pathCollator.compare(a.path, b.path);
}

export function usePreviewPanelState({
  selectedFiles,
  fileContents,
  loadingFiles,
  fileSizes,
  decodeFileSelection,
  tokenCounting,
}: UsePreviewPanelStateProps) {
  const [cachedSelectionStats, setCachedSelectionStats] = useState<{
    cachedFileCount: number;
    selection: Set<string>;
    tokenCounts: ReadonlyMap<string, number>;
    totalTokens: number;
  }>({
    cachedFileCount: 0,
    selection: new Set<string>(),
    tokenCounts: new Map<string, number>(),
    totalTokens: 0,
  });

  const [tokenVersion, setTokenVersion] = useState(0);
  const isMountedRef = useRef(true);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/plugin: Cleanup effect for unmount tracking and debounce timer
  useEffect(
    () => () => {
      isMountedRef.current = false;
      // Clean up debounce timer on unmount
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    },
    []
  );

  // Debounced token version update to batch rapid-fire token resolutions
  const handleTokenResolved = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }

    // Cancel any pending update
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Schedule a batched update
    debounceTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setTokenVersion((prev) => prev + 1);
      }
      debounceTimerRef.current = null;
    }, TOKEN_VERSION_DEBOUNCE_MS);
  }, []);

  // Use the persistent token cache hook
  // This provides automatic caching with PGlite persistence when available
  const persistentCache = usePersistentTokenCache({
    decodeFileSelection,
    fileContents,
    ...(fileSizes === undefined ? {} : { fileSizes }),
    onTokenResolved: handleTokenResolved,
    tokenCounting,
  });
  const { cacheVersion, getCachedSelectionStats, getFileSize, getTokenCount } = persistentCache;

  useEffect(() => {
    let cancelled = false;

    if (selectedFiles.size === 0) {
      setCachedSelectionStats({
        cachedFileCount: 0,
        selection: selectedFiles,
        tokenCounts: new Map<string, number>(),
        totalTokens: 0,
      });
      return;
    }

    // tokenCounting.mode and tokenCounting.reason re-trigger the fetch when the
    // counting mode changes, since persisted token counts may no longer match.
    void getCachedSelectionStats(selectedFiles)
      .then((stats) => {
        if (!cancelled) {
          setCachedSelectionStats({
            ...stats,
            selection: selectedFiles,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCachedSelectionStats({
            cachedFileCount: 0,
            selection: selectedFiles,
            tokenCounts: new Map<string, number>(),
            totalTokens: 0,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    cacheVersion,
    getCachedSelectionStats,
    selectedFiles,
    tokenCounting.mode,
    tokenCounting.reason,
  ]);

  // Clear hot cache when counting mode changes
  useEffect(() => {
    setTokenVersion((prev) => prev + 1);
  }, [tokenCounting.mode, tokenCounting.reason]);

  // Build file items using the persistent cache. Hot-cache updates arrive as a
  // new `getTokenCount`, whose identity follows the provider's cache version.
  // `tokenVersion` serves only the provider-less in-memory path, which neither
  // shipped app takes (both mount TokenCacheProvider).
  const flatListItems = useMemo(() => {
    const folderGroups: Record<string, FileItem[]> = {};

    for (const compositeKey of selectedFiles) {
      const { folderId, path } = decodeFileSelection(compositeKey);
      if (!folderGroups[folderId]) {
        folderGroups[folderId] = [];
      }

      // Get token count from persistent cache (returns undefined if loading)
      const tokenCount = getTokenCount(compositeKey);

      // Get file size from metadata with fallback to persistent cache
      // This fixes the race condition where fileSizes (from fileNodeCache) is empty on app restore
      const fileSize = getFileSizeFromMetadata(compositeKey, fileSizes, getFileSize);

      const fileItem: FileItem = {
        compositeKey,
        folderId,
        path,
        type: 'file',
        ...(fileSize === undefined ? {} : { size: fileSize }),
        ...(tokenCount === undefined ? {} : { tokens: tokenCount }),
      };

      folderGroups[folderId].push(fileItem);
    }

    // Bucket order is `selectedFiles` first-seen order; within a bucket, path
    // order. Both are observable — preview-panel.tsx re-sorts this list with a
    // STABLE comparator keyed only on the root, so everything else it inherits
    // from here decides Tapestry card order. Pinned by
    // "buckets files by first-seen folder and path-sorts only within a bucket".
    const items: FileItem[] = [];
    for (const files of Object.values(folderGroups)) {
      files.sort(comparePathsAscending);
      items.push(...files);
    }

    return items;
  }, [selectedFiles, fileSizes, decodeFileSelection, tokenVersion, getFileSize, getTokenCount]);

  // Calculate total stats using the persistent cache
  // BST-153: Also track pendingCount for "estimating..." UI state
  const totalStats = useMemo(() => {
    let totalFiles = 0;
    let resolvedCount = 0;
    let totalTokens = 0;
    // Only merge cached counts that were fetched for the current selection.
    // Hot-cache counts win per file because they reflect the latest in-session recount.
    const cachedTokenCounts =
      cachedSelectionStats.selection === selectedFiles
        ? cachedSelectionStats.tokenCounts
        : new Map<string, number>();

    for (const compositeKey of selectedFiles) {
      totalFiles++;
      const tokenCount = getTokenCount(compositeKey);
      if (tokenCount !== undefined) {
        totalTokens += tokenCount;
        resolvedCount++;
        continue;
      }

      const cachedTokenCount = cachedTokenCounts.get(compositeKey);
      if (cachedTokenCount !== undefined) {
        totalTokens += cachedTokenCount;
        resolvedCount++;
      }
    }

    return {
      pendingCount: Math.max(0, totalFiles - resolvedCount),
      totalFiles,
      totalTokens,
    };
  }, [
    cachedSelectionStats.selection,
    cachedSelectionStats.tokenCounts,
    getTokenCount,
    selectedFiles,
    tokenVersion,
  ]);

  return { flatListItems, loadingFiles, totalStats };
}

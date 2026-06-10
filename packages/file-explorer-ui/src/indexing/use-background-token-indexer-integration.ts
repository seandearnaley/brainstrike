/**
 * useBackgroundTokenIndexerIntegration
 *
 * Integration hook that connects the file tree and selection to the background token indexer.
 * When files are selected, it extracts FileSystemFileHandles and queues them for background indexing.
 *
 * This enables accurate token counting without blocking the main thread or
 * requiring file content to be loaded first.
 *
 * Priority contract: foreground token counting (this hook) is never gated on background-sync
 * flags (`isImporting`, `isEmbeddingActive`). The WebGPU/LLM priority contract lives in
 * `packages/utils/src/background-work-arbiter.ts` and is enforced at the collection-sync layer.
 */

import { DEFAULT_MAX_FILE_SIZE } from '@brainstrike/file-system';
import type { FileToIndex } from '@brainstrike/token-cache/background-indexer';
import { useBackgroundTokenIndexer } from '@brainstrike/token-cache/background-indexer';
import type { FileForIndexingResolution, IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAdaptiveDebounceMs, INDEX_BATCH_SIZE, TOKEN_INDEXER_IO_BATCH_SIZE } from '../constants';
import { useOptionalFileTreeIndexContext } from '../tree/file-tree-provider';
import {
  normalizeSelectionPathForTokenCache,
  shouldEmitLargeSelectionDiagnostics,
  yieldIfMoreTokenIndexingBatches,
} from './background-token-indexer-dispatch-helpers';
import {
  planTokenIndexingDispatch,
  type TokenIndexingDispatchCandidate,
  type TokenIndexingDispatchHandle,
} from './background-token-indexer-dispatch-planner';
import {
  buildFileHandleMap,
  buildSyntheticElectronHandle,
  type ElectronFileHandle,
  type HandleInfo,
  isMissingFileError,
} from './background-token-indexer-handles';
import {
  handleSelectionShrink,
  shouldReconcileShrink,
} from './background-token-indexer-selection-shrink';
import { resolveBackgroundIndexerWorkerUrlHref } from './resolve-token-cache-worker-url';
import { useOptionalTokenCacheContext } from './token-cache-context';

const logger = createLogger('BackgroundTokenIndexerIntegration');

/**
 * Maximum file size for token indexing (750KB).
 * Files larger than this are skipped to prevent memory issues and processing delays.
 */
const MAX_INDEXABLE_FILE_SIZE = DEFAULT_MAX_FILE_SIZE;

/**
 * Function to read file content for Electron handles via IPC.
 * Required for Electron; workers cannot read files directly due to security restrictions.
 */
export type ElectronFileReader = (handle: ElectronFileHandle) => Promise<string>;

/**
 * Resolution returned by the web file resolver. The production web adapter
 * returns `kind: 'handle'` so the indexer worker can read bytes off the main
 * thread; in-memory adapters (e.g. dev-fixture) return `kind: 'content'` with
 * pre-loaded UTF-8 bytes because their handles are not structured-clone-safe
 * across the worker boundary.
 *
 * Re-exported from `@brainstrike/types` so the canonical adapter contract is
 * the single source of truth and a future third variant cannot drift between
 * the type package and the UI package.
 */
export type WebFileForIndexingResolution = FileForIndexingResolution;

/**
 * Function to resolve the bytes the indexer needs for a `${folderId}/${relativePath}`
 * path. Mirrors the desktop `electronFileReader` fallback so unexpanded subfolder
 * selections can be background-indexed without forcing the whole tree to expand on
 * the main thread.
 */
export type WebFileHandleResolver = (absolutePath: string) => Promise<WebFileForIndexingResolution>;

export interface UseBackgroundTokenIndexerIntegrationProps {
  /** File reader for Electron handles - required when using Electron file handles */
  electronFileReader?: ElectronFileReader;
  /** The file tree containing IFileNodes with handles */
  fileTree: IFileNode[];
  /** Callback when a file's token count is resolved */
  onTokenResolved?: (compositeKey: string, tokenCount: number) => void;
  /** Set of selected file composite keys (folderId::path format) */
  selectedFiles: Set<string>;
  /**
   * Web-only fallback to resolve a real `FileSystemFileHandle` for a selected file path
   * when neither the FileTreeIndex nor the local handle map has a cached entry.
   * Only relevant on the web platform; desktop uses `electronFileReader` instead.
   */
  webFileHandleResolver?: WebFileHandleResolver;
}

/** Diagnostic info for debugging indexing issues */
export interface IndexerDiagnostics {
  /** Whether the token cache is operational (counting works) */
  cacheOperational: boolean;
  /** Whether the token cache is persisted (DB-backed) */
  cachePersisted: boolean;
  /** Clear the indexed files tracking (forces re-indexing) */
  clearIndexedCache: () => void;
  /** Number of file handles available */
  fileHandleMapSize: number;
  /** Number of files tracked as already indexed */
  indexedCount: number;
  /** Number of files currently being processed */
  inFlightCount: number;
  /** Whether the background indexer worker is ready */
  workerReady: boolean;
}

export interface UseBackgroundTokenIndexerIntegrationReturn {
  /** Diagnostic info for debugging */
  diagnostics: IndexerDiagnostics;
  /** Whether background indexing is active */
  isIndexing: boolean;
  /** Whether the background indexer is ready */
  isReady: boolean;
  /** Current indexing progress */
  progress: { completed: number; total: number; currentFile?: string } | null;
  /** Manually trigger indexing for specific files (async for Electron file reading) */
  triggerIndexing: (compositeKeys: string[]) => Promise<void>;
}

interface PreloadedFolderSnapshot {
  cacheVersion: number;
  normalizedPaths: readonly string[];
}

function doesPreloadedSnapshotCoverSelection(
  snapshot: PreloadedFolderSnapshot | undefined,
  cacheVersion: number,
  normalizedPaths: readonly string[]
): boolean {
  if (!snapshot || snapshot.cacheVersion !== cacheVersion) {
    return false;
  }
  if (snapshot.normalizedPaths.length < normalizedPaths.length) {
    return false;
  }
  const preloadedPaths = new Set(snapshot.normalizedPaths);
  return normalizedPaths.every((path) => preloadedPaths.has(path));
}

/**
 * Electron-style handle with path property
 */
/**
 * Look up the file size for `compositeKey` from the handle sources the
 * indexing effect already consults -- `FileTreeIndex` first (O(1), shared
 * across folders), then the local HandleInfo map built from the current
 * tree. Returns `undefined` when neither source knows the size yet; the
 * caller can re-run after the FileTreeIndex version bumps or the local map
 * rebuilds.
 *
 * Extracted so the metadata-prefetch effect stays small and so it can be
 * unit-tested without a full render. Parking compositeKey decoding /
 * normalization here also means the effect body doesn't branch on path
 * validity.
 */
function lookupSelectedFileSize(params: {
  compositeKey: string;
  getHandle: ((folderId: string, path: string) => HandleInfo | undefined) | undefined;
  localMap: ReadonlyMap<string, HandleInfo>;
}): { folderId: string; normalizedPath: string; fileSize: number } | null {
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
  // FileTreeIndex keys by raw tree paths (same as classification loop below),
  // so use selectionPath here and only normalize once we're committing to a
  // cache write.
  const handleInfo = getHandle?.(folderId, selectionPath) ?? localMap.get(compositeKey);
  if (!handleInfo || typeof handleInfo.fileSize !== 'number') {
    return null;
  }
  let normalizedPath: string;
  try {
    normalizedPath = normalizeSelectionPathForTokenCache(folderId, selectionPath);
  } catch (error) {
    logger.debug('Failed to normalize selection path during size prefetch lookup', {
      folderId,
      selectionPath,
      error,
    });
    return null;
  }
  return { folderId, normalizedPath, fileSize: handleInfo.fileSize };
}

// Foreground selection-driven dispatch is intentionally NOT gated on
// `isImporting` or `isEmbeddingActive`. The tokenizer worker is CPU-only and
// does not contend with the collection sync for WebGPU; PGLite serializes
// cache writes internally so concurrent `TokenCacheStore.set` calls from the
// foreground and background paths cannot corrupt data. The WebGPU priority
// contract (local LLM > background sync) lives in `background-work-arbiter`
// and is enforced at the collection-sync layer, not here. See
// packages/utils/src/background-work-arbiter.ts and
// packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx
// for the full priority story.
function getSelectionSkipState(params: {
  hasHandleSource: boolean;
  selectedCount: number;
}): 'no-files' | 'no-handles' | null {
  if (params.selectedCount === 0) {
    return 'no-files';
  }
  if (!params.hasHandleSource) {
    return 'no-handles';
  }
  return null;
}

function createDispatchHandle(handleInfo: HandleInfo): TokenIndexingDispatchHandle | null {
  if (handleInfo.webHandle) {
    return {
      fileName: handleInfo.fileName,
      fileSize: handleInfo.fileSize,
      kind: 'web',
      synthetic: handleInfo.isSynthetic === true,
    };
  }
  if (handleInfo.electronHandle) {
    return {
      fileName: handleInfo.fileName,
      fileSize: handleInfo.fileSize,
      kind: 'electron',
      synthetic: handleInfo.isSynthetic === true,
    };
  }
  return null;
}

/**
 * Hook that integrates selected files with background token indexing.
 *
 * When the selection changes, it queues newly selected files for background indexing.
 * Results are stored in the TokenCacheContext when available.
 */
export function useBackgroundTokenIndexerIntegration({
  fileTree,
  selectedFiles,
  onTokenResolved,
  electronFileReader,
  webFileHandleResolver,
}: UseBackgroundTokenIndexerIntegrationProps): UseBackgroundTokenIndexerIntegrationReturn {
  // Get the token cache context (may be null if not in provider)
  const tokenCache = useOptionalTokenCacheContext();

  // Get the FileTreeIndex context for O(1) handle lookups (optional - falls back to local map)
  const fileTreeIndex = useOptionalFileTreeIndexContext();
  const indexGetHandle = fileTreeIndex?.getHandle;
  // Track FileTreeIndex version for retry logic - when index fills, retry pending files
  const indexVersion = fileTreeIndex?.version ?? 0;

  // Track which files we've already queued for indexing
  const indexedFilesRef = useRef<Set<string>>(new Set());
  // Track files currently in flight to avoid re-queuing while a batch is running
  const inFlightRef = useRef<Set<string>>(new Set());
  // Track files skipped due to missing handles - retry when FileTreeIndex fills
  const pendingNoHandleRef = useRef<Set<string>>(new Set());
  const previousSelectionSizeRef = useRef<number>(0);
  // Track the exact prior selection so we can narrow cancel-on-shrink to the
  // composite keys that actually left the selection. Without this, any filter
  // change that deselected even a single already-indexed file would abort the
  // whole in-flight batch and the remaining still-selected rows would render
  // `—` until the next debounced triggerIndexing arrived.
  const previousSelectedFilesRef = useRef<Set<string>>(new Set());
  const [_inFlightPulse, bumpInFlightPulse] = useState(0);
  // Track file handle map population to trigger selection effect re-run
  const [fileHandleMapSize, setFileHandleMapSize] = useState(0);

  // Stable refs for tokenCache functions to avoid re-render loops.
  // The tokenCache object changes on every cacheVersion bump, but the functions are stable.
  // Using refs prevents effects from re-running when cacheVersion changes.
  const tokenCacheRef = useRef(tokenCache);
  tokenCacheRef.current = tokenCache;

  // Stable ref for FileTreeIndex getHandle - provides O(1) lookups when index is available
  const indexGetHandleRef = useRef(indexGetHandle);
  indexGetHandleRef.current = indexGetHandle;

  // Build file handle map whenever tree changes (debounced to avoid rebuilding during expand-all)
  const fileHandleMapRef = useRef<Map<string, HandleInfo>>(new Map());
  const previousRootIdsRef = useRef<string>('');
  // Explicit flag for "have we seen a root yet?" - avoids truthiness issues with empty string
  const hasSeenRootRef = useRef(false);
  const rebuildTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // P0 optimization: Track staleness to enable lazy rebuilds
  const fileHandleMapStaleRef = useRef(true); // Start stale since map is empty
  // P0 optimization: Track previous selection size for 0→>0 transition detection
  const previousSelectionSizeForMapRef = useRef<number>(0);

  // P0 optimization: Track which folder selections have been preloaded to avoid repeated DB reads.
  // A folder is only considered preloaded when both the cache version and the selected-path coverage
  // match the current selection. This prevents shallow initial selections from suppressing later
  // hydration when the same folder expands to include additional files.
  const preloadedFoldersRef = useRef<Map<string, PreloadedFolderSnapshot>>(new Map());
  // Track previous persistence state to clear preload memo when persistence changes
  const previousPersistedStateRef = useRef<boolean | undefined>(undefined);
  const selectionSkipReasonRef = useRef<string | null>(null);
  const warmCacheSkipReasonRef = useRef<string | null>(null);

  // Refs for values accessed inside the rebuild callback to avoid stale closures
  // and to prevent callback recreation on selection changes
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;
  const selectedFilesSizeRef = useRef(selectedFiles.size);
  selectedFilesSizeRef.current = selectedFiles.size;

  /**
   * Compute root fingerprint from fileTree for detecting root folder changes.
   * O(rootCount) - only iterates top-level nodes, not entire tree.
   * This is computed regardless of whether FileTreeIndex or local map is used.
   */
  const rootFingerprint = useMemo(() => {
    const ids = new Set<string>();
    for (const node of fileTree) {
      if (node.rootFolderId) {
        ids.add(node.rootFolderId);
      }
    }
    return Array.from(ids).sort().join('|');
  }, [fileTree]);

  /**
   * Effect: Clear caches when root folders change.
   * This runs independently of handle map rebuild to ensure cache clearing works
   * even when FileTreeIndex provides O(1) lookups (skipping local map rebuild).
   *
   * Empty fingerprint ('') is treated as "loading/unknown" state to avoid
   * wasteful back-to-back clears during transient empty states (e.g., rehydration).
   * Only clears on A → B where both A and B are non-empty and different.
   */
  // biome-ignore lint/plugin: Intentional effect to reset caches on root folder change
  useEffect(() => {
    const prev = previousRootIdsRef.current;

    // Determine if we should clear caches:
    // - Must have seen a root before (not initial mount)
    // - Previous fingerprint must be non-empty (actual roots, not loading state)
    // - Current fingerprint must be non-empty (actual roots, not loading state)
    // - Fingerprints must differ
    const shouldClear =
      hasSeenRootRef.current && prev !== '' && rootFingerprint !== '' && prev !== rootFingerprint;

    if (shouldClear) {
      indexedFilesRef.current.clear();
      inFlightRef.current.clear();
      pendingNoHandleRef.current.clear();
      preloadedFoldersRef.current.clear();
      bumpInFlightPulse((v) => v + 1);
      logger.debug('Cleared caches due to root folder change', {
        previousRootIds: prev,
        nextRootIds: rootFingerprint,
      });
    }

    // Only update previousRootIds when we have actual roots (non-empty)
    // This preserves the "last known good" fingerprint across transient empty states
    if (rootFingerprint !== '') {
      previousRootIdsRef.current = rootFingerprint;
    }
    hasSeenRootRef.current = true;
  }, [rootFingerprint]);

  /**
   * Idempotent rebuild scheduler - only schedules if no rebuild is already queued.
   * This prevents "debounce reset" behavior where each selection change would restart the timer.
   * Uses refs to avoid callback recreation on selection changes.
   */
  const scheduleRebuildIfNeeded = useCallback(() => {
    // Skip rebuild entirely when FileTreeIndex is available - it provides O(1) lookups
    if (indexGetHandleRef.current) {
      logger.debug('Skipping handle map rebuild - using FileTreeIndex');
      return;
    }

    // Skip if rebuild already scheduled
    if (rebuildTimeoutRef.current) {
      logger.debug('Rebuild already scheduled, skipping duplicate');
      return;
    }

    // Skip if map is not stale and already populated
    if (!fileHandleMapStaleRef.current && fileHandleMapRef.current.size > 0) {
      logger.debug('Map is fresh, skipping rebuild');
      return;
    }

    rebuildTimeoutRef.current = setTimeout(() => {
      rebuildTimeoutRef.current = null;

      // Use refs to get current values at execution time (not stale closure values)
      const currentSelectedSize = selectedFilesSizeRef.current;
      const currentFileTree = fileTreeRef.current;

      // Skip rebuild if no files selected and no pending operations
      // This avoids expensive tree traversal when the map won't be used
      if (currentSelectedSize === 0 && inFlightRef.current.size === 0) {
        logger.debug('Skipping handle map rebuild - no active operations', {
          selectedCount: currentSelectedSize,
          inFlightCount: inFlightRef.current.size,
        });
        return;
      }

      const map = new Map<string, HandleInfo>();
      buildFileHandleMap(currentFileTree, map);
      fileHandleMapRef.current = map;
      fileHandleMapStaleRef.current = false;
      // Update state to trigger selection effect re-run when map is populated
      setFileHandleMapSize(map.size);

      // Note: Root folder change detection is now handled by a dedicated effect
      // that runs regardless of whether FileTreeIndex or local map is used.

      logger.debug('File handle map built', {
        size: map.size,
        hasElectron: [...map.values()].some((h) => h.electronHandle),
        hasWeb: [...map.values()].some((h) => h.webHandle),
      });
    }, 500); // Wait 500ms for tree to stabilize before rebuilding
  }, []); // Empty deps - uses refs for all values

  /**
   * Effect A (tree-driven): When fileTree changes, mark map as stale.
   * Schedule rebuild only if there's active work (selected files or in-flight indexing).
   */
  useEffect(() => {
    // Cancel any pending rebuild when tree changes - the tree structure is different now
    if (rebuildTimeoutRef.current) {
      clearTimeout(rebuildTimeoutRef.current);
      rebuildTimeoutRef.current = null;
    }

    // Mark map as stale immediately
    fileHandleMapStaleRef.current = true;

    // Only schedule rebuild if there's active work (use ref to avoid dependency on selectedFiles)
    if (selectedFilesSizeRef.current > 0 || inFlightRef.current.size > 0) {
      scheduleRebuildIfNeeded();
    }

    return () => {
      if (rebuildTimeoutRef.current) {
        clearTimeout(rebuildTimeoutRef.current);
        rebuildTimeoutRef.current = null;
      }
    };
  }, [fileTree, scheduleRebuildIfNeeded]);

  /**
   * Effect B (need-driven): Watch selection size but only act on 0 → >0 transition.
   * This handles the case where selection becomes non-empty and we need the map.
   */
  useEffect(() => {
    const prevSize = previousSelectionSizeForMapRef.current;
    previousSelectionSizeForMapRef.current = selectedFiles.size;

    // Only act on 0 → >0 transition
    const isZeroToNonZero = prevSize === 0 && selectedFiles.size > 0;
    if (!isZeroToNonZero) {
      return;
    }

    // Only rebuild if stale or empty
    const needsRebuild = fileHandleMapStaleRef.current || fileHandleMapRef.current.size === 0;
    if (!needsRebuild) {
      logger.debug('Selection became non-empty but map is fresh, skipping rebuild');
      return;
    }

    logger.debug('Selection transition 0 → >0, checking if rebuild needed', {
      newSize: selectedFiles.size,
      isStale: fileHandleMapStaleRef.current,
      mapSize: fileHandleMapRef.current.size,
      hasIndex: !!indexGetHandleRef.current,
    });

    // Note: scheduleRebuildIfNeeded will short-circuit if FileTreeIndex is available
    scheduleRebuildIfNeeded();
  }, [selectedFiles.size, scheduleRebuildIfNeeded]);

  // Stable ref for onTokenResolved to avoid callback instability
  const onTokenResolvedRef = useRef(onTokenResolved);
  onTokenResolvedRef.current = onTokenResolved;

  /**
   * Callback when background indexer resolves a token count.
   * Updates both hot cache (tokens) and file size cache to trigger React re-render.
   * Uses refs to maintain stable callback identity and avoid re-render loops.
   */
  const handleFileIndexed = useCallback(
    (compositeKey: string, tokenCount: number, fileSize: number) => {
      const { folderId, path } = decodeFileSelection(compositeKey);
      inFlightRef.current.delete(compositeKey);
      if (inFlightRef.current.size === 0) {
        bumpInFlightPulse((value) => value + 1);
      }
      let normalizedPath: string;
      try {
        normalizedPath = normalizeSelectionPathForTokenCache(folderId, path);
      } catch (error) {
        logger.warn('Skipping hot-cache writeback for unsafe indexed path', {
          compositeKey,
          folderId,
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      tokenCacheRef.current?.updateHotCache(folderId, normalizedPath, tokenCount);
      tokenCacheRef.current?.updateFileSizeCache(folderId, normalizedPath, fileSize);
      indexedFilesRef.current.add(compositeKey);
      onTokenResolvedRef.current?.(compositeKey, tokenCount);
    },
    []
  );

  const handleFileError = useCallback((compositeKey: string, error: string) => {
    if (compositeKey === '__worker__') {
      // Terminal worker failures invalidate the whole in-flight queue.
      // Keep behavior deterministic by clearing all pending file markers.
      inFlightRef.current.clear();
      bumpInFlightPulse((value) => value + 1);
      logger.error('Background indexer terminal worker error', { error });
      return;
    }

    inFlightRef.current.delete(compositeKey);
    indexedFilesRef.current.delete(compositeKey);
    if (inFlightRef.current.size === 0) {
      bumpInFlightPulse((value) => value + 1);
    }
    // ENOENT means the file vanished between when we cached its handle and
    // when we tried to read it (delete, rename, git checkout, etc.). The
    // indexer correctly removed it from in-flight above; the absence isn't
    // alert-worthy. Other IO errors are still real bugs and stay at error.
    if (isMissingFileError(error)) {
      logger.debug('Background indexer skipping deleted file', { compositeKey });
      return;
    }
    logger.error('Background indexer file error', { compositeKey, error });
  }, []);

  // Use the background token indexer when context is available
  const backgroundIndexer = useBackgroundTokenIndexer({
    autoStart: false,
    store: tokenCache?.store ?? null,
    mode: tokenCache?.countingMode ?? 'heuristic',
    onFileIndexed: handleFileIndexed,
    onFileError: handleFileError,
    workerUrl: resolveBackgroundIndexerWorkerUrlHref(),
  });

  // Stable ref for backgroundIndexer to avoid callback instability
  const backgroundIndexerRef = useRef(backgroundIndexer);
  backgroundIndexerRef.current = backgroundIndexer;

  // Stable ref for electronFileReader
  const electronFileReaderRef = useRef(electronFileReader);
  electronFileReaderRef.current = electronFileReader;

  // Stable ref for webFileHandleResolver. Mirrors the electronFileReader pattern so the
  // triggerIndexing callback can stay deps-stable while still calling the latest resolver.
  // The resolver is only meaningful on the web platform; desktop leaves it undefined and
  // continues using the synthetic-handle / IPC path.
  const webFileHandleResolverRef = useRef(webFileHandleResolver);
  webFileHandleResolverRef.current = webFileHandleResolver;

  /**
   * Queue files for indexing using the background worker.
   * For Electron files, reads content via IPC first (async, non-blocking).
   * Uses refs to maintain stable callback identity and avoid re-render loops.
   */
  const triggerIndexing = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Indexing logic requires branching for handle types and batch processing
    async (compositeKeys: string[]) => {
      const cache = tokenCacheRef.current;
      const indexer = backgroundIndexerRef.current;
      if (!cache?.isOperational) {
        // Use debug level - this is expected during startup before everything initializes
        logger.debug('triggerIndexing blocked - not ready', {
          tokenCacheOperational: cache?.isOperational ?? false,
          backgroundIndexerReady: indexer.isReady,
          requestedFiles: compositeKeys.length,
        });
        return;
      }

      logger.debug('triggerIndexing started', { fileCount: compositeKeys.length });

      const dispatchCandidates: TokenIndexingDispatchCandidate[] = [];
      const handleInfoByCompositeKey = new Map<string, HandleInfo>();

      /** Mark a file as in-flight and bump the pulse counter when transitioning from empty. */
      const markInFlight = (key: string): void => {
        const wasEmpty = inFlightRef.current.size === 0;
        inFlightRef.current.add(key);
        if (wasEmpty) {
          bumpInFlightPulse((value) => value + 1);
        }
      };

      const dispatchBatches = async (files: FileToIndex[]): Promise<void> => {
        if (files.length === 0) {
          return;
        }
        for (let i = 0; i < files.length; i += INDEX_BATCH_SIZE) {
          const batch = files.slice(i, i + INDEX_BATCH_SIZE);
          await indexer.indexFiles(batch);
          await yieldIfMoreTokenIndexingBatches({
            nextIndex: i + INDEX_BATCH_SIZE,
            totalCount: files.length,
            onYield: () => undefined,
          });
        }
      };

      for (const compositeKey of compositeKeys) {
        if (indexedFilesRef.current.has(compositeKey) || inFlightRef.current.has(compositeKey)) {
          continue;
        }

        const { folderId, path: selectionPath } = decodeFileSelection(compositeKey);
        let normalizedFilePath: string;
        try {
          normalizedFilePath = normalizeSelectionPathForTokenCache(folderId, selectionPath);
        } catch (error) {
          dispatchCandidates.push({
            compositeKey,
            errorMessage: error instanceof Error ? error.message : String(error),
            folderId,
            kind: 'invalid-path',
            selectionPath,
          });
          continue;
        }

        // Try FileTreeIndex first (O(1) lookup), then fall back to local map.
        // NOTE: Use selectionPath (not normalizedFilePath) because FileTreeIndex
        // stores handles keyed by original file-tree node paths.
        const indexGetHandleFn = indexGetHandleRef.current;
        let handleInfo = indexGetHandleFn?.(folderId, selectionPath);
        if (!handleInfo) {
          handleInfo = fileHandleMapRef.current.get(compositeKey);
        }

        let cachedFileSize: number | undefined;
        if (!handleInfo) {
          if (electronFileReaderRef.current || webFileHandleResolverRef.current) {
            cachedFileSize = cache.getFileSize(folderId, normalizedFilePath);
          }
          const syntheticElectronHandle =
            electronFileReaderRef.current &&
            buildSyntheticElectronHandle({
              filePath: normalizedFilePath,
              fileSize: cachedFileSize,
              folderId,
            });
          if (syntheticElectronHandle) {
            handleInfo = syntheticElectronHandle;
          }
        }

        const dispatchHandle = handleInfo ? createDispatchHandle(handleInfo) : null;
        if (handleInfo && dispatchHandle) {
          handleInfoByCompositeKey.set(compositeKey, handleInfo);
        }

        dispatchCandidates.push({
          compositeKey,
          folderId,
          handle: dispatchHandle,
          kind: 'file',
          normalizedFilePath,
          selectionPath,
          ...(cachedFileSize === undefined ? {} : { cachedFileSize }),
        });
      }

      const dispatchPlan = planTokenIndexingDispatch({
        candidates: dispatchCandidates,
        hasWebFileHandleResolver: Boolean(webFileHandleResolverRef.current),
        indexedKeys: indexedFilesRef.current,
        inFlightKeys: inFlightRef.current,
        maxIndexableFileSize: MAX_INDEXABLE_FILE_SIZE,
      });

      for (const warning of dispatchPlan.invalidPathWarnings) {
        logger.warn('Skipping file with unsafe path for background indexing', {
          compositeKey: warning.compositeKey,
          error: warning.errorMessage,
          folderId: warning.folderId,
          selectionPath: warning.selectionPath,
        });
      }

      for (const key of dispatchPlan.pendingNoHandleKeysToDelete) {
        pendingNoHandleRef.current.delete(key);
      }
      for (const key of dispatchPlan.indexedKeysToAdd) {
        indexedFilesRef.current.add(key);
      }
      for (const key of dispatchPlan.pendingNoHandleKeysToAdd) {
        pendingNoHandleRef.current.add(key);
      }

      const webFilesToIndex: FileToIndex[] = [];
      for (const file of dispatchPlan.webFiles) {
        const handleInfo = handleInfoByCompositeKey.get(file.compositeKey);
        if (!handleInfo?.webHandle) {
          throw new Error(`Missing planned web file handle for ${file.compositeKey}`);
        }
        markInFlight(file.compositeKey);
        webFilesToIndex.push({
          compositeKey: file.compositeKey,
          fileHandle: handleInfo.webHandle,
          filePath: file.filePath,
          folderId: file.folderId,
        });
      }

      const electronFilesToRead: Array<{
        compositeKey: string;
        folderId: string;
        filePath: string;
        fileSize: number | undefined;
        handle: ElectronFileHandle;
      }> = [];
      for (const file of dispatchPlan.electronFiles) {
        const handleInfo = handleInfoByCompositeKey.get(file.compositeKey);
        if (!handleInfo?.electronHandle) {
          throw new Error(`Missing planned Electron file handle for ${file.compositeKey}`);
        }
        electronFilesToRead.push({
          compositeKey: file.compositeKey,
          filePath: file.filePath,
          fileSize: file.fileSize,
          folderId: file.folderId,
          handle: handleInfo.electronHandle,
        });
      }

      const webResolverQueue = [...dispatchPlan.webResolverFiles];
      const skippedNoHandle = dispatchPlan.skipped.noHandle;
      const skippedBinary = dispatchPlan.skipped.binary;
      const skippedTooLarge = dispatchPlan.skipped.tooLarge;
      const skippedInvalidPath = dispatchPlan.skipped.invalidPath;
      const estimatedElectronBytes = dispatchPlan.estimatedElectronBytes;

      const emitLargeSelectionDiagnostics = shouldEmitLargeSelectionDiagnostics({
        totalFileCount: compositeKeys.length,
        electronFileCount: electronFilesToRead.length,
        estimatedElectronBytes,
      });

      if (emitLargeSelectionDiagnostics) {
        logger.info('Background token indexing prepared large selection', {
          requestedFiles: compositeKeys.length,
          webFiles: webFilesToIndex.length,
          electronFiles: electronFilesToRead.length,
          estimatedElectronBytes,
          indexedCount: indexedFilesRef.current.size,
          inFlightCount: inFlightRef.current.size,
          skippedBinary,
          skippedInvalidPath,
          skippedNoHandle,
          skippedTooLarge,
        });
      }

      logger.debug('Background token indexing classified files', {
        requestedFiles: compositeKeys.length,
        webFiles: webFilesToIndex.length,
        webResolverFiles: webResolverQueue.length,
        electronFiles: electronFilesToRead.length,
        skippedBinary,
        skippedInvalidPath,
        skippedNoHandle,
        skippedTooLarge,
      });

      if (webFilesToIndex.length > 0) {
        try {
          await dispatchBatches(webFilesToIndex);
        } catch (error) {
          logger.error('triggerIndexing web batch dispatch failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Resolve missing-handle web files in concurrent windows that match the
      // electron read concurrency (20 per batch). Each batch fires Promise.all
      // so the resolver sees all 20 paths simultaneously, mirroring the existing
      // electron `Promise.all` pattern; resolved handles are then dispatched
      // through the same `dispatchBatches` path used by the live-handle web flow.
      if (webResolverQueue.length > 0) {
        const webResolver = webFileHandleResolverRef.current;
        if (webResolver) {
          let webHandlesResolved = 0;
          let webResolverFailures = 0;
          let webResolverSkippedTooLarge = 0;
          let webResolverYieldedBatches = 0;
          const webResolverStartedAt = Date.now();
          for (let i = 0; i < webResolverQueue.length; i += TOKEN_INDEXER_IO_BATCH_SIZE) {
            const batch = webResolverQueue.slice(i, i + TOKEN_INDEXER_IO_BATCH_SIZE);
            const results = await Promise.all(
              batch.map(async (item) => {
                try {
                  const resolution = await webResolver(item.absolutePath);
                  return { ...item, resolution, error: null as Error | null };
                } catch (error) {
                  const wrapped = error instanceof Error ? error : new Error(String(error));
                  return {
                    ...item,
                    resolution: null as WebFileForIndexingResolution | null,
                    error: wrapped,
                  };
                }
              })
            );

            const resolvedBatchToIndex: FileToIndex[] = [];
            for (const result of results) {
              if (result.error || !result.resolution) {
                webResolverFailures += 1;
                // Park failures for retry on the next FileTreeIndex version bump,
                // mirroring the no-handle path.
                pendingNoHandleRef.current.add(result.compositeKey);
                logger.debug('Web file handle resolver failed; parked for retry', {
                  absolutePath: result.absolutePath,
                  compositeKey: result.compositeKey,
                  error: result.error?.message,
                });
                continue;
              }

              // Authoritative size guard. Both resolution variants now carry
              // `fileSize` (web `getFile()` metadata or pre-loaded content
              // length), so this is the single point where the resolver path
              // enforces MAX_INDEXABLE_FILE_SIZE. Files surfaced by Select All
              // on unexpanded folders never had their size cached at tree-walk
              // time; without this check an oversize file would slip past the
              // pre-resolution `cache.getFileSize` guard above and reach the
              // worker — inflating token totals and burning CPU on payloads
              // the worker would otherwise never see.
              //
              // Mark the key as terminally indexed (not retryable): the size
              // came directly from the file system, so a future re-attempt
              // would hit the same guard and waste another resolver round-trip.
              if (result.resolution.fileSize > MAX_INDEXABLE_FILE_SIZE) {
                webResolverSkippedTooLarge += 1;
                indexedFilesRef.current.add(result.compositeKey);
                pendingNoHandleRef.current.delete(result.compositeKey);
                continue;
              }

              webHandlesResolved += 1;
              markInFlight(result.compositeKey);
              // Branch on resolution kind: production web returns a real
              // (structured-clone-safe) handle that the worker reads on its own
              // thread; in-memory adapters return pre-loaded content because
              // their synthetic handles cannot survive postMessage to a Worker.
              if (result.resolution.kind === 'handle') {
                resolvedBatchToIndex.push({
                  compositeKey: result.compositeKey,
                  fileHandle: result.resolution.fileHandle,
                  filePath: result.filePath,
                  folderId: result.folderId,
                });
              } else {
                resolvedBatchToIndex.push({
                  compositeKey: result.compositeKey,
                  content: result.resolution.content,
                  fileSize: result.resolution.fileSize,
                  filePath: result.filePath,
                  folderId: result.folderId,
                });
              }
            }

            if (resolvedBatchToIndex.length > 0) {
              try {
                await dispatchBatches(resolvedBatchToIndex);
              } catch (error) {
                logger.error('triggerIndexing web resolver batch dispatch failed', {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            await yieldIfMoreTokenIndexingBatches({
              nextIndex: i + TOKEN_INDEXER_IO_BATCH_SIZE,
              totalCount: webResolverQueue.length,
              onYield: () => {
                webResolverYieldedBatches += 1;
              },
            });
          }

          if (emitLargeSelectionDiagnostics) {
            logger.info('Background token indexing dispatched web resolver batches', {
              batchSize: TOKEN_INDEXER_IO_BATCH_SIZE,
              elapsedMs: Date.now() - webResolverStartedAt,
              queuedFiles: webResolverQueue.length,
              remainingFiles: 0,
              yieldedBatchCount: webResolverYieldedBatches,
              webHandlesResolved,
              webResolverFailures,
              webResolverSkippedTooLarge,
            });
          }
        } else {
          // The queue is only populated when the resolver was present at classify
          // time, but guard defensively in case the prop was unset between the
          // classification loop and the dispatch (e.g. component unmount).
          for (const queued of webResolverQueue) {
            pendingNoHandleRef.current.add(queued.compositeKey);
          }
        }
      }

      // Read Electron file contents via IPC (async, non-blocking)
      if (electronFilesToRead.length > 0) {
        const fileReader = electronFileReaderRef.current;
        if (!fileReader) {
          throw new Error(
            'electronFileReader is required for Electron file handles. ' +
              'The background worker cannot read files directly due to security restrictions.'
          );
        }

        let electronFilesRead = 0;
        let electronBytesRead = 0;
        let electronYieldedBatches = 0;
        const electronStartedAt = Date.now();
        for (let i = 0; i < electronFilesToRead.length; i += TOKEN_INDEXER_IO_BATCH_SIZE) {
          const batch = electronFilesToRead.slice(i, i + TOKEN_INDEXER_IO_BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async ({ compositeKey, folderId, filePath, fileSize, handle }) => {
              try {
                const content = await fileReader(handle);
                return { compositeKey, folderId, filePath, fileSize, content, error: null };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                  compositeKey,
                  folderId,
                  filePath,
                  fileSize,
                  content: null,
                  error: message,
                };
              }
            })
          );

          const electronFilesReady: FileToIndex[] = [];
          for (const result of results) {
            if (result.error || result.content === null) {
              const errorMessage = result.error ?? 'No content returned';
              // Match the level used by handleFileError so ENOENT
              // doesn't surface here as error AND there as debug.
              if (isMissingFileError(errorMessage)) {
                logger.debug('Skipping deleted Electron file', {
                  compositeKey: result.compositeKey,
                });
              } else {
                logger.error('Failed to read Electron file', {
                  compositeKey: result.compositeKey,
                  error: errorMessage,
                });
              }
              handleFileError(result.compositeKey, errorMessage);
              continue;
            }

            markInFlight(result.compositeKey);
            electronFilesRead += 1;
            electronBytesRead += result.fileSize ?? new Blob([result.content]).size;
            electronFilesReady.push({
              compositeKey: result.compositeKey,
              folderId: result.folderId,
              filePath: result.filePath,
              content: result.content,
              fileSize: result.fileSize ?? new Blob([result.content]).size,
            });
          }

          logger.debug('Background token indexing dispatched Electron batch', {
            batchSize: TOKEN_INDEXER_IO_BATCH_SIZE,
            batchFilesReady: electronFilesReady.length,
            electronBytesRead,
            electronFilesRead,
            elapsedMs: Date.now() - electronStartedAt,
            estimatedElectronBytes,
            remainingFiles: Math.max(electronFilesToRead.length - (i + batch.length), 0),
            yieldedBatchCount: electronYieldedBatches,
          });

          if (
            emitLargeSelectionDiagnostics &&
            i + TOKEN_INDEXER_IO_BATCH_SIZE >= electronFilesToRead.length
          ) {
            logger.info('Background token indexing dispatched Electron batches', {
              batchSize: TOKEN_INDEXER_IO_BATCH_SIZE,
              electronBytesRead,
              electronFilesRead,
              elapsedMs: Date.now() - electronStartedAt,
              estimatedElectronBytes,
              queuedFiles: electronFilesToRead.length,
              remainingFiles: 0,
              yieldedBatchCount: electronYieldedBatches,
            });
          }

          try {
            await dispatchBatches(electronFilesReady);
          } catch (error) {
            logger.error('triggerIndexing electron batch dispatch failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }

          await yieldIfMoreTokenIndexingBatches({
            nextIndex: i + TOKEN_INDEXER_IO_BATCH_SIZE,
            totalCount: electronFilesToRead.length,
            onYield: () => {
              electronYieldedBatches += 1;
            },
          });
        }
      }

      logger.debug('triggerIndexing prepared', {
        toIndex: webFilesToIndex.length + electronFilesToRead.length,
        skippedNoHandle,
        skippedBinary,
        skippedTooLarge,
        skippedInvalidPath,
        electronFiles: electronFilesToRead.length,
        webFiles: webFilesToIndex.length,
      });

      // Log upfront filtering summary at info level when files are skipped
      if (skippedBinary > 0 || skippedTooLarge > 0) {
        logger.info('Upfront filtering applied', {
          skippedBinary,
          skippedTooLarge,
          totalSkipped: skippedBinary + skippedTooLarge,
          remaining: webFilesToIndex.length + electronFilesToRead.length,
        });
      }
    },
    [handleFileError]
  );

  // Queue newly selected files for indexing when selection changes
  // Uses refs to avoid re-render loops while still accessing latest values
  const tokenCacheIsOperational = tokenCache?.isOperational ?? false;
  const tokenCacheIsPersisted = tokenCache?.isPersisted ?? false;

  // Prefetch file sizes into the hot cache as soon as the selection and
  // handle sources know them. Previously sizes were only written after the
  // background token indexer finished a batch, so any time the indexing path
  // was gated (embedding active, adaptive debounce, large queue) the
  // context-explorer column rendered `—` for size even though the tree
  // already had the value. Writes are idempotent (use-token-cache no-ops when
  // the value matches) so re-running on every selection change is cheap.
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
  }, [selectedFiles, tokenCacheIsOperational, fileHandleMapSize, indexVersion]);

  useEffect(() => {
    const indexer = backgroundIndexerRef.current;
    const previousSize = previousSelectionSizeRef.current;
    const previousSelectedFiles = previousSelectedFilesRef.current;
    previousSelectionSizeRef.current = selectedFiles.size;
    // Shallow-clone so `reconcileInFlightOnShrink` stays correct even if an
    // upstream caller ever mutates the Set in place. Storing a bare reference
    // would mean the "previous" and "next" Sets point at the same object on
    // the next render, and the diff loop would find zero removed keys --
    // silently skipping the narrow/cancel path. React selection state is
    // replaced immutably today, but this ref persists across renders and the
    // failure mode would be invisible, so we pay the tiny clone cost.
    previousSelectedFilesRef.current = new Set(selectedFiles);

    if (
      shouldReconcileShrink({
        previousSize,
        nextSize: selectedFiles.size,
        inFlightSize: inFlightRef.current.size,
        pendingNoHandleSize: pendingNoHandleRef.current.size,
      })
    ) {
      // Previously, any shrink cleared the entire in-flight set, which threw
      // away token-count work for files the user had not deselected (see the
      // context-explorer responsiveness investigation). `handleSelectionShrink`
      // drops tracking only for keys that actually left the selection and
      // hard-cancels the worker batch only when every in-flight key was
      // deselected.
      handleSelectionShrink({
        previousSize,
        previousSelectedFiles,
        selectedFiles,
        inFlight: inFlightRef.current,
        pendingNoHandle: pendingNoHandleRef.current,
        cancelBatch: () => indexer.cancelIndexing(),
        onPulse: () => bumpInFlightPulse((value) => value + 1),
      });
    }

    // Note: We no longer clear indexedFilesRef based on selection size shrinking.
    // The root folder change detection in the file handle map effect handles
    // clearing when user actually navigates to a different folder. Selection
    // size changes (e.g., "select all" briefly going to 0 then 90) should NOT
    // invalidate already-indexed files.

    // Exit early if no files selected or no file handles available yet.
    // During startup, selection may be restored from storage before file tree has handles.
    // When FileTreeIndex is available, skip the local map size check since we use index lookups.
    const hasHandleSource = indexGetHandleRef.current || fileHandleMapRef.current.size > 0;
    const skipReason = getSelectionSkipState({
      selectedCount: selectedFiles.size,
      hasHandleSource: Boolean(hasHandleSource),
    });
    if (skipReason) {
      // Track the last skip reason to avoid log thrash when the skip persists
      // across rerenders. The remaining skip reasons ("no-files", "no-handles")
      // are quiet states that do not require user-visible logging; they happen
      // routinely during startup (selection restored before handles are ready)
      // and when the user deselects everything.
      selectionSkipReasonRef.current = skipReason;
      return;
    }

    selectionSkipReasonRef.current = null;

    // Find files that haven't been indexed yet
    const newFiles = Array.from(selectedFiles).filter(
      (key) => !(indexedFilesRef.current.has(key) || inFlightRef.current.has(key))
    );
    logger.debug('New files to index', { count: newFiles.length, first3: newFiles.slice(0, 3) });

    if (newFiles.length === 0) {
      return;
    }

    // Phase 4 optimization: Adaptive debounce based on batch size
    // Larger batches get longer debounce to allow selection to stabilize
    // This prevents thrashing during "select all" operations
    const debounceMs = getAdaptiveDebounceMs(newFiles.length);

    logger.debug('Selection debounce configured', {
      newFileCount: newFiles.length,
      debounceMs,
    });

    const timeoutId = setTimeout(() => {
      void triggerIndexing(newFiles);
    }, debounceMs);

    return () => clearTimeout(timeoutId);
  }, [selectedFiles, triggerIndexing, tokenCacheIsOperational, fileHandleMapSize, indexGetHandle]);

  // Clear indexed files cache when file tree changes significantly
  // biome-ignore lint/plugin: Intentional effect to reset cache when folder is cleared - not an event handler
  useEffect(() => {
    // Reset cache when tree is empty (folder cleared)
    if (fileTree.length === 0) {
      indexedFilesRef.current.clear();
      pendingNoHandleRef.current.clear();
      if (inFlightRef.current.size > 0) {
        inFlightRef.current.clear();
        bumpInFlightPulse((value) => value + 1);
      }
    }
  }, [fileTree.length]);

  // Retry pending files when FileTreeIndex version changes (index was updated with new handles)
  // This handles the case where recursive selection loads handles after initial indexing attempt
  useEffect(() => {
    // Skip if no pending files or not ready
    if (pendingNoHandleRef.current.size === 0) {
      return;
    }

    const cache = tokenCacheRef.current;
    if (!cache?.isOperational) {
      return;
    }

    // Filter pending files to only those still in selection
    const pendingInSelection = Array.from(pendingNoHandleRef.current).filter((key) =>
      selectedFiles.has(key)
    );

    if (pendingInSelection.length === 0) {
      pendingNoHandleRef.current.clear();
      return;
    }

    logger.debug('Retrying pending files after index update', {
      indexVersion,
      pendingCount: pendingInSelection.length,
      pendingSample: pendingInSelection.slice(0, 3),
    });

    // Small debounce to allow index to settle
    const timeoutId = setTimeout(() => {
      void triggerIndexing(pendingInSelection);
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [indexVersion, selectedFiles, triggerIndexing]);

  // Warm hot cache from persistent store so repeat selections show existing counts immediately.
  // Uses tokenCacheRef to avoid re-render loops when cacheVersion changes.
  // P0 optimization: Uses preloadedFoldersRef to skip redundant preloads within same cache session.
  // biome-ignore lint/plugin: Cache hydration from persistent store is intentional side effect
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Warm-cache logic requires branching for memo checks, persistence state, folder iteration, and async hydration
  useEffect(() => {
    const cache = tokenCacheRef.current;
    if (!cache?.isOperational || selectedFiles.size === 0) {
      const skipReason = cache?.isOperational ? 'no-selection' : 'cache-unavailable';
      warmCacheSkipReasonRef.current = skipReason;
      return;
    }

    // NOTE: Warm-cache hydration is intentionally not gated on `isImporting`.
    // This is a READ from PGLite and does not contend with the collection
    // sync's writes (PGLite serializes internally). Gating it here would
    // strand already-persisted token counts for the entire duration of a
    // background scan, which is the opposite of what the persistent cache
    // exists to provide.

    // P0 optimization: Clear preload memo when persistence state changes.
    // This ensures we re-preload from DB when persistence becomes available.
    const currentPersisted = cache.isPersisted;
    if (previousPersistedStateRef.current !== currentPersisted) {
      if (previousPersistedStateRef.current !== undefined) {
        logger.debug('Clearing preload memo due to persistence state change', {
          previous: previousPersistedStateRef.current,
          current: currentPersisted,
        });
        preloadedFoldersRef.current.clear();
      }
      previousPersistedStateRef.current = currentPersisted;
    }

    const currentCacheVersion = cache.cacheVersion;
    const folderIds = new Set<string>();
    const keysByFolder = new Map<string, string[]>();
    for (const key of selectedFiles) {
      const { folderId } = decodeFileSelection(key);
      folderIds.add(folderId);
      const arr = keysByFolder.get(folderId) ?? [];
      arr.push(key);
      keysByFolder.set(folderId, arr);
    }

    const folderSelections = new Map<
      string,
      {
        normalizedPaths: string[];
        normalizedPathToCompositeKey: Map<string, string>;
      }
    >();
    for (const folderId of folderIds) {
      const keys = keysByFolder.get(folderId);
      if (!keys) {
        continue;
      }

      const normalizedPathToCompositeKey = new Map<string, string>();
      const normalizedPaths: string[] = [];
      for (const key of keys) {
        const { path } = decodeFileSelection(key);
        let normalizedPath: string;
        try {
          normalizedPath = normalizeSelectionPathForTokenCache(folderId, path);
        } catch (error) {
          logger.warn('Skipping warm-cache lookup for unsafe path', {
            folderId,
            path,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!normalizedPathToCompositeKey.has(normalizedPath)) {
          normalizedPathToCompositeKey.set(normalizedPath, key);
          normalizedPaths.push(normalizedPath);
        }
      }

      normalizedPaths.sort();
      folderSelections.set(folderId, {
        normalizedPaths,
        normalizedPathToCompositeKey,
      });
    }

    // P0 optimization: Filter to only folders that need preloading.
    // A folder is considered "preloaded" only when both the cache version and the exact selected
    // file coverage match the current selection snapshot.
    const foldersToPreload: string[] = [];
    for (const folderId of folderIds) {
      const folderSelection = folderSelections.get(folderId);
      if (!folderSelection || folderSelection.normalizedPaths.length === 0) {
        continue;
      }
      const memoizedSnapshot = preloadedFoldersRef.current.get(folderId);
      if (
        !doesPreloadedSnapshotCoverSelection(
          memoizedSnapshot,
          currentCacheVersion,
          folderSelection.normalizedPaths
        )
      ) {
        foldersToPreload.push(folderId);
      }
    }

    if (foldersToPreload.length === 0) {
      if (warmCacheSkipReasonRef.current !== 'already-preloaded') {
        warmCacheSkipReasonRef.current = 'already-preloaded';
        logger.debug('Warm cache effect skipped - folders already preloaded', {
          folderCount: folderIds.size,
          totalFiles: selectedFiles.size,
          cacheVersion: currentCacheVersion,
        });
      }
      return;
    }

    warmCacheSkipReasonRef.current = null;

    logger.debug('Warm cache effect: preloading folders', {
      folderCount: folderIds.size,
      foldersToPreload: foldersToPreload.length,
      totalFiles: selectedFiles.size,
      cacheVersion: currentCacheVersion,
    });

    // Only preload folders that haven't been preloaded at this cache version
    for (const folderId of foldersToPreload) {
      const folderSelection = folderSelections.get(folderId);
      if (!folderSelection) {
        continue;
      }
      void cache.preloadFolder(folderId);
      preloadedFoldersRef.current.set(folderId, {
        cacheVersion: currentCacheVersion,
        normalizedPaths: [...folderSelection.normalizedPaths],
      });
    }

    // After preload, ensure hot cache gets populated for any selected files that
    // were already stored but not yet marked indexed (prevents zero-count UI).
    // Only do this for folders that we actually preloaded (new folders or stale memo).
    for (const folderId of foldersToPreload) {
      const folderSelection = folderSelections.get(folderId);
      if (!folderSelection) {
        continue;
      }

      void cache.store
        .getBatch(folderId, folderSelection.normalizedPaths)
        .then((entries) => {
          // Use ref to get latest cache instance in async callback
          const currentCache = tokenCacheRef.current;
          if (!currentCache) {
            logger.warn('Warm cache: cache ref became null during async operation');
            return;
          }
          let hydrated = 0;
          let skipped = 0;
          for (const [path, entry] of entries.entries()) {
            const compositeKey =
              folderSelection.normalizedPathToCompositeKey.get(path) ??
              encodeFileSelection(folderId, path);
            if (indexedFilesRef.current.has(compositeKey)) {
              skipped++;
            } else {
              currentCache.updateHotCache(folderId, path, entry.tokenCount);
              indexedFilesRef.current.add(compositeKey);
              hydrated++;
            }
          }
          if (hydrated > 0 || entries.size > 0) {
            logger.debug('Warm cache: hydrated from store', {
              folderId,
              requested: folderSelection.normalizedPaths.length,
              foundInStore: entries.size,
              hydrated,
              skippedAlreadyIndexed: skipped,
            });
          }
        })
        .catch((error) => {
          logger.warn('Failed to hydrate hot cache from store', { folderId, error });
        });
    }
    // NOTE: tokenCacheIsPersisted is included to re-run when persistence becomes available.
    // This handles the case where isOperational=true (worker ready) but DB isn't ready yet.
    // When the DB initializes later, isPersisted changes → effect re-runs → preloads from store.
  }, [selectedFiles, tokenCacheIsOperational, tokenCacheIsPersisted]);

  // Diagnostic function to force re-indexing by clearing the tracked files
  const clearIndexedCache = useCallback(() => {
    const previousSize = indexedFilesRef.current.size;
    indexedFilesRef.current.clear();
    inFlightRef.current.clear();
    pendingNoHandleRef.current.clear();
    // P0 optimization: Also clear preload memo to force re-preload
    preloadedFoldersRef.current.clear();
    bumpInFlightPulse((v) => v + 1);
    logger.debug('Manually cleared indexed cache', { previousSize });
  }, []);

  return {
    isIndexing: backgroundIndexer.isIndexing,
    triggerIndexing,
    isReady: backgroundIndexer.isReady && (tokenCache?.isOperational ?? false),
    progress: backgroundIndexer.progress,
    diagnostics: {
      indexedCount: indexedFilesRef.current.size,
      inFlightCount: inFlightRef.current.size,
      fileHandleMapSize: fileHandleMapRef.current.size,
      workerReady: backgroundIndexer.isReady,
      cacheOperational: tokenCache?.isOperational ?? false,
      cachePersisted: tokenCache?.isPersisted ?? false,
      clearIndexedCache,
    },
  };
}

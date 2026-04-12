/**
 * useBackgroundTokenIndexerIntegration
 *
 * Integration hook that connects the file tree and selection to the background token indexer.
 * When files are selected, it extracts FileSystemFileHandles and queues them for background indexing.
 *
 * This enables accurate token counting without blocking the main thread or
 * requiring file content to be loaded first.
 */

import { DEFAULT_MAX_FILE_SIZE } from '@brainstrike/file-system';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import type { FileToIndex } from '@brainstrike/token-cache/background-indexer';
import { useBackgroundTokenIndexer } from '@brainstrike/token-cache/background-indexer';
import type { IFileNode } from '@brainstrike/types';
import { isBinaryFile } from '@brainstrike/utils/file-utils';
import { createLogger } from '@brainstrike/utils/logger';
import {
  normalizeSelectionPathForFolder,
  WINDOWS_ABSOLUTE_PATH_REGEX,
} from '@brainstrike/utils/relative-file-path';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAdaptiveDebounceMs, INDEX_BATCH_SIZE } from './constants';
import { useOptionalFileTreeIndexContext } from './file-tree-provider';
import { resolveBackgroundIndexerWorkerUrlHref } from './resolve-token-cache-worker-url';
import { useOptionalTokenCacheContext } from './token-cache-context';

const logger = createLogger('BackgroundTokenIndexerIntegration');

/**
 * Maximum file size for token indexing (750KB).
 * Files larger than this are skipped to prevent memory issues and processing delays.
 */
const MAX_INDEXABLE_FILE_SIZE = DEFAULT_MAX_FILE_SIZE;
const LARGE_SELECTION_DIAGNOSTIC_FILE_THRESHOLD = 250;
const LARGE_SELECTION_DIAGNOSTIC_BYTES_THRESHOLD = 25 * 1024 * 1024;

/**
 * Helper hook to check if file import is in progress.
 * When true, background token indexing should be paused to avoid database contention.
 */
function useFileImportingState(): boolean {
  return useVectorStatusUIStore((s) => s.isImporting);
}

function useEmbeddingActiveState(): boolean {
  return useVectorStatusUIStore((s) => s.isEmbeddingActive);
}

/**
 * Function to read file content for Electron handles via IPC.
 * Required for Electron; workers cannot read files directly due to security restrictions.
 */
export type ElectronFileReader = (handle: ElectronFileHandle) => Promise<string>;

export interface UseBackgroundTokenIndexerIntegrationProps {
  /** File reader for Electron handles - required when using Electron file handles */
  electronFileReader?: ElectronFileReader;
  /** The file tree containing IFileNodes with handles */
  fileTree: IFileNode[];
  /** Callback when a file's token count is resolved */
  onTokenResolved?: (compositeKey: string, tokenCount: number) => void;
  /** Set of selected file composite keys (folderId::path format) */
  selectedFiles: Set<string>;
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
interface ElectronFileHandle {
  kind: 'file';
  name: string;
  path: string;
  platform: 'electron';
}

/**
 * Type guard to check if handle is an Electron handle with path
 */
function isElectronHandle(handle: unknown): handle is ElectronFileHandle {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    'platform' in handle &&
    (handle as ElectronFileHandle).platform === 'electron' &&
    'path' in handle &&
    typeof (handle as ElectronFileHandle).path === 'string'
  );
}

/**
 * Type guard to check if handle is a Web FileSystemFileHandle
 */
function isWebFileHandle(handle: unknown): handle is FileSystemFileHandle {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    'getFile' in handle &&
    typeof (handle as FileSystemFileHandle).getFile === 'function'
  );
}

/**
 * Combined handle info for indexing.
 * Includes file metadata for upfront filtering before queuing.
 */
interface HandleInfo {
  electronHandle?: ElectronFileHandle;
  /** File name for binary detection */
  fileName: string;
  /** File size in bytes (if known) for large file filtering */
  fileSize: number | undefined;
  webHandle?: FileSystemFileHandle;
}

function isAbsoluteFolderPath(folderId: string): boolean {
  return (
    folderId.startsWith('/') ||
    folderId.startsWith('\\\\') ||
    folderId.startsWith('//') ||
    WINDOWS_ABSOLUTE_PATH_REGEX.test(folderId)
  );
}

function joinElectronAbsolutePath(rootPath: string, relativePath: string): string {
  const prefersBackslashes =
    WINDOWS_ABSOLUTE_PATH_REGEX.test(rootPath) ||
    rootPath.startsWith('\\\\') ||
    rootPath.includes('\\');
  const separator = prefersBackslashes ? '\\' : '/';
  const trimmedRootPath = rootPath.replace(/[\\/]+$/u, '');
  const normalizedRelativePath = relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .join(separator);
  if (normalizedRelativePath.length === 0) {
    return trimmedRootPath;
  }
  return `${trimmedRootPath}${separator}${normalizedRelativePath}`;
}

function buildSyntheticElectronHandle(args: {
  filePath: string;
  fileSize: number | undefined;
  folderId: string;
}): HandleInfo | null {
  if (!isAbsoluteFolderPath(args.folderId)) {
    return null;
  }

  const fileName = args.filePath.split('/').at(-1);
  if (!fileName) {
    return null;
  }

  return {
    electronHandle: {
      kind: 'file',
      name: fileName,
      path: joinElectronAbsolutePath(args.folderId, args.filePath),
      platform: 'electron',
    },
    fileName,
    fileSize: args.fileSize,
  };
}

function normalizeSelectionPathForTokenCache(folderId: string, selectionPath: string): string {
  return normalizeSelectionPathForFolder(selectionPath, folderId, {
    label: 'Token cache file path',
  });
}

function shouldEmitLargeSelectionDiagnostics(params: {
  electronFileCount: number;
  estimatedElectronBytes: number;
  totalFileCount: number;
}): boolean {
  return (
    params.totalFileCount >= LARGE_SELECTION_DIAGNOSTIC_FILE_THRESHOLD ||
    params.electronFileCount >= LARGE_SELECTION_DIAGNOSTIC_FILE_THRESHOLD ||
    params.estimatedElectronBytes >= LARGE_SELECTION_DIAGNOSTIC_BYTES_THRESHOLD
  );
}

/**
 * Log debug info for first file node encountered
 */
function logFirstFileNode(node: IFileNode): void {
  const handle = node.handle as unknown as Record<string, unknown> | undefined;
  logger.debug('buildFileHandleMap first file node', {
    nodeName: node.name,
    nodePath: node.path,
    nodeType: node.type,
    hasHandle: !!node.handle,
    hasRootFolderId: !!node.rootFolderId,
    rootFolderId: node.rootFolderId,
    handleKeys: handle ? Object.keys(handle) : [],
    handlePlatform: handle?.['platform'],
    handleKind: handle?.['kind'],
    handlePath: handle?.['path'],
    hasGetFile: handle && typeof handle['getFile'] === 'function',
  });
}

/**
 * Build a lookup map from composite key to file handle info
 * Supports both Web FileSystemFileHandle and Electron path-based handles
 */
function buildFileHandleMap(
  nodes: IFileNode[],
  map: Map<string, HandleInfo>,
  loggedFirstRef: { logged: boolean } = { logged: false }
): void {
  for (const node of nodes) {
    // Debug: log first file node to understand handle structure
    if (!loggedFirstRef.logged && node.type === 'file') {
      logFirstFileNode(node);
      loggedFirstRef.logged = true;
    }

    if (node.type === 'file' && node.handle && node.rootFolderId) {
      const handle = node.handle;
      const compositeKey = encodeFileSelection(node.rootFolderId, node.path);

      if (isWebFileHandle(handle)) {
        map.set(compositeKey, {
          webHandle: handle,
          fileName: node.name,
          fileSize: node.size,
        });
      } else if (isElectronHandle(handle)) {
        map.set(compositeKey, {
          electronHandle: handle,
          fileName: node.name,
          fileSize: node.size,
        });
      }
    }
    if (node.children) {
      buildFileHandleMap(node.children, map, loggedFirstRef);
    }
  }
}

function getSelectionSkipState(params: {
  hasHandleSource: boolean;
  isEmbeddingActive: boolean;
  isFileImporting: boolean;
  selectedCount: number;
}): {
  reason: 'embedding-active' | 'file-import' | 'no-files' | 'no-handles' | null;
  message: string | null;
} {
  if (params.isFileImporting) {
    return {
      reason: 'file-import',
      message: 'Selection effect skipped - file import in progress',
    };
  }
  if (params.isEmbeddingActive) {
    return {
      reason: 'embedding-active',
      message: 'Selection effect skipped - embedding active',
    };
  }
  if (params.selectedCount === 0) {
    return { reason: 'no-files', message: null };
  }
  if (!params.hasHandleSource) {
    return { reason: 'no-handles', message: null };
  }
  return { reason: null, message: null };
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
}: UseBackgroundTokenIndexerIntegrationProps): UseBackgroundTokenIndexerIntegrationReturn {
  // Get the token cache context (may be null if not in provider)
  const tokenCache = useOptionalTokenCacheContext();

  // Get the FileTreeIndex context for O(1) handle lookups (optional - falls back to local map)
  const fileTreeIndex = useOptionalFileTreeIndexContext();
  const indexGetHandle = fileTreeIndex?.getHandle;
  // Track FileTreeIndex version for retry logic - when index fills, retry pending files
  const indexVersion = fileTreeIndex?.version ?? 0;

  // Check if file import is in progress - skip background indexing to avoid database contention
  // Import the store dynamically to get isImporting state
  const isFileImporting = useFileImportingState();
  const isEmbeddingActive = useEmbeddingActiveState();

  // Track which files we've already queued for indexing
  const indexedFilesRef = useRef<Set<string>>(new Set());
  // Track files currently in flight to avoid re-queuing while a batch is running
  const inFlightRef = useRef<Set<string>>(new Set());
  // Track files skipped due to missing handles - retry when FileTreeIndex fills
  const pendingNoHandleRef = useRef<Set<string>>(new Set());
  const previousSelectionSizeRef = useRef<number>(0);
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
  const isEmbeddingActiveRef = useRef(isEmbeddingActive);
  isEmbeddingActiveRef.current = isEmbeddingActive;

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

      const webFilesToIndex: FileToIndex[] = [];
      const electronFilesToRead: Array<{
        compositeKey: string;
        folderId: string;
        filePath: string;
        fileSize: number | undefined;
        handle: ElectronFileHandle;
      }> = [];
      let skippedNoHandle = 0;
      let skippedBinary = 0;
      let skippedTooLarge = 0;
      let skippedInvalidPath = 0;
      let estimatedElectronBytes = 0;

      if (isEmbeddingActiveRef.current) {
        logger.info('Background token indexing blocked because embedding is active', {
          requestedFiles: compositeKeys.length,
          indexedCount: indexedFilesRef.current.size,
          inFlightCount: inFlightRef.current.size,
        });
        return;
      }

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
        }
      };

      for (const compositeKey of compositeKeys) {
        if (indexedFilesRef.current.has(compositeKey) || inFlightRef.current.has(compositeKey)) {
          continue;
        }

        // Decode key early so we can use index lookup
        const { folderId, path: selectionPath } = decodeFileSelection(compositeKey);
        let normalizedFilePath: string;
        try {
          normalizedFilePath = normalizeSelectionPathForTokenCache(folderId, selectionPath);
        } catch (error) {
          skippedInvalidPath++;
          logger.warn('Skipping file with unsafe path for background indexing', {
            compositeKey,
            folderId,
            selectionPath,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        // Try FileTreeIndex first (O(1) lookup), then fall back to local map
        // NOTE: Use selectionPath (not normalizedFilePath) because FileTreeIndex
        // stores handles keyed by original file-tree node paths.
        const indexGetHandleFn = indexGetHandleRef.current;
        let handleInfo = indexGetHandleFn?.(folderId, selectionPath);
        if (!handleInfo) {
          // Fall back to local map
          handleInfo = fileHandleMapRef.current.get(compositeKey);
        }
        if (!handleInfo) {
          const syntheticElectronHandle =
            electronFileReaderRef.current &&
            buildSyntheticElectronHandle({
              filePath: normalizedFilePath,
              fileSize: cache.getFileSize(folderId, normalizedFilePath),
              folderId,
            });
          if (syntheticElectronHandle) {
            handleInfo = syntheticElectronHandle;
          }
        }
        if (!handleInfo) {
          skippedNoHandle++;
          // Track for retry when FileTreeIndex fills with handles
          pendingNoHandleRef.current.add(compositeKey);
          continue;
        }
        // Handle found - remove from pending if it was there
        pendingNoHandleRef.current.delete(compositeKey);

        // Filter out binary files BEFORE attempting to read/index
        // This avoids IPC overhead for files that would fail anyway
        if (isBinaryFile(handleInfo.fileName)) {
          skippedBinary++;
          // Mark as "indexed" to prevent re-queuing (it will never succeed)
          indexedFilesRef.current.add(compositeKey);
          continue;
        }

        // Filter out large files BEFORE attempting to read/index
        // This avoids AccessError exceptions and IPC overhead
        if (handleInfo.fileSize !== undefined && handleInfo.fileSize > MAX_INDEXABLE_FILE_SIZE) {
          skippedTooLarge++;
          // Mark as "indexed" to prevent re-queuing (it will never succeed)
          indexedFilesRef.current.add(compositeKey);
          continue;
        }

        if (handleInfo.webHandle) {
          markInFlight(compositeKey);
          webFilesToIndex.push({
            compositeKey,
            folderId,
            filePath: normalizedFilePath,
            fileHandle: handleInfo.webHandle,
          });
        } else if (handleInfo.electronHandle) {
          // Electron files: need to read content first
          estimatedElectronBytes += handleInfo.fileSize ?? 0;
          electronFilesToRead.push({
            compositeKey,
            folderId,
            filePath: normalizedFilePath,
            fileSize: handleInfo.fileSize,
            handle: handleInfo.electronHandle,
          });
        }
      }

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

      try {
        await dispatchBatches(webFilesToIndex);
      } catch (error) {
        logger.error('triggerIndexing web batch dispatch failed', {
          error: error instanceof Error ? error.message : String(error),
        });
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

        // Read files in parallel batches to avoid overwhelming IPC
        const electronBatchSize = 20;
        let electronFilesRead = 0;
        let electronBytesRead = 0;
        for (let i = 0; i < electronFilesToRead.length; i += electronBatchSize) {
          if (isEmbeddingActiveRef.current) {
            logger.info('Stopped Electron token indexing because embedding became active mid-run', {
              electronBytesRead,
              electronFilesRead,
              remainingFiles: electronFilesToRead.length - i,
            });
            return;
          }

          const batch = electronFilesToRead.slice(i, i + electronBatchSize);
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
              logger.error('Failed to read Electron file', {
                compositeKey: result.compositeKey,
                error: result.error ?? 'No content returned',
              });
              handleFileError(result.compositeKey, result.error ?? 'No content returned');
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

          if (emitLargeSelectionDiagnostics) {
            logger.info('Background token indexing dispatched Electron batch', {
              batchFilesReady: electronFilesReady.length,
              electronBatchSize,
              electronBytesRead,
              electronFilesRead,
              estimatedElectronBytes,
              remainingFiles: Math.max(electronFilesToRead.length - (i + batch.length), 0),
            });
          }

          try {
            await dispatchBatches(electronFilesReady);
          } catch (error) {
            logger.error('triggerIndexing electron batch dispatch failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
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
  useEffect(() => {
    const indexer = backgroundIndexerRef.current;
    const previousSize = previousSelectionSizeRef.current;
    previousSelectionSizeRef.current = selectedFiles.size;

    if (selectedFiles.size < previousSize && inFlightRef.current.size > 0) {
      indexer.cancelIndexing();
      inFlightRef.current.clear();
      bumpInFlightPulse((value) => value + 1);
      logger.debug('Cleared in-flight queue due to selection shrink', {
        previousSize,
        nextSize: selectedFiles.size,
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
    const skipState = getSelectionSkipState({
      isFileImporting,
      isEmbeddingActive,
      selectedCount: selectedFiles.size,
      hasHandleSource: Boolean(hasHandleSource),
    });
    if (skipState.reason) {
      if (selectionSkipReasonRef.current !== skipState.reason) {
        selectionSkipReasonRef.current = skipState.reason;
        if (skipState.message) {
          logger.debug(skipState.message);
        }
        if (
          skipState.reason === 'embedding-active' &&
          selectedFiles.size >= LARGE_SELECTION_DIAGNOSTIC_FILE_THRESHOLD
        ) {
          logger.info('Selection effect skipped while embedding is active', {
            indexedCount: indexedFilesRef.current.size,
            inFlightCount: inFlightRef.current.size,
            selectedCount: selectedFiles.size,
          });
        }
      }
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
  }, [
    selectedFiles,
    triggerIndexing,
    tokenCacheIsOperational,
    fileHandleMapSize,
    isFileImporting,
    isEmbeddingActive,
    indexGetHandle,
  ]);

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

    // Skip during file import
    if (isFileImporting) {
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
  }, [indexVersion, selectedFiles, triggerIndexing, isFileImporting]);

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

    // Skip during file import to avoid database contention
    if (isFileImporting) {
      if (warmCacheSkipReasonRef.current !== 'file-import') {
        warmCacheSkipReasonRef.current = 'file-import';
        logger.debug('Warm cache effect skipped - file import in progress');
      }
      return;
    }

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
  }, [selectedFiles, tokenCacheIsOperational, tokenCacheIsPersisted, isFileImporting]);

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

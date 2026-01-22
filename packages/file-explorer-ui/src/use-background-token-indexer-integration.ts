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
import { useVectorStatusUIStore } from '@brainstrike/preferences';
import { type FileToIndex, useBackgroundTokenIndexer } from '@brainstrike/token-cache';
import type { IFileNode } from '@brainstrike/types';
import {
  createLogger,
  decodeFileSelection,
  encodeFileSelection,
  isBinaryFile,
} from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdaptiveDebounceMs, INDEX_BATCH_SIZE } from './constants';
import { useOptionalTokenCacheContext } from './token-cache-context';

const logger = createLogger('BackgroundTokenIndexerIntegration');

/**
 * Maximum file size for token indexing (750KB).
 * Files larger than this are skipped to prevent memory issues and processing delays.
 */
const MAX_INDEXABLE_FILE_SIZE = DEFAULT_MAX_FILE_SIZE;

/**
 * Helper hook to check if file import is in progress.
 * When true, background token indexing should be paused to avoid database contention.
 */
function useFileImportingState(): boolean {
  return useVectorStatusUIStore((s) => s.isImporting);
}

/**
 * Function to read file content for Electron handles via IPC.
 * Required for Electron; workers cannot read files directly due to security restrictions.
 */
export type ElectronFileReader = (handle: ElectronFileHandle) => Promise<string>;

export interface UseBackgroundTokenIndexerIntegrationProps {
  /** The file tree containing IFileNodes with handles */
  fileTree: IFileNode[];
  /** Set of selected file composite keys (folderId::path format) */
  selectedFiles: Set<string>;
  /** Callback when a file's token count is resolved */
  onTokenResolved?: (compositeKey: string, tokenCount: number) => void;
  /** File reader for Electron handles - required when using Electron file handles */
  electronFileReader?: ElectronFileReader;
}

/** Diagnostic info for debugging indexing issues */
export interface IndexerDiagnostics {
  /** Number of files tracked as already indexed */
  indexedCount: number;
  /** Number of files currently being processed */
  inFlightCount: number;
  /** Number of file handles available */
  fileHandleMapSize: number;
  /** Whether the background indexer worker is ready */
  workerReady: boolean;
  /** Whether the token cache is operational (counting works) */
  cacheOperational: boolean;
  /** Whether the token cache is persisted (DB-backed) */
  cachePersisted: boolean;
  /** Clear the indexed files tracking (forces re-indexing) */
  clearIndexedCache: () => void;
}

export interface UseBackgroundTokenIndexerIntegrationReturn {
  /** Whether background indexing is active */
  isIndexing: boolean;
  /** Manually trigger indexing for specific files (async for Electron file reading) */
  triggerIndexing: (compositeKeys: string[]) => Promise<void>;
  /** Whether the background indexer is ready */
  isReady: boolean;
  /** Current indexing progress */
  progress: { completed: number; total: number; currentFile?: string } | null;
  /** Diagnostic info for debugging */
  diagnostics: IndexerDiagnostics;
}

/**
 * Electron-style handle with path property
 */
interface ElectronFileHandle {
  path: string;
  name: string;
  kind: 'file';
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
  webHandle?: FileSystemFileHandle;
  electronHandle?: ElectronFileHandle;
  /** File name for binary detection */
  fileName: string;
  /** File size in bytes (if known) for large file filtering */
  fileSize: number | undefined;
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

  // Check if file import is in progress - skip background indexing to avoid database contention
  // Import the store dynamically to get isImporting state
  const isFileImporting = useFileImportingState();

  // Track which files we've already queued for indexing
  const indexedFilesRef = useRef<Set<string>>(new Set());
  // Track files currently in flight to avoid re-queuing while a batch is running
  const inFlightRef = useRef<Set<string>>(new Set());
  const previousSelectionSizeRef = useRef<number>(0);
  const [_inFlightPulse, bumpInFlightPulse] = useState(0);
  // Track file handle map population to trigger selection effect re-run
  const [fileHandleMapSize, setFileHandleMapSize] = useState(0);

  // Stable refs for tokenCache functions to avoid re-render loops.
  // The tokenCache object changes on every cacheVersion bump, but the functions are stable.
  // Using refs prevents effects from re-running when cacheVersion changes.
  const tokenCacheRef = useRef(tokenCache);
  tokenCacheRef.current = tokenCache;

  // Build file handle map whenever tree changes (debounced to avoid rebuilding during expand-all)
  const fileHandleMapRef = useRef<Map<string, HandleInfo>>(new Map());
  const previousRootIdsRef = useRef<string>('');
  const rebuildTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase 4 optimization: Track staleness to enable lazy rebuilds
  const fileHandleMapStaleRef = useRef(false);

  // Side-effectful map construction on tree change is intentional
  useEffect(() => {
    // Cancel any pending rebuild
    if (rebuildTimeoutRef.current) {
      clearTimeout(rebuildTimeoutRef.current);
    }

    // Mark map as stale immediately
    fileHandleMapStaleRef.current = true;

    // Debounce the expensive rebuild - wait for tree to stabilize
    rebuildTimeoutRef.current = setTimeout(() => {
      // Phase 4 optimization: Skip rebuild if no files selected and no pending operations
      // This avoids expensive tree traversal when the map won't be used
      if (selectedFiles.size === 0 && inFlightRef.current.size === 0) {
        logger.debug('Skipping handle map rebuild - no active operations', {
          selectedCount: selectedFiles.size,
          inFlightCount: inFlightRef.current.size,
        });
        return;
      }

      const map = new Map<string, HandleInfo>();
      const rootIds = new Set<string>();
      buildFileHandleMap(fileTree, map);
      for (const key of map.keys()) {
        const folderId = key.split('|@|', 1)[0];
        if (folderId) {
          rootIds.add(folderId);
        }
      }
      fileHandleMapRef.current = map;
      fileHandleMapStaleRef.current = false;
      // Update state to trigger selection effect re-run when map is populated
      setFileHandleMapSize(map.size);

      const rootFingerprint = Array.from(rootIds).sort().join('|');
      if (previousRootIdsRef.current && previousRootIdsRef.current !== rootFingerprint) {
        indexedFilesRef.current.clear();
        inFlightRef.current.clear();
        bumpInFlightPulse((value) => value + 1);
        logger.debug('Cleared indexedFiles cache due to root folder change', {
          previousRootIds: previousRootIdsRef.current,
          nextRootIds: rootFingerprint,
        });
      }
      previousRootIdsRef.current = rootFingerprint;

      logger.debug('File handle map built', {
        size: map.size,
        hasElectron: [...map.values()].some((h) => h.electronHandle),
        hasWeb: [...map.values()].some((h) => h.webHandle),
      });
    }, 500); // Wait 500ms for tree to stabilize before rebuilding

    return () => {
      if (rebuildTimeoutRef.current) {
        clearTimeout(rebuildTimeoutRef.current);
      }
    };
  }, [fileTree, selectedFiles.size]);

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
      tokenCacheRef.current?.updateHotCache(folderId, path, tokenCount);
      tokenCacheRef.current?.updateFileSizeCache(folderId, path, fileSize);
      indexedFilesRef.current.add(compositeKey);
      logger.debug('File indexed', { compositeKey, tokenCount, fileSize });
      onTokenResolvedRef.current?.(compositeKey, tokenCount);
    },
    []
  );

  const handleFileError = useCallback((compositeKey: string, error: string) => {
    inFlightRef.current.delete(compositeKey);
    indexedFilesRef.current.delete(compositeKey);
    if (inFlightRef.current.size === 0) {
      bumpInFlightPulse((value) => value + 1);
    }
    logger.error('Background indexer file error', { compositeKey, error });
  }, []);

  // Use the background token indexer when context is available
  const backgroundIndexer = useBackgroundTokenIndexer({
    store: tokenCache?.store ?? null,
    mode: tokenCache?.countingMode ?? 'heuristic',
    onFileIndexed: handleFileIndexed,
    onFileError: handleFileError,
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
      if (!(cache?.isOperational && indexer.isReady)) {
        // Use debug level - this is expected during startup before everything initializes
        logger.debug('triggerIndexing blocked - not ready', {
          tokenCacheOperational: cache?.isOperational ?? false,
          backgroundIndexerReady: indexer.isReady,
          requestedFiles: compositeKeys.length,
        });
        return;
      }

      logger.debug('triggerIndexing started', { fileCount: compositeKeys.length });

      const filesToIndex: FileToIndex[] = [];
      const electronFilesToRead: Array<{
        compositeKey: string;
        folderId: string;
        path: string;
        handle: ElectronFileHandle;
      }> = [];
      let skippedNoHandle = 0;
      let skippedBinary = 0;
      let skippedTooLarge = 0;

      // DEBUG: Log sample keys from map and selection to diagnose mismatch
      const mapKeys = Array.from(fileHandleMapRef.current.keys()).slice(0, 3);
      const selectionKeys = compositeKeys.slice(0, 3);
      logger.debug('triggerIndexing key comparison', {
        mapKeysSample: mapKeys,
        selectionKeysSample: selectionKeys,
        mapSize: fileHandleMapRef.current.size,
        selectionSize: compositeKeys.length,
      });

      for (const compositeKey of compositeKeys) {
        // Skip if already indexed in this session
        if (indexedFilesRef.current.has(compositeKey)) {
          continue;
        }
        // Skip if already queued
        if (inFlightRef.current.has(compositeKey)) {
          continue;
        }

        const handleInfo = fileHandleMapRef.current.get(compositeKey);
        if (!handleInfo) {
          skippedNoHandle++;
          continue;
        }

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

        const { folderId, path } = decodeFileSelection(compositeKey);

        if (handleInfo.webHandle) {
          // Web files: pass handle directly to worker
          const wasEmpty = inFlightRef.current.size === 0;
          inFlightRef.current.add(compositeKey);
          if (wasEmpty) {
            bumpInFlightPulse((value) => value + 1);
          }
          filesToIndex.push({
            compositeKey,
            folderId,
            filePath: path,
            fileHandle: handleInfo.webHandle,
          });
        } else if (handleInfo.electronHandle) {
          // Electron files: need to read content first
          electronFilesToRead.push({
            compositeKey,
            folderId,
            path,
            handle: handleInfo.electronHandle,
          });
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

        // Read files in parallel batches to avoid overwhelming IPC
        const BatchSize = 20;
        for (let i = 0; i < electronFilesToRead.length; i += BatchSize) {
          const batch = electronFilesToRead.slice(i, i + BatchSize);
          const results = await Promise.all(
            batch.map(async ({ compositeKey, folderId, path, handle }) => {
              try {
                const content = await fileReader(handle);
                return { compositeKey, folderId, path, content, error: null };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { compositeKey, folderId, path, content: null, error: message };
              }
            })
          );

          for (const result of results) {
            if (result.error || result.content === null) {
              logger.error('Failed to read Electron file', {
                compositeKey: result.compositeKey,
                error: result.error ?? 'No content returned',
              });
              handleFileError(result.compositeKey, result.error ?? 'No content returned');
              continue;
            }

            const wasEmpty = inFlightRef.current.size === 0;
            inFlightRef.current.add(result.compositeKey);
            if (wasEmpty) {
              bumpInFlightPulse((value) => value + 1);
            }
            filesToIndex.push({
              compositeKey: result.compositeKey,
              folderId: result.folderId,
              filePath: result.path,
              content: result.content,
              fileSize: new Blob([result.content]).size,
            });
          }
        }
      }

      logger.debug('triggerIndexing prepared', {
        toIndex: filesToIndex.length,
        skippedNoHandle,
        skippedBinary,
        skippedTooLarge,
        electronFiles: electronFilesToRead.length,
        webFiles: filesToIndex.filter((f) => f.fileHandle).length,
      });

      // Log upfront filtering summary at info level when files are skipped
      if (skippedBinary > 0 || skippedTooLarge > 0) {
        logger.info('Upfront filtering applied', {
          skippedBinary,
          skippedTooLarge,
          totalSkipped: skippedBinary + skippedTooLarge,
          remaining: filesToIndex.length,
        });
      }

      if (filesToIndex.length === 0) {
        return;
      }

      // Queue files for background indexing in manageable batches
      for (let i = 0; i < filesToIndex.length; i += INDEX_BATCH_SIZE) {
        const batch = filesToIndex.slice(i, i + INDEX_BATCH_SIZE);
        indexer.indexFiles(batch);
      }
    },
    [handleFileError]
  );

  // Queue newly selected files for indexing when selection changes
  // Uses refs to avoid re-render loops while still accessing latest values
  const backgroundIndexerIsReady = backgroundIndexer.isReady;
  const tokenCacheIsOperational = tokenCache?.isOperational ?? false;
  const tokenCacheIsPersisted = tokenCache?.isPersisted ?? false;
  useEffect(() => {
    const indexer = backgroundIndexerRef.current;
    const cache = tokenCacheRef.current;
    logger.debug('Selection effect triggered', {
      selectedFilesCount: selectedFiles.size,
      isReady: indexer.isReady,
      tokenCacheOperational: cache?.isOperational ?? false,
      alreadyIndexed: indexedFilesRef.current.size,
      fileHandleMapSize: fileHandleMapRef.current.size,
      isFileImporting,
    });

    // Skip background indexing during file import to avoid database contention
    // File import writes many records; concurrent token cache reads/writes cause PGlite serialization delays
    if (isFileImporting) {
      logger.debug('Selection effect skipped - file import in progress');
      return;
    }

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

    // Exit early if no files selected, indexer not ready, or no file handles available yet.
    // During startup, selection may be restored from storage before file tree has handles.
    if (selectedFiles.size === 0 || !indexer.isReady || fileHandleMapRef.current.size === 0) {
      logger.debug('Selection effect exiting early', {
        noFiles: selectedFiles.size === 0,
        notReady: !indexer.isReady,
        noHandles: fileHandleMapRef.current.size === 0,
      });
      return;
    }

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
    backgroundIndexerIsReady,
    tokenCacheIsOperational,
    fileHandleMapSize,
    isFileImporting,
  ]);

  // Clear indexed files cache when file tree changes significantly
  // biome-ignore lint/plugin: Intentional effect to reset cache when folder is cleared - not an event handler
  useEffect(() => {
    // Reset cache when tree is empty (folder cleared)
    if (fileTree.length === 0) {
      indexedFilesRef.current.clear();
      if (inFlightRef.current.size > 0) {
        inFlightRef.current.clear();
        bumpInFlightPulse((value) => value + 1);
      }
    }
  }, [fileTree.length]);

  // Warm hot cache from persistent store so repeat selections show existing counts immediately.
  // Uses tokenCacheRef to avoid re-render loops when cacheVersion changes.
  // biome-ignore lint/plugin: Cache hydration from persistent store is intentional side effect
  useEffect(() => {
    const cache = tokenCacheRef.current;
    if (!cache?.isOperational || selectedFiles.size === 0) {
      logger.debug('Warm cache effect skipped', {
        cacheOperational: cache?.isOperational ?? false,
        cachePersisted: cache?.isPersisted ?? false,
        selectedCount: selectedFiles.size,
      });
      return;
    }

    // Skip during file import to avoid database contention
    if (isFileImporting) {
      logger.debug('Warm cache effect skipped - file import in progress');
      return;
    }
    const folderIds = new Set<string>();
    const keysByFolder = new Map<string, string[]>();
    for (const key of selectedFiles) {
      const { folderId } = decodeFileSelection(key);
      folderIds.add(folderId);
      const arr = keysByFolder.get(folderId) ?? [];
      arr.push(key);
      keysByFolder.set(folderId, arr);
    }

    logger.debug('Warm cache effect: preloading folders', {
      folderCount: folderIds.size,
      totalFiles: selectedFiles.size,
      isPersisted: cache?.isPersisted ?? false,
    });

    for (const folderId of folderIds) {
      void cache.preloadFolder(folderId);
    }

    // After preload, ensure hot cache gets populated for any selected files that
    // were already stored but not yet marked indexed (prevents zero-count UI).
    for (const [folderId, keys] of keysByFolder.entries()) {
      const paths = keys.map((key) => decodeFileSelection(key).path);
      void cache.store
        .getBatch(folderId, paths)
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
            const compositeKey = encodeFileSelection(folderId, path);
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
              requested: paths.length,
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

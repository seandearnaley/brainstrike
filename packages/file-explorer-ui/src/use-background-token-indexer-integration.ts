/**
 * useBackgroundTokenIndexerIntegration
 *
 * Integration hook that connects the file tree and selection to the background token indexer.
 * When files are selected, it extracts FileSystemFileHandles and queues them for background indexing.
 *
 * This enables accurate token counting without blocking the main thread or
 * requiring file content to be loaded first.
 */

import { type FileToIndex, useBackgroundTokenIndexer } from '@brainstrike/token-cache';
import type { IFileNode } from '@brainstrike/types';
import { createLogger, decodeFileSelection, encodeFileSelection } from '@brainstrike/utils';
import { useCallback, useEffect, useRef } from 'react';
import { useOptionalTokenCacheContext } from './token-cache-context';

const logger = createLogger('BackgroundTokenIndexerIntegration');

export type UseBackgroundTokenIndexerIntegrationProps = {
  /** The file tree containing IFileNodes with handles */
  fileTree: IFileNode[];
  /** Set of selected file composite keys (folderId::path format) */
  selectedFiles: Set<string>;
  /** Callback when a file's token count is resolved */
  onTokenResolved?: (compositeKey: string, tokenCount: number) => void;
};

export type UseBackgroundTokenIndexerIntegrationReturn = {
  /** Whether background indexing is active */
  isIndexing: boolean;
  /** Manually trigger indexing for specific files */
  triggerIndexing: (compositeKeys: string[]) => void;
  /** Whether the background indexer is ready */
  isReady: boolean;
  /** Current indexing progress */
  progress: { completed: number; total: number; currentFile?: string } | null;
};

/**
 * Electron-style handle with path property
 */
type ElectronFileHandle = {
  path: string;
  name: string;
  kind: 'file';
  platform: 'electron';
};

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
 * Combined handle info for indexing
 */
type HandleInfo = {
  webHandle?: FileSystemFileHandle;
  electronHandle?: ElectronFileHandle;
};

/**
 * Log debug info for first file node encountered
 */
function logFirstFileNode(node: IFileNode): void {
  const handle = node.handle as unknown as Record<string, unknown> | undefined;
  logger.info('buildFileHandleMap first file node', {
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
        map.set(compositeKey, { webHandle: handle });
      } else if (isElectronHandle(handle)) {
        map.set(compositeKey, { electronHandle: handle });
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
}: UseBackgroundTokenIndexerIntegrationProps): UseBackgroundTokenIndexerIntegrationReturn {
  // Get the token cache context (may be null if not in provider)
  const tokenCache = useOptionalTokenCacheContext();

  // Log context availability on mount and changes
  logger.debug('Hook initialized', {
    hasTokenCache: !!tokenCache,
    tokenCacheIsReady: tokenCache?.isReady ?? false,
    countingMode: tokenCache?.countingMode ?? 'N/A',
    hasStore: !!tokenCache?.store,
  });

  // Track which files we've already queued for indexing
  const indexedFilesRef = useRef<Set<string>>(new Set());

  // Build file handle map whenever tree changes
  const fileHandleMapRef = useRef<Map<string, HandleInfo>>(new Map());
  const previousRootIdsRef = useRef<string>('');
  // biome-ignore lint/plugin: Hook is intentionally used for side-effectful map construction on tree change
  useEffect(() => {
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

    const rootFingerprint = Array.from(rootIds).sort().join('|');
    if (previousRootIdsRef.current && previousRootIdsRef.current !== rootFingerprint) {
      indexedFilesRef.current.clear();
      logger.info('Cleared indexedFiles cache due to root folder change', {
        previousRootIds: previousRootIdsRef.current,
        nextRootIds: rootFingerprint,
      });
    }
    previousRootIdsRef.current = rootFingerprint;

    logger.info('File handle map built', {
      size: map.size,
      hasElectron: [...map.values()].some((h) => h.electronHandle),
      hasWeb: [...map.values()].some((h) => h.webHandle),
    });
  }, [fileTree]);

  /**
   * Callback when background indexer resolves a token count.
   * Updates the hot cache to trigger React re-render.
   */
  const handleFileIndexed = useCallback(
    (compositeKey: string, tokenCount: number) => {
      // Decode the composite key to get folderId and path for cache key consistency
      const { folderId, path } = decodeFileSelection(compositeKey);
      // Update the hot cache to trigger UI re-render
      tokenCache?.updateHotCache(folderId, path, tokenCount);
      // Mark as indexed only after we have a resolved result
      indexedFilesRef.current.add(compositeKey);
      // Call optional external callback
      onTokenResolved?.(compositeKey, tokenCount);
    },
    [tokenCache, onTokenResolved]
  );

  // Use the background token indexer when context is available
  const backgroundIndexer = useBackgroundTokenIndexer({
    store: tokenCache?.store ?? null,
    mode: tokenCache?.countingMode ?? 'heuristic',
    onFileIndexed: handleFileIndexed,
  });

  // Log indexer state for debugging
  logger.debug('Background indexer state', {
    isReady: backgroundIndexer.isReady,
    isIndexing: backgroundIndexer.isIndexing,
    selectedFilesCount: selectedFiles.size,
  });

  /**
   * Queue files for indexing using the background worker
   */
  const triggerIndexing = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Indexing logic requires multiple conditional branches for handle types and caching
    (compositeKeys: string[]) => {
      if (!(tokenCache?.isReady && backgroundIndexer.isReady)) {
        logger.warn('triggerIndexing blocked - not ready', {
          tokenCacheReady: tokenCache?.isReady ?? false,
          backgroundIndexerReady: backgroundIndexer.isReady,
          requestedFiles: compositeKeys.length,
        });
        return;
      }

      logger.info('triggerIndexing started', { fileCount: compositeKeys.length });

      const filesToIndex: FileToIndex[] = [];
      let skippedNoHandle = 0;

      for (const compositeKey of compositeKeys) {
        // Skip if already indexed in this session
        if (indexedFilesRef.current.has(compositeKey)) {
          continue;
        }

        const handleInfo = fileHandleMapRef.current.get(compositeKey);
        if (!handleInfo) {
          skippedNoHandle++;
          continue;
        }

        const { folderId, path } = decodeFileSelection(compositeKey);
        filesToIndex.push({
          compositeKey,
          folderId,
          filePath: path,
          // Conditionally include handles to satisfy exactOptionalPropertyTypes
          ...(handleInfo.webHandle ? { fileHandle: handleInfo.webHandle } : {}),
          ...(handleInfo.electronHandle ? { electronHandle: handleInfo.electronHandle } : {}),
        });
      }

      logger.info('triggerIndexing prepared', {
        toIndex: filesToIndex.length,
        skippedNoHandle,
        hasElectron: filesToIndex.some((f) => f.electronHandle),
        hasWeb: filesToIndex.some((f) => f.fileHandle),
      });

      if (filesToIndex.length === 0) {
        return;
      }

      // Queue files for background indexing
      backgroundIndexer.indexFiles(filesToIndex);
    },
    [tokenCache, backgroundIndexer]
  );

  // Queue newly selected files for indexing when selection changes
  useEffect(() => {
    // Use INFO for critical diagnostic visibility
    logger.info('Selection effect triggered', {
      selectedFilesCount: selectedFiles.size,
      isReady: backgroundIndexer.isReady,
      tokenCacheReady: tokenCache?.isReady ?? false,
      alreadyIndexed: indexedFilesRef.current.size,
      fileHandleMapSize: fileHandleMapRef.current.size,
    });

    // Safety: if we think everything is indexed but nothing is running, assume stale cache.
    if (
      selectedFiles.size > 0 &&
      indexedFilesRef.current.size >= selectedFiles.size &&
      !backgroundIndexer.isIndexing
    ) {
      indexedFilesRef.current.clear();
      logger.warn('Cleared indexedFiles cache due to no progress while fully indexed', {
        selectedFilesCount: selectedFiles.size,
      });
    }

    // If the current selection is smaller than what we've already indexed, the cached
    // set is stale (e.g., user navigated to a different folder). Clear it to allow
    // re-counting for the new selection.
    if (indexedFilesRef.current.size > selectedFiles.size) {
      indexedFilesRef.current.clear();
      logger.info('Cleared indexedFiles cache due to selection shrink', {
        previousIndexed: indexedFilesRef.current.size,
        selectedFilesCount: selectedFiles.size,
      });
    }

    if (selectedFiles.size === 0 || !backgroundIndexer.isReady) {
      logger.info('Selection effect exiting early', {
        noFiles: selectedFiles.size === 0,
        notReady: !backgroundIndexer.isReady,
      });
      return;
    }

    // Find files that haven't been indexed yet
    const newFiles = Array.from(selectedFiles).filter((key) => !indexedFilesRef.current.has(key));
    logger.info('New files to index', { count: newFiles.length, first3: newFiles.slice(0, 3) });

    if (newFiles.length === 0) {
      return;
    }

    // Debounce to avoid rapid re-indexing during fast selection changes
    const timeoutId = setTimeout(() => {
      triggerIndexing(newFiles);
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [selectedFiles, triggerIndexing, backgroundIndexer.isReady]);

  // Clear indexed files cache when file tree changes significantly
  // biome-ignore lint/plugin: Intentional effect to reset cache when folder is cleared - not an event handler
  useEffect(() => {
    // Reset cache when tree is empty (folder cleared)
    if (fileTree.length === 0) {
      indexedFilesRef.current.clear();
    }
  }, [fileTree.length]);

  // Warm hot cache from persistent store so repeat selections show existing counts immediately.
  useEffect(() => {
    if (!tokenCache?.isReady || selectedFiles.size === 0) {
      return;
    }
    const folderIds = new Set<string>();
    for (const key of selectedFiles) {
      const { folderId } = decodeFileSelection(key);
      folderIds.add(folderId);
    }
    for (const folderId of folderIds) {
      void tokenCache.preloadFolder(folderId);
    }
  }, [selectedFiles, tokenCache?.isReady, tokenCache?.preloadFolder, tokenCache]);

  return {
    isIndexing: backgroundIndexer.isIndexing,
    triggerIndexing,
    isReady: backgroundIndexer.isReady && (tokenCache?.isReady ?? false),
    progress: backgroundIndexer.progress,
  };
}

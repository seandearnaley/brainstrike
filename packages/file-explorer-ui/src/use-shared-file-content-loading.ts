import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { buildInaccessibleContent, useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileHandle } from '@brainstrike/file-system';
import { DEFAULT_MAX_FILE_SIZE, formatFileSize, getFileSizeConfig } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import { getKnownFileSize } from '@brainstrike/utils/file-content';

const logger = createLogger('SharedFileContentLoading');

import type { FileContentWorker, FileReadRequest } from '@brainstrike/workers/file-content-worker';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { resolveDirectReadPath, supportsDirectPathRead } from './file-content-direct-read-path';
import type { FileContentLoadIntent } from './file-content-load-authority-context';
import { useFileContentLoadAuthority } from './file-content-load-authority-context';
import {
  clearFileLoadingState,
  collectFileContentFailures,
  createFileContentLoadError,
  processFileContentWorkerResults,
  runFileContentWorkerBatch,
  settleFileContentPromises,
  settleFileReadPreparations,
} from './file-content-load-results';
import { runFileContentReloadGroups } from './file-content-reload-scheduler';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './shell/file-explorer-provider';
import { useOptionalFileTreeIndexContext } from './tree/file-tree-provider';
import { initFileContentWorker } from './utils/file-content-worker';
import {
  buildFileNodeCache,
  getFileNodeFromCache,
  refreshFileNodeCacheEntry,
} from './utils/file-node-cache';

// File handle creation helper
function createFileHandle(fileNode: IFileNode, fileSystemAdapter: unknown): FileHandle {
  const adapterPlatform = (fileSystemAdapter as { platform?: Platform }).platform;
  const sourceHandle = fileNode.handle as { platform?: Platform; rootId?: string };
  const handlePlatform = sourceHandle.platform;
  const platform: Platform = adapterPlatform ?? handlePlatform ?? 'web';

  const fileHandle: FileHandle = {
    _internal: fileNode.handle,
    kind: 'file',
    name: fileNode.name,
    path: fileNode.path,
    platform,
    rootFolderId: fileNode.rootFolderId,
    ...(sourceHandle.rootId === undefined ? {} : { rootId: sourceHandle.rootId }),
  };

  const knownFileSize = getKnownFileSize(fileNode.size);
  if (knownFileSize !== null) {
    fileHandle.size = knownFileSize;
  }

  return fileHandle;
}

// File node validation helper
function isFileNodeValid(fileNode: IFileNode | null, folderId: string): boolean {
  return !!(
    fileNode &&
    fileNode.type === 'file' &&
    fileNode.handle &&
    fileNode.rootFolderId === folderId
  );
}

// Count total nodes in tree for debugging
function countTreeNodes(nodes: IFileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children) {
      count += countTreeNodes(node.children);
    }
  }
  return count;
}

function shouldLoadFile(
  compositeKey: string,
  loadingPathsRef: React.RefObject<Set<string>>,
  fileContents: Record<string, string>,
  folderId: string,
  fileTree: IFileNode[],
  canLoadWithoutTree: boolean
): boolean {
  // On Electron (canLoadWithoutTree), we can load without the tree
  const hasTreeOrCanSkip = canLoadWithoutTree || fileTree.length > 0;
  const alreadyLoading = loadingPathsRef.current.has(compositeKey);
  const alreadyLoaded = compositeKey in fileContents;
  const shouldLoad = !!(folderId && hasTreeOrCanSkip && !alreadyLoading && !alreadyLoaded);

  logger.debug('shouldLoadFile check', {
    alreadyLoaded,
    alreadyLoading,
    canLoadWithoutTree,
    compositeKey,
    folderId,
    hasTreeOrCanSkip,
    shouldLoad,
    treeLength: fileTree.length,
  });

  return shouldLoad;
}

// File node retrieval with index-first lookup and cache fallback
async function getFileNodeWithRetry(
  nodeCacheRef: React.RefObject<Map<string, Map<string, IFileNode>>>,
  fileTree: IFileNode[],
  folderId: string,
  path: string,
  indexGetNode?: (folderId: string, path: string) => IFileNode | undefined,
  options: { readonly warnOnCacheMiss?: boolean } = {}
): Promise<IFileNode | null> {
  const hasIndexLookup = typeof indexGetNode === 'function';

  // Try index first (O(1) lookup) when available
  if (indexGetNode) {
    const indexNode = indexGetNode(folderId, path);
    if (isFileNodeValid(indexNode ?? null, folderId)) {
      logger.debug('Node found via FileTreeIndex', { folderId, path });
      return indexNode ?? null;
    }
    // Index miss - fall through to cache lookup
    logger.debug('Index miss, falling back to cache', { folderId, path });
  }

  // Fallback to cache lookup
  const treeNodeCount = countTreeNodes(fileTree);
  const cacheLookupOptions =
    typeof options.warnOnCacheMiss === 'boolean'
      ? { warnOnMiss: options.warnOnCacheMiss }
      : undefined;
  let fileNode = getFileNodeFromCache(
    nodeCacheRef.current,
    fileTree,
    folderId,
    path,
    cacheLookupOptions
  );

  // When the shared index is present, let index/tree updates drive retries instead of polling.
  if (!isFileNodeValid(fileNode, folderId)) {
    if (hasIndexLookup) {
      return fileNode;
    }

    logger.debug('Initial lookup failed, retrying', {
      fileTreeLength: fileTree.length,
      folderId,
      foundNode: !!fileNode,
      hasHandle: fileNode?.handle !== undefined && fileNode?.handle !== null,
      path,
      treeNodeCount,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    fileNode = refreshFileNodeCacheEntry(nodeCacheRef.current, fileTree, folderId, path);
  }

  return fileNode;
}

interface CachedHandleLookup {
  getFileHandle?: (folderId: string, relativePath: string) => Promise<FileSystemFileHandle | null>;
}

type CachedFileRequestResult =
  | { status: 'blocked' }
  | { status: 'miss' }
  | { request: FileReadRequest; status: 'request' };

function getHandleCache(fileSystemAdapter: unknown): CachedHandleLookup | null {
  const adapterWithCache = fileSystemAdapter as {
    getHandleCache?: () => CachedHandleLookup;
  };
  return adapterWithCache.getHandleCache?.() ?? null;
}

function getConfiguredMaxFileSize(): number {
  const configuredMaxFileSize = getFileSizeConfig().maxFileSize;
  if (
    typeof configuredMaxFileSize !== 'number' ||
    !Number.isFinite(configuredMaxFileSize) ||
    configuredMaxFileSize <= 0
  ) {
    return DEFAULT_MAX_FILE_SIZE;
  }
  return configuredMaxFileSize;
}

function isKnownFileSizeTooLargeForMax(
  size: number | undefined,
  maxFileSize: number
): size is number {
  const knownFileSize = getKnownFileSize(size);
  return knownFileSize !== null && knownFileSize > maxFileSize;
}

function buildTooLargeFileMessage(size: number, maxFileSize: number): string {
  return `File too large: ${formatFileSize(size)} (max: ${formatFileSize(maxFileSize)})`;
}

function markFileLoading(
  compositeKey: string,
  loadingPathsRef: React.RefObject<Set<string>>,
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>
): void {
  loadingPathsRef.current.add(compositeKey);
  setLoadingFiles((prev) => new Set(prev).add(compositeKey));
}

/** @internal Exported for focused regression coverage. */
export function getCachedFileRequestName(path: string): string {
  const lastSlashIndex = path.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return path;
  }

  const name = path.slice(lastSlashIndex + 1);
  return name || path;
}

async function buildCachedFileRequest(args: {
  handleCache: CachedHandleLookup | null;
  folderId: string;
  path: string;
  compositeKey: string;
  setFileContent: (key: string, content: string) => void;
  loadingPathsRef: React.RefObject<Set<string>>;
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
}): Promise<CachedFileRequestResult> {
  const {
    handleCache,
    folderId,
    path,
    compositeKey,
    setFileContent,
    loadingPathsRef,
    setLoadingFiles,
  } = args;
  if (!handleCache?.getFileHandle) {
    return { status: 'miss' };
  }

  const cachedHandle = await handleCache.getFileHandle(folderId, path);
  if (!cachedHandle) {
    return { status: 'miss' };
  }

  if (typeof cachedHandle.queryPermission === 'function') {
    const permission = await cachedHandle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') {
      setFileContent(compositeKey, buildInaccessibleContent(`permission required: ${path}`));
      return { status: 'blocked' };
    }
  }

  markFileLoading(compositeKey, loadingPathsRef, setLoadingFiles);
  // Avoid split/pop here: cached browser handle requests can be prepared in bulk.
  const name = getCachedFileRequestName(path);
  const fileHandle: FileHandle = {
    _internal: cachedHandle,
    kind: 'file',
    name,
    path,
    platform: 'web',
    rootFolderId: folderId,
  };
  return { request: { compositeKey, handle: fileHandle, path }, status: 'request' };
}

async function handleMissingFileNode(args: {
  fileTree: IFileNode[];
  folderId: string;
  path: string;
  compositeKey: string;
  handleCache: CachedHandleLookup | null;
  nodeCacheRef: React.RefObject<Map<string, Map<string, IFileNode>>>;
  /** Exact durable registry authority for a direct-path read. */
  directReadAuthority: { readonly rootId: string; readonly rootPath: string } | null;
  setFileContent: (key: string, content: string) => void;
  loadingPathsRef: React.RefObject<Set<string>>;
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  fileSystemAdapter: unknown;
}): Promise<FileReadRequest | null> {
  const {
    fileTree,
    folderId,
    path,
    compositeKey,
    handleCache,
    nodeCacheRef,
    directReadAuthority,
    setFileContent,
    loadingPathsRef,
    setLoadingFiles,
    fileSystemAdapter,
  } = args;

  if (supportsDirectPathRead(fileSystemAdapter)) {
    if (!directReadAuthority) {
      // Root descriptors hydrate asynchronously during desktop boot. Keep the
      // key unloaded so WorkspaceTabsProvider can retry when authority arrives;
      // persisting an inaccessible sentinel here would turn a transient boot
      // ordering state into a sticky terminal result.
      logger.debug('Deferred direct file read until mounted-root authority is available');
      return null;
    }
    const directReadPath = resolveDirectReadPath(directReadAuthority.rootPath, path);
    if (directReadPath) {
      markFileLoading(compositeKey, loadingPathsRef, setLoadingFiles);
      return {
        absoluteRootId: directReadAuthority.rootId,
        absoluteRootPath: directReadAuthority.rootPath,
        compositeKey,
        path: directReadPath,
      };
    }
    logger.warn('Rejected unavailable direct file read path', {
      hasAbsoluteRootPath:
        directReadAuthority.rootPath.startsWith('/') ||
        /^[A-Za-z]:[\\/]/u.test(directReadAuthority.rootPath),
    });
    setFileContent(
      compositeKey,
      buildInaccessibleContent('direct read path is unavailable or outside the mounted root')
    );
    return null;
  }

  const cachedRequest = await buildCachedFileRequest({
    compositeKey,
    folderId,
    handleCache,
    loadingPathsRef,
    path,
    setFileContent,
    setLoadingFiles,
  });
  if (cachedRequest.status === 'request') {
    return cachedRequest.request;
  }
  if (cachedRequest.status === 'blocked') {
    return null;
  }

  const folderCache = nodeCacheRef.current.get(folderId);
  const cacheSize = folderCache?.size ?? 0;
  const totalCacheFolders = nodeCacheRef.current.size;
  const treeNodeCount = countTreeNodes(fileTree);

  logger.warn('File not found in tree', {
    cacheSize,
    fileTreeLength: fileTree.length,
    folderId,
    path,
    totalCacheFolders,
    treeNodeCount,
  });
  setFileContent(compositeKey, `File not found: ${path}`);
  return null;
}

async function handleInvalidFileNode(args: {
  fileNode: IFileNode;
  folderId: string;
  path: string;
  compositeKey: string;
  handleCache: CachedHandleLookup | null;
  setFileContent: (key: string, content: string) => void;
  loadingPathsRef: React.RefObject<Set<string>>;
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
}): Promise<FileReadRequest | null> {
  const {
    fileNode,
    folderId,
    path,
    compositeKey,
    handleCache,
    setFileContent,
    loadingPathsRef,
    setLoadingFiles,
  } = args;

  if (fileNode.rootFolderId !== folderId) {
    const error = buildInaccessibleContent(
      `Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`
    );
    logger.warn('Folder mismatch', { expected: folderId, found: fileNode.rootFolderId, path });
    setFileContent(compositeKey, error);
    return null;
  }

  if (!fileNode.handle) {
    const cachedRequest = await buildCachedFileRequest({
      compositeKey,
      folderId,
      handleCache,
      loadingPathsRef,
      path,
      setFileContent,
      setLoadingFiles,
    });
    if (cachedRequest.status === 'request') {
      return cachedRequest.request;
    }
    if (cachedRequest.status === 'blocked') {
      return null;
    }
    logger.warn('File has no handle', { folderId, nodeType: fileNode.type, path });
    setFileContent(compositeKey, `File handle not available: ${path}`);
    return null;
  }

  if (fileNode.type !== 'file') {
    logger.warn('Node is not a file', { path, type: fileNode.type });
    setFileContent(compositeKey, `Not a file: ${path}`);
  }

  return null;
}

// File read preparation logic
async function prepareFileReadRequest(
  compositeKey: string,
  expectedGeneration: number,
  fileTree: IFileNode[],
  fileSystemAdapter: unknown,
  store: ReturnType<typeof useFileExplorerStoreContext>,
  nodeCacheRef: React.RefObject<Map<string, Map<string, IFileNode>>>,
  loadingPathsRef: React.RefObject<Set<string>>,
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>,
  canLoadWithoutTree: boolean,
  isCurrentGeneration: (compositeKey: string, expectedGeneration: number) => boolean,
  indexGetNode?: (folderId: string, path: string) => IFileNode | undefined
): Promise<FileReadRequest | null> {
  const { setFileContent: commitFileContent, fileContents } = store.getState();
  const setFileContent = (key: string, content: string): void => {
    if (!isCurrentGeneration(key, expectedGeneration)) {
      return;
    }
    commitFileContent(key, content);
  };
  const { folderId, path } = decodeFileSelection(compositeKey);

  if (
    !shouldLoadFile(
      compositeKey,
      loadingPathsRef,
      fileContents,
      folderId,
      fileTree,
      canLoadWithoutTree
    )
  ) {
    return null;
  }

  const fileNode = await getFileNodeWithRetry(
    nodeCacheRef,
    fileTree,
    folderId,
    path,
    indexGetNode,
    {
      warnOnCacheMiss: !canLoadWithoutTree,
    }
  );
  const handleCache = getHandleCache(fileSystemAdapter);

  if (!fileNode) {
    // Storage v5: folderId must exact-match a durable descriptor. A legacy
    // path-shaped folderId is not sufficient authority and never falls back to
    // path-only registry lookup (duplicate presentation aliases are ambiguous).
    const rootDescriptor = store.getState().rootDescriptors[folderId];
    const directReadAuthority =
      rootDescriptor?.rootId === folderId
        ? { rootId: rootDescriptor.rootId, rootPath: rootDescriptor.path }
        : null;
    return handleMissingFileNode({
      compositeKey,
      directReadAuthority,
      fileSystemAdapter,
      fileTree,
      folderId,
      handleCache,
      loadingPathsRef,
      nodeCacheRef,
      path,
      setFileContent,
      setLoadingFiles,
    });
  }

  if (!isFileNodeValid(fileNode, folderId)) {
    return handleInvalidFileNode({
      compositeKey,
      fileNode,
      folderId,
      handleCache,
      loadingPathsRef,
      path,
      setFileContent,
      setLoadingFiles,
    });
  }

  const maxFileSize = getConfiguredMaxFileSize();
  if (isKnownFileSizeTooLargeForMax(fileNode.size, maxFileSize)) {
    logger.debug('Skipping oversized file before read', {
      folderId,
      max: maxFileSize,
      path,
      size: fileNode.size,
    });
    setFileContent(compositeKey, buildTooLargeFileMessage(fileNode.size, maxFileSize));
    return null;
  }

  markFileLoading(compositeKey, loadingPathsRef, setLoadingFiles);

  const fileHandle = createFileHandle(fileNode, fileSystemAdapter);
  return { compositeKey, handle: fileHandle, path };
}

export function useSharedFileContentLoading(fileTree: IFileNode[]) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  const loadingPathsRef = useRef(new Set<string>());
  const nodeCacheRef = useRef<Map<string, Map<string, IFileNode>>>(new Map());
  const workerRef = useRef<FileContentWorker | null>(null);
  const activeExecutionCountRef = useRef(0);

  // Use ref to access current tree without closure stale state issues.
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;

  const { fileSystemAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();
  const loadAuthority = useFileContentLoadAuthority();
  const fileContentErrors = useSyncExternalStore(
    loadAuthority.subscribeErrors,
    loadAuthority.getErrorsSnapshot,
    loadAuthority.getErrorsSnapshot
  );
  const error = useMemo(() => {
    const uniqueErrors = [...new Set(fileContentErrors.values())];
    return uniqueErrors.length > 0 ? createFileContentLoadError(uniqueErrors) : null;
  }, [fileContentErrors]);

  // Try to use shared FileTreeIndex for O(1) lookups when available
  // Falls back to cache-based lookups when not within FileTreeProvider
  const fileTreeIndex = useOptionalFileTreeIndexContext();
  const indexGetNode = fileTreeIndex?.getNode;

  // Debounce timeout ref for cache rebuild (only used as fallback when index unavailable)
  const cacheRebuildTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build cache in effect (async) - only when FileTreeIndex is not available
  // When index is available, this expensive O(N) traversal is skipped entirely
  useEffect(() => {
    // Skip cache rebuild when using shared FileTreeIndex
    if (indexGetNode) {
      return;
    }

    // Cancel any pending rebuild
    if (cacheRebuildTimeoutRef.current) {
      clearTimeout(cacheRebuildTimeoutRef.current);
    }

    const treeNodeCount = countTreeNodes(fileTree);
    logger.debug('Cache rebuild scheduled (fallback mode)', {
      fileTreeLength: fileTree.length,
      treeNodeCount,
    });

    // Debounce the expensive rebuild - wait for tree to stabilize
    cacheRebuildTimeoutRef.current = setTimeout(() => {
      nodeCacheRef.current = buildFileNodeCache(fileTree);

      // Log cache stats after rebuild
      let totalCached = 0;
      for (const folderMap of nodeCacheRef.current.values()) {
        totalCached += folderMap.size;
      }
      logger.debug('Cache rebuilt (fallback mode)', {
        folders: nodeCacheRef.current.size,
        totalCached,
        treeNodeCount,
      });
    }, 500);

    return () => {
      if (cacheRebuildTimeoutRef.current) {
        clearTimeout(cacheRebuildTimeoutRef.current);
      }
    };
  }, [fileTree, indexGetNode]);

  useEffect(() => {
    workerRef.current = initFileContentWorker(fileSystemAdapter);
    return () => {
      workerRef.current = null;
    };
  }, [fileSystemAdapter]);

  // Check if the adapter supports direct path reading (Electron)
  const canLoadWithoutTree = supportsDirectPathRead(fileSystemAdapter);

  // Prepare a single file for reading - uses ref to get current tree
  // When FileTreeIndex is available, uses O(1) lookups instead of cache traversal
  const prepareFileRead = useCallback(
    async (compositeKey: string, expectedGeneration: number): Promise<FileReadRequest | null> =>
      prepareFileReadRequest(
        compositeKey,
        expectedGeneration,
        fileTreeRef.current, // Use ref instead of closure to get current tree
        fileSystemAdapter,
        store,
        nodeCacheRef,
        loadingPathsRef,
        setLoadingFiles,
        canLoadWithoutTree,
        loadAuthority.isCurrentGeneration,
        indexGetNode // Pass index getter for O(1) lookups when available
      ),
    [fileSystemAdapter, store, canLoadWithoutTree, loadAuthority, indexGetNode]
  );

  const executeFileContentLoading = useCallback(
    async (
      compositeKeys: readonly string[],
      expectedGenerations: ReadonlyMap<string, number>
    ): Promise<void> => {
      const worker = workerRef.current;
      if (!worker) {
        const unavailableError = new Error('File content worker is unavailable.');
        loadAuthority.recordErrors(
          compositeKeys.map((compositeKey) => ({
            compositeKey,
            error: unavailableError,
            expectedGeneration: expectedGenerations.get(compositeKey) ?? 0,
          }))
        );
        for (const compositeKey of compositeKeys) {
          clearFileLoadingState(compositeKey, loadingPathsRef, setLoadingFiles);
        }
        throw unavailableError;
      }

      const treeNodeCount = countTreeNodes(fileTreeRef.current);
      logger.debug('handleFileContentLoading called', {
        cacheSize: nodeCacheRef.current.size,
        fileTreeLength: fileTreeRef.current.length,
        requestedFiles: compositeKeys.length,
        treeNodeCount,
      });

      activeExecutionCountRef.current += 1;
      if (activeExecutionCountRef.current === 1) {
        setIsLoading(true);
      }

      try {
        const preparationResults = await Promise.allSettled(
          compositeKeys.map((key) => prepareFileRead(key, expectedGenerations.get(key) ?? 0))
        );
        const clearLoading = (compositeKey: string): void => {
          clearFileLoadingState(compositeKey, loadingPathsRef, setLoadingFiles);
        };
        const { failures: preparationFailures, requests } = settleFileReadPreparations(
          preparationResults,
          compositeKeys,
          clearLoading
        );

        logger.debug('Prepared file read requests', {
          failedRequests: compositeKeys.length - requests.length,
          requestedFiles: compositeKeys.length,
          successfulRequests: requests.length,
        });
        const workerResult =
          requests.length === 0
            ? ({ status: 'completed' } as const)
            : await runFileContentWorkerBatch({
                clearLoading,
                processResults: (results) => {
                  processFileContentWorkerResults(
                    results,
                    store.getState().setFileContent,
                    expectedGenerations,
                    loadAuthority.isCurrentGeneration
                  );
                },
                requests,
                worker,
              });
        const { errorRecords, failures } = collectFileContentFailures({
          expectedGenerations,
          preparationFailures,
          requests,
          workerResult,
        });

        if (failures.length > 0) {
          loadAuthority.recordErrors(errorRecords);
          throw createFileContentLoadError(failures);
        }
      } finally {
        activeExecutionCountRef.current -= 1;
        setIsLoading(activeExecutionCountRef.current > 0);
      }
    },
    [prepareFileRead, store, loadAuthority]
  );

  const runFileContentLoading = useCallback(
    async (
      compositeKeys: readonly string[],
      clearErrorsAtBoundary: boolean,
      intent: FileContentLoadIntent
    ): Promise<void> => {
      const uniqueKeys = [...new Set(compositeKeys)];
      if (clearErrorsAtBoundary) {
        loadAuthority.clearErrors(uniqueKeys);
      }
      const promises = new Set<Promise<void>>();
      const keysToStart: string[] = [];
      for (const key of uniqueKeys) {
        let activePromise = loadAuthority.getActiveLoad(key);
        if (activePromise && intent === 'interactive') {
          activePromise = loadAuthority.promoteQueuedLoad(key) ?? activePromise;
        }
        if (activePromise) {
          promises.add(activePromise);
        } else {
          keysToStart.push(key);
        }
      }

      if (keysToStart.length > 0) {
        const expectedGenerations = new Map(
          keysToStart.map((key) => [key, loadAuthority.currentGeneration(key)] as const)
        );
        const batchPromise = loadAuthority.scheduleBatch(
          keysToStart,
          (scheduledKeys) => {
            const scheduledGenerations = new Map(
              scheduledKeys.map((key) => {
                const expectedGeneration = expectedGenerations.get(key);
                if (expectedGeneration === undefined) {
                  throw new Error('Scheduled file-content key is missing its generation');
                }
                return [key, expectedGeneration] as const;
              })
            );
            return executeFileContentLoading(scheduledKeys, scheduledGenerations);
          },
          intent === 'interactive' ? 'interactive' : 'bulk'
        );
        promises.add(batchPromise);
      }

      await settleFileContentPromises(promises);
    },
    [executeFileContentLoading, loadAuthority]
  );

  const handleFileContentLoading = useCallback(
    (compositeKeys: readonly string[], intent: FileContentLoadIntent): Promise<void> =>
      runFileContentLoading(compositeKeys, true, intent),
    [runFileContentLoading]
  );

  const reloadFileContents = useCallback(
    async (compositeKeys: readonly string[], intent: FileContentLoadIntent): Promise<void> => {
      const uniqueKeys = [...new Set(compositeKeys)];
      if (uniqueKeys.length === 0) {
        return;
      }

      loadAuthority.clearErrors(uniqueKeys);

      // Explicit tab Retry is allowed to promote/join an already queued read.
      // Starting a replacement generation first would turn that queued read
      // into a stale predecessor, forcing duplicate I/O before Retry could run.
      // Background watcher refreshes deliberately keep replacement semantics:
      // a mutation may have happened after an older read began.
      const joinedInteractiveLoads = new Set<Promise<void>>();
      const keysToReload: string[] = [];
      for (const key of uniqueKeys) {
        const activeLoad = intent === 'interactive' ? loadAuthority.getActiveLoad(key) : undefined;
        if (!activeLoad) {
          keysToReload.push(key);
          continue;
        }
        joinedInteractiveLoads.add(loadAuthority.promoteQueuedLoad(key) ?? activeLoad);
      }

      if (keysToReload.length === 0) {
        await settleFileContentPromises(joinedInteractiveLoads);
        return;
      }

      const requestedGenerations = loadAuthority.beginReload(keysToReload);

      // Evict synchronously before awaiting any older read. Every consumer of
      // the shared cache sees a loading boundary instead of stale disk bytes.
      store.getState().clearFileContents(keysToReload);

      const replacement = runFileContentReloadGroups({
        clearGeneration: loadAuthority.clearGeneration,
        compositeKeys: keysToReload,
        getActiveLoad: loadAuthority.getActiveLoad,
        intent,
        isCurrentGeneration: loadAuthority.isCurrentGeneration,
        reload: (keys, reloadIntent) => runFileContentLoading(keys, false, reloadIntent),
        requestedGenerations,
      });
      joinedInteractiveLoads.add(replacement);
      await settleFileContentPromises(joinedInteractiveLoads);
    },
    [loadAuthority, runFileContentLoading, store]
  );

  // Content loading is demand-driven via handleFileContentLoading() when:
  // 1. User explicitly previews a file
  // 2. Import/export operation is triggered
  // Do not make selection eagerly read content; large selections can contain
  // thousands of files.

  // Use zustand selector to get fileContents with proper memoization
  const fileContents = useFileExplorerStoreSelector((state) => state.fileContents);

  return {
    /** True if an explicit root-confined absolute-path capability can bypass the tree. */
    canLoadWithoutTree,
    error,
    fileContentErrors,
    fileContents,
    handleFileContentLoading,
    isLoading,
    loadingFiles,
    reloadFileContents,
  };
}

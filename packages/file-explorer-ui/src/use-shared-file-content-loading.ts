import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileHandle } from '@brainstrike/file-system';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import { createLogger, decodeFileSelection } from '@brainstrike/utils';

const logger = createLogger('SharedFileContentLoading');

import type { FileContentWorker, FileReadRequest } from '@brainstrike/workers/file-content-worker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useOptionalFileTreeIndexContext } from './file-tree-provider';
import { initFileContentWorker } from './utils/file-content-worker';
import {
  buildFileNodeCache,
  getFileNodeFromCache,
  refreshFileNodeCacheEntry,
} from './utils/file-node-cache';

// File handle creation helper
function createFileHandle(fileNode: IFileNode, fileSystemAdapter: unknown): FileHandle {
  const adapterPlatform = (fileSystemAdapter as { platform?: Platform }).platform;
  const handlePlatform = (fileNode.handle as { platform?: Platform }).platform;
  const platform: Platform = adapterPlatform ?? handlePlatform ?? 'web';

  return {
    path: fileNode.path,
    name: fileNode.name,
    kind: 'file',
    platform,
    rootFolderId: fileNode.rootFolderId,
    _internal: fileNode.handle,
  };
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

// Loading state management helpers
function updateLoadingState(
  compositeKey: string,
  loadingPathsRef: React.RefObject<Set<string>>,
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>
): void {
  loadingPathsRef.current.delete(compositeKey);
  setLoadingFiles((prev) => {
    const newSet = new Set(prev);
    newSet.delete(compositeKey);
    return newSet;
  });
}

function processWorkerResults(
  results: Record<string, string>,
  setFileContent: (key: string, content: string) => void
): void {
  for (const [key, value] of Object.entries(results)) {
    setFileContent(key, value);
  }
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
    compositeKey,
    folderId,
    canLoadWithoutTree,
    treeLength: fileTree.length,
    hasTreeOrCanSkip,
    alreadyLoading,
    alreadyLoaded,
    shouldLoad,
  });

  return shouldLoad;
}

// File node retrieval with index-first lookup and cache fallback
async function getFileNodeWithRetry(
  nodeCacheRef: React.RefObject<Map<string, Map<string, IFileNode>>>,
  fileTree: IFileNode[],
  folderId: string,
  path: string,
  indexGetNode?: (folderId: string, path: string) => IFileNode | undefined
): Promise<IFileNode | null> {
  // Try index first (O(1) lookup) when available
  if (indexGetNode) {
    const indexNode = indexGetNode(folderId, path);
    if (isFileNodeValid(indexNode ?? null, folderId)) {
      logger.debug('Node found via FileTreeIndex', { path, folderId });
      return indexNode ?? null;
    }
    // Index miss - fall through to cache lookup
    logger.debug('Index miss, falling back to cache', { path, folderId });
  }

  // Fallback to cache lookup
  const treeNodeCount = countTreeNodes(fileTree);
  let fileNode = getFileNodeFromCache(nodeCacheRef.current, fileTree, folderId, path);

  // If we can't find the node initially, wait and retry once
  if (!isFileNodeValid(fileNode, folderId)) {
    logger.debug('Initial lookup failed, retrying', {
      path,
      folderId,
      treeNodeCount,
      fileTreeLength: fileTree.length,
      foundNode: !!fileNode,
      hasHandle: fileNode?.handle !== undefined && fileNode?.handle !== null,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    fileNode = refreshFileNodeCacheEntry(nodeCacheRef.current, fileTree, folderId, path);
  }

  return fileNode;
}

interface CachedHandleLookup {
  getFileHandle?: (folderId: string, relativePath: string) => Promise<FileSystemFileHandle | null>;
}

function getHandleCache(fileSystemAdapter: unknown): CachedHandleLookup | null {
  const adapterWithCache = fileSystemAdapter as {
    getHandleCache?: () => CachedHandleLookup;
  };
  return adapterWithCache.getHandleCache?.() ?? null;
}

/**
 * Check if the adapter supports reading files directly by path.
 * This is available on Electron where we have direct file system access.
 */
function supportsDirectPathRead(fileSystemAdapter: unknown): boolean {
  const adapter = fileSystemAdapter as { readFileByPath?: unknown };
  return typeof adapter.readFileByPath === 'function';
}

function markFileLoading(
  compositeKey: string,
  loadingPathsRef: React.RefObject<Set<string>>,
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>
): void {
  loadingPathsRef.current.add(compositeKey);
  setLoadingFiles((prev) => new Set(prev).add(compositeKey));
}

async function buildCachedFileRequest(args: {
  handleCache: CachedHandleLookup | null;
  folderId: string;
  path: string;
  compositeKey: string;
  setFileContent: (key: string, content: string) => void;
  loadingPathsRef: React.RefObject<Set<string>>;
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
}): Promise<FileReadRequest | null> {
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
    return null;
  }

  const cachedHandle = await handleCache.getFileHandle(folderId, path);
  if (!cachedHandle) {
    return null;
  }

  if (typeof cachedHandle.queryPermission === 'function') {
    const permission = await cachedHandle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') {
      setFileContent(compositeKey, `File not accessible - permission required: ${path}`);
      return null;
    }
  }

  markFileLoading(compositeKey, loadingPathsRef, setLoadingFiles);
  const name = path.split('/').pop() || path;
  const fileHandle: FileHandle = {
    path,
    name,
    kind: 'file',
    platform: 'web',
    rootFolderId: folderId,
    _internal: cachedHandle,
  };
  return { compositeKey, handle: fileHandle, path };
}

async function handleMissingFileNode(args: {
  fileTree: IFileNode[];
  folderId: string;
  path: string;
  compositeKey: string;
  handleCache: CachedHandleLookup | null;
  nodeCacheRef: React.RefObject<Map<string, Map<string, IFileNode>>>;
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
    setFileContent,
    loadingPathsRef,
    setLoadingFiles,
    fileSystemAdapter,
  } = args;

  // On platforms with direct file access (Electron), we can read by path without a tree handle
  if (supportsDirectPathRead(fileSystemAdapter)) {
    logger.debug('Using direct path read for file not in tree', { path, folderId });
    markFileLoading(compositeKey, loadingPathsRef, setLoadingFiles);
    // Return request without handle - worker will use readFileByPath
    return { compositeKey, path };
  }

  const cachedRequest = await buildCachedFileRequest({
    handleCache,
    folderId,
    path,
    compositeKey,
    setFileContent,
    loadingPathsRef,
    setLoadingFiles,
  });
  if (cachedRequest) {
    return cachedRequest;
  }

  const folderCache = nodeCacheRef.current.get(folderId);
  const cacheSize = folderCache?.size ?? 0;
  const totalCacheFolders = nodeCacheRef.current.size;
  const treeNodeCount = countTreeNodes(fileTree);

  logger.warn('File not found in tree', {
    path,
    folderId,
    cacheSize,
    totalCacheFolders,
    treeNodeCount,
    fileTreeLength: fileTree.length,
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
    const error = `File not accessible - Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`;
    logger.warn('Folder mismatch', { path, expected: folderId, found: fileNode.rootFolderId });
    setFileContent(compositeKey, error);
    return null;
  }

  if (!fileNode.handle) {
    const cachedRequest = await buildCachedFileRequest({
      handleCache,
      folderId,
      path,
      compositeKey,
      setFileContent,
      loadingPathsRef,
      setLoadingFiles,
    });
    if (cachedRequest) {
      return cachedRequest;
    }
    logger.warn('File has no handle', { path, folderId, nodeType: fileNode.type });
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
  fileTree: IFileNode[],
  fileSystemAdapter: unknown,
  store: ReturnType<typeof useFileExplorerStoreContext>,
  nodeCacheRef: React.RefObject<Map<string, Map<string, IFileNode>>>,
  loadingPathsRef: React.RefObject<Set<string>>,
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>,
  canLoadWithoutTree: boolean,
  indexGetNode?: (folderId: string, path: string) => IFileNode | undefined
): Promise<FileReadRequest | null> {
  const { setFileContent, fileContents } = store.getState();
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

  const fileNode = await getFileNodeWithRetry(nodeCacheRef, fileTree, folderId, path, indexGetNode);
  const handleCache = getHandleCache(fileSystemAdapter);

  if (!fileNode) {
    return handleMissingFileNode({
      fileTree,
      folderId,
      path,
      compositeKey,
      handleCache,
      nodeCacheRef,
      setFileContent,
      loadingPathsRef,
      setLoadingFiles,
      fileSystemAdapter,
    });
  }

  if (!isFileNodeValid(fileNode, folderId)) {
    return handleInvalidFileNode({
      fileNode,
      folderId,
      path,
      compositeKey,
      handleCache,
      setFileContent,
      loadingPathsRef,
      setLoadingFiles,
    });
  }

  markFileLoading(compositeKey, loadingPathsRef, setLoadingFiles);

  const fileHandle = createFileHandle(fileNode, fileSystemAdapter);
  return { compositeKey, handle: fileHandle, path };
}

export function useSharedFileContentLoading(fileTree: IFileNode[]) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  const loadingPathsRef = useRef(new Set<string>());
  const nodeCacheRef = useRef<Map<string, Map<string, IFileNode>>>(new Map());
  const workerRef = useRef<FileContentWorker | null>(null);

  // Use ref to access current tree without closure stale state issues.
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;

  const { fileSystemAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();

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
      logger.debug('Skipping cache rebuild - using FileTreeIndex');
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
    async (compositeKey: string): Promise<FileReadRequest | null> =>
      prepareFileReadRequest(
        compositeKey,
        fileTreeRef.current, // Use ref instead of closure to get current tree
        fileSystemAdapter,
        store,
        nodeCacheRef,
        loadingPathsRef,
        setLoadingFiles,
        canLoadWithoutTree,
        indexGetNode // Pass index getter for O(1) lookups when available
      ),
    [fileSystemAdapter, store, canLoadWithoutTree, indexGetNode]
  );

  const handleFileContentLoading = useCallback(
    async (compositeKeys: string[]) => {
      if (!workerRef.current) {
        // Expected during startup before worker is ready
        logger.debug('Worker not initialized, skipping file content loading');
        return;
      }

      const treeNodeCount = countTreeNodes(fileTreeRef.current);
      logger.debug('handleFileContentLoading called', {
        requestedFiles: compositeKeys.length,
        treeNodeCount,
        fileTreeLength: fileTreeRef.current.length,
        cacheSize: nodeCacheRef.current.size,
      });

      setIsLoading(true);
      setError(null);

      try {
        const requests: FileReadRequest[] = [];
        for (const key of compositeKeys) {
          const req = await prepareFileRead(key);
          if (req) {
            requests.push(req);
          }
        }

        logger.debug('Prepared file read requests', {
          requestedFiles: compositeKeys.length,
          successfulRequests: requests.length,
          failedRequests: compositeKeys.length - requests.length,
        });

        await workerRef
          .current(requests, ({ key }) => {
            updateLoadingState(key, loadingPathsRef, setLoadingFiles);
          })
          .then((results) => {
            processWorkerResults(results, store.getState().setFileContent);
          });
      } catch (err) {
        setError(err as Error);
      } finally {
        setIsLoading(false);
      }
    },
    [prepareFileRead, store]
  );

  // NOTE: Eager content loading removed for performance.
  // Content is now loaded on-demand via handleFileContentLoading() when:
  // 1. User explicitly previews a file
  // 2. Import/export operation is triggered
  // This prevents loading 1000s of files just because they're selected.

  // Use zustand selector to get fileContents with proper memoization
  const fileContents = store((state) => state.fileContents);

  return {
    fileContents,
    isLoading,
    error,
    loadingFiles,
    handleFileContentLoading,
    /** True if files can be loaded without a file tree (Electron with readFileByPath) */
    canLoadWithoutTree,
  };
}

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileHandle } from '@brainstrike/file-system';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import { decodeFileSelection } from '@brainstrike/utils';
import type { FileContentWorker, FileReadRequest } from '@brainstrike/workers/file-content-worker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
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

// Loading state management helpers
function updateLoadingState(
  compositeKey: string,
  loadingPathsRef: React.MutableRefObject<Set<string>>,
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
  loadingPathsRef: React.MutableRefObject<Set<string>>,
  fileContents: Record<string, string>,
  folderId: string,
  fileTree: IFileNode[]
): boolean {
  return !!(
    folderId &&
    fileTree.length &&
    !loadingPathsRef.current.has(compositeKey) &&
    !(compositeKey in fileContents)
  );
}

// File node retrieval with retry logic
async function getFileNodeWithRetry(
  nodeCacheRef: React.MutableRefObject<Map<string, Map<string, IFileNode>>>,
  fileTree: IFileNode[],
  folderId: string,
  path: string
): Promise<IFileNode | null> {
  let fileNode = getFileNodeFromCache(nodeCacheRef.current, fileTree, folderId, path);

  // If we can't find the node initially, wait and retry once
  if (!isFileNodeValid(fileNode, folderId)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    fileNode = refreshFileNodeCacheEntry(nodeCacheRef.current, fileTree, folderId, path);
  }

  return fileNode;
}

// File read preparation logic
async function prepareFileReadRequest(
  compositeKey: string,
  fileTree: IFileNode[],
  fileSystemAdapter: unknown,
  store: ReturnType<typeof useFileExplorerStoreContext>,
  nodeCacheRef: React.MutableRefObject<Map<string, Map<string, IFileNode>>>,
  loadingPathsRef: React.MutableRefObject<Set<string>>,
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>
): Promise<FileReadRequest | null> {
  const { setFileContent, fileContents } = store.getState();
  const { folderId, path } = decodeFileSelection(compositeKey);

  if (!shouldLoadFile(compositeKey, loadingPathsRef, fileContents, folderId, fileTree)) {
    return null;
  }

  const fileNode = await getFileNodeWithRetry(nodeCacheRef, fileTree, folderId, path);

  if (!isFileNodeValid(fileNode, folderId)) {
    if (fileNode && fileNode.rootFolderId !== folderId) {
      const error = `File not accessible - Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`;
      setFileContent(compositeKey, error);
    }
    return null;
  }

  if (!fileNode) {
    return null;
  }

  loadingPathsRef.current.add(compositeKey);
  setLoadingFiles((prev) => new Set(prev).add(compositeKey));

  const fileHandle = createFileHandle(fileNode, fileSystemAdapter);
  return { compositeKey, handle: fileHandle, path };
}

// Single file loading helper
async function loadSingleFile(
  compositeKey: string,
  workerRef: React.MutableRefObject<FileContentWorker | null>,
  prepareFileRead: (key: string) => Promise<FileReadRequest | null>,
  loadingPathsRef: React.MutableRefObject<Set<string>>,
  setLoadingFiles: React.Dispatch<React.SetStateAction<Set<string>>>,
  setFileContent: (key: string, content: string) => void
): Promise<void> {
  const req = await prepareFileRead(compositeKey);
  if (req && workerRef.current) {
    workerRef
      .current([req], ({ key }) => {
        updateLoadingState(key, loadingPathsRef, setLoadingFiles);
      })
      .then((results) => {
        processWorkerResults(results, setFileContent);
      });
  }
}

export function useSharedFileContentLoading(fileTree: IFileNode[]) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  const loadingPathsRef = useRef(new Set<string>());
  const nodeCacheRef = useRef<Map<string, Map<string, IFileNode>>>(new Map());
  const workerRef = useRef<FileContentWorker | null>(null);

  const { fileSystemAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();

  useEffect(() => {
    workerRef.current = initFileContentWorker(fileSystemAdapter);
    return () => {
      workerRef.current = null;
    };
  }, [fileSystemAdapter]);

  const selectedFilePaths = store((s) => s.selectedFilePaths);

  // Build a cache of path -> node keyed by folder ID whenever the file tree changes
  useEffect(() => {
    nodeCacheRef.current = buildFileNodeCache(fileTree);
  }, [fileTree]);

  const prepareFileRead = useCallback(
    async (compositeKey: string): Promise<FileReadRequest | null> =>
      prepareFileReadRequest(
        compositeKey,
        fileTree,
        fileSystemAdapter,
        store,
        nodeCacheRef,
        loadingPathsRef,
        setLoadingFiles
      ),
    [fileTree, fileSystemAdapter, store]
  );

  const handleFileContentLoading = useCallback(
    async (compositeKeys: string[]) => {
      if (!workerRef.current) {
        return;
      }
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

  // Automatically load content for selected files
  // biome-ignore lint/plugin: Auto-load content for selected files - reactive data loading
  useEffect(() => {
    const { fileContents, setFileContent } = store.getState();

    for (const compositeKey of selectedFilePaths) {
      if (!(fileContents[compositeKey] || loadingPathsRef.current.has(compositeKey))) {
        void loadSingleFile(
          compositeKey,
          workerRef,
          prepareFileRead,
          loadingPathsRef,
          setLoadingFiles,
          setFileContent
        );
      }
    }
  }, [selectedFilePaths, prepareFileRead, store]);

  // Use zustand selector to get fileContents with proper memoization
  const fileContents = store((state) => state.fileContents);

  return {
    fileContents,
    isLoading,
    error,
    loadingFiles,
    handleFileContentLoading,
  };
}

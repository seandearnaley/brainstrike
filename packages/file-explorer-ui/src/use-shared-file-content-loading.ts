import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileHandle } from '@brainstrike/file-system';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import { decodeFileSelection } from '@brainstrike/utils';
import type { FileContentWorker, FileReadRequest } from '@brainstrike/workers/file-content-worker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { initFileContentWorker } from './utils/file-content-worker';
import {
  buildFileNodeCache,
  getFileNodeFromCache,
  refreshFileNodeCacheEntry,
} from './utils/file-node-cache';

// Helper function to create a FileHandle from an IFileNode
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

// Helper function to validate if a file node is accessible
function isFileNodeValid(fileNode: IFileNode | null, folderId: string): boolean {
  return !!(
    fileNode &&
    fileNode.type === 'file' &&
    fileNode.handle &&
    fileNode.rootFolderId === folderId
  );
}

// Helper function to handle loading state updates
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

// Helper function to process worker results
function processWorkerResults(
  results: Record<string, string>,
  setFileContent: (key: string, content: string) => void
): void {
  for (const [key, value] of Object.entries(results)) {
    setFileContent(key, value);
  }
}

// Helper function to check if file should be loaded
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

  const { selectedFilePaths } = store((s) => ({ selectedFilePaths: s.selectedFilePaths }), shallow);

  // Build a cache of path -> node keyed by folder ID whenever the file tree changes
  useEffect(() => {
    nodeCacheRef.current = buildFileNodeCache(fileTree);
  }, [fileTree]);

  const prepareFileRead = useCallback(
    async (compositeKey: string): Promise<FileReadRequest | null> => {
      const { setFileContent, fileContents } = store.getState();
      const { folderId, path } = decodeFileSelection(compositeKey);

      if (!shouldLoadFile(compositeKey, loadingPathsRef, fileContents, folderId, fileTree)) {
        return null;
      }

      let fileNode = getFileNodeFromCache(nodeCacheRef.current, fileTree, folderId, path);

      // If we can't find the node initially, wait and retry once
      if (!isFileNodeValid(fileNode, folderId)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        fileNode = refreshFileNodeCacheEntry(nodeCacheRef.current, fileTree, folderId, path);

        if (!isFileNodeValid(fileNode, folderId)) {
          if (fileNode && fileNode.rootFolderId !== folderId) {
            const error = `File not accessible - Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`;
            setFileContent(compositeKey, error);
          }
          return null;
        }
      }

      // At this point, fileNode is guaranteed to be valid due to isFileNodeValid check
      if (!fileNode) {
        return null;
      }

      loadingPathsRef.current.add(compositeKey);
      setLoadingFiles((prev) => new Set(prev).add(compositeKey));

      const fileHandle = createFileHandle(fileNode, fileSystemAdapter);
      return { compositeKey, handle: fileHandle, path };
    },
    [fileTree, fileSystemAdapter, store]
  );

  const handleFileContentLoading = useCallback(
    async (compositeKeys: string[]) => {
      if (!workerRef.current) return;
      setIsLoading(true);
      setError(null);

      try {
        const requests: FileReadRequest[] = [];
        for (const key of compositeKeys) {
          const req = await prepareFileRead(key);
          if (req) requests.push(req);
        }

        await workerRef
          .current(requests, ({ key }) => {
            updateLoadingState(key, loadingPathsRef, setLoadingFiles);
          })
          .then((results) => {
            processWorkerResults(results, store.getState().setFileContent);
          });
      } catch (err) {
        console.error('Error loading files:', err);
        setError(err as Error);
      } finally {
        setIsLoading(false);
      }
    },
    [prepareFileRead, store]
  );

  // Automatically load content for selected files
  useEffect(() => {
    const { fileContents } = store.getState();

    for (const compositeKey of selectedFilePaths) {
      if (!fileContents[compositeKey] && !loadingPathsRef.current.has(compositeKey)) {
        prepareFileRead(compositeKey).then((req) => {
          if (req && workerRef.current) {
            workerRef
              .current([req], ({ key }) => {
                updateLoadingState(key, loadingPathsRef, setLoadingFiles);
              })
              .then((results) => {
                processWorkerResults(results, store.getState().setFileContent);
              });
          }
        });
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

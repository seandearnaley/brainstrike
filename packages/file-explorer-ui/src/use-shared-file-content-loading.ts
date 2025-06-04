import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileHandle, Platform } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils';
import { decodeFileSelection } from '@brainstrike/utils';
import {
  type FileContentWorker,
  type FileReadRequest,
  createFileContentWorker,
} from '@brainstrike/workers/file-content-worker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';

// Default concurrency based on hardware capabilities
const getDefaultConcurrency = () => {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    // Use number of CPU cores * 2 as a reasonable default
    return Math.max(5, Math.min(50, navigator.hardwareConcurrency * 2));
  }
  return 20; // Fallback for environments without hardwareConcurrency
};

const MAX_CONCURRENT_LOADS = getDefaultConcurrency();

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
    // Note: createFileContentWorker returns a function, not a worker instance
    // No cleanup needed as it doesn't create persistent resources
    workerRef.current = createFileContentWorker({
      fileSystemAdapter,
      concurrency: MAX_CONCURRENT_LOADS,
    });
  }, [fileSystemAdapter]);
  const { selectedFilePaths } = store(
    (s) => ({
      selectedFilePaths: s.selectedFilePaths,
    }),
    shallow
  );

  // Build a cache of path -> node keyed by folder ID whenever the file tree changes
  useEffect(() => {
    const newCache = new Map<string, Map<string, IFileNode>>();

    const populate = (nodes: IFileNode[]) => {
      for (const node of nodes) {
        const folderMap = newCache.get(node.rootFolderId) || new Map<string, IFileNode>();
        folderMap.set(node.path, node);
        newCache.set(node.rootFolderId, folderMap);

        if (node.type === 'directory' && node.children) {
          populate(node.children);
        }
      }
    };

    populate(fileTree);
    nodeCacheRef.current = newCache;
  }, [fileTree]);

  const prepareFileRead = useCallback(
    async (compositeKey: string): Promise<FileReadRequest | null> => {
      const currentSetFileContent = store.getState().setFileContent;

      // Skip if already loading or loaded
      if (
        loadingPathsRef.current.has(compositeKey) ||
        compositeKey in store.getState().fileContents
      ) {
        return null;
      }

      const { folderId, path } = decodeFileSelection(compositeKey);

      // Skip loading if we don't have a valid folder ID
      if (!folderId) {
        console.debug('Skipping file load - no folder ID');
        return null;
      }

      // Skip loading if file tree is empty (no root directory selected yet)
      if (!fileTree.length) {
        return null;
      }

      // Use the cached node lookup directly instead of via callback
      const cached = nodeCacheRef.current.get(folderId)?.get(path);
      let fileNode = cached || fileExplorer.findNodeByPath(fileTree, path, folderId);

      // Update cache if we found the node
      if (fileNode && !cached) {
        let folderMap = nodeCacheRef.current.get(folderId);
        if (!folderMap) {
          folderMap = new Map<string, IFileNode>();
          nodeCacheRef.current.set(folderId, folderMap);
        }
        folderMap.set(path, fileNode);
      }

      // Debug logging removed to reduce console spam

      // If we can't find the node or don't have access to its handle, wait a bit and retry once
      if (!fileNode || fileNode.type !== 'file' || !fileNode.handle) {
        // Wait a short time for the file tree to potentially update
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Try to find the node again
        fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);

        // Debug logging removed to reduce console spam

        if (!fileNode || fileNode.type !== 'file' || !fileNode.handle) {
          console.debug('File not accessible:', {
            path,
            folderId,
            type: fileNode?.type ?? 'not found',
            rootFolderId: fileNode?.rootFolderId ?? 'unknown',
          });
          return null;
        }
      }

      // Verify the file node belongs to the correct root folder
      if (fileNode.rootFolderId !== folderId) {
        const error = `File not accessible - Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`;
        console.error(error);
        currentSetFileContent(compositeKey, error);
        return null;
      }

      loadingPathsRef.current.add(compositeKey);
      setLoadingFiles((prev) => new Set(prev).add(compositeKey));

      // Create a FileHandle from the IFileNode
      const adapterPlatform = (fileSystemAdapter as unknown as { platform?: Platform }).platform;
      const handlePlatform = (fileNode.handle as unknown as { platform?: Platform }).platform;
      const platform: Platform = adapterPlatform ?? handlePlatform ?? 'web';

      const fileHandle: FileHandle = {
        path: fileNode.path,
        name: fileNode.name,
        kind: 'file',
        platform,
        _internal: fileNode.handle,
      };

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
            loadingPathsRef.current.delete(key);
            setLoadingFiles((prev) => {
              const newSet = new Set(prev);
              newSet.delete(key);
              return newSet;
            });
          })
          .then((results) => {
            const setContent = store.getState().setFileContent;
            for (const [k, value] of Object.entries(results)) {
              setContent(k, value);
            }
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
    const currentFileContents = store.getState().fileContents;
    for (const compositeKey of selectedFilePaths) {
      if (!currentFileContents[compositeKey] && !loadingPathsRef.current.has(compositeKey)) {
        prepareFileRead(compositeKey).then((req) => {
          if (req && workerRef.current) {
            workerRef
              .current([req], ({ key }) => {
                loadingPathsRef.current.delete(key);
                setLoadingFiles((prev) => {
                  const newSet = new Set(prev);
                  newSet.delete(key);
                  return newSet;
                });
              })
              .then((results) => {
                const setContent = store.getState().setFileContent;
                for (const [k, value] of Object.entries(results)) {
                  setContent(k, value);
                }
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

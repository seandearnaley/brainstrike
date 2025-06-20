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
      // Clean up the reference when adapter changes
      workerRef.current = null;
    };
  }, [fileSystemAdapter]);
  const { selectedFilePaths } = store(
    (s) => ({
      selectedFilePaths: s.selectedFilePaths,
    }),
    shallow
  );

  // Build a cache of path -> node keyed by folder ID whenever the file tree changes
  useEffect(() => {
    nodeCacheRef.current = buildFileNodeCache(fileTree);
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

      let fileNode = getFileNodeFromCache(nodeCacheRef.current, fileTree, folderId, path);

      // Debug logging removed to reduce console spam

      // If we can't find the node or don't have access to its handle, wait a bit and retry once
      if (!fileNode || fileNode.type !== 'file' || !fileNode.handle) {
        // Wait a short time for the file tree to potentially update
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Try to find the node again with a fresh lookup
        fileNode = refreshFileNodeCacheEntry(nodeCacheRef.current, fileTree, folderId, path);

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

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileHandle, Platform } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { FileContentError } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils';
import { decodeFileSelection, fileContent } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

interface ImportMetaWithViteEnv {
  readonly env: {
    readonly DEV: boolean;
  };
}

const MAX_CONCURRENT_LOADS = 5; // Limit concurrent file loads

export function useSharedFileContentLoading(fileTree: IFileNode[]) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  const loadingPathsRef = useRef(new Set<string>());
  const nodeCacheRef = useRef<Map<string, Map<string, IFileNode>>>(new Map());
  const { fileSystemAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();
  const { fileContents, setFileContent, selectedFilePaths } = store();

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

  const loadSingleFileContent = useCallback(
    async (compositeKey: string) => {
      // Skip if already loading or loaded
      if (loadingPathsRef.current.has(compositeKey) || compositeKey in fileContents) {
        return;
      }

      const { folderId, path } = decodeFileSelection(compositeKey);

      // Skip loading if we don't have a valid folder ID
      if (!folderId) {
        console.debug('Skipping file load - no folder ID');
        return;
      }

      // Skip loading if file tree is empty (no root directory selected yet)
      if (!fileTree.length) {
        return;
      }

      let fileNode =
        nodeCacheRef.current.get(folderId)?.get(path) ||
        fileExplorer.findNodeByPath(fileTree, path, folderId);

      if (fileNode) {
        let folderMap = nodeCacheRef.current.get(folderId);
        if (!folderMap) {
          folderMap = new Map<string, IFileNode>();
          nodeCacheRef.current.set(folderId, folderMap);
        }
        folderMap.set(path, fileNode);
      }

      if ((import.meta as unknown as ImportMetaWithViteEnv).env.DEV) {
        console.debug('Initial file node lookup:', {
          compositeKey,
          path,
          folderId,
          found: !!fileNode,
          type: fileNode?.type,
          hasHandle: fileNode?.handle !== undefined,
          rootFolderId: fileNode?.rootFolderId,
        });
      }

      // If we can't find the node or don't have access to its handle, wait a bit and retry once
      if (!fileNode || fileNode.type !== 'file' || !fileNode.handle) {
        // Wait a short time for the file tree to potentially update
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Try to find the node again
        fileNode =
          nodeCacheRef.current.get(folderId)?.get(path) ||
          fileExplorer.findNodeByPath(fileTree, path, folderId);

        if (fileNode) {
          let folderMap = nodeCacheRef.current.get(folderId);
          if (!folderMap) {
            folderMap = new Map<string, IFileNode>();
            nodeCacheRef.current.set(folderId, folderMap);
          }
          folderMap.set(path, fileNode);
        }

        if ((import.meta as unknown as ImportMetaWithViteEnv).env.DEV) {
          console.debug('Retry file node lookup:', {
            compositeKey,
            path,
            folderId,
            found: !!fileNode,
            type: fileNode?.type,
            hasHandle: fileNode?.handle !== undefined,
            rootFolderId: fileNode?.rootFolderId,
          });
        }

        if (!fileNode || fileNode.type !== 'file' || !fileNode.handle) {
          console.debug('File not accessible:', {
            path,
            folderId,
            type: fileNode?.type ?? 'not found',
            rootFolderId: fileNode?.rootFolderId ?? 'unknown',
          });
          return;
        }
      }

      // Verify the file node belongs to the correct root folder
      if (fileNode.rootFolderId !== folderId) {
        const error = `File not accessible - Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`;
        console.error(error);
        setFileContent(compositeKey, error);
        return;
      }

      loadingPathsRef.current.add(compositeKey);
      setLoadingFiles((prev) => new Set(prev).add(compositeKey));

      try {
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

        let content: string;

        try {
          content = await fileSystemAdapter.readFile(fileHandle);
        } catch (error) {
          console.error('Error reading file:', {
            error,
            path,
            folderId,
            fileNode,
          });
          throw new FileContentError('Error accessing file', path, 'LOADING_ERROR');
        }

        const extension = fileExplorer.getFileExtension(path);

        // Early return for known binary files
        if (fileContent.isBinaryExtension(extension)) {
          throw new FileContentError('Binary file - preview not available', path, 'BINARY');
        }

        // Early return for known text files
        if (fileContent.isTextExtension(extension)) {
          if (!fileContent.isTextContent(content)) {
            throw new FileContentError('Binary file - preview not available', path, 'BINARY');
          }
          setFileContent(compositeKey, content);
          return;
        }

        // Handle unknown extensions
        if (!fileContent.isTextContent(content)) {
          throw new FileContentError('Binary file - preview not available', path, 'BINARY');
        }
        setFileContent(compositeKey, content);
      } catch (err) {
        if (err instanceof FileContentError) {
          setFileContent(compositeKey, err.message);
        } else {
          console.error('Error loading file:', {
            error: err,
            compositeKey,
            path,
            folderId,
          });
          const error = new FileContentError('Error loading file content', path, 'LOADING_ERROR');
          setFileContent(compositeKey, error.message);
        }
      } finally {
        loadingPathsRef.current.delete(compositeKey);
        setLoadingFiles((prev) => {
          const newSet = new Set(prev);
          newSet.delete(compositeKey);
          return newSet;
        });
      }
    },
    [fileTree, fileContents, fileSystemAdapter, setFileContent]
  );

  const handleFileContentLoading = useCallback(
    async (compositeKeys: string[]) => {
      setIsLoading(true);
      setError(null);

      try {
        // Process files in chunks to avoid overwhelming the browser
        const chunks = [];
        for (let i = 0; i < compositeKeys.length; i += MAX_CONCURRENT_LOADS) {
          chunks.push(compositeKeys.slice(i, i + MAX_CONCURRENT_LOADS));
        }

        for (const chunk of chunks) {
          await Promise.all(chunk.map(loadSingleFileContent));
        }
      } catch (err) {
        console.error('Error loading files:', err);
        setError(err as Error);
      } finally {
        setIsLoading(false);
      }
    },
    [loadSingleFileContent]
  );

  // Automatically load content for selected files
  useEffect(() => {
    for (const compositeKey of selectedFilePaths) {
      if (!fileContents[compositeKey] && !loadingPathsRef.current.has(compositeKey)) {
        loadSingleFileContent(compositeKey);
      }
    }
  }, [selectedFilePaths, fileContents, loadSingleFileContent]);

  return {
    fileContents,
    isLoading,
    error,
    loadingFiles,
    handleFileContentLoading,
  };
}

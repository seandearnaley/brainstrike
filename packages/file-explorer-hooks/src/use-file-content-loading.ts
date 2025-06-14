import { useFileExplorerStore } from '@brainstrike/file-explorer';
import type { FileHandle } from '@brainstrike/file-system';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import { FileContentError } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils';
import { decodeFileSelection, fileContent } from '@brainstrike/utils';
import { useCallback, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';

const MAX_CONCURRENT_LOADS = 5; // Limit concurrent file loads

interface UseFileContentLoadingReturn {
  fileContents: { [compositeKey: string]: string };
  isLoading: boolean;
  error: Error | null;
  handleFileContentLoading: (compositeKeys: string[]) => Promise<void>;
  clearFileContents: (compositeKeys: string[]) => void;
}

export function useFileContentLoading(fileTree: IFileNode[]): UseFileContentLoadingReturn {
  const [fileContents, setFileContents] = useState<{
    [compositeKey: string]: string;
  }>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const loadingPathsRef = useRef(new Set<string>());
  const { fileSystemAdapter } = useAdapters();

  // Get database mode from store
  const { databaseMode, folderStates } = useFileExplorerStore();

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
        // console.debug('Skipping file load - no root directory selected');
        return;
      }

      // Check if folder is populated in database mode
      const isPopulated = folderStates[folderId]?.isPopulated || false;
      const isDatabaseAdapter = fileSystemAdapter && 'isDatabaseMode' in fileSystemAdapter;
      const isInDatabaseMode = databaseMode && isDatabaseAdapter && isPopulated;

      let fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);

      // Debug logging removed to reduce console spam

      // In database mode, we don't need a file handle
      if (!isInDatabaseMode && (!fileNode || fileNode.type !== 'file' || !fileNode.handle)) {
        // Wait a short time for the file tree to potentially update
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Try to find the node again
        fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);

        // Debug logging removed to reduce console spam

        if (!fileNode || fileNode.type !== 'file' || !fileNode.handle) {
          // Don't log as error since this is expected when loading persisted selections
          console.debug('File not accessible:', {
            path,
            folderId,
            type: fileNode?.type ?? 'not found',
            rootFolderId: fileNode?.rootFolderId ?? 'unknown',
          });
          return;
        }
      }

      // In database mode, we still need to find the node but don't require a handle
      if (isInDatabaseMode && (!fileNode || fileNode.type !== 'file')) {
        console.debug('File not found in tree:', { path, folderId });
        return;
      }

      // Final null check - ensure fileNode exists at this point
      if (!fileNode) {
        console.debug('File node is null after all checks:', { path, folderId });
        return;
      }

      // Verify the file node belongs to the correct root folder
      if (fileNode.rootFolderId !== folderId) {
        const error = `File not accessible - Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`;
        console.error(error);
        setFileContents((prev) => ({
          ...prev,
          [compositeKey]: error,
        }));
        return;
      }

      loadingPathsRef.current.add(compositeKey);

      try {
        // Create a FileHandle from the IFileNode
        const adapterPlatform = (fileSystemAdapter as unknown as { platform?: Platform }).platform;
        const handlePlatform =
          fileNode.handle && (fileNode.handle as unknown as { platform?: Platform }).platform;
        const platform: Platform = adapterPlatform || handlePlatform || 'web';

        const fileHandle: FileHandle = {
          path: fileNode.path,
          name: fileNode.name,
          kind: 'file',
          platform,
          _internal: fileNode.handle || null, // Handle can be null in database mode
          // Add folder ID for database lookups
          ...(isInDatabaseMode && { folderId, rootFolderId: folderId }),
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
          setFileContents((prev) => ({
            ...prev,
            [compositeKey]: content,
          }));
          return;
        }

        // Handle unknown extensions
        if (!fileContent.isTextContent(content)) {
          throw new FileContentError('Binary file - preview not available', path, 'BINARY');
        }
        setFileContents((prev) => ({
          ...prev,
          [compositeKey]: content,
        }));
      } catch (err) {
        if (err instanceof FileContentError) {
          setFileContents((prev) => ({
            ...prev,
            [compositeKey]: err.message,
          }));
        } else {
          console.error('Error loading file:', {
            error: err,
            compositeKey,
            path,
            folderId,
          });
          const error = new FileContentError('Error loading file content', path, 'LOADING_ERROR');
          setFileContents((prev) => ({
            ...prev,
            [compositeKey]: error.message,
          }));
        }
      } finally {
        loadingPathsRef.current.delete(compositeKey);
      }
    },
    [fileTree, fileContents, fileSystemAdapter, databaseMode, folderStates]
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

  const clearFileContents = useCallback((compositeKeys: string[]) => {
    setFileContents((prev) => {
      const newContents = { ...prev };
      for (const key of compositeKeys) {
        delete newContents[key];
      }
      return newContents;
    });
  }, []);

  return {
    fileContents,
    isLoading,
    error,
    handleFileContentLoading,
    clearFileContents,
  };
}

import type { IFileNode } from '@brainstrike/types';
import { FileContentError } from '@brainstrike/types';
import { useCallback, useRef, useState } from 'react';
import { fileContent } from '../lib/file/content';
import { fileExplorer } from '../lib/file/explorer';
import { decodeFileSelection } from '../utils/file-selection-utils';

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
        console.debug('Skipping file load - no root directory selected');
        return;
      }

      let fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);

      if (import.meta.env.DEV) {
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
        fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);

        if (import.meta.env.DEV) {
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
        const fileHandle = fileNode.handle as FileSystemFileHandle;
        let file: File;

        try {
          file = await fileHandle.getFile();
        } catch (error) {
          console.error('Error getting file handle:', {
            error,
            path,
            folderId,
            fileNode,
          });
          throw new FileContentError('Error accessing file', path, 'LOADING_ERROR');
        }

        const content = await file.text();
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
    [fileTree, fileContents]
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

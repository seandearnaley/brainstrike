import type { IFileNode } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';
import {
  createFileContentProcessor,
  type FileContentProcessor,
  type FileContentRequest,
} from './file-content-processor';
import { buildInaccessibleContent } from './inaccessible-content';

const MAX_CONCURRENT_LOADS = 3; // Reduced to prevent main thread saturation and WorkerStorage timeouts

interface UseFileContentLoadingReturn {
  clearFileContents: (compositeKeys: string[]) => void;
  error: Error | null;
  fileContents: { [compositeKey: string]: string };
  handleFileContentLoading: (compositeKeys: string[]) => Promise<void>;
  isLoading: boolean;
}

export interface UseFileContentLoadingOptions {
  processor?: FileContentProcessor;
}

export function useFileContentLoading(
  fileTree: IFileNode[],
  options: UseFileContentLoadingOptions = {}
): UseFileContentLoadingReturn {
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const loadingPathsRef = useRef(new Set<string>());
  const { fileSystemAdapter } = useAdapters();

  // Create processor with dependency injection
  const processor = useMemo(() => {
    if (options.processor) {
      return options.processor;
    }

    return createFileContentProcessor(fileSystemAdapter, {
      concurrency: MAX_CONCURRENT_LOADS,
    });
  }, [options.processor, fileSystemAdapter]);

  const prepareFileRequest = useCallback(
    async (compositeKey: string): Promise<FileContentRequest | null> => {
      if (loadingPathsRef.current.has(compositeKey) || compositeKey in fileContents) {
        return null;
      }

      const { folderId, path } = decodeFileSelection(compositeKey);
      if (!(folderId && fileTree.length)) {
        return null;
      }

      let fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);
      if (fileNode?.type !== 'file' || !fileNode.handle) {
        await new Promise((r) => setTimeout(r, 100));
        fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);
        if (fileNode?.type !== 'file' || !fileNode.handle) {
          return null;
        }
      }

      if (fileNode.rootFolderId !== folderId) {
        const msg = buildInaccessibleContent(
          `Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`
        );
        setFileContents((prev) => ({ ...prev, [compositeKey]: msg }));
        return null;
      }

      loadingPathsRef.current.add(compositeKey);

      return {
        compositeKey,
        fileNode,
        fileSystemAdapter,
      };
    },
    [fileTree, fileContents, fileSystemAdapter]
  );

  const handleFileContentLoading = useCallback(
    async (compositeKeys: string[]) => {
      setIsLoading(true);
      setError(null);

      try {
        const requests: FileContentRequest[] = [];
        for (const key of compositeKeys) {
          const req = await prepareFileRequest(key);
          if (req) {
            requests.push(req);
          }
        }

        if (requests.length === 0) {
          return;
        }

        const results = await processor.processFiles(requests, ({ key }) => {
          loadingPathsRef.current.delete(key);
        });

        setFileContents((prev) => ({ ...prev, ...results }));
      } catch (err) {
        setError(err as Error);
      } finally {
        setIsLoading(false);
      }
    },
    [prepareFileRequest, processor]
  );

  const clearFileContents = useCallback((compositeKeys: string[]) => {
    setFileContents((prev) => {
      const updated = { ...prev };
      for (const key of compositeKeys) {
        delete updated[key];
      }
      return updated;
    });
  }, []);

  return {
    clearFileContents,
    error,
    fileContents,
    handleFileContentLoading,
    isLoading,
  };
}

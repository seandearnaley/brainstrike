import { fileExplorer } from '@brainstrike/file-explorer/file-tree';
import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { IFileNode } from '@brainstrike/types';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useAdapters } from './adapters-context.js';
import {
  createFileContentProcessor,
  type FileContentProcessor,
  type FileContentRequest,
} from './file-content-processor.js';
import { buildInaccessibleContent } from './inaccessible-content.js';

const MAX_CONCURRENT_LOADS = 3; // Reduced to prevent main thread saturation

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

      const readDisplayContents = async (): Promise<Record<string, string> | null> => {
        const requests: FileContentRequest[] = [];
        for (const key of compositeKeys) {
          const req = await prepareFileRequest(key);
          if (req) {
            requests.push(req);
          }
        }
        if (requests.length === 0) {
          return null;
        }
        const results = await processor.processFiles(requests, ({ key }) => {
          loadingPathsRef.current.delete(key);
        });
        return Object.fromEntries(
          Object.entries(results).map(([key, result]) => [
            key,
            result.status === 'accessible' ? result.content : result.message,
          ])
        );
      };

      const displayContents = await readDisplayContents().catch((err: unknown) => {
        setError(err as Error);
        return null;
      });
      if (displayContents) {
        setFileContents((prev) => ({ ...prev, ...displayContents }));
      }
      setIsLoading(false);
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

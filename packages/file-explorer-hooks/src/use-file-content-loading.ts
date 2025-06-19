import type { FileHandle } from '@brainstrike/file-system';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils';
import { decodeFileSelection } from '@brainstrike/utils';
import {
  type FileContentWorker,
  type FileReadRequest,
  type ProgressEvent,
  createFileContentWorker,
} from '@brainstrike/workers/file-content-worker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';

const MAX_CONCURRENT_LOADS = 5;

interface UseFileContentLoadingReturn {
  fileContents: { [compositeKey: string]: string };
  isLoading: boolean;
  error: Error | null;
  handleFileContentLoading: (compositeKeys: string[]) => Promise<void>;
  clearFileContents: (compositeKeys: string[]) => void;
}

export function useFileContentLoading(fileTree: IFileNode[]): UseFileContentLoadingReturn {
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const loadingPathsRef = useRef(new Set<string>());
  const workerRef = useRef<FileContentWorker | null>(null);
  const { fileSystemAdapter } = useAdapters();

  useEffect(() => {
    workerRef.current = createFileContentWorker({
      fileSystemAdapter,
      concurrency: MAX_CONCURRENT_LOADS,
    });
    return () => {
      workerRef.current = null;
    };
  }, [fileSystemAdapter]);

  const prepareFileRead = useCallback(
    async (compositeKey: string): Promise<FileReadRequest | null> => {
      if (loadingPathsRef.current.has(compositeKey) || compositeKey in fileContents) {
        return null;
      }

      const { folderId, path } = decodeFileSelection(compositeKey);
      if (!folderId || !fileTree.length) {
        return null;
      }

      let fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);
      if (!fileNode || fileNode.type !== 'file' || !fileNode.handle) {
        await new Promise((r) => setTimeout(r, 100));
        fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);
        if (!fileNode || fileNode.type !== 'file' || !fileNode.handle) {
          return null;
        }
      }

      if (fileNode.rootFolderId !== folderId) {
        const msg = `File not accessible - Folder mismatch. Expected: ${folderId}, Found: ${fileNode.rootFolderId}`;
        setFileContents((prev) => ({ ...prev, [compositeKey]: msg }));
        return null;
      }

      loadingPathsRef.current.add(compositeKey);

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

      return { compositeKey, handle: fileHandle, path: fileNode.path };
    },
    [fileTree, fileContents, fileSystemAdapter]
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
          .current(requests, ({ key }: ProgressEvent) => {
            loadingPathsRef.current.delete(key);
          })
          .then((results: Record<string, string>) => {
            setFileContents((prev) => ({ ...prev, ...results }));
          });
      } catch (err) {
        setError(err as Error);
      } finally {
        setIsLoading(false);
      }
    },
    [prepareFileRead]
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

import type { FileImportResult, ImportProgress } from '@brainstrike/db';
import { useFileRecordRepository } from '@brainstrike/db/react';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { fileNodeToFileHandle } from '@brainstrike/file-system/file-node-handles';
import type { IFileNode } from '@brainstrike/types';
import { useCallback, useMemo, useState } from 'react';
import {
  appendProcessError,
  createProcessErrorProgress,
  getImportPathFileName,
  runFileImport,
} from './file-import/file-import-coordinator';
import { FileImportError, isFileImportError } from './file-import/file-import-errors';
import type {
  FileImportContext,
  FileImportDependencies,
  FileSystemPort,
} from './file-import/file-import-types';
import {
  createNativeImportRepository,
  getSourceFilesCapability,
} from './file-import/native-source-import';

interface UseFileImportServiceOptions {
  onComplete?: (results: FileImportResult[]) => void;
  onError?: (error: Error) => void;
  onProgress?: (progress: ImportProgress) => void;
}

interface FileImportServiceReturn {
  importFiles: (
    selectedFilePaths: Set<string>,
    fileTree: IFileNode[],
    fileContents: Record<string, string>,
    embeddingSetId?: string
  ) => Promise<void>;
  isImporting: boolean;
  progress: ImportProgress | null;
}

interface FileHandleLookup {
  getFileHandle: (folderId: string, relativePath: string) => Promise<FileSystemFileHandle | null>;
}

interface AdapterWithHandleCache extends FileSystemAdapter {
  getHandleCache: () => FileHandleLookup;
}

interface AdapterWithReadFileByPath extends FileSystemAdapter {
  readFileByPath: (absolutePath: string) => Promise<string>;
}

function hasHandleCache(adapter: FileSystemAdapter): adapter is AdapterWithHandleCache {
  return typeof (adapter as Partial<AdapterWithHandleCache>).getHandleCache === 'function';
}

function hasReadFileByPath(adapter: FileSystemAdapter): adapter is AdapterWithReadFileByPath {
  return typeof (adapter as Partial<AdapterWithReadFileByPath>).readFileByPath === 'function';
}

function createFileSystemPort(adapter: FileSystemAdapter | null): FileSystemPort | null {
  if (!adapter) {
    return null;
  }

  return {
    async readFile(node) {
      return adapter.readFile(fileNodeToFileHandle(node));
    },
    async readFileBySelection(folderId, path) {
      const name = getImportPathFileName(path);

      if (hasReadFileByPath(adapter)) {
        const content = await adapter.readFileByPath(path);
        return {
          content,
          name,
          path,
          size: content.length,
        };
      }

      if (!hasHandleCache(adapter)) {
        return null;
      }

      const fileHandle = await adapter.getHandleCache().getFileHandle(folderId, path);
      if (!fileHandle) {
        return null;
      }

      const file = await fileHandle.getFile();
      const content = await adapter.readFile({
        _internal: fileHandle,
        kind: 'file',
        name,
        path,
        platform: 'web',
        rootFolderId: folderId,
      });

      return {
        content,
        name,
        path,
        size: file.size,
      };
    },
  };
}

function createDependencies(
  repository: ReturnType<typeof useFileRecordRepository>,
  adapter: FileSystemAdapter | null
): FileImportDependencies {
  const boundBulkImport = repository?.bulkImport
    ? repository.bulkImport.bind(repository)
    : undefined;

  const repositoryPort: FileImportDependencies['repository'] = repository
    ? boundBulkImport
      ? { bulkImport: boundBulkImport }
      : {}
    : null;

  return {
    fileSystem: createFileSystemPort(adapter),
    repository: repositoryPort,
  };
}

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new FileImportError('unknown', 'Unknown error during file import');
}

function withProcessError(
  progress: ImportProgress | null,
  message: string,
  total: number
): ImportProgress {
  if (progress) {
    return appendProcessError(progress, message);
  }

  return createProcessErrorProgress(total, message);
}

export function useFileImportService(
  options: UseFileImportServiceOptions = {}
): FileImportServiceReturn {
  const { onProgress, onComplete, onError } = options;

  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  const sourceFiles = getSourceFilesCapability();
  const repository = useFileRecordRepository({ enabled: !sourceFiles });
  const { fileSystemAdapter } = useAdapters();

  const dependencies = useMemo(
    () =>
      sourceFiles
        ? {
            fileSystem: createFileSystemPort(fileSystemAdapter ?? null),
            repository: createNativeImportRepository(sourceFiles),
          }
        : createDependencies(repository, fileSystemAdapter ?? null),
    [repository, fileSystemAdapter, sourceFiles]
  );

  const importFiles = useCallback(
    async (
      selectedFilePaths: Set<string>,
      fileTree: IFileNode[],
      fileContents: Record<string, string>,
      embeddingSetId?: string
    ) => {
      setIsImporting(true);

      const handleProgress = (update: ImportProgress) => {
        setProgress(update);
        onProgress?.(update);
      };

      try {
        const context: FileImportContext = embeddingSetId
          ? { embeddingSetId, fileContents, fileTree, selectedFilePaths }
          : { fileContents, fileTree, selectedFilePaths };

        const outcome = await runFileImport(dependencies, context, { onProgress: handleProgress });

        setProgress(outcome.progress);
        onProgress?.(outcome.progress);
        onComplete?.(outcome.results);
      } catch (error) {
        const normalized = ensureError(error);
        const processProgress = withProcessError(
          isFileImportError(error) ? error.progress : null,
          normalized.message,
          selectedFilePaths.size
        );

        setProgress(processProgress);
        onProgress?.(processProgress);
        onError?.(normalized);
      } finally {
        setIsImporting(false);
      }
    },
    [dependencies, onProgress, onComplete, onError]
  );

  return useMemo(
    () => ({
      importFiles,
      isImporting,
      progress,
    }),
    [importFiles, isImporting, progress]
  );
}

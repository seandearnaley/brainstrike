import { useFileRecordRepository } from '@brainstrike/db';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import type { ImportProgress } from '@brainstrike/ui';
import { decodeFileSelection, fileContent, fileExplorer } from '@brainstrike/utils';
import { useCallback, useMemo, useState } from 'react';

// Local type definitions to avoid import issues during development
interface FileImportRequest {
  path: string;
  name: string;
  content: string;
  size: number;
}

interface FileImportResult {
  id: string;
  imported: boolean;
  existed: boolean;
  error?: string;
}

interface UseFileImportServiceOptions {
  onProgress?: (progress: ImportProgress) => void;
  onComplete?: (results: FileImportResult[]) => void;
  onError?: (error: Error) => void;
}

interface FileImportServiceReturn {
  importFiles: (
    selectedFilePaths: Set<string>,
    fileTree: IFileNode[],
    fileContents: Record<string, string>
  ) => Promise<void>;
  isImporting: boolean;
  progress: ImportProgress | null;
}

// File handle creation helper
function createFileHandle(fileNode: IFileNode, _fileSystemAdapter: FileSystemAdapter): FileHandle {
  const handlePlatform = (fileNode.handle as { platform?: Platform }).platform;
  const platform: Platform = handlePlatform ?? 'web';

  return {
    path: fileNode.path,
    name: fileNode.name,
    kind: 'file',
    platform,
    _internal: fileNode.handle,
  };
}

// Helper to find file node in tree
function findFileNode(fileTree: IFileNode[], folderId: string, path: string): IFileNode | null {
  return fileExplorer.findNodeByPath(fileTree, path, folderId);
}

// Helper to check if content is accessible
function isContentAccessible(content: string): boolean {
  return (
    !content.startsWith('Error accessing file') &&
    !content.includes('Binary file') &&
    !content.includes('not accessible')
  );
}

// Helper to prepare file import requests from cached content
function prepareRequestsFromCache(
  selectedFilePaths: Set<string>,
  fileTree: IFileNode[],
  fileContents: Record<string, string>,
  errors: Array<{ file: string; error: string }>
): {
  requests: FileImportRequest[];
  filesToLoad: Array<{ compositeKey: string; fileNode: IFileNode }>;
} {
  const requests: FileImportRequest[] = [];
  const filesToLoad: Array<{ compositeKey: string; fileNode: IFileNode }> = [];

  for (const compositeKey of selectedFilePaths) {
    const { folderId, path } = decodeFileSelection(compositeKey);

    if (!folderId) {
      errors.push({
        file: path,
        error: 'Invalid file selection format',
      });
      continue;
    }

    // Check if we already have content - prioritize cached content over file tree
    const existingContent = fileContents[compositeKey];

    if (existingContent && isContentAccessible(existingContent)) {
      // Extract file name from path for cached content
      const fileName = path.split('/').pop() || 'unknown';

      requests.push({
        path: path,
        name: fileName,
        content: existingContent,
        size: existingContent.length,
      });
      continue;
    }

    // Only try to find in file tree if we don't have cached content
    const fileNode = findFileNode(fileTree, folderId, path);

    if (!fileNode || fileNode.type !== 'file') {
      errors.push({
        file: path,
        error: 'File not found in tree and no cached content available',
      });
      continue;
    }

    // Need to load content from file system
    filesToLoad.push({ compositeKey, fileNode });
  }

  return { requests, filesToLoad };
}

// Helper to load file content from disk
async function loadFileContent(
  fileNode: IFileNode,
  fileSystemAdapter: FileSystemAdapter
): Promise<string> {
  const fileHandle = createFileHandle(fileNode, fileSystemAdapter);

  try {
    const content = await fileSystemAdapter.readFile(fileHandle);
    const extension = fileExplorer.getFileExtension(fileNode.path);

    // Check if it's a text file
    if (fileContent.isBinaryExtension(extension)) {
      throw new Error('Binary file - only text files are supported');
    }

    if (!fileContent.isTextExtension(extension) && !fileContent.isTextContent(content)) {
      throw new Error('Binary file - only text files are supported');
    }

    return content;
  } catch (error) {
    throw new Error(
      `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

// Helper to process bulk import with progress tracking
async function processBulkImport(
  repository: ReturnType<typeof useFileRecordRepository>,
  requests: FileImportRequest[],
  selectedFilesCount: number,
  initialErrorsCount: number,
  onProgress?: (completed: number, total: number, current?: string) => void
): Promise<{ results: FileImportResult[]; requestMap: Map<number, FileImportRequest> }> {
  if (!repository) {
    throw new Error('Repository not available');
  }

  // Create a map to track requests by their index for error mapping
  const requestMap = new Map<number, FileImportRequest>();
  requests.forEach((request, index) => {
    requestMap.set(index, request);
  });

  const results = await repository.bulkImport?.(
    requests,
    (completed: number, _total: number, current?: string) => {
      const currentProgress = {
        total: selectedFilesCount,
        completed: initialErrorsCount + completed,
        current,
        errors: [], // errors are tracked separately
      };
      onProgress?.(currentProgress.completed, currentProgress.total, current);
    }
  );

  if (!results) {
    throw new Error('Bulk import not supported by repository');
  }

  return { results, requestMap };
}

// Helper to process final results and errors
function processFinalResults(
  results: FileImportResult[],
  requestMap: Map<number, FileImportRequest>,
  initialErrors: Array<{ file: string; error: string }>,
  selectedFilesCount: number,
  setProgress: (progress: ImportProgress) => void,
  options: UseFileImportServiceOptions
): void {
  const allErrors = [
    ...initialErrors,
    ...results
      .map((result, index) => {
        if (!result.error) return null;

        // Map back to original request using the index
        const originalRequest = requestMap.get(index);
        const fileName =
          originalRequest?.name || originalRequest?.path.split('/').pop() || 'Unknown';

        return {
          file: fileName,
          error: result.error || 'Import failed',
        };
      })
      .filter((error): error is { file: string; error: string } => error !== null),
  ];

  const finalProgress: ImportProgress = {
    total: selectedFilesCount,
    completed: selectedFilesCount,
    errors: allErrors,
  };

  setProgress(finalProgress);
  options.onProgress?.(finalProgress);
  options.onComplete?.(results);
}

// Helper to validate import prerequisites
function validateImportPrerequisites(
  repository: ReturnType<typeof useFileRecordRepository>,
  fileSystemAdapter: FileSystemAdapter | null,
  selectedFilePaths: Set<string>,
  options: UseFileImportServiceOptions
): boolean {
  if (!repository || !fileSystemAdapter) {
    options.onError?.(new Error('Database or file system not available'));
    return false;
  }

  if (selectedFilePaths.size === 0) {
    options.onError?.(new Error('No files selected for import'));
    return false;
  }

  return true;
}

// Helper to load files that don't have cached content
async function loadMissingFileContents(
  filesToLoad: Array<{ fileNode: IFileNode }>,
  fileSystemAdapter: FileSystemAdapter,
  requests: FileImportRequest[],
  errors: Array<{ file: string; error: string }>,
  setProgress: (updater: (prev: ImportProgress | null) => ImportProgress | null) => void
): Promise<void> {
  for (const { fileNode } of filesToLoad) {
    setProgress((prev) =>
      prev
        ? {
            ...prev,
            current: fileNode.name,
          }
        : null
    );

    try {
      const content = await loadFileContent(fileNode, fileSystemAdapter);

      requests.push({
        path: fileNode.path,
        name: fileNode.name,
        content,
        size: fileNode.size || content.length,
      });
    } catch (error) {
      errors.push({
        file: fileNode.path,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

// Helper to handle import errors
function handleImportError(
  error: unknown,
  selectedFilePathsSize: number,
  initialErrors: Array<{ file: string; error: string }>,
  setProgress: (progress: ImportProgress | null) => void,
  options: UseFileImportServiceOptions
): void {
  const finalProgress: ImportProgress = {
    total: selectedFilePathsSize,
    completed: 0,
    errors: [
      ...initialErrors,
      {
        file: 'Import Process',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    ],
  };
  setProgress(finalProgress);
  options.onError?.(error instanceof Error ? error : new Error('Import failed'));
}

export function useFileImportService(
  options: UseFileImportServiceOptions = {}
): FileImportServiceReturn {
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  const repository = useFileRecordRepository();
  const { fileSystemAdapter } = useAdapters();

  const importFiles = useCallback(
    async (
      selectedFilePaths: Set<string>,
      fileTree: IFileNode[],
      fileContents: Record<string, string>
    ) => {
      // Validate prerequisites
      if (!validateImportPrerequisites(repository, fileSystemAdapter, selectedFilePaths, options)) {
        return;
      }

      setIsImporting(true);

      const initialProgress: ImportProgress = {
        total: selectedFilePaths.size,
        completed: 0,
        errors: [],
      };
      setProgress(initialProgress);

      try {
        // First pass: prepare requests for files with cached content
        const { requests, filesToLoad } = prepareRequestsFromCache(
          selectedFilePaths,
          fileTree,
          fileContents,
          initialProgress.errors
        );

        // Second pass: load content for files that don't have it
        await loadMissingFileContents(
          filesToLoad,
          fileSystemAdapter as FileSystemAdapter,
          requests,
          initialProgress.errors,
          setProgress
        );

        // Update progress with any errors from loading
        setProgress((prev: ImportProgress | null) =>
          prev
            ? {
                ...prev,
                errors: initialProgress.errors,
              }
            : null
        );

        if (requests.length === 0) {
          throw new Error('No valid files to import');
        }

        // Import files using repository bulk import
        const { results, requestMap } = await processBulkImport(
          repository,
          requests,
          selectedFilePaths.size,
          initialProgress.errors.length,
          (completed, total, current) => {
            const currentProgress: ImportProgress = {
              total,
              completed,
              ...(current && { current }),
              errors: initialProgress.errors,
            };
            setProgress(currentProgress);
            options.onProgress?.(currentProgress);
          }
        );

        // Process final results
        processFinalResults(
          results,
          requestMap,
          initialProgress.errors,
          selectedFilePaths.size,
          setProgress,
          options
        );
      } catch (error) {
        handleImportError(
          error,
          selectedFilePaths.size,
          initialProgress.errors,
          setProgress,
          options
        );
      } finally {
        setIsImporting(false);
      }
    },
    [repository, fileSystemAdapter, options]
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

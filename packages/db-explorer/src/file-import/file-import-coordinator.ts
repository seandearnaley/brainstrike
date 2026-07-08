import type { FileImportRequest, FileImportResult } from '@brainstrike/db';
import type { IFileNode } from '@brainstrike/types';
import { fileContent } from '@brainstrike/utils/file-content';
import { fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import { FileImportError, isFileImportError } from './file-import-errors';
import type {
  FileImportCallbacks,
  FileImportContext,
  FileImportDependencies,
  FileImportOutcome,
} from './file-import-types';
import { ImportProgressTracker } from './progress-tracker';

interface PendingFile {
  fileNode: IFileNode | null;
  folderId: string;
  name: string;
  path: string;
}

interface ErrorEntry {
  error: string;
  file: string;
}

const IMPORT_PROCESS_LABEL = 'Import Process';
const BINARY_FILE_ERROR_MESSAGE = 'Binary file - only text files are supported';
const IMPORT_REQUEST_BATCH_SIZE = 50;

export function getImportPathFileName(path: string): string {
  // Bulk imports call this per selected file; avoid split/pop segment arrays.
  const lastSlashIdx = path.lastIndexOf('/');
  return lastSlashIdx === -1 ? path : path.slice(lastSlashIdx + 1);
}

function isContentAccessible(content: string): boolean {
  return !(
    content.startsWith('Error accessing file') ||
    content.includes('Binary file') ||
    content.includes('not accessible')
  );
}

function prepareRequestsFromCache(
  context: FileImportContext,
  tracker: ImportProgressTracker
): { requests: FileImportRequest[]; pending: PendingFile[] } {
  const { selectedFilePaths, fileTree, fileContents, embeddingSetId } = context;
  const requests: FileImportRequest[] = [];
  const pending: PendingFile[] = [];

  for (const compositeKey of selectedFilePaths) {
    const { folderId, path } = decodeFileSelection(compositeKey);

    if (!folderId) {
      tracker.addError({
        error: 'Invalid file selection format',
        file: path,
      });
      continue;
    }

    const cachedContent = fileContents[compositeKey];

    if (cachedContent && isContentAccessible(cachedContent)) {
      const fileName = getImportPathFileName(path);
      const request: FileImportRequest = {
        content: cachedContent,
        name: fileName,
        path,
        size: cachedContent.length,
      };

      if (embeddingSetId) {
        request.embeddingSetId = embeddingSetId;
      }

      requests.push(request);
      continue;
    }

    const fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);

    pending.push({
      fileNode: fileNode?.type === 'file' ? fileNode : null,
      folderId,
      name: getImportPathFileName(path),
      path,
    });
  }

  return { pending, requests };
}

function createImportRequest(
  fileNode: Pick<IFileNode, 'name' | 'path' | 'size'>,
  content: string,
  embeddingSetId?: string
): FileImportRequest {
  const request: FileImportRequest = {
    content,
    name: fileNode.name,
    path: fileNode.path,
    size: fileNode.size ?? content.length,
  };

  if (embeddingSetId) {
    request.embeddingSetId = embeddingSetId;
  }

  return request;
}

function validateTextContent(path: string, content: string): void {
  const extension = fileExplorer.getFileExtension(path);

  if (fileContent.isBinaryExtension(extension)) {
    throw new FileImportError('unsupported-content', BINARY_FILE_ERROR_MESSAGE);
  }

  if (!(fileContent.isTextExtension(extension) || fileContent.isTextContent(content))) {
    throw new FileImportError('unsupported-content', BINARY_FILE_ERROR_MESSAGE);
  }
}

async function readTextFile(
  fileNode: IFileNode,
  fileSystem: NonNullable<FileImportDependencies['fileSystem']>
): Promise<string> {
  const content = await fileSystem.readFile(fileNode);
  validateTextContent(fileNode.path, content);
  return content;
}

function resolveReadError(error: unknown): string {
  if (isFileImportError(error)) {
    return error.message;
  }

  if (error instanceof Error) {
    return `Failed to read file: ${error.message}`;
  }

  return 'Failed to read file: Unknown error';
}

async function loadMissingFileContents(
  pending: PendingFile[],
  dependencies: FileImportDependencies,
  tracker: ImportProgressTracker,
  embeddingSetId?: string
): Promise<FileImportRequest[]> {
  const requests: FileImportRequest[] = [];

  // If no files need loading, return early (file system not required)
  if (pending.length === 0) {
    return requests;
  }

  const { fileSystem } = dependencies;

  if (!fileSystem) {
    throw new FileImportError('missing-dependency', 'File system is not available', {
      progress: tracker.snapshot(),
    });
  }

  // Reads are independent; run them concurrently so the import waits on the
  // slowest file rather than the sum. Errors are reported via `addError`
  // (singular) the moment they happen so `tracker.errorCount` and any
  // progress UI reading the live error count stay current during the parallel
  // window — batching errors until after `Promise.all` would freeze the
  // displayed count at its pre-loop value.
  const results = await Promise.all(
    pending.map(async (pendingFile) => {
      try {
        if (pendingFile.fileNode) {
          const content = await readTextFile(pendingFile.fileNode, fileSystem);
          return createImportRequest(pendingFile.fileNode, content, embeddingSetId);
        }

        const resolved = await fileSystem.readFileBySelection?.(
          pendingFile.folderId,
          pendingFile.path
        );
        if (!resolved) {
          tracker.addError({
            error: 'File not found in tree and no cached content available',
            file: pendingFile.path,
          });
          return null;
        }

        validateTextContent(resolved.path, resolved.content);
        return createImportRequest(
          {
            name: resolved.name,
            path: resolved.path,
            size: resolved.size,
          },
          resolved.content,
          embeddingSetId
        );
      } catch (error) {
        tracker.addError({
          error: resolveReadError(error),
          file: pendingFile.path,
        });
        return null;
      } finally {
        tracker.update(tracker.errorCount, pendingFile.name);
      }
    })
  );

  for (const request of results) {
    if (request !== null) {
      requests.push(request);
    }
  }
  tracker.clearCurrent();

  return requests;
}

async function importRequestBatch(
  repository: NonNullable<FileImportDependencies['repository']>,
  requests: FileImportRequest[],
  tracker: ImportProgressTracker,
  processedRequestCount: number,
  processedResultErrorCount: number
): Promise<{ resultErrorCount: number; results: FileImportResult[] }> {
  if (!repository.bulkImport) {
    throw new FileImportError('unsupported-operation', 'Bulk import not supported by repository', {
      progress: tracker.snapshot(),
    });
  }

  const requestMap = createRequestMap(requests);
  const nonRequestErrorCount = tracker.errorCount - processedResultErrorCount;
  if (nonRequestErrorCount < 0) {
    throw new FileImportError(
      'unknown',
      'Import progress tracker entered an invalid error-count state.',
      {
        progress: tracker.snapshot(),
      }
    );
  }

  let results: FileImportResult[] | null;
  try {
    results = await repository.bulkImport(requests, (completed, _total, current) => {
      tracker.update(nonRequestErrorCount + processedRequestCount + completed, current);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error during bulk import';
    throw new FileImportError('repository-error', message, {
      cause: error,
      progress: tracker.snapshot(),
    });
  }

  if (!results) {
    throw new FileImportError('unsupported-operation', 'Bulk import not supported by repository', {
      progress: tracker.snapshot(),
    });
  }

  const resultErrors = mapResultErrors(results, requestMap);
  tracker.addErrors(resultErrors);
  return {
    resultErrorCount: resultErrors.length,
    results,
  };
}

function splitIntoBatches<T>(items: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}

function createRequestMap(requests: FileImportRequest[]): Map<number, FileImportRequest> {
  return requests.reduce((map, request, index) => {
    map.set(index, request);
    return map;
  }, new Map<number, FileImportRequest>());
}

function mapResultErrors(
  results: FileImportResult[],
  requestMap: Map<number, FileImportRequest>
): ErrorEntry[] {
  return results
    .map((result, index) => {
      if (!result.error) {
        return null;
      }

      const original = requestMap.get(index);
      const fileName =
        original?.name ?? (original ? getImportPathFileName(original.path) : 'Unknown');

      return {
        error: result.error ?? 'Import failed',
        file: fileName,
      } satisfies ErrorEntry;
    })
    .filter((entry): entry is ErrorEntry => entry !== null);
}

export async function runFileImport(
  dependencies: FileImportDependencies,
  context: FileImportContext,
  callbacks: FileImportCallbacks = {}
): Promise<FileImportOutcome> {
  const { repository } = dependencies;

  if (!repository) {
    throw new FileImportError('missing-dependency', 'Database repository not available');
  }

  if (context.selectedFilePaths.size === 0) {
    throw new FileImportError('empty-selection', 'No files selected for import');
  }

  const tracker = new ImportProgressTracker(context.selectedFilePaths.size, callbacks.onProgress);
  tracker.emitInitial();

  const { requests: cachedRequests, pending } = prepareRequestsFromCache(context, tracker);
  const results: FileImportResult[] = [];
  let processedRequestCount = 0;
  let processedResultErrorCount = 0;

  for (const batch of splitIntoBatches(cachedRequests, IMPORT_REQUEST_BATCH_SIZE)) {
    const batchOutcome = await importRequestBatch(
      repository,
      batch,
      tracker,
      processedRequestCount,
      processedResultErrorCount
    );
    results.push(...batchOutcome.results);
    processedRequestCount += batch.length;
    processedResultErrorCount += batchOutcome.resultErrorCount;
  }

  for (const pendingBatch of splitIntoBatches(pending, IMPORT_REQUEST_BATCH_SIZE)) {
    const loadedRequests = await loadMissingFileContents(
      pendingBatch,
      dependencies,
      tracker,
      context.embeddingSetId
    );
    if (loadedRequests.length === 0) {
      continue;
    }
    const batchOutcome = await importRequestBatch(
      repository,
      loadedRequests,
      tracker,
      processedRequestCount,
      processedResultErrorCount
    );
    results.push(...batchOutcome.results);
    processedRequestCount += loadedRequests.length;
    processedResultErrorCount += batchOutcome.resultErrorCount;
  }

  if (results.length === 0) {
    throw new FileImportError('no-valid-files', 'No valid files to import', {
      progress: tracker.snapshot(),
    });
  }

  const finalProgress = tracker.complete();

  return {
    progress: finalProgress,
    results,
  };
}

export function appendProcessError(
  progress: ReturnType<ImportProgressTracker['snapshot']>,
  message: string
): ReturnType<ImportProgressTracker['snapshot']> {
  return {
    ...progress,
    errors: [...progress.errors, { error: message, file: IMPORT_PROCESS_LABEL }],
  };
}

export function createProcessErrorProgress(total: number, message: string) {
  return {
    completed: 0,
    errors: [{ error: message, file: IMPORT_PROCESS_LABEL }],
    total,
  };
}

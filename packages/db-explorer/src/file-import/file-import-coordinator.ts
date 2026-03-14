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
  fileNode: IFileNode;
}

interface ErrorEntry {
  error: string;
  file: string;
}

const IMPORT_PROCESS_LABEL = 'Import Process';
const BINARY_FILE_ERROR_MESSAGE = 'Binary file - only text files are supported';

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
        file: path,
        error: 'Invalid file selection format',
      });
      continue;
    }

    const cachedContent = fileContents[compositeKey];

    if (cachedContent && isContentAccessible(cachedContent)) {
      const fileName = path.split('/').pop() ?? 'unknown';
      const request: FileImportRequest = {
        path,
        name: fileName,
        content: cachedContent,
        size: cachedContent.length,
      };

      if (embeddingSetId) {
        request.embeddingSetId = embeddingSetId;
      }

      requests.push(request);
      continue;
    }

    const fileNode = fileExplorer.findNodeByPath(fileTree, path, folderId);

    if (!fileNode || fileNode.type !== 'file') {
      tracker.addError({
        file: path,
        error: 'File not found in tree and no cached content available',
      });
      continue;
    }

    pending.push({ fileNode });
  }

  return { requests, pending };
}

function createImportRequest(
  fileNode: IFileNode,
  content: string,
  embeddingSetId?: string
): FileImportRequest {
  const request: FileImportRequest = {
    path: fileNode.path,
    name: fileNode.name,
    content,
    size: fileNode.size ?? content.length,
  };

  if (embeddingSetId) {
    request.embeddingSetId = embeddingSetId;
  }

  return request;
}

async function readTextFile(
  fileNode: IFileNode,
  fileSystem: NonNullable<FileImportDependencies['fileSystem']>
): Promise<string> {
  const content = await fileSystem.readFile(fileNode);
  const extension = fileExplorer.getFileExtension(fileNode.path);

  if (fileContent.isBinaryExtension(extension)) {
    throw new FileImportError('unsupported-content', BINARY_FILE_ERROR_MESSAGE);
  }

  if (!(fileContent.isTextExtension(extension) || fileContent.isTextContent(content))) {
    throw new FileImportError('unsupported-content', BINARY_FILE_ERROR_MESSAGE);
  }

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

  for (const { fileNode } of pending) {
    tracker.update(tracker.errorCount, fileNode.name);

    try {
      const content = await readTextFile(fileNode, fileSystem);
      requests.push(createImportRequest(fileNode, content, embeddingSetId));
    } catch (error) {
      tracker.addError({
        file: fileNode.path,
        error: resolveReadError(error),
      });
    }
  }

  tracker.clearCurrent();

  return requests;
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
      const fileName = original?.name ?? original?.path.split('/').pop() ?? 'Unknown';

      return {
        file: fileName,
        error: result.error ?? 'Import failed',
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

  const loadedRequests = await loadMissingFileContents(
    pending,
    dependencies,
    tracker,
    context.embeddingSetId
  );
  const requests = [...cachedRequests, ...loadedRequests];

  if (requests.length === 0) {
    throw new FileImportError('no-valid-files', 'No valid files to import', {
      progress: tracker.snapshot(),
    });
  }

  if (!repository.bulkImport) {
    throw new FileImportError('unsupported-operation', 'Bulk import not supported by repository', {
      progress: tracker.snapshot(),
    });
  }

  const requestMap = createRequestMap(requests);
  const initialErrorCount = tracker.errorCount;

  let results: FileImportResult[] | null;
  try {
    results = await repository.bulkImport(requests, (completed, _total, current) => {
      tracker.update(initialErrorCount + completed, current);
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

  const finalProgress = tracker.complete();

  return {
    results,
    progress: finalProgress,
  };
}

export function appendProcessError(
  progress: ReturnType<ImportProgressTracker['snapshot']>,
  message: string
): ReturnType<ImportProgressTracker['snapshot']> {
  return {
    ...progress,
    errors: [...progress.errors, { file: IMPORT_PROCESS_LABEL, error: message }],
  };
}

export function createProcessErrorProgress(total: number, message: string) {
  return {
    total,
    completed: 0,
    errors: [{ file: IMPORT_PROCESS_LABEL, error: message }],
  };
}

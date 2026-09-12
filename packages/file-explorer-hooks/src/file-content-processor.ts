import { fileExplorer } from '@brainstrike/file-explorer/file-tree';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { DEFAULT_MAX_FILE_SIZE, formatFileSize, getFileSizeConfig } from '@brainstrike/file-system';
import { fileNodeToFileHandle } from '@brainstrike/file-system/file-node-handles';
import type { IFileNode } from '@brainstrike/types';
import { BINARY_CONTENT_MESSAGE, FileContentError } from '@brainstrike/types';
import { fileContent, getKnownFileSize } from '@brainstrike/utils/file-content';
import {
  createFileContentWorker,
  type FileContentReadResult,
  type FileContentWorker,
  type FileReadRequest,
} from '@brainstrike/workers/file-content-worker';

export type FileContentResult = FileContentReadResult;

export interface FileContentProcessor {
  processFiles: (
    requests: FileContentRequest[],
    onProgress?: (event: { key: string; loaded: number; total: number }) => void,
    options?: {
      abortSignal?: AbortSignal;
    }
  ) => Promise<Record<string, FileContentResult>>;
}

export interface FileContentRequest {
  compositeKey: string;
  fileNode: IFileNode;
  fileSystemAdapter: FileSystemAdapter;
}

function getConfiguredMaxFileSize(): number {
  const configuredMaxFileSize = getFileSizeConfig().maxFileSize;
  if (
    typeof configuredMaxFileSize !== 'number' ||
    !Number.isFinite(configuredMaxFileSize) ||
    configuredMaxFileSize <= 0
  ) {
    return DEFAULT_MAX_FILE_SIZE;
  }
  return configuredMaxFileSize;
}

function createAbortError(): Error {
  const error = new Error('The file content read was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
}

/**
 * Worker-based file content processor for production use
 */
export class WorkerFileContentProcessor implements FileContentProcessor {
  private readonly worker: FileContentWorker;

  constructor(fileSystemAdapter: FileSystemAdapter, concurrency = 3) {
    this.worker = createFileContentWorker({
      concurrency,
      fileSystemAdapter,
    });
  }

  async processFiles(
    requests: FileContentRequest[],
    onProgress?: (event: { key: string; loaded: number; total: number }) => void,
    options?: {
      abortSignal?: AbortSignal;
    }
  ): Promise<Record<string, FileContentResult>> {
    throwIfAborted(options?.abortSignal);
    const fileReadRequests: FileReadRequest[] = requests.map((req) => ({
      compositeKey: req.compositeKey,
      handle: fileNodeToFileHandle(req.fileNode),
      path: req.fileNode.path,
    }));

    return this.worker(fileReadRequests, onProgress, options);
  }
}

/**
 * Direct file content processor for testing and fallback scenarios
 */
export class DirectFileContentProcessor implements FileContentProcessor {
  async processFiles(
    requests: FileContentRequest[],
    onProgress?: (event: { key: string; loaded: number; total: number }) => void,
    options?: {
      abortSignal?: AbortSignal;
    }
  ): Promise<Record<string, FileContentResult>> {
    const results: Record<string, FileContentResult> = {};
    let completed = 0;
    const total = requests.length;

    for (const request of requests) {
      throwIfAborted(options?.abortSignal);
      try {
        const content = await this.processFile(request);
        results[request.compositeKey] = { content, status: 'accessible' };
      } catch (err: unknown) {
        const msg = err instanceof FileContentError ? err.message : 'Error accessing file';
        results[request.compositeKey] = { message: msg, status: 'inaccessible' };
      }

      completed++;
      onProgress?.({ key: request.compositeKey, loaded: completed, total });
    }

    throwIfAborted(options?.abortSignal);

    return results;
  }

  private async processFile(request: FileContentRequest): Promise<string> {
    const { fileNode, fileSystemAdapter } = request;
    const knownFileSize = getKnownFileSize(fileNode.size);
    const maxFileSize = getConfiguredMaxFileSize();

    if (knownFileSize !== null && knownFileSize > maxFileSize) {
      throw new FileContentError(
        `File too large: ${formatFileSize(knownFileSize)} (max: ${formatFileSize(maxFileSize)})`,
        fileNode.path,
        'TOO_LARGE'
      );
    }

    const fileHandle = fileNodeToFileHandle(fileNode);

    const content = await fileSystemAdapter.readFile(fileHandle);
    const extension = fileExplorer.getFileExtension(fileNode.path);

    if (fileContent.isBinaryExtension(extension)) {
      throw new FileContentError(BINARY_CONTENT_MESSAGE, fileNode.path, 'BINARY');
    }

    if (fileContent.isTextExtension(extension)) {
      if (!fileContent.isTextContent(content)) {
        throw new FileContentError(BINARY_CONTENT_MESSAGE, fileNode.path, 'BINARY');
      }
      return content;
    }

    if (!fileContent.isTextContent(content)) {
      throw new FileContentError(BINARY_CONTENT_MESSAGE, fileNode.path, 'BINARY');
    }
    return content;
  }
}

/**
 * Factory function to create the appropriate processor
 */
export function createFileContentProcessor(
  fileSystemAdapter: FileSystemAdapter,
  options: { concurrency?: number; preferDirect?: boolean } = {}
): FileContentProcessor {
  const { concurrency = 3, preferDirect = false } = options;

  if (preferDirect) {
    return new DirectFileContentProcessor();
  }

  return new WorkerFileContentProcessor(fileSystemAdapter, concurrency);
}

import type { FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import {
  DEFAULT_MAX_FILE_SIZE,
  formatFileSize,
  getFileSizeConfig,
  getFileTooLargeMessage,
  isDurableRootId,
  isFullyQualifiedFileSystemPath,
} from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import { BINARY_CONTENT_MESSAGE, FileContentError } from '@brainstrike/types';
import {
  fileContent,
  getKnownFileSize,
  isBinaryExtension,
  isTextExtension,
} from '@brainstrike/utils';
import { getFileExtension } from '@brainstrike/utils/file-utils';

export interface FileReadRequest {
  /** Durable identity required with `absoluteRootPath`. */
  absoluteRootId?: string;
  /** Mounted native root required when `handle` is absent for an absolute read. */
  absoluteRootPath?: string;
  compositeKey: string;
  /** File handle; optional for an explicit absolute-root or adapter-defined path read. */
  handle?: FileHandle;
  path: string;
}

export interface ProgressEvent {
  key: string;
  loaded: number;
  total: number;
}

export type FileContentReadResult =
  | { content: string; status: 'accessible' }
  | { message: string; status: 'inaccessible' };

export interface FileContentWorkerOptions {
  concurrency?: number;
  fileSystemAdapter: FileSystemAdapter;
  maxFileSize?: number;
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

function normalizeAbortError(error: unknown): Error {
  return error instanceof Error ? error : createAbortError();
}

function normalizeSchedulerError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('File content queue scheduling failed.', { cause: error });
}

async function readRequestContent(
  fileSystemAdapter: FileSystemAdapter,
  request: FileReadRequest
): Promise<string> {
  if (request.handle) {
    return fileSystemAdapter.readFile(request.handle);
  }
  if (request.absoluteRootPath !== undefined || request.absoluteRootId !== undefined) {
    if (
      !(
        isDurableRootId(request.absoluteRootId) &&
        isFullyQualifiedFileSystemPath(request.absoluteRootPath) &&
        isFullyQualifiedFileSystemPath(request.path)
      )
    ) {
      throw new Error(
        'Absolute path reads require durable root identity and non-empty fully qualified root and file paths'
      );
    }
    if (!fileSystemAdapter.readFileByAbsolutePath) {
      throw new Error('Absolute path read capability is unavailable');
    }
    return fileSystemAdapter.readFileByAbsolutePath(
      request.path,
      request.absoluteRootPath,
      request.absoluteRootId
    );
  }
  if (!fileSystemAdapter.readFileByPath) {
    throw new Error('No handle or path-read capability is available');
  }
  return fileSystemAdapter.readFileByPath(request.path);
}

const logger = createLogger('FileContentWorker');

function normalizeMaxFileSize(maxFileSize: unknown): number {
  if (typeof maxFileSize !== 'number' || !Number.isFinite(maxFileSize) || maxFileSize <= 0) {
    return DEFAULT_MAX_FILE_SIZE;
  }
  return maxFileSize;
}

export function createFileContentWorker({
  fileSystemAdapter,
  concurrency = 3, // Reduced from 5 to prevent main thread saturation
  maxFileSize,
}: FileContentWorkerOptions) {
  const getEffectiveMaxFileSize = (): number => {
    if (maxFileSize !== undefined) {
      return normalizeMaxFileSize(maxFileSize);
    }
    return normalizeMaxFileSize(getFileSizeConfig().maxFileSize);
  };

  async function runQueue(
    queue: FileReadRequest[],
    onProgress?: (e: ProgressEvent) => void,
    abortSignal?: AbortSignal
  ) {
    const results: Record<string, FileContentReadResult> = {};
    let index = 0;
    let active = 0;
    let completed = 0;
    const total = queue.length;

    return new Promise<Record<string, FileContentReadResult>>((resolve, reject) => {
      let settled = false;
      const finishResolve = (value: Record<string, FileContentReadResult>): void => {
        if (settled) {
          return;
        }
        settled = true;
        abortSignal?.removeEventListener('abort', handleAbort);
        resolve(value);
      };
      const finishReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        abortSignal?.removeEventListener('abort', handleAbort);
        reject(error);
      };
      const handleAbort = (): void => {
        finishReject(createAbortError());
      };
      const yieldForQueueTurn = async (): Promise<void> => {
        throwIfAborted(abortSignal);
        await new Promise((resolve) => setTimeout(resolve, 0));
        throwIfAborted(abortSignal);
      };
      const finalizeRequest = (request: FileReadRequest): void => {
        if (settled) {
          return;
        }
        active -= 1;
        completed += 1;
        onProgress?.({ key: request.compositeKey, loaded: completed, total });
        if (completed === total) {
          finishResolve(results);
          return;
        }
        void next().catch((error: unknown) => {
          finishReject(normalizeSchedulerError(error));
        });
      };
      const handleRequestSuccess = (
        request: FileReadRequest,
        key: string,
        content: string
      ): void => {
        if (settled) {
          return;
        }
        results[key] = { content, status: 'accessible' };
        finalizeRequest(request);
      };
      const handleRequestFailure = (request: FileReadRequest, error: unknown): void => {
        if (settled) {
          return;
        }
        const message = error instanceof FileContentError ? error.message : 'Error accessing file';
        results[request.compositeKey] = { message, status: 'inaccessible' };
        finalizeRequest(request);
      };
      const runRequestHandler = (handler: () => void): void => {
        try {
          handler();
        } catch (error) {
          finishReject(normalizeSchedulerError(error));
        }
      };
      const scheduleRequest = async (request: FileReadRequest): Promise<void> => {
        active += 1;
        try {
          await yieldForQueueTurn();
        } catch (error) {
          active -= 1;
          finishReject(normalizeAbortError(error));
          return;
        }
        void processRequest(request)
          .then(
            ({ key, content }) => {
              runRequestHandler(() => {
                handleRequestSuccess(request, key, content);
              });
            },
            (error: unknown) => {
              runRequestHandler(() => {
                handleRequestFailure(request, error);
              });
            }
          )
          .catch((error: unknown) => {
            finishReject(normalizeSchedulerError(error));
          });
      };
      const next = async () => {
        try {
          throwIfAborted(abortSignal);
        } catch (error) {
          finishReject(normalizeAbortError(error));
          return;
        }
        while (!settled && active < concurrency && index < queue.length) {
          const request = queue[index] as FileReadRequest;
          index += 1;
          await scheduleRequest(request);
        }
      };

      if (abortSignal) {
        abortSignal.addEventListener('abort', handleAbort, { once: true });
      }
      if (queue.length === 0) {
        finishResolve(results);
        return;
      }
      void next().catch((error: unknown) => {
        finishReject(normalizeSchedulerError(error));
      });
    });
  }

  async function processRequest(req: FileReadRequest): Promise<{ key: string; content: string }> {
    const effectiveMaxFileSize = getEffectiveMaxFileSize();
    const knownFileSize = getKnownFileSize(req.handle?.size);
    if (knownFileSize !== null && knownFileSize > effectiveMaxFileSize) {
      throw new FileContentError(
        `File too large: ${formatFileSize(knownFileSize)} (max: ${formatFileSize(effectiveMaxFileSize)})`,
        req.path,
        'TOO_LARGE'
      );
    }

    let content: string;
    try {
      content = await readRequestContent(fileSystemAdapter, req);
    } catch (error) {
      if (error instanceof FileContentError) {
        throw error;
      }
      const tooLargeMessage = getFileTooLargeMessage(error);
      if (tooLargeMessage) {
        throw new FileContentError(tooLargeMessage, req.path, 'TOO_LARGE');
      }
      logger.warn('Failed to read file content via adapter', { error, path: req.path });
      throw new FileContentError('Error accessing file', req.path, 'LOADING_ERROR');
    }

    const extension = getFileExtension(req.path);

    if (isBinaryExtension(extension)) {
      throw new FileContentError(BINARY_CONTENT_MESSAGE, req.path, 'BINARY');
    }

    if (isTextExtension(extension)) {
      if (!fileContent.isTextContent(content)) {
        throw new FileContentError(BINARY_CONTENT_MESSAGE, req.path, 'BINARY');
      }
      return { content, key: req.compositeKey };
    }

    if (!fileContent.isTextContent(content)) {
      throw new FileContentError(BINARY_CONTENT_MESSAGE, req.path, 'BINARY');
    }
    return { content, key: req.compositeKey };
  }

  return async function readFiles(
    requests: FileReadRequest[],
    onProgress?: (e: ProgressEvent) => void,
    options?: {
      abortSignal?: AbortSignal;
    }
  ): Promise<Record<string, FileContentReadResult>> {
    return runQueue(requests, onProgress, options?.abortSignal);
  };
}

export type FileContentWorker = ReturnType<typeof createFileContentWorker>;

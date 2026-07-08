import type { FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import {
  AccessError,
  DEFAULT_MAX_FILE_SIZE,
  formatFileSize,
  getFileSizeConfig,
} from '@brainstrike/file-system';
import { FileContentError } from '@brainstrike/types';
import {
  createLogger,
  fileContent,
  fileExplorer,
  isBinaryExtension,
  isTextExtension,
} from '@brainstrike/utils';

export interface FileReadRequest {
  compositeKey: string;
  /** File handle - optional if readFileByPath is available on the adapter */
  handle?: FileHandle;
  path: string;
}

export interface ProgressEvent {
  key: string;
  loaded: number;
  total: number;
}

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

const logger = createLogger('FileContentWorker');

function getKnownFileSize(request: FileReadRequest): number | null {
  const size = request.handle?.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return null;
  }
  return size;
}

function hasTooLargeCode(error: unknown): error is { code: 'TOO_LARGE' } {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown };
  return candidate.code === 'TOO_LARGE';
}

function isTooLargeAccessError(error: unknown): error is AccessError {
  return (
    error instanceof AccessError &&
    error.operation === 'read' &&
    error.message.includes('File too large')
  );
}

function getTooLargeMessage(error: unknown): string | null {
  // This helper classifies raw adapter errors. FileContentError instances are re-thrown upstream.
  if (hasTooLargeCode(error)) {
    if (error instanceof Error) {
      return error.message;
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : 'File too large';
  }
  if (isTooLargeAccessError(error)) {
    return error.message;
  }
  return null;
}

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
    const results: Record<string, string> = {};
    let index = 0;
    let active = 0;
    let completed = 0;
    const total = queue.length;

    return new Promise<Record<string, string>>((resolve, reject) => {
      let settled = false;
      const finishResolve = (value: Record<string, string>): void => {
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
        void next();
      };
      const handleRequestSuccess = (
        request: FileReadRequest,
        key: string,
        content: string
      ): void => {
        if (settled) {
          return;
        }
        results[key] = content;
        finalizeRequest(request);
      };
      const handleRequestFailure = (request: FileReadRequest, error: unknown): void => {
        if (settled) {
          return;
        }
        const message = error instanceof FileContentError ? error.message : 'Error accessing file';
        results[request.compositeKey] = message;
        finalizeRequest(request);
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
        processRequest(request)
          .then(({ key, content }) => {
            handleRequestSuccess(request, key, content);
          })
          .catch((error) => {
            handleRequestFailure(request, error);
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
      void next();
    });
  }

  async function processRequest(req: FileReadRequest): Promise<{ key: string; content: string }> {
    const effectiveMaxFileSize = getEffectiveMaxFileSize();
    const knownFileSize = getKnownFileSize(req);
    if (knownFileSize !== null && knownFileSize > effectiveMaxFileSize) {
      throw new FileContentError(
        `File too large: ${formatFileSize(knownFileSize)} (max: ${formatFileSize(effectiveMaxFileSize)})`,
        req.path,
        'TOO_LARGE'
      );
    }

    let content: string;
    try {
      // Prefer handle-based reads when available so we can use metadata already loaded in the tree.
      if (req.handle) {
        content = await fileSystemAdapter.readFile(req.handle);
      } else if (fileSystemAdapter.readFileByPath) {
        // Fallback for persisted tabs / paths that don't have a tree handle yet.
        content = await fileSystemAdapter.readFileByPath(req.path);
      } else {
        throw new Error('No handle available and readFileByPath not supported');
      }
    } catch (error) {
      if (error instanceof FileContentError) {
        throw error;
      }
      const tooLargeMessage = getTooLargeMessage(error);
      if (tooLargeMessage) {
        throw new FileContentError(tooLargeMessage, req.path, 'TOO_LARGE');
      }
      logger.warn('Failed to read file content via adapter', { error, path: req.path });
      throw new FileContentError('Error accessing file', req.path, 'LOADING_ERROR');
    }

    const extension = fileExplorer.getFileExtension(req.path);

    if (isBinaryExtension(extension)) {
      throw new FileContentError('Binary file - preview not available', req.path, 'BINARY');
    }

    if (isTextExtension(extension)) {
      if (!fileContent.isTextContent(content)) {
        throw new FileContentError('Binary file - preview not available', req.path, 'BINARY');
      }
      return { content, key: req.compositeKey };
    }

    if (!fileContent.isTextContent(content)) {
      throw new FileContentError('Binary file - preview not available', req.path, 'BINARY');
    }
    return { content, key: req.compositeKey };
  }

  return async function readFiles(
    requests: FileReadRequest[],
    onProgress?: (e: ProgressEvent) => void,
    options?: {
      abortSignal?: AbortSignal;
    }
  ): Promise<Record<string, string>> {
    return runQueue(requests, onProgress, options?.abortSignal);
  };
}

export type FileContentWorker = ReturnType<typeof createFileContentWorker>;

import type { FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { AccessError, DEFAULT_MAX_FILE_SIZE, formatFileSize } from '@brainstrike/file-system';
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
  fileSystemAdapter: FileSystemAdapter;
  concurrency?: number;
  maxFileSize?: number;
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
  if (error instanceof FileContentError && error.code === 'TOO_LARGE') {
    return error.message;
  }
  if (hasTooLargeCode(error) && error instanceof Error) {
    return error.message;
  }
  if (isTooLargeAccessError(error)) {
    return error.message;
  }
  return null;
}

export function createFileContentWorker({
  fileSystemAdapter,
  concurrency = 3, // Reduced from 5 to prevent main thread saturation
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
}: FileContentWorkerOptions) {
  async function runQueue(queue: FileReadRequest[], onProgress?: (e: ProgressEvent) => void) {
    const results: Record<string, string> = {};
    let index = 0;
    let active = 0;
    let completed = 0;
    const total = queue.length;

    return new Promise<Record<string, string>>((resolve) => {
      const next = async () => {
        while (active < concurrency && index < queue.length) {
          const req = queue[index] as FileReadRequest;
          index += 1;
          active += 1;

          // Yield to main thread to prevent blocking WorkerStorage communication
          await new Promise((resolve) => setTimeout(resolve, 0));

          processRequest(req)
            .then(({ key, content }) => {
              results[key] = content;
            })
            .catch((err) => {
              const msg = err instanceof FileContentError ? err.message : 'Error accessing file';
              results[req.compositeKey] = msg;
            })
            .finally(() => {
              active -= 1;
              completed += 1;
              onProgress?.({ key: req.compositeKey, loaded: completed, total });
              if (completed === total) {
                resolve(results);
              } else {
                next(); // Don't await here to prevent blocking
              }
            });
        }
      };

      if (queue.length === 0) {
        resolve(results);
      }
      next(); // Don't await here to start processing immediately
    });
  }

  async function processRequest(req: FileReadRequest): Promise<{ key: string; content: string }> {
    const knownFileSize = getKnownFileSize(req);
    if (knownFileSize !== null && knownFileSize > maxFileSize) {
      throw new FileContentError(
        `File too large: ${formatFileSize(knownFileSize)} (max: ${formatFileSize(maxFileSize)})`,
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
      return { key: req.compositeKey, content };
    }

    if (!fileContent.isTextContent(content)) {
      throw new FileContentError('Binary file - preview not available', req.path, 'BINARY');
    }
    return { key: req.compositeKey, content };
  }

  return async function readFiles(
    requests: FileReadRequest[],
    onProgress?: (e: ProgressEvent) => void
  ): Promise<Record<string, string>> {
    return runQueue(requests, onProgress);
  };
}

export type FileContentWorker = ReturnType<typeof createFileContentWorker>;

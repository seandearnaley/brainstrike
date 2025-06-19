import type { FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { FileContentError } from '@brainstrike/types';
import {
  fileContent,
  fileExplorer,
  isBinaryExtension,
  isTextExtension,
} from '@brainstrike/utils';

export interface FileReadRequest {
  compositeKey: string;
  handle: FileHandle;
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
}

export function createFileContentWorker({
  fileSystemAdapter,
  concurrency = 3, // Reduced from 5 to prevent main thread saturation
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
          await new Promise(resolve => setTimeout(resolve, 0));
          
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

      if (queue.length === 0) resolve(results);
      next(); // Don't await here to start processing immediately
    });
  }

  async function processRequest(req: FileReadRequest): Promise<{ key: string; content: string }> {
    let content: string;
    try {
      content = await fileSystemAdapter.readFile(req.handle);
    } catch (_err) {
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

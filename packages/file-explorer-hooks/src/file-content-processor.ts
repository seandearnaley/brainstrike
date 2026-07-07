import type { FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { DEFAULT_MAX_FILE_SIZE, formatFileSize, getFileSizeConfig } from '@brainstrike/file-system';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import { FileContentError } from '@brainstrike/types';
import { fileContent } from '@brainstrike/utils/file-content';
import { fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import {
  createFileContentWorker,
  type FileContentWorker,
  type FileReadRequest,
} from '@brainstrike/workers/file-content-worker';

export interface FileContentProcessor {
  processFiles: (
    requests: FileContentRequest[],
    onProgress?: (event: { key: string; loaded: number; total: number }) => void,
    options?: {
      abortSignal?: AbortSignal;
    }
  ) => Promise<Record<string, string>>;
}

export interface FileContentRequest {
  compositeKey: string;
  fileNode: IFileNode;
  fileSystemAdapter: FileSystemAdapter;
}

function getKnownFileSize(size: unknown): number | null {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return null;
  }
  return size;
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

function getCanonicalFileHandlePath(fileNode: IFileNode): string {
  const handlePath = (fileNode.handle as unknown as { path?: unknown }).path;
  if (typeof handlePath === 'string' && handlePath.length > 0) {
    return handlePath;
  }
  return fileNode.path;
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
  ): Promise<Record<string, string>> {
    throwIfAborted(options?.abortSignal);
    const fileReadRequests: FileReadRequest[] = requests.map((req) => ({
      compositeKey: req.compositeKey,
      handle: this.createFileHandle(req.fileNode, req.fileSystemAdapter),
      path: req.fileNode.path,
    }));

    return this.worker(fileReadRequests, onProgress, options);
  }

  private createFileHandle(fileNode: IFileNode, fileSystemAdapter: FileSystemAdapter): FileHandle {
    const adapterPlatform = (fileSystemAdapter as unknown as { platform?: Platform }).platform;
    const handlePlatform = (fileNode.handle as unknown as { platform?: Platform }).platform;
    const platform: Platform = adapterPlatform ?? handlePlatform ?? 'web';

    const fileHandle: FileHandle = {
      _internal: fileNode.handle,
      kind: 'file',
      name: fileNode.name,
      path: getCanonicalFileHandlePath(fileNode),
      platform,
      rootFolderId: fileNode.rootFolderId,
    };

    const knownFileSize = getKnownFileSize(fileNode.size);
    if (knownFileSize !== null) {
      fileHandle.size = knownFileSize;
    }

    return fileHandle;
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
  ): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    let completed = 0;
    const total = requests.length;

    for (const request of requests) {
      throwIfAborted(options?.abortSignal);
      try {
        const content = await this.processFile(request);
        results[request.compositeKey] = content;
      } catch (err: unknown) {
        const msg = err instanceof FileContentError ? err.message : 'Error accessing file';
        results[request.compositeKey] = msg;
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

    const adapterPlatform = (fileSystemAdapter as unknown as { platform?: Platform }).platform;
    const handlePlatform = (fileNode.handle as unknown as { platform?: Platform }).platform;
    const platform: Platform = adapterPlatform ?? handlePlatform ?? 'web';

    const fileHandle: FileHandle = {
      _internal: fileNode.handle,
      kind: 'file',
      name: fileNode.name,
      path: getCanonicalFileHandlePath(fileNode),
      platform,
      rootFolderId: fileNode.rootFolderId,
    };

    if (knownFileSize !== null) {
      fileHandle.size = knownFileSize;
    }

    const content = await fileSystemAdapter.readFile(fileHandle);
    const extension = fileExplorer.getFileExtension(fileNode.path);

    if (fileContent.isBinaryExtension(extension)) {
      throw new FileContentError('Binary file - preview not available', fileNode.path, 'BINARY');
    }

    if (fileContent.isTextExtension(extension)) {
      if (!fileContent.isTextContent(content)) {
        throw new FileContentError('Binary file - preview not available', fileNode.path, 'BINARY');
      }
      return content;
    }

    if (!fileContent.isTextContent(content)) {
      throw new FileContentError('Binary file - preview not available', fileNode.path, 'BINARY');
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

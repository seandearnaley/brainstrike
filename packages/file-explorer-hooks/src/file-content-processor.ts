import type { FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { DEFAULT_MAX_FILE_SIZE, formatFileSize } from '@brainstrike/file-system';
import type { Platform } from '@brainstrike/platform-utils';
import type { IFileNode } from '@brainstrike/types';
import { FileContentError } from '@brainstrike/types';
import { fileContent, fileExplorer } from '@brainstrike/utils';
import {
  createFileContentWorker,
  type FileContentWorker,
  type FileReadRequest,
} from '@brainstrike/workers/file-content-worker';

export interface FileContentProcessor {
  processFiles(
    requests: FileContentRequest[],
    onProgress?: (event: { key: string; loaded: number; total: number }) => void
  ): Promise<Record<string, string>>;
}

export interface FileContentRequest {
  compositeKey: string;
  fileNode: IFileNode;
  fileSystemAdapter: FileSystemAdapter;
}

/**
 * Worker-based file content processor for production use
 */
export class WorkerFileContentProcessor implements FileContentProcessor {
  private readonly worker: FileContentWorker;

  constructor(fileSystemAdapter: FileSystemAdapter, concurrency = 3) {
    this.worker = createFileContentWorker({
      fileSystemAdapter,
      concurrency,
    });
  }

  async processFiles(
    requests: FileContentRequest[],
    onProgress?: (event: { key: string; loaded: number; total: number }) => void
  ): Promise<Record<string, string>> {
    const fileReadRequests: FileReadRequest[] = requests.map((req) => ({
      compositeKey: req.compositeKey,
      handle: this.createFileHandle(req.fileNode, req.fileSystemAdapter),
      path: req.fileNode.path,
    }));

    return this.worker(fileReadRequests, onProgress);
  }

  private createFileHandle(fileNode: IFileNode, fileSystemAdapter: FileSystemAdapter): FileHandle {
    const adapterPlatform = (fileSystemAdapter as unknown as { platform?: Platform }).platform;
    const handlePlatform = (fileNode.handle as unknown as { platform?: Platform }).platform;
    const platform: Platform = adapterPlatform ?? handlePlatform ?? 'web';

    const fileHandle: FileHandle = {
      path: fileNode.path,
      name: fileNode.name,
      kind: 'file',
      platform,
      rootFolderId: fileNode.rootFolderId,
      _internal: fileNode.handle,
    };

    if (typeof fileNode.size === 'number') {
      fileHandle.size = fileNode.size;
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
    onProgress?: (event: { key: string; loaded: number; total: number }) => void
  ): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    let completed = 0;
    const total = requests.length;

    for (const request of requests) {
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

    return results;
  }

  private async processFile(request: FileContentRequest): Promise<string> {
    const { fileNode, fileSystemAdapter } = request;

    if (typeof fileNode.size === 'number' && fileNode.size > DEFAULT_MAX_FILE_SIZE) {
      throw new FileContentError(
        `File too large: ${formatFileSize(fileNode.size)} (max: ${formatFileSize(DEFAULT_MAX_FILE_SIZE)})`,
        fileNode.path,
        'TOO_LARGE'
      );
    }

    const adapterPlatform = (fileSystemAdapter as unknown as { platform?: Platform }).platform;
    const handlePlatform = (fileNode.handle as unknown as { platform?: Platform }).platform;
    const platform: Platform = adapterPlatform ?? handlePlatform ?? 'web';

    const fileHandle: FileHandle = {
      path: fileNode.path,
      name: fileNode.name,
      kind: 'file',
      platform,
      rootFolderId: fileNode.rootFolderId,
      _internal: fileNode.handle,
    };

    if (typeof fileNode.size === 'number') {
      fileHandle.size = fileNode.size;
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

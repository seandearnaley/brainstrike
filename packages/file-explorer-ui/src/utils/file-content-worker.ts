import {
  createFileContentWorker,
  type FileContentWorker,
} from '@brainstrike/file-explorer-hooks/file-content-worker';
import type { FileSystemAdapter } from '@brainstrike/file-system';

export function getDefaultConcurrency(): number {
  if (navigator?.hardwareConcurrency) {
    return Math.max(5, Math.min(50, navigator.hardwareConcurrency * 2));
  }
  return 20;
}

export function initFileContentWorker(adapter: FileSystemAdapter): FileContentWorker {
  return createFileContentWorker({
    concurrency: getDefaultConcurrency(),
    fileSystemAdapter: adapter,
  });
}

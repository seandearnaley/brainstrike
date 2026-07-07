import type { FileSystemAdapter } from '@brainstrike/file-system';
import {
  createFileContentWorker,
  type FileContentWorker,
} from '@brainstrike/workers/file-content-worker';

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

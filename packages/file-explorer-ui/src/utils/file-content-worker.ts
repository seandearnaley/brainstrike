import type { FileSystemAdapter } from '@brainstrike/file-system';
import {
  createFileContentWorker,
  type FileContentWorker,
} from '@brainstrike/workers/file-content-worker';

export function getDefaultConcurrency(): number {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return Math.max(5, Math.min(50, navigator.hardwareConcurrency * 2));
  }
  return 20;
}

export function initFileContentWorker(adapter: FileSystemAdapter): FileContentWorker {
  const platform = (adapter as unknown as { platform?: string }).platform;
  const isElectron =
    platform === 'electron' ||
    (typeof process !== 'undefined' &&
      !!(process as unknown as { versions?: { electron?: string } }).versions?.electron);
  const concurrency = isElectron ? 3 : getDefaultConcurrency();
  return createFileContentWorker({ fileSystemAdapter: adapter, concurrency });
}

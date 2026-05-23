import fileTreeWorkerUrlHref from './file-tree.worker.ts?worker&url';

export type {
  AccumulatedFileTreePatchMessage,
  BatchLoadResult,
  DirectoryLoadState,
  FileTreePatchMessage,
  FileTreeWorkerPort,
  FlattenedNode,
  MainToWorkerMessage,
  WorkerFileNode,
  WorkerToMainMessage,
} from './index';
export {
  collectExpandedPaths,
  createFileTreeWorkerPort,
  findNodeByPath,
  needsLoading,
  sortFileNodes,
  updateNodeChildren,
} from './index';

export function resolveFileTreeWorkerUrl(): URL {
  return new URL(fileTreeWorkerUrlHref, import.meta.url);
}

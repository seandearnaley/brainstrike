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
  canLoadNode,
  collectDirectoryPaths,
  collectExpandedPaths,
  createFileTreeWorkerPort,
  findNodeByPath,
  getPathDepth,
  isDescendantPath,
  isLoading,
  needsLoading,
  resetDirectoryNode,
  setNodeLoadState,
  sortFileNodes,
  sortTreeNodes,
  updateNodeChildren,
} from './index';

export function resolveFileTreeWorkerUrl(): URL {
  return new URL(fileTreeWorkerUrlHref, import.meta.url);
}

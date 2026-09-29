import type { IFileNode } from '@brainstrike/types';

export interface LazyFileTreeState {
  error: Error | null;
  fileTree: IFileNode[];
  isInitialLoading: boolean;
  loadingPaths: Set<string>;
}

export type FileTreeRefreshResult = { status: 'cancelled' } | { status: 'completed' };

export interface FileTreeDirectorySnapshot {
  directoryPath: string;
  entries: readonly IFileNode[];
}

export type RootLoadOutcome =
  | FileTreeRefreshResult
  | { error: Error; status: 'failed' }
  | { status: 'skipped' };

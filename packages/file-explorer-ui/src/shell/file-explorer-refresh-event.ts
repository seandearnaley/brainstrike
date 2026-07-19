import type { FileSystemChange } from '@brainstrike/types';

export const FILE_EXPLORER_REFRESH_EVENT = 'brainstrike:file-explorer-refreshed' as const;

export type FileExplorerRefreshSource = 'watcher' | 'manual' | 'visibility-recovery';
export type FileExplorerRefreshScope = 'incremental' | 'full';

export interface FileExplorerRefreshRootDetail {
  readonly changes: readonly FileSystemChange[];
  readonly rootId: string;
  readonly rootPath: string;
}

export interface FileExplorerRefreshEventDetail {
  /**
   * Root identities (RootId UUID and/or root path) the DISPATCHER already
   * refreshed itself. Tree consumers skip these so a manual full refresh
   * doesn't enumerate the focused root twice; the background indexer ignores
   * the field (its full sync is identity-agnostic).
   */
  readonly refreshedRootIds?: readonly string[];
  readonly roots: readonly FileExplorerRefreshRootDetail[];
  readonly scope: FileExplorerRefreshScope;
  readonly source: FileExplorerRefreshSource;
}

export type FileExplorerRefreshEvent = CustomEvent<FileExplorerRefreshEventDetail>;

export function createFileExplorerRefreshEvent(
  detail: FileExplorerRefreshEventDetail
): FileExplorerRefreshEvent {
  return new CustomEvent(FILE_EXPLORER_REFRESH_EVENT, { detail });
}

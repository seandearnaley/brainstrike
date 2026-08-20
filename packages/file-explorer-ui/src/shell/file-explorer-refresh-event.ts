import type { FileSystemChange } from '@brainstrike/types';

export const FILE_EXPLORER_REFRESH_EVENT = 'brainstrike:file-explorer-refreshed' as const;

export type FileExplorerRefreshSource = 'watcher' | 'manual' | 'visibility-recovery';
export type FileExplorerRefreshScope = 'incremental' | 'full';

export interface FileExplorerRefreshRootDetail {
  readonly changes: readonly FileSystemChange[];
  /**
   * Bounded root-relative default-filter boundaries whose detailed activity is
   * intentionally absent from `changes`. Git consumers map these paths to
   * intersecting registered worktrees; Explorer/indexing consumers do no work.
   */
  readonly filteredChangeBoundaries?: readonly string[];
  /** The boundary cap was exceeded; Git consumers fail open in this root only. */
  readonly filteredChangeBoundariesOverflow?: true;
  readonly rootId: string;
  readonly rootPath: string;
}

export interface FileExplorerRefreshEventDetail {
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

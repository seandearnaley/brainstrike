export type {
  WorkspaceSearchFileResult,
  WorkspaceSearchHit,
  WorkspaceSearchMatch,
  WorkspaceSearchSummary,
} from './core';
export { useWorkspaceSearchStore, type WorkspaceSearchStatus } from './core';
export {
  buildSearchTreeNodes,
  type FileSelectionState,
  type HeadlineSegment,
  highlightQuery,
  matchNodeId,
  type SearchNodeData,
  type SearchOpenTarget,
  SearchResultsTree,
  type SearchResultsTreeProps,
  type SearchSelectionBridge,
  WorkspaceSearchPanel,
  type WorkspaceSearchPanelProps,
} from './panel';

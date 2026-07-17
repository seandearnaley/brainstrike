export {
  type SelectedChunk,
  useChunkSelectionStore,
} from './bridge/chunk-selection-store';
export {
  type ChunkBounds,
  deriveSearchRanges,
  searchRangeColor,
  type TapestrySpan,
  toTapestrySpan,
} from './bridge/range-math';
export {
  type ChunkSelectionState,
  type FileSelectionState,
  type SearchSelectionBridge,
  useSearchSelectionBridge,
} from './bridge/use-search-selection-bridge';
export type {
  ResultProvenance,
  WorkspaceSearchChild,
  WorkspaceSearchChunkHit,
  WorkspaceSearchFileResult,
  WorkspaceSearchMode,
  WorkspaceSearchNotices,
  WorkspaceSearchResults,
  WorkspaceSearchTextMatch,
} from './core';
export {
  buildGrepPattern,
  escapeRegExpLiteral,
  type ResolvedFileInfo,
  type SemanticSearchRequest,
  type TextSearchRequest,
  useWorkspaceSearchStore,
  WorkspaceSearchExecutor,
  type WorkspaceSearchExecutorDeps,
  type WorkspaceSearchStatus,
} from './core';
export {
  buildSearchTreeNodes,
  childNodeId,
  fileNodeId,
  fileResultChunks,
  type HeadlineSegment,
  highlightQuery,
  SearchCollectionPicker,
  type SearchCollectionPickerProps,
  SearchCoverageBanner,
  type SearchCoverageBannerProps,
  SearchInputBar,
  type SearchInputBarProps,
  SearchModeToggle,
  type SearchNodeData,
  SearchResultsTree,
  type SearchResultsTreeProps,
  splitHeadline,
  textChunkNodeId,
  WorkspaceSearchPanel,
  type WorkspaceSearchPanelProps,
} from './panel';

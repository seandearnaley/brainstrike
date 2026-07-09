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
} from './core/search-result-model';
export {
  buildGrepPattern,
  escapeRegExpLiteral,
  type ResolvedFileInfo,
  type SemanticSearchRequest,
  type TextSearchRequest,
  WorkspaceSearchExecutor,
  type WorkspaceSearchExecutorDeps,
} from './core/workspace-search-executor';
export {
  useWorkspaceSearchStore,
  type WorkspaceSearchStatus,
} from './core/workspace-search-store';
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

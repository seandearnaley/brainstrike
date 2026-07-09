export {
  addChunkRange,
  type ChunkBounds,
  type CoverageState,
  chunkCoverage,
  fileCoverage,
  removeChunkRange,
  type TapestrySpan,
  toTapestrySpan,
} from './bridge/range-math';
export {
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
  WorkspaceSearchPanel,
  type WorkspaceSearchPanelProps,
} from './panel';

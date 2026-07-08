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

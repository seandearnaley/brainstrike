// Core barrel: the UI-free search machinery (result model + executor + store).
// Exposed as the `@brainstrike/workspace-search/core` subpath so composition-layer
// consumers (e.g. app-shell's controller) can import the executor/store/types
// WITHOUT pulling the panel component graph into their bundle — the panel stays
// behind the root barrel's `React.lazy` split.

export {
  fuseNativeSearchPools,
  getNativeSemanticAvailability,
  NATIVE_SEARCH_CANDIDATE_LIMIT,
  NATIVE_SEARCH_FINAL_LIMIT,
  type NativeSemanticAvailability,
  NativeWorkspaceSearchExecutor,
  type NativeWorkspaceSearchRequest,
} from './native-workspace-search';
export {
  type NativeWorkspaceSearchDependencies,
  NativeWorkspaceSearchProvider,
  useNativeWorkspaceSearchDependencies,
} from './native-workspace-search-context';
export type {
  ResultProvenance,
  WorkspaceSearchChild,
  WorkspaceSearchChunkHit,
  WorkspaceSearchFileResult,
  WorkspaceSearchMode,
  WorkspaceSearchNotices,
  WorkspaceSearchResults,
  WorkspaceSearchTextMatch,
} from './search-result-model';
export {
  buildGrepPattern,
  escapeRegExpLiteral,
  type ResolvedFileInfo,
  type SemanticSearchRequest,
  type TextSearchRequest,
  WorkspaceSearchExecutor,
  type WorkspaceSearchExecutorDeps,
} from './workspace-search-executor';
export {
  useWorkspaceSearchStore,
  type WorkspaceSearchStatus,
} from './workspace-search-store';

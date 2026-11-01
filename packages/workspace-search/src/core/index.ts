// Core barrel: the UI-free search machinery (result model, search seam, store).
// Exposed as the `@brainstrike/workspace-search/core` subpath so composition-layer
// consumers (e.g. app-shell's controller) can import it WITHOUT pulling the panel
// component graph into their bundle; the panel stays behind the root barrel's
// `React.lazy` split.

export type {
  WorkspaceSearchFileResult,
  WorkspaceSearchHit,
  WorkspaceSearchMatch,
  WorkspaceSearchRequest,
  WorkspaceSearchSummary,
} from './search-result-model';
export {
  useWorkspaceFileSearch,
  type WorkspaceFileSearch,
  WorkspaceFileSearchContext,
} from './workspace-file-search';
export {
  fileResultId,
  useWorkspaceSearchStore,
  type WorkspaceSearchStatus,
} from './workspace-search-store';

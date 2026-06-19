export const TOOL_DESCRIPTIONS: Record<string, string> = {
  'brainstrike.readWorkspaceFile':
    'Read a file from the selected workspace root with optional range and truncation',
  'brainstrike.writeWorkspaceFile':
    'Write or create a UTF-8 file in the selected workspace root (overwrites existing content; workspace-scoped, requires approval)',
  'brainstrike.stringReplaceWorkspaceFile':
    'Surgically edit a workspace file by replacing one old_str block with new_str (fuzzy-matched; refuses ambiguous matches; workspace-scoped, requires approval)',
  'brainstrike.findWorkspaceSymbol':
    "Locate a symbol's best-effort enclosing line range in a workspace file without returning whole-file content",
  'brainstrike.readWorkspaceDirectory':
    'List a workspace directory in a compact, token-efficient format',
  'brainstrike.listWorkspaceContext':
    'Inspect the current workspace root, selected context paths, and workspace index hint without reading file contents; compact summary by default, detail: true for per-file Tapestry ranges',
  'brainstrike.readWorkspaceContext':
    'Read selected or explicit workspace files under strict file and token budgets after semantic search needs exact source',
  'brainstrike.updateWorkspaceContextSelection':
    'Bulk add, remove, or replace files selected in the workspace context explorer for reusable curated context',
  'brainstrike.updateWorkspaceTapestrySelections':
    'Create, update, or clear token-aware Tapestry line ranges for selected workspace context files',
  'brainstrike.listEmbeddingSpaces':
    'List available embedding spaces, workspace-index status, and optional coverage statistics',
  'brainstrike.queryEmbeddingSpace':
    'Query semantic workspace context; omit embeddingSetId to use the Workspace Index by default',
  'brainstrike.grepSearch':
    "Grep indexed file content for an exact string or regex. Default 'files' mode surveys matching paths cheaply; 'content' mode (scoped with filePaths) returns path:line matches with context",
};

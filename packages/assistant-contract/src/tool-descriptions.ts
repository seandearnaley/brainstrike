export const TOOL_DESCRIPTIONS: Record<string, string> = {
  'brainstrike.readWorkspaceFile':
    'Read a file from the selected workspace root with optional range and truncation',
  'brainstrike.findWorkspaceSymbol':
    "Locate a symbol's best-effort enclosing line range in a workspace file without returning whole-file content",
  'brainstrike.readWorkspaceDirectory':
    'List a workspace directory in a compact, token-efficient format',
  'brainstrike.listWorkspaceContext':
    'Inspect the current workspace root, selected context paths, and workspace index hint without reading file contents',
  'brainstrike.readWorkspaceContext':
    'Read selected or explicit workspace files under strict file and token budgets after semantic search needs exact source',
  'brainstrike.updateWorkspaceContextSelection':
    'Bulk add, remove, or replace files selected in the workspace context explorer for reusable curated context',
  'brainstrike.updateWorkspaceTapestrySelections':
    'Create, update, or clear token-aware Tapestry line ranges for selected workspace context files',
  'brainstrike.listEmbeddingSpaces':
    'List available embedding spaces and identify the recommended workspace index for semantic retrieval',
  'brainstrike.queryEmbeddingSpace':
    'Query a specific embedding space by explicit embeddingSetId and return packed source text plus metadata-only line ranges',
};

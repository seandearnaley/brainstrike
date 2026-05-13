export const TOOL_DESCRIPTIONS: Record<string, string> = {
  'brainstrike.readWorkspaceFile':
    'Read a file from the selected workspace root with optional range and truncation',
  'brainstrike.readWorkspaceDirectory':
    'List a workspace directory in a compact, token-efficient format',
  'brainstrike.listWorkspaceContext':
    'Inspect the current workspace root and selected context paths without reading file contents',
  'brainstrike.readWorkspaceContext':
    'Read selected or explicit workspace files under strict file and token budgets',
  'brainstrike.listEmbeddingSpaces':
    'List available embedding spaces so semantic retrieval can choose an explicit embeddingSetId',
  'brainstrike.queryEmbeddingSpace':
    'Query a specific embedding space by explicit embeddingSetId and return packed semantic context',
};

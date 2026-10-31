import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { QueryEmbeddingSpaceInputSchema } from '../schemas/schemas-search.ts';

export const queryEmbeddingSpace = defineNativeTool({
  activity: { active: 'Searching', done: 'Searched', family: 'search', request: 'Search' },
  defaults: {
    category: 'retrieval',
    estimatedTokens: 190,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    'Search the Workspace Index by meaning. A companion to grepSearch for a conceptual question that exact-text search cannot find; omit embeddingSetId to use the Workspace Index',
  discovery: { family: 'embedding search', namespace: 'embeddings' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    embeddingSetId:
      'Optional embedding space ID returned by listEmbeddingSpaces; omit for Workspace Index codebase searches',
    filePaths: 'Optional workspace-relative file paths to constrain retrieval',
    limit: 'Maximum candidate chunks to retrieve',
    maxChunks: 'Maximum chunks to pack into the result, independent of the candidate limit',
    query: 'Semantic retrieval query text',
    selectionSnapshotId: 'Optional selection snapshot id to retrieve against a pinned selection',
    threshold: 'Minimum similarity threshold',
    tokenBudget: 'Maximum approximate tokens to pack into the retrieval result',
  },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.queryEmbeddingSpace',
  inputSchema: effectToolInputSchema(QueryEmbeddingSpaceInputSchema),
  kind: 'desktop',
  returns:
    'Packed semantic chunks with source line ranges, offsets, chunk metadata (incl. rootId/rootName), budget, and skipped counts',
  surfaces: ['desktop', 'web'],
});

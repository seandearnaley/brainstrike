import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { QueryEmbeddingSpaceInputSchema } from '../schemas/schemas-search.js';

export const queryEmbeddingSpace = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 190,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    'Query semantic workspace context; omit embeddingSetId to use the Workspace Index by default',
  discovery: { family: 'embedding search', namespace: 'embeddings' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.queryEmbeddingSpace',
  inputSchema: providerCompatibleInputSchema(QueryEmbeddingSpaceInputSchema),
  kind: 'desktop',
  returns:
    'Packed semantic chunks with source line ranges, offsets, chunk metadata (incl. rootId/rootName), budget, and skipped counts',
  surfaces: ['desktop', 'web'],
});

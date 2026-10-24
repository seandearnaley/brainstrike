import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { ListEmbeddingSetsInputSchema } from '../schemas/schemas-diagnostics.ts';

export const listEmbeddingSpaces = defineNativeTool({
  defaults: {
    category: 'analysis',
    estimatedTokens: 110,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    'List available embedding spaces, workspace-index status, and optional coverage statistics',
  discovery: { family: 'embedding search', namespace: 'embeddings' },
  history: { staleReplayable: true },
  id: 'brainstrike.listEmbeddingSpaces',
  inputSchema: effectToolInputSchema(ListEmbeddingSetsInputSchema),
  kind: 'desktop',
  returns:
    'Embedding spaces with model, dimensions, distance, workspace-index recommendation flags, and optional coverage stats',
  surfaces: ['desktop', 'web'],
});

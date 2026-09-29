import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { HybridSearchInputSchema } from '../schemas/schemas-search.js';

// Read-only hybrid (vector + BM25 keyword, RRF-fused) workspace retrieval.
export const hybridSearch = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 200,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    'Hybrid workspace search fusing semantic (vector) and exact-term (BM25 keyword) rankings with reciprocal rank fusion; best default for code/doc retrieval mixing concepts with distinctive terms. Omit embeddingSetId to use the Workspace Index; fails visibly (never degrades) if the keyword index is unavailable',
  discovery: { family: 'embedding search', namespace: 'semantics' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.hybridSearch',
  inputSchema: providerCompatibleInputSchema(HybridSearchInputSchema),
  kind: 'desktop',
  returns:
    'Fused ranked chunks with rrfScore, sourceCount, per-arm scores (vectorSimilarity, ftsRank), file paths, and per-arm result counts',
  surfaces: ['desktop', 'web'],
});

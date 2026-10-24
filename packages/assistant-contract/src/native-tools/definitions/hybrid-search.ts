import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { HybridSearchInputSchema } from '../schemas/schemas-search.ts';

// Read-only hybrid (vector + BM25 keyword, RRF-fused) workspace retrieval.
export const hybridSearch = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 200,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    'Search the Workspace Index by meaning and exact terms together (vector and BM25 keyword rankings, reciprocal rank fusion). A companion to grepSearch for a conceptual question that also carries distinctive terms; use grepSearch for exact strings and identifiers. Omit embeddingSetId to use the Workspace Index; fails visibly (never degrades) if the keyword index is unavailable',
  discovery: { family: 'embedding search', namespace: 'semantics' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.hybridSearch',
  inputSchema: effectToolInputSchema(HybridSearchInputSchema),
  kind: 'desktop',
  returns:
    'Fused ranked chunks with rrfScore, sourceCount, per-arm scores (vectorSimilarity, ftsRank), file paths, and per-arm result counts',
  surfaces: ['desktop', 'web'],
});

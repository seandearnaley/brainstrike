/**
 * Search utilities for hybrid search with RRF fusion
 */

// Hybrid Search Service
export {
  createHybridSearchService,
  DEFAULT_HYBRID_SOURCE_LIMIT,
  type HybridSearchMetadata,
  type HybridSearchOptions,
  type HybridSearchRepository,
  type HybridSearchResponse,
  type HybridSearchResult,
  HybridSearchService,
} from './hybrid-search-service.js';
// RRF Algorithm
export {
  // Core RRF functions
  calculateRRFContribution,
  createRankedList,
  // Types
  type FusedResult,
  fuseRankedLists,
  fuseVectorAndFTS,
  normalizeRRFScores,
  type RankedItem,
  type RankedList,
  // Constants
  RRF_K_DEFAULT,
  type RRFContribution,
  type RRFOptions,
} from './rrf.js';

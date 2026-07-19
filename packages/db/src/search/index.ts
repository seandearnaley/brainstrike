/**
 * Search utilities for hybrid search with RRF fusion
 */

// Grep pattern utilities
export {
  escapeLikeLiteral,
  extractTrigramLiteral,
  MIN_TRIGRAM_LITERAL_LENGTH,
} from './grep-pattern.js';
// Grep Search Service
export {
  collectGrepMatchesInContent,
  createGrepLineMatcher,
  createGrepSearchService,
  GREP_DEFAULT_CANDIDATE_LIMIT,
  GREP_DEFAULT_CONTEXT_LINES,
  GREP_DEFAULT_MAX_RESULTS,
  type GrepMatch,
  type GrepSearchOptions,
  type GrepSearchRepository,
  type GrepSearchResult,
  GrepSearchService,
  type LineMatcher,
} from './grep-search-service.js';
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
// Quick-open (⌘P) file-name search
export {
  clampQuickOpenLimit,
  QUICK_OPEN_MAX_LIMIT,
  QUICK_OPEN_NAME_SEARCH_SQL,
  type QuickOpenFileRow,
} from './quick-open-query.js';
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
// Thread hybrid search (thread-native binding of the shared RRF core)
export {
  createThreadSearchService,
  type ThreadMessageMatchResult,
  type ThreadMessageMatchSource,
  type ThreadSearchMetadata,
  type ThreadSearchQueryOptions,
  type ThreadSearchResponse,
  type ThreadSearchResultItem,
  ThreadSearchService,
  type ThreadSearchServiceRepository,
} from './thread-search-service.js';

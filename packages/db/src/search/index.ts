/**
 * Search utilities for hybrid search with RRF fusion
 */

export { createGrepLineMatcher, type LineMatcher } from '@brainstrike/utils/grep-line-matcher';
// Grep pattern utilities
export {
  escapeLikeLiteral,
  extractTrigramLiteral,
  MIN_TRIGRAM_LITERAL_LENGTH,
} from '@brainstrike/utils/grep-pattern';
// Grep Search Service
export {
  collectGrepMatchesInContent,
  createGrepSearchService,
  GREP_DEFAULT_CANDIDATE_LIMIT,
  GREP_DEFAULT_CONTEXT_LINES,
  GREP_DEFAULT_MAX_RESULTS,
  type GrepMatch,
  type GrepSearchOptions,
  type GrepSearchRepository,
  type GrepSearchResult,
  GrepSearchService,
} from '@brainstrike/utils/grep-search';
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
} from '@brainstrike/utils/rrf';
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
// Thread hybrid search (thread-native binding of the shared RRF core)
export {
  createThreadSearchService,
  type ThreadMessageMatchResult,
  type ThreadMessageMatchSource,
  type ThreadSearchArmMessage,
  type ThreadSearchExtraArms,
  type ThreadSearchMetadata,
  type ThreadSearchQueryOptions,
  type ThreadSearchResponse,
  type ThreadSearchResultItem,
  ThreadSearchService,
  type ThreadSearchServiceRepository,
} from './thread-search-service.js';

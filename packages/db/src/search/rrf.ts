/**
 * Reciprocal Rank Fusion (RRF) Algorithm
 *
 * RRF is a technique for combining multiple ranked lists into a single ranking.
 * It's particularly effective for hybrid search where we combine:
 * - Vector similarity search (semantic relevance)
 * - Full-text search (keyword matching)
 * - Other ranking signals (recency, popularity, etc.)
 *
 * Formula: RRF_score(d) = Σ 1/(k + rank_i(d))
 * Where:
 * - d is a document
 * - k is a constant (typically 60)
 * - rank_i(d) is the rank of document d in ranked list i (1-indexed)
 *
 * @see https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking
 * @see Cormack, G. V., Clarke, C. L., & Buettcher, S. (2009). Reciprocal rank fusion
 *      outperforms condorcet and individual rank learning methods.
 */

/**
 * Default k constant for RRF.
 * k=60 is the standard value used in academic literature and industry implementations.
 * - Lower k: More weight to top-ranked items
 * - Higher k: More uniform weighting across ranks
 */
export const RRF_K_DEFAULT = 60;

/**
 * A single item with an identifier and score from a ranking source
 */
export interface RankedItem<T = string> {
  /** Unique identifier for the item */
  id: T;
  /** Original score from the ranking source (optional, for debugging) */
  score?: number;
}

/**
 * A ranked list from a single source (e.g., vector search, full-text search)
 */
export interface RankedList<T = string> {
  /** Items in rank order (first = rank 1, best match) */
  items: RankedItem<T>[];
  /** Name of the ranking source for debugging/logging */
  source: string;
  /** Optional weight multiplier for this source (default: 1.0) */
  weight?: number;
}

/**
 * Result item after RRF fusion with combined score
 */
export interface FusedResult<T = string> {
  /** Breakdown of contributions from each source */
  contributions: RRFContribution[];
  /** Unique identifier for the item */
  id: T;
  /** Combined RRF score (higher = better) */
  rrfScore: number;
  /** Number of ranking sources this item appeared in */
  sourceCount: number;
}

/**
 * Contribution from a single ranking source to the final RRF score
 */
export interface RRFContribution {
  /** RRF contribution: weight * 1/(k + rank) */
  contribution: number;
  /** Original score from this source (if available) */
  originalScore?: number;
  /** Rank in this source (1-indexed) */
  rank: number;
  /** Name of the ranking source */
  source: string;
}

/**
 * Options for RRF fusion
 */
export interface RRFOptions {
  /** The k constant (default: 60) */
  k?: number;
  /** Maximum number of results to return (default: all) */
  limit?: number;
  /** Minimum number of sources an item must appear in (default: 1) */
  minSourceCount?: number;
}

/**
 * Calculate the RRF contribution for a single rank
 *
 * @param rank - The rank of the item (1-indexed)
 * @param k - The k constant
 * @param weight - Optional weight multiplier for this source
 * @returns The RRF contribution value
 */
export function calculateRRFContribution(
  rank: number,
  k: number = RRF_K_DEFAULT,
  weight = 1.0
): number {
  if (rank < 1) {
    throw new Error(`Rank must be >= 1, got ${rank}`);
  }
  return weight * (1 / (k + rank));
}

/**
 * Fuse multiple ranked lists using Reciprocal Rank Fusion
 *
 * @param rankedLists - Array of ranked lists from different sources
 * @param options - RRF configuration options
 * @returns Array of fused results sorted by RRF score (descending)
 *
 * @example
 * ```typescript
 * const vectorResults: RankedList = {
 *   source: 'vector',
 *   items: [
 *     { id: 'doc1', score: 0.95 },
 *     { id: 'doc2', score: 0.87 },
 *     { id: 'doc3', score: 0.82 },
 *   ],
 * };
 *
 * const ftsResults: RankedList = {
 *   source: 'fts',
 *   items: [
 *     { id: 'doc2', score: 15.2 },
 *     { id: 'doc4', score: 12.8 },
 *     { id: 'doc1', score: 8.5 },
 *   ],
 * };
 *
 * const fused = fuseRankedLists([vectorResults, ftsResults], { k: 60 });
 * // Returns items sorted by combined RRF score
 * ```
 */
/**
 * Internal type for accumulating item scores during fusion
 */
interface ItemScoreAccumulator {
  contributions: RRFContribution[];
  rrfScore: number;
  sourceCount: number;
}

/**
 * Create a contribution entry with optional original score
 */
function createContributionEntry(
  source: string,
  rank: number,
  contribution: number,
  originalScore: number | undefined
): RRFContribution {
  const entry: RRFContribution = { contribution, rank, source };
  if (originalScore !== undefined) {
    entry.originalScore = originalScore;
  }
  return entry;
}

/**
 * Process a single item from a ranked list and update the accumulator
 */
function processRankedItem<T>(
  item: RankedItem<T>,
  rank: number,
  source: string,
  k: number,
  weight: number,
  itemScores: Map<T, ItemScoreAccumulator>
): void {
  const contribution = calculateRRFContribution(rank, k, weight);

  let entry = itemScores.get(item.id);
  if (!entry) {
    entry = { contributions: [], rrfScore: 0, sourceCount: 0 };
    itemScores.set(item.id, entry);
  }

  entry.rrfScore += contribution;
  entry.sourceCount += 1;
  entry.contributions.push(createContributionEntry(source, rank, contribution, item.score));
}

/**
 * Convert accumulated scores to sorted, filtered results
 */
function buildFusedResults<T>(
  itemScores: Map<T, ItemScoreAccumulator>,
  minSourceCount: number,
  limit: number | undefined
): FusedResult<T>[] {
  const results: FusedResult<T>[] = [];

  for (const [id, data] of itemScores) {
    if (data.sourceCount >= minSourceCount) {
      results.push({
        contributions: data.contributions,
        id,
        rrfScore: data.rrfScore,
        sourceCount: data.sourceCount,
      });
    }
  }

  // Sort by RRF score descending
  results.sort((a, b) => b.rrfScore - a.rrfScore);

  // Apply limit if specified
  if (limit !== undefined && limit > 0) {
    return results.slice(0, limit);
  }

  return results;
}

export function fuseRankedLists<T = string>(
  rankedLists: RankedList<T>[],
  options: RRFOptions = {}
): FusedResult<T>[] {
  const { k = RRF_K_DEFAULT, limit, minSourceCount = 1 } = options;
  const itemScores = new Map<T, ItemScoreAccumulator>();

  for (const rankedList of rankedLists) {
    const { source, items, weight = 1.0 } = rankedList;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) {
        continue;
      }
      processRankedItem(item, i + 1, source, k, weight, itemScores);
    }
  }

  return buildFusedResults(itemScores, minSourceCount, limit);
}

/**
 * Convenience function to fuse two ranked lists (common case: vector + FTS)
 *
 * @param vectorResults - Results from vector similarity search
 * @param ftsResults - Results from full-text search
 * @param options - RRF configuration options with optional source weights
 * @returns Array of fused results sorted by RRF score (descending)
 */
export function fuseVectorAndFTS<T = string>(
  vectorResults: RankedItem<T>[],
  ftsResults: RankedItem<T>[],
  options: RRFOptions & {
    vectorWeight?: number;
    ftsWeight?: number;
  } = {}
): FusedResult<T>[] {
  const { vectorWeight = 1.0, ftsWeight = 1.0, ...rrfOptions } = options;

  return fuseRankedLists(
    [
      { items: vectorResults, source: 'vector', weight: vectorWeight },
      { items: ftsResults, source: 'fts', weight: ftsWeight },
    ],
    rrfOptions
  );
}

/**
 * Normalize RRF scores to a 0-1 range for easier interpretation.
 * This is useful when you want scores that are comparable across different
 * queries with different numbers of results.
 *
 * @param results - Array of fused results
 * @returns Results with normalized scores (0-1 range)
 */
export function normalizeRRFScores<T = string>(results: FusedResult<T>[]): FusedResult<T>[] {
  if (results.length === 0) {
    return [];
  }

  const firstResult = results[0];
  // Safety check for array access (required by strictNullChecks)
  if (!firstResult) {
    return [];
  }

  const maxScore = firstResult.rrfScore; // Already sorted descending
  const lastResult = results.at(-1);
  const minScore = lastResult ? lastResult.rrfScore : maxScore; // sorted descending

  // All scores identical → the score range collapses (max === min). Any
  // range-based normalization (min-max, or divide-by-max when max is 0) would
  // divide by zero and emit NaN. There is no discriminating signal, so map every
  // item to the top of the range: 1.0 for a non-zero equal set, and 0 for an
  // all-zero set (nothing matched — keep it at the floor). This guard makes the
  // degenerate case explicit and NaN-proof regardless of the mapping below.
  if (maxScore === minScore) {
    const collapsedScore = maxScore === 0 ? 0 : 1;
    return results.map((result) => ({ ...result, rrfScore: collapsedScore }));
  }

  return results.map((result) => ({
    ...result,
    rrfScore: result.rrfScore / maxScore,
  }));
}

/**
 * Create a ranked list from search results with scores.
 * Helper function to convert typical search output to RRF input format.
 *
 * @param items - Array of items with id and score
 * @param source - Name of the ranking source
 * @param options - Optional sorting and limiting options
 * @returns A RankedList ready for RRF fusion
 */
export function createRankedList<T = string>(
  items: Array<{ id: T; score: number }>,
  source: string,
  options: { sortDescending?: boolean; limit?: number; weight?: number } = {}
): RankedList<T> {
  const { sortDescending = true, limit, weight } = options;

  let ranked = [...items];

  // Sort by score if requested (default: descending for typical similarity scores)
  if (sortDescending) {
    ranked.sort((a, b) => b.score - a.score);
  }

  // Apply limit if specified
  if (limit !== undefined && limit > 0) {
    ranked = ranked.slice(0, limit);
  }

  // Build result, only including weight if defined (exactOptionalPropertyTypes)
  const result: RankedList<T> = {
    items: ranked.map((item) => ({ id: item.id, score: item.score })),
    source,
  };
  if (weight !== undefined) {
    result.weight = weight;
  }
  return result;
}

/**
 * Hybrid Search Service
 *
 * Combines vector similarity search (semantic) with full-text search (keyword)
 * using Reciprocal Rank Fusion (RRF) to produce a unified ranking.
 *
 * @see https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview
 */

import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FTSQueryMode,
  FTSSearchOptions,
  FTSSearchResult,
} from '../models/file-chunk.js';
import { createRankedList, type FusedResult, fuseRankedLists, type RRFOptions } from './rrf.js';

/**
 * Minimal interface for repositories that support hybrid search.
 * Defines only the methods required by HybridSearchService, allowing
 * any repository implementation (Drizzle, Electron, PGlite) to be used.
 */
export interface HybridSearchRepository {
  /** Full-text keyword search */
  fullTextSearch: (query: string, options: FTSSearchOptions) => Promise<FTSSearchResult[]>;
  /** Vector similarity search */
  searchSimilar: (
    queryEmbedding: number[],
    options: ChunkSearchOptions
  ) => Promise<ChunkSearchResult[]>;
}

/**
 * Options for hybrid search
 */
export interface HybridSearchOptions {
  /** Filter by chunk type */
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  /** Required: embedding set ID for dimension matching */
  embeddingSetId: string;
  /** Optional allowlist of file paths */
  filePaths?: readonly string[];

  // === Common Filters ===
  /** Filter by specific file record ID */
  fileRecordId?: string;
  /** Allow plain-mode typo recovery after an empty exact FTS arm (default: true). */
  ftsFuzzyFallback?: boolean;
  /** Minimum 0–1 score for fuzzy FTS candidates (default: 0.6). */
  ftsFuzzyThreshold?: number;
  /** FTS language configuration (default: 'english') */
  ftsLanguage?: string;
  /** Number of results to fetch from FTS before fusion (default: 50) */
  ftsLimit?: number;
  /** FTS query parsing mode (default: 'websearch') */
  ftsQueryMode?: FTSQueryMode;

  // === Full-Text Search Options ===
  /** Minimum rank threshold for FTS (default: 0) */
  ftsThreshold?: number;
  /** Weight for FTS results in RRF (default: 1.0) */
  ftsWeight?: number;
  /**
   * Whether the source-pool reads return the full embedding vector. Defaults to
   * `false`: RRF fusion needs only ids + scores and result rows only need the
   * dimension count (preserved via `vector_dims`), so the heavy vector is
   * projected away to keep large fan-out affordable. A caller that genuinely
   * needs the vector back on hybrid results can opt in with `true`.
   */
  includeEmbedding?: boolean;
  /**
   * Whether the FTS source read generates per-row `ts_headline` snippets.
   * Defaults to `true` (snippets available on results). A caller that won't
   * render the snippet — e.g. the hybrid UI search path — can pass `false` to
   * skip generating headlines for the whole candidate pool (only the final
   * survivors would ever show one), avoiding a costly ~per-row operation at
   * large `ftsLimit`.
   */
  includeHeadline?: boolean;
  /** Maximum number of final results to return (default: 10) */
  limit?: number;
  /** Minimum sources required for result inclusion (default: 1) */
  minSourceCount?: number;

  // === RRF Options ===
  /** Optional multi-root workspace scope (file_records.root_id ∈ rootIds). Empty array matches nothing. */
  rootIds?: readonly string[];
  /** RRF k constant (default: 60) */
  rrfK?: number;
  /** Optional snapshot ID for selection filtering */
  selectionSnapshotId?: string;
  /** Number of results to fetch from vector search before fusion (default: 50) */
  vectorLimit?: number;

  // === Vector Search Options ===
  /** Minimum similarity threshold for vector search (default: 0.5) */
  vectorThreshold?: number;
  /** Weight for vector search results in RRF (default: 1.0) */
  vectorWeight?: number;
}

/**
 * Result from hybrid search with detailed scoring information
 */
export interface HybridSearchResult {
  /** The matched chunk */
  chunk: FileChunk;
  /** FTS rank score (if found by FTS): negated BM25, higher = better, unbounded */
  ftsRank?: number;
  /** Headline snippet from FTS (if available) */
  headline?: string;
  /** Position in final result set (1-indexed) */
  position: number;
  /** Combined RRF score (higher = better) */
  rrfScore: number;
  /** Number of search methods that found this chunk (1 or 2) */
  sourceCount: number;
  /** Vector similarity score (if found by vector search) */
  vectorSimilarity?: number;
}

/**
 * Metadata about the hybrid search execution
 */
export interface HybridSearchMetadata {
  /** Number of results from FTS before fusion */
  ftsResultCount: number;
  /** Time taken for FTS (ms) */
  ftsSearchMs: number;
  /** Number of results after fusion */
  fusedResultCount: number;
  /** Time taken for fusion (ms) */
  fusionMs: number;
  /** Total time (ms) */
  totalMs: number;
  /** Number of results from vector search before fusion */
  vectorResultCount: number;
  /** Time taken for vector search (ms) */
  vectorSearchMs: number;
}

/**
 * Complete response from hybrid search
 */
export interface HybridSearchResponse {
  /** Execution metadata */
  metadata: HybridSearchMetadata;
  /** Search results */
  results: HybridSearchResult[];
}

/**
 * Default size of each RRF source pool (vector + FTS). Exported so callers that
 * scale the pools to a requested limit can floor at this value without
 * hand-duplicating the constant (RRF reranks best from a pool larger than the
 * final cut).
 */
export const DEFAULT_HYBRID_SOURCE_LIMIT = 50;

/**
 * Service for performing hybrid search combining vector and full-text search
 */
export class HybridSearchService {
  constructor(private readonly chunkRepository: HybridSearchRepository) {}

  /**
   * Perform hybrid search combining vector similarity and full-text search
   *
   * @param queryText - The search query text (used for FTS)
   * @param queryEmbedding - The query embedding vector (used for vector search)
   * @param options - Search configuration options
   * @returns Search results with metadata
   *
   * @example
   * ```typescript
   * const response = await hybridSearch.search(
   *   'authentication middleware',
   *   await embedder.embed('authentication middleware'),
   *   {
   *     embeddingSetId: 'my-set-id',
   *     limit: 20,
   *     vectorWeight: 1.2,  // Slightly favor semantic matches
   *     ftsWeight: 1.0,
   *   }
   * );
   * ```
   */
  async search(
    queryText: string,
    queryEmbedding: number[],
    options: HybridSearchOptions
  ): Promise<HybridSearchResponse> {
    const startTime = performance.now();

    const {
      limit = 10,
      // Vector options
      vectorThreshold = 0.5,
      vectorLimit = DEFAULT_HYBRID_SOURCE_LIMIT,
      vectorWeight = 1.0,
      embeddingSetId,
      // FTS options
      ftsThreshold = 0,
      ftsLimit = DEFAULT_HYBRID_SOURCE_LIMIT,
      ftsWeight = 1.0,
      ftsQueryMode = 'websearch',
      ftsLanguage = 'english',
      ftsFuzzyFallback = true,
      ftsFuzzyThreshold = 0.6,
      // Default to projecting the embedding vector away (see HybridSearchOptions).
      includeEmbedding = false,
      // Default to generating FTS headlines (callers that won't render them opt out).
      includeHeadline = true,
      // Common filters
      fileRecordId,
      chunkType,
      filePaths,
      rootIds,
      selectionSnapshotId,
      // RRF options
      rrfK = 60,
      minSourceCount = 1,
    } = options;

    // Build search options, only including defined properties (exactOptionalPropertyTypes).
    // RRF fusion needs only ids + scores, and result rows only need the embedding
    // DIMENSION (preserved via vector_dims), never the multi-KB vector — so the
    // source-pool reads project the heavy embedding payload away by default. At
    // large limits this avoids materializing thousands of full embeddings in the
    // renderer. A caller can opt back in via `includeEmbedding`.
    const vectorSearchOptions: ChunkSearchOptions = {
      embeddingSetId,
      includeEmbedding,
      limit: vectorLimit,
      threshold: vectorThreshold,
    };
    if (fileRecordId !== undefined) {
      vectorSearchOptions.fileRecordId = fileRecordId;
    }
    if (chunkType !== undefined) {
      vectorSearchOptions.chunkType = chunkType;
    }
    if (filePaths !== undefined) {
      vectorSearchOptions.filePaths = filePaths;
    }
    if (selectionSnapshotId !== undefined) {
      vectorSearchOptions.selectionSnapshotId = selectionSnapshotId;
    }
    if (rootIds !== undefined) {
      vectorSearchOptions.rootIds = rootIds;
    }

    // The keyword arm is scoped to the SAME embedding set as the vector arm
    // (coverage-identity semantics in the repos), so fusion can never surface
    // BM25-only chunks from another embedding space.
    const ftsSearchOptions: FTSSearchOptions = {
      embeddingSetId,
      fuzzyFallback: ftsFuzzyFallback,
      fuzzyThreshold: ftsFuzzyThreshold,
      includeEmbedding,
      includeHeadline,
      language: ftsLanguage,
      limit: ftsLimit,
      queryMode: ftsQueryMode,
      threshold: ftsThreshold,
    };
    if (fileRecordId !== undefined) {
      ftsSearchOptions.fileRecordId = fileRecordId;
    }
    if (chunkType !== undefined) {
      ftsSearchOptions.chunkType = chunkType;
    }
    if (filePaths !== undefined) {
      ftsSearchOptions.filePaths = filePaths;
    }
    if (selectionSnapshotId !== undefined) {
      ftsSearchOptions.selectionSnapshotId = selectionSnapshotId;
    }
    if (rootIds !== undefined) {
      ftsSearchOptions.rootIds = rootIds;
    }

    // Run both searches in parallel, timing each ARM individually — a shared
    // clock around the joint await reported two identical wall-time numbers
    // (BST-578).
    const timeArm = async <T>(run: () => Promise<T>): Promise<{ ms: number; result: T }> => {
      const start = performance.now();
      const result = await run();
      return { ms: performance.now() - start, result };
    };

    const [vectorTimed, ftsTimed] = await Promise.all([
      timeArm(() => this.executeVectorSearch(queryEmbedding, vectorSearchOptions)),
      timeArm(() => this.executeFullTextSearch(queryText, ftsSearchOptions)),
    ]);
    const vectorResults = vectorTimed.result;
    const ftsResults = ftsTimed.result;
    const vectorSearchMs = vectorTimed.ms;
    const ftsSearchMs = ftsTimed.ms;

    // Fuse results using RRF
    const fusionStart = performance.now();
    const fusedResults = this.fuseResults(
      vectorResults,
      ftsResults,
      {
        k: rrfK,
        limit,
        minSourceCount,
      },
      vectorWeight,
      ftsWeight
    );
    const fusionMs = performance.now() - fusionStart;

    // Build final results with all metadata
    const results = this.buildHybridResults(fusedResults, vectorResults, ftsResults);

    const totalMs = performance.now() - startTime;

    return {
      metadata: {
        ftsResultCount: ftsResults.length,
        ftsSearchMs,
        fusedResultCount: fusedResults.length,
        fusionMs,
        totalMs,
        vectorResultCount: vectorResults.length,
        vectorSearchMs,
      },
      results,
    };
  }

  /**
   * Execute vector similarity search
   */
  private async executeVectorSearch(
    queryEmbedding: number[],
    options: ChunkSearchOptions
  ): Promise<ChunkSearchResult[]> {
    return this.chunkRepository.searchSimilar(queryEmbedding, options);
  }

  /**
   * Execute full-text search
   */
  private async executeFullTextSearch(
    queryText: string,
    options: FTSSearchOptions
  ): Promise<FTSSearchResult[]> {
    return this.chunkRepository.fullTextSearch(queryText, options);
  }

  /**
   * Fuse vector and FTS results using RRF
   */
  private fuseResults(
    vectorResults: ChunkSearchResult[],
    ftsResults: FTSSearchResult[],
    rrfOptions: RRFOptions,
    vectorWeight: number,
    ftsWeight: number
  ): FusedResult<string>[] {
    // Create ranked lists from both result sets
    const vectorRanked = createRankedList(
      vectorResults.map((r) => ({ id: r.chunk.id, score: r.similarity })),
      'vector',
      { weight: vectorWeight }
    );

    const ftsRanked = createRankedList(
      ftsResults.map((r) => ({ id: r.chunk.id, score: r.rank })),
      'fts',
      { weight: ftsWeight }
    );

    return fuseRankedLists([vectorRanked, ftsRanked], rrfOptions);
  }

  /**
   * Build final hybrid results with all metadata from both search types
   */
  private buildHybridResults(
    fusedResults: FusedResult<string>[],
    vectorResults: ChunkSearchResult[],
    ftsResults: FTSSearchResult[]
  ): HybridSearchResult[] {
    // Create lookup maps for quick access
    const vectorMap = new Map(vectorResults.map((r) => [r.chunk.id, r]));
    const ftsMap = new Map(ftsResults.map((r) => [r.chunk.id, r]));

    const results: HybridSearchResult[] = [];

    for (let i = 0; i < fusedResults.length; i++) {
      const fused = fusedResults[i];
      if (!fused) {
        continue;
      }

      const vectorResult = vectorMap.get(fused.id);
      const ftsResult = ftsMap.get(fused.id);

      // Get the chunk from whichever source has it
      const chunk = vectorResult?.chunk ?? ftsResult?.chunk;
      if (!chunk) {
        continue; // Should never happen, but safety check
      }

      const result: HybridSearchResult = {
        chunk,
        position: i + 1,
        rrfScore: fused.rrfScore,
        sourceCount: fused.sourceCount,
      };

      // Add vector similarity if available
      if (vectorResult) {
        result.vectorSimilarity = vectorResult.similarity;
      }

      // Add FTS metadata if available
      if (ftsResult) {
        result.ftsRank = ftsResult.rank;
        if (ftsResult.headline) {
          result.headline = ftsResult.headline;
        }
      }

      results.push(result);
    }

    return results;
  }
}

/**
 * Create a HybridSearchService instance
 */
export function createHybridSearchService(
  chunkRepository: HybridSearchRepository
): HybridSearchService {
  return new HybridSearchService(chunkRepository);
}

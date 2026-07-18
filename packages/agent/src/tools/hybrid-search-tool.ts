/**
 * Hybrid Search Tool
 *
 * Platform-agnostic hybrid search tool that combines vector similarity
 * and full-text search using dependency injection. This follows the same
 * pattern as retrieval-tool.ts for cross-platform compatibility.
 *
 * @see retrieval-tool.ts for the DI pattern reference
 */

import type { HybridSearchInput } from './schemas';
import { HybridSearchInputSchema } from './schemas';
import { handleToolError, type ToolContext } from './types';

/** Tool identifier used in the Mastra tools registry */
export const HYBRID_SEARCH_TOOL_ID = 'brainstrike.hybridSearch' as const;

/**
 * Safe error messages that can be shown to users.
 */
export const HYBRID_SEARCH_ERROR_MESSAGES = {
  embeddingFailed: 'Failed to generate query embedding.',
  embeddingSetNotFound: 'The specified embedding set was not found.',
  invalidQuery: 'Search query must be at least 1 character.',
  missingApiKey: 'No API key configured for the embedding provider.',
  missingEmbeddingSet: 'An embedding set ID is required for hybrid search.',
  searchFailed: 'Hybrid search failed. Please try again.',
  unsupportedProvider:
    'Local embedding models are not available in the assistant. Choose a hosted embedding set.',
} as const;

export const SAFE_HYBRID_SEARCH_ERRORS = new Set<string>(
  Object.values(HYBRID_SEARCH_ERROR_MESSAGES)
);

/**
 * Individual search result from hybrid search.
 */
export interface HybridSearchResultItem {
  /** Chunk index within file */
  chunkIndex: number;
  /** Chunk content */
  content: string;
  /** File name */
  fileName?: string;
  /** File path where chunk originated */
  filePath?: string;
  /** FTS rank (if found by full-text search): negated BM25, higher = better, unbounded */
  ftsRank?: number;
  /** Headline snippet from FTS */
  headline?: string;
  /** Chunk ID */
  id: string;
  /** Position in result set (1-indexed) */
  position: number;
  /** Combined RRF score */
  rrfScore: number;
  /** Number of search methods that found this chunk */
  sourceCount: number;
  /** Vector similarity score (if found by vector search) */
  vectorSimilarity?: number;
}

/**
 * Result returned by the hybrid search tool.
 */
export interface HybridSearchToolResult {
  embeddingSetId: string;
  ftsWeight: number;
  limit: number;
  metadata: {
    vectorResultCount: number;
    ftsResultCount: number;
    fusedResultCount: number;
    totalMs: number;
  };
  query: string;
  results: HybridSearchResultItem[];
  vectorWeight: number;
}

/**
 * Chunk data structure from search results.
 */
export interface SearchChunk {
  chunkIndex: number;
  chunkType?: string;
  content: string;
  fileRecordId: string;
  id: string;
}

/**
 * File record information for enriching results.
 */
export interface SearchFileRecord {
  id: string;
  name: string;
  path: string;
}

/**
 * Hybrid search result from the service.
 */
export interface HybridSearchServiceResult {
  chunk: SearchChunk;
  ftsRank?: number;
  headline?: string;
  position: number;
  rrfScore: number;
  sourceCount: number;
  vectorSimilarity?: number;
}

/**
 * Search metadata from the service.
 */
export interface HybridSearchServiceMetadata {
  ftsResultCount: number;
  fusedResultCount: number;
  totalMs: number;
  vectorResultCount: number;
}

/**
 * Dependencies required by the hybrid search tool.
 * Platform-specific implementations provide these callbacks.
 */
export interface HybridSearchToolDependencies {
  /**
   * Generates a query embedding vector.
   * @throws Error with safe message on failure
   */
  generateQueryEmbedding: (embeddingSetId: string, query: string) => Promise<number[]>;

  /**
   * Optional logger for debugging.
   */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };

  /**
   * Performs the hybrid search using both vector and FTS.
   */
  performHybridSearch: (
    queryText: string,
    queryEmbedding: number[],
    options: {
      embeddingSetId: string;
      limit: number;
      vectorWeight: number;
      ftsWeight: number;
      vectorThreshold?: number;
      filePaths?: readonly string[];
      chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
    }
  ) => Promise<{
    results: HybridSearchServiceResult[];
    metadata: HybridSearchServiceMetadata;
  }>;

  /**
   * Resolves file record information for enriching results.
   */
  resolveFileRecords: (fileRecordIds: string[]) => Promise<Map<string, SearchFileRecord>>;
}

/**
 * Default search parameters.
 */
const DEFAULT_LIMIT = 20;
const DEFAULT_VECTOR_WEIGHT = 1.0;
const DEFAULT_FTS_WEIGHT = 1.0;
const DEFAULT_VECTOR_THRESHOLD = 0.5;

/**
 * Core hybrid search execution logic.
 */
async function runHybridSearch(
  input: HybridSearchInput,
  deps: HybridSearchToolDependencies
): Promise<HybridSearchToolResult> {
  const query = input.query.trim();
  if (!query) {
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.invalidQuery);
  }

  const { embeddingSetId } = input;
  if (!embeddingSetId) {
    throw new Error(HYBRID_SEARCH_ERROR_MESSAGES.missingEmbeddingSet);
  }

  deps.logger?.debug('Starting hybrid search', {
    embeddingSetId,
    query: query.slice(0, 100),
  });

  // Generate query embedding
  const queryEmbedding = await deps.generateQueryEmbedding(embeddingSetId, query);

  // Perform hybrid search
  const limit = input.limit ?? DEFAULT_LIMIT;
  const vectorWeight = input.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  const ftsWeight = input.ftsWeight ?? DEFAULT_FTS_WEIGHT;

  const searchOptions: Parameters<HybridSearchToolDependencies['performHybridSearch']>[2] = {
    embeddingSetId,
    ftsWeight,
    limit,
    vectorWeight,
  };

  if (input.vectorThreshold === undefined) {
    searchOptions.vectorThreshold = DEFAULT_VECTOR_THRESHOLD;
  } else {
    searchOptions.vectorThreshold = input.vectorThreshold;
  }

  if (input.filePaths !== undefined) {
    searchOptions.filePaths = input.filePaths;
  }

  if (input.chunkType !== undefined) {
    searchOptions.chunkType = input.chunkType;
  }

  const { results, metadata } = await deps.performHybridSearch(
    query,
    queryEmbedding,
    searchOptions
  );

  deps.logger?.debug('Hybrid search completed', {
    ftsResultCount: metadata.ftsResultCount,
    resultCount: results.length,
    totalMs: metadata.totalMs,
    vectorResultCount: metadata.vectorResultCount,
  });

  // Resolve file records for enrichment
  const fileRecordIds = Array.from(new Set(results.map((r) => r.chunk.fileRecordId)));
  const fileMap = await deps.resolveFileRecords(fileRecordIds);

  // Transform results to tool output format
  const toolResults: HybridSearchResultItem[] = results.map((result) => {
    const fileInfo = fileMap.get(result.chunk.fileRecordId);

    const item: HybridSearchResultItem = {
      chunkIndex: result.chunk.chunkIndex,
      content: result.chunk.content,
      id: result.chunk.id,
      position: result.position,
      rrfScore: result.rrfScore,
      sourceCount: result.sourceCount,
    };

    if (fileInfo?.path !== undefined) {
      item.filePath = fileInfo.path;
    }
    if (fileInfo?.name !== undefined) {
      item.fileName = fileInfo.name;
    }
    if (result.vectorSimilarity !== undefined) {
      item.vectorSimilarity = result.vectorSimilarity;
    }
    if (result.ftsRank !== undefined) {
      item.ftsRank = result.ftsRank;
    }
    if (result.headline !== undefined) {
      item.headline = result.headline;
    }

    return item;
  });

  return {
    embeddingSetId,
    ftsWeight,
    limit,
    metadata,
    query,
    results: toolResults,
    vectorWeight,
  };
}

/**
 * Mastra tool type - matches the pattern from retrieval-tool.ts
 */
interface MastraTool {
  description: string;
  execute: (context: ToolContext<HybridSearchInput>) => Promise<HybridSearchToolResult>;
  id: string;
  inputSchema: typeof HybridSearchInputSchema;
}

/**
 * Creates a Mastra-compatible hybrid search tool with the provided dependencies.
 *
 * @example
 * ```typescript
 * const tool = createHybridSearchTool({
 *   generateQueryEmbedding: async (setId, query) => { ... },
 *   performHybridSearch: async (text, embedding, opts) => { ... },
 *   resolveFileRecords: async (ids) => { ... },
 * });
 * ```
 */
export function createHybridSearchTool(deps: HybridSearchToolDependencies): MastraTool {
  return {
    description:
      'Search the codebase using hybrid search (vector similarity + keyword). ' +
      'Combines semantic understanding with exact keyword matching for best results.',
    execute: async (context: ToolContext<HybridSearchInput>) => {
      try {
        return await runHybridSearch(context.context, deps);
      } catch (error) {
        handleToolError(
          error,
          SAFE_HYBRID_SEARCH_ERRORS,
          HYBRID_SEARCH_ERROR_MESSAGES.searchFailed,
          deps.logger
        );
      }
    },
    id: HYBRID_SEARCH_TOOL_ID,
    inputSchema: HybridSearchInputSchema,
  };
}

/**
 * Type for tools input (matching Mastra pattern).
 */
export type ToolsInput = Record<string, MastraTool>;

/**
 * Builds a tools object with the hybrid search tool added to a base set.
 */
export function buildToolsWithHybridSearch(
  deps: HybridSearchToolDependencies,
  base: ToolsInput = {}
): ToolsInput {
  return {
    ...base,
    [HYBRID_SEARCH_TOOL_ID]: createHybridSearchTool(deps),
  };
}

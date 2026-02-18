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
  missingEmbeddingSet: 'An embedding set ID is required for hybrid search.',
  embeddingSetNotFound: 'The specified embedding set was not found.',
  unsupportedProvider:
    'Local embedding models are not available in the assistant. Choose a hosted embedding set.',
  missingApiKey: 'No API key configured for the embedding provider.',
  embeddingFailed: 'Failed to generate query embedding.',
  searchFailed: 'Hybrid search failed. Please try again.',
  invalidQuery: 'Search query must be at least 1 character.',
} as const;

export const SAFE_HYBRID_SEARCH_ERRORS = new Set<string>(
  Object.values(HYBRID_SEARCH_ERROR_MESSAGES)
);

/**
 * Individual search result from hybrid search.
 */
export interface HybridSearchResultItem {
  /** Chunk ID */
  id: string;
  /** Chunk content */
  content: string;
  /** File path where chunk originated */
  filePath?: string;
  /** File name */
  fileName?: string;
  /** Chunk index within file */
  chunkIndex: number;
  /** Combined RRF score */
  rrfScore: number;
  /** Vector similarity score (if found by vector search) */
  vectorSimilarity?: number;
  /** FTS rank (if found by full-text search) */
  ftsRank?: number;
  /** Headline snippet from FTS */
  headline?: string;
  /** Position in result set (1-indexed) */
  position: number;
  /** Number of search methods that found this chunk */
  sourceCount: number;
}

/**
 * Result returned by the hybrid search tool.
 */
export interface HybridSearchToolResult {
  query: string;
  embeddingSetId: string;
  limit: number;
  vectorWeight: number;
  ftsWeight: number;
  results: HybridSearchResultItem[];
  metadata: {
    vectorResultCount: number;
    ftsResultCount: number;
    fusedResultCount: number;
    totalMs: number;
  };
}

/**
 * Chunk data structure from search results.
 */
export interface SearchChunk {
  id: string;
  content: string;
  chunkIndex: number;
  chunkType?: string;
  fileRecordId: string;
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
  rrfScore: number;
  sourceCount: number;
  vectorSimilarity?: number;
  ftsRank?: number;
  headline?: string;
  position: number;
}

/**
 * Search metadata from the service.
 */
export interface HybridSearchServiceMetadata {
  vectorResultCount: number;
  ftsResultCount: number;
  fusedResultCount: number;
  totalMs: number;
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

  /**
   * Optional logger for debugging.
   */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
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
    query: query.slice(0, 100),
    embeddingSetId,
  });

  // Generate query embedding
  const queryEmbedding = await deps.generateQueryEmbedding(embeddingSetId, query);

  // Perform hybrid search
  const limit = input.limit ?? DEFAULT_LIMIT;
  const vectorWeight = input.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  const ftsWeight = input.ftsWeight ?? DEFAULT_FTS_WEIGHT;

  const searchOptions: Parameters<HybridSearchToolDependencies['performHybridSearch']>[2] = {
    embeddingSetId,
    limit,
    vectorWeight,
    ftsWeight,
  };

  if (input.vectorThreshold !== undefined) {
    searchOptions.vectorThreshold = input.vectorThreshold;
  } else {
    searchOptions.vectorThreshold = DEFAULT_VECTOR_THRESHOLD;
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
    resultCount: results.length,
    vectorResultCount: metadata.vectorResultCount,
    ftsResultCount: metadata.ftsResultCount,
    totalMs: metadata.totalMs,
  });

  // Resolve file records for enrichment
  const fileRecordIds = Array.from(new Set(results.map((r) => r.chunk.fileRecordId)));
  const fileMap = await deps.resolveFileRecords(fileRecordIds);

  // Transform results to tool output format
  const toolResults: HybridSearchResultItem[] = results.map((result) => {
    const fileInfo = fileMap.get(result.chunk.fileRecordId);

    const item: HybridSearchResultItem = {
      id: result.chunk.id,
      content: result.chunk.content,
      chunkIndex: result.chunk.chunkIndex,
      rrfScore: result.rrfScore,
      position: result.position,
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
    query,
    embeddingSetId,
    limit,
    vectorWeight,
    ftsWeight,
    results: toolResults,
    metadata,
  };
}

/**
 * Mastra tool type - matches the pattern from retrieval-tool.ts
 */
interface MastraTool {
  id: string;
  description: string;
  inputSchema: typeof HybridSearchInputSchema;
  execute: (context: ToolContext<HybridSearchInput>) => Promise<HybridSearchToolResult>;
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
    id: HYBRID_SEARCH_TOOL_ID,
    description:
      'Search the codebase using hybrid search (vector similarity + keyword). ' +
      'Combines semantic understanding with exact keyword matching for best results.',
    inputSchema: HybridSearchInputSchema,
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

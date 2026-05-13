/**
 * Platform-agnostic retrieval tool factory (BST-174)
 *
 * This module provides a factory function to create a Mastra-compatible retrieval tool
 * that can be used in both web and desktop environments. Dependencies are injected
 * to avoid platform-specific imports.
 */

import type { ToolsInput } from '@mastra/core/agent';
import {
  ContextPacker,
  type ContextPackerChunk,
  type ContextPackerResult,
  type PackedContextChunk,
} from '../context-packer';
import type { RuntimeData } from '../types';
import type { RetrievalContextInput } from './schemas';
import { RetrievalContextInputSchema } from './schemas';
import type { ToolContext } from './types';

/** Tool identifier used in the Mastra tools registry */
export const RETRIEVAL_TOOL_ID = 'brainstrike.retrieveContext' as const;

const DEFAULT_LIMIT = 20;
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_TOKEN_BUDGET = 4000;

/** Estimated characters per token for heuristic token counting */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Safe error messages that can be shown to users without leaking internal details.
 */
export const RETRIEVAL_ERROR_MESSAGES = {
  missingEmbeddingSet: 'Select an active embedding set to enable retrieval.',
  invalidEmbeddingSet: 'Active embedding set metadata is unavailable.',
  embeddingSetLookupFailed: 'Unable to load embedding set metadata.',
  unsupportedProvider:
    'Local embedding models are not available in the assistant. Choose a hosted embedding set.',
  missingApiKey: 'No API key configured for the embedding provider.',
  invalidSelectionSnapshot: 'Selection snapshot reference is invalid.',
  invalidSelectionFilePaths: 'Selection file paths are invalid.',
  selectionTooLarge: 'Selection exceeds retrieval limits.',
  embeddingDimensionMismatch: 'Embedding dimensions do not match the active set.',
  embeddingFailed: 'Unable to generate query embeddings for retrieval.',
  missingSourceRange:
    'Retrieved chunks are missing source line metadata. Rebuild the embedding space.',
  retrievalFailed: 'Unable to retrieve context right now. Try again.',
} as const;

export const SAFE_ERROR_MESSAGES = new Set<string>(Object.values(RETRIEVAL_ERROR_MESSAGES));

/**
 * Chunk search result from the database search operation.
 */
export interface ChunkSearchResultInput {
  chunk: {
    id: string;
    content: string;
    tokenCount?: number;
    chunkIndex: number;
    chunkType?: string;
    endLine?: number;
    endOffset?: number;
    fileRecordId: string;
    embeddingSetId?: string;
    startLine?: number;
    startOffset?: number;
  };
  rank: number;
  similarity: number;
}

/**
 * File record information for enriching search results.
 */
export interface FileRecordInfo {
  id: string;
  name: string;
  path: string;
  tokenCount: number | null;
}

/**
 * Embedding set metadata.
 */
export interface EmbeddingSetInfo {
  dimensions: number;
  distance: string | null;
  modelId: string;
  modelKey: string;
}

/**
 * Selection state for scoping retrieval.
 */
export interface RetrievalSelectionState {
  filePaths?: string[];
  selectionSnapshotId?: string;
}

/**
 * Result returned by the retrieval tool.
 */
export interface RetrievalToolResult {
  budget: number;
  chunks: PackedContextChunk[];
  context: string;
  embeddingSetId: string;
  limit: number;
  query: string;
  remainingTokens: number;
  selectionSnapshotId?: string;
  skipped: number;
  threshold: number;
  totalTokens: number;
}

/**
 * Dependencies required by the retrieval tool.
 * Platform-specific implementations provide these callbacks.
 */
export interface RetrievalToolDependencies {
  /**
   * Optional: Creates a selection snapshot for large file path lists.
   * If not provided, large selections will be passed inline (may fail).
   */
  createSelectionSnapshot?: (filePaths: readonly string[]) => Promise<string>;

  /**
   * Optional: Token estimation function for context packing.
   * Defaults to a heuristic estimate if not provided.
   */
  estimateTokens?: (text: string) => number;

  /**
   * Generates a query embedding vector using the specified model.
   * @throws Error with safe message on failure
   */
  generateQueryEmbedding: (embeddingSet: EmbeddingSetInfo, query: string) => Promise<number[]>;

  /**
   * Optional: Logger for debugging.
   */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
  /**
   * Resolves embedding set metadata by ID.
   * @throws Error with safe message on failure
   */
  resolveEmbeddingSet: (embeddingSetId: string) => Promise<EmbeddingSetInfo>;

  /**
   * Resolves file record information for a list of file record IDs.
   */
  resolveFileRecords: (fileRecordIds: string[]) => Promise<Map<string, FileRecordInfo>>;

  /**
   * Searches for similar chunks using the provided embedding.
   */
  searchSimilarChunks: (
    embedding: number[],
    options: {
      embeddingSetId: string;
      limit: number;
      threshold: number;
      filePaths?: string[];
      selectionSnapshotId?: string;
    }
  ) => Promise<ChunkSearchResultInput[]>;
}

/**
 * Default token estimation heuristic based on average chars per token.
 */
function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Type guard to check if running in a Node.js-like environment.
 * Uses proper type narrowing instead of type assertions.
 */
function isNodeEnvironment(): boolean {
  // Check for Node.js process global with env property
  return (
    typeof process !== 'undefined' &&
    process !== null &&
    typeof process.env === 'object' &&
    process.env !== null
  );
}

/**
 * Type guard to check if running in development mode.
 * Safe for both Node.js and browser environments.
 */
function isDevelopmentMode(): boolean {
  if (!isNodeEnvironment()) {
    return false;
  }
  return process.env['NODE_ENV'] === 'development';
}

/**
 * Normalizes text by trimming and returning undefined for empty strings.
 */
function normalizeText(value: string | null | undefined): string | undefined {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalizes and deduplicates file paths.
 */
function normalizeFilePaths(filePaths: readonly string[] | undefined): string[] | undefined {
  if (!filePaths || filePaths.length === 0) {
    return;
  }
  const unique = new Set<string>();
  for (const raw of filePaths) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }
  return unique.size > 0 ? Array.from(unique) : undefined;
}

/**
 * Resolves embedding set ID from input or runtime data.
 * Input takes precedence as it represents explicit tool call intent.
 */
function resolveRuntimeEmbeddingSetId(
  runtime: RuntimeData | undefined,
  inputEmbeddingSetId: string | undefined
): string | undefined {
  return normalizeText(inputEmbeddingSetId) ?? normalizeText(runtime?.embeddingSetId);
}

/**
 * Resolves selection filters from runtime data and input.
 */
function resolveSelectionFilters(
  runtime: RuntimeData | undefined,
  inputFilePaths: readonly string[] | undefined,
  inputSnapshotId: string | undefined
): { filePaths?: string[]; snapshotId?: string } {
  const runtimeSnapshotId = normalizeText(runtime?.selectionSnapshotId);
  const snapshotId = runtimeSnapshotId ?? normalizeText(inputSnapshotId);
  const runtimePaths = normalizeFilePaths(runtime?.selectionFilePaths);
  const filePaths = runtimePaths ?? normalizeFilePaths(inputFilePaths);
  if (snapshotId) {
    return { snapshotId };
  }
  return filePaths ? { filePaths } : {};
}

/**
 * Resolves token budget from runtime data or input override.
 */
function resolveTokenBudget(runtime: RuntimeData | undefined, override?: number): number {
  const runtimeBudget = runtime?.tokenBudget;
  const candidate = override ?? runtimeBudget ?? DEFAULT_TOKEN_BUDGET;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_TOKEN_BUDGET;
  }
  return Math.floor(candidate);
}

/**
 * Converts search results to ContextPacker input format.
 */
function toContextChunks(
  results: ChunkSearchResultInput[],
  fileMap: Map<string, FileRecordInfo>
): ContextPackerChunk[] {
  return results.map((result) => {
    if (
      result.chunk.startLine === undefined ||
      result.chunk.endLine === undefined ||
      result.chunk.startOffset === undefined ||
      result.chunk.endOffset === undefined
    ) {
      throw new Error(RETRIEVAL_ERROR_MESSAGES.missingSourceRange);
    }
    const fileInfo = fileMap.get(result.chunk.fileRecordId);
    const chunk: ContextPackerChunk = {
      id: result.chunk.id,
      content: result.chunk.content,
      tokenCount: result.chunk.tokenCount ?? null,
      chunkIndex: result.chunk.chunkIndex,
      startLine: result.chunk.startLine,
      endLine: result.chunk.endLine,
      startOffset: result.chunk.startOffset,
      endOffset: result.chunk.endOffset,
      score: result.similarity,
      metadata: {
        fileRecordId: result.chunk.fileRecordId,
        embeddingSetId: result.chunk.embeddingSetId,
        chunkType: result.chunk.chunkType,
        rank: result.rank,
        fileTokenCount: fileInfo?.tokenCount ?? undefined,
      },
    };
    if (fileInfo?.path !== undefined) {
      chunk.filePath = fileInfo.path;
    }
    if (fileInfo?.name !== undefined) {
      chunk.fileName = fileInfo.name;
    }
    return chunk;
  });
}

/**
 * Formats packed chunks into a human-readable context string.
 */
function formatContext(chunks: readonly PackedContextChunk[]): string {
  if (chunks.length === 0) {
    return '';
  }
  return chunks
    .map((chunk, index) => {
      const location = chunk.filePath ?? chunk.fileName ?? 'Unknown file';
      const lineSuffix = chunk.lineRange ? `:${chunk.lineRange.start}-${chunk.lineRange.end}` : '';
      const chunkLabel = chunk.chunkIndex === undefined ? '' : ` (chunk ${chunk.chunkIndex})`;
      return `Source ${index + 1}: ${location}${lineSuffix}${chunkLabel}\n${chunk.content}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Handles errors from the retrieval process, ensuring only safe messages are exposed.
 */
function handleRetrievalError(error: unknown, logger?: RetrievalToolDependencies['logger']): never {
  const message = error instanceof Error ? error.message : RETRIEVAL_ERROR_MESSAGES.retrievalFailed;
  if (SAFE_ERROR_MESSAGES.has(message)) {
    throw new Error(message);
  }
  logger?.error('Retrieval tool failed', { error });
  // Expose stack trace in development mode for debugging
  if (isDevelopmentMode()) {
    const debugMessage =
      error instanceof Error ? (error.stack ?? error.message) : String(error ?? 'Unknown error');
    throw new Error(`${RETRIEVAL_ERROR_MESSAGES.retrievalFailed} [Debug: ${debugMessage}]`);
  }
  throw new Error(RETRIEVAL_ERROR_MESSAGES.retrievalFailed);
}

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

/**
 * Core retrieval execution logic.
 */
async function runRetrieval(
  input: RetrievalContextInput,
  runtimeData: RuntimeData | undefined,
  deps: RetrievalToolDependencies
): Promise<RetrievalToolResult> {
  const query = input.query.trim();
  if (!query) {
    throw new Error(RETRIEVAL_ERROR_MESSAGES.retrievalFailed);
  }

  const embeddingSetId = resolveRuntimeEmbeddingSetId(runtimeData, input.embeddingSetId);
  if (!embeddingSetId) {
    throw new Error(RETRIEVAL_ERROR_MESSAGES.missingEmbeddingSet);
  }

  deps.logger?.debug('Starting retrieval', { query: query.slice(0, 100), embeddingSetId });

  // Resolve embedding set metadata
  const embeddingSet = await deps.resolveEmbeddingSet(embeddingSetId);

  // Generate query embedding
  const embedding = await deps.generateQueryEmbedding(embeddingSet, query);
  if (embedding.length !== embeddingSet.dimensions) {
    deps.logger?.warn('Embedding dimension mismatch', {
      expected: embeddingSet.dimensions,
      actual: embedding.length,
    });
    throw new Error(RETRIEVAL_ERROR_MESSAGES.embeddingDimensionMismatch);
  }

  // Resolve selection filters
  const selection = resolveSelectionFilters(
    runtimeData,
    input.filePaths,
    input.selectionSnapshotId
  );

  // Search for similar chunks
  const limit = input.limit ?? DEFAULT_LIMIT;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const searchResults = await deps.searchSimilarChunks(embedding, {
    embeddingSetId,
    limit,
    threshold,
    ...(selection.filePaths ? { filePaths: selection.filePaths } : {}),
    ...(selection.snapshotId ? { selectionSnapshotId: selection.snapshotId } : {}),
  });

  deps.logger?.debug('Search completed', { resultCount: searchResults.length });

  // Resolve file records for enrichment
  const fileRecordIds = Array.from(new Set(searchResults.map((r) => r.chunk.fileRecordId)));
  const fileMap = await deps.resolveFileRecords(fileRecordIds);

  // Convert to packer input format
  const chunkInputs = toContextChunks(searchResults, fileMap);

  // Pack context within token budget
  const tokenBudget = resolveTokenBudget(runtimeData, input.tokenBudget);
  const packerOptions = {
    budgetTokens: tokenBudget,
    estimateTokens: deps.estimateTokens ?? defaultEstimateTokens,
    ...(input.maxChunks === undefined ? {} : { maxChunks: input.maxChunks }),
  };
  const packer = new ContextPacker(packerOptions);
  const packed: ContextPackerResult = packer.pack(chunkInputs);

  // Format context for display
  const contextText = formatContext(packed.chunks);

  deps.logger?.debug('Context packed', {
    totalTokens: packed.totalTokens,
    budget: packed.budget,
    skipped: packed.skipped,
    chunksIncluded: packed.chunks.length,
  });

  return {
    query,
    embeddingSetId,
    limit,
    threshold,
    totalTokens: packed.totalTokens,
    budget: packed.budget,
    remainingTokens: packed.remainingTokens,
    skipped: packed.skipped,
    context: contextText,
    chunks: [...packed.chunks],
    ...(selection.snapshotId ? { selectionSnapshotId: selection.snapshotId } : {}),
  };
}

/**
 * Creates a Mastra-compatible retrieval tool with the provided dependencies.
 *
 * @example
 * ```typescript
 * const tool = createRetrievalTool(runtimeData, {
 *   resolveEmbeddingSet: async (id) => { ... },
 *   generateQueryEmbedding: async (set, query) => { ... },
 *   searchSimilarChunks: async (embedding, opts) => { ... },
 *   resolveFileRecords: async (ids) => { ... },
 * });
 * ```
 */
export function createRetrievalTool(
  runtimeData: RuntimeData | undefined,
  deps: RetrievalToolDependencies
): MastraTools[string] {
  return {
    id: RETRIEVAL_TOOL_ID,
    description:
      'Retrieve and pack relevant project context from the active embedding set. Use for codebase questions.',
    inputSchema: RetrievalContextInputSchema,
    execute: async (context: ToolContext<RetrievalContextInput>) => {
      try {
        return await runRetrieval(context.context, runtimeData, deps);
      } catch (error) {
        handleRetrievalError(error, deps.logger);
      }
    },
  };
}

/**
 * Builds a tools object with the retrieval tool added to a base set.
 */
export function buildToolsWithRetrieval(
  runtimeData: RuntimeData | undefined,
  deps: RetrievalToolDependencies,
  base: ToolsInput = {}
): ToolsInput {
  return {
    ...base,
    [RETRIEVAL_TOOL_ID]: createRetrievalTool(runtimeData, deps),
  };
}

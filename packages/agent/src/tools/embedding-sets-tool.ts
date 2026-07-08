/**
 * Embedding Sets Tool
 *
 * Platform-agnostic tools for listing and creating embedding collections.
 * Uses dependency injection for cross-platform compatibility.
 *
 * @see retrieval-tool.ts for the DI pattern reference
 */

import type { CreateEmbeddingSetInput, ListEmbeddingSetsInput } from './schemas';
import { CreateEmbeddingSetInputSchema, ListEmbeddingSetsInputSchema } from './schemas';
import { handleToolError, type ToolContext } from './types';

/** Tool identifiers used in the Mastra tools registry */
export const LIST_EMBEDDING_SETS_TOOL_ID = 'brainstrike.listEmbeddingSets' as const;
export const CREATE_EMBEDDING_SET_TOOL_ID = 'brainstrike.createEmbeddingSet' as const;

/**
 * Safe error messages that can be shown to users.
 */
export const EMBEDDING_SETS_ERROR_MESSAGES = {
  createFailed: 'Failed to create embedding set. Please try again.',
  invalidModelKey: 'The specified model key is not valid.',
  listFailed: 'Failed to list embedding sets. Please try again.',
  modelNotFound: 'The specified embedding model was not found.',
  setAlreadyExists: 'An embedding set with this configuration already exists.',
} as const;

export const SAFE_EMBEDDING_SETS_ERRORS = new Set<string>(
  Object.values(EMBEDDING_SETS_ERROR_MESSAGES)
);

/**
 * Embedding set information returned by list operation.
 */
export interface EmbeddingSetInfo {
  /** Category */
  category?: string;
  /** Creation timestamp */
  createdAt: string;
  /** Description */
  description?: string;
  /** Vector dimensions */
  dimensions: number;
  /** Distance metric */
  distance: string;
  /** Unique identifier */
  id: string;
  /** Model identifier */
  modelId: string;
  /** Model key (provider::model format) */
  modelKey: string;
  /** Human-readable name */
  name?: string;
  /** Tags for categorization */
  tags?: string;
}

/**
 * Coverage statistics for an embedding set.
 */
export interface EmbeddingSetCoverage {
  /** Coverage percentage (0-100) */
  coveragePercent: number;
  /** Chunks with embeddings */
  embeddedChunks: number;
  /** Total chunks in the set */
  totalChunks: number;
}

/**
 * Result returned by the list embedding sets tool.
 */
export interface ListEmbeddingSetsToolResult {
  /** Total count */
  count: number;
  /** Coverage stats per set (if includeStats was true) */
  coverageStats?: Record<string, EmbeddingSetCoverage>;
  /** List of embedding sets */
  sets: EmbeddingSetInfo[];
}

/**
 * Result returned by the create embedding set tool.
 */
export interface CreateEmbeddingSetToolResult {
  /** Whether the set was created (false if already existed) */
  created: boolean;
  /** Human-readable message */
  message: string;
  /** The created or existing embedding set */
  set: EmbeddingSetInfo;
}

/**
 * Dependencies required by the embedding sets tools.
 * Platform-specific implementations provide these callbacks.
 */
export interface EmbeddingSetsToolDependencies {
  /**
   * Creates a new embedding set.
   * @param modelKey - Model key (provider::model format)
   * @param name - Human-readable name
   * @param description - Optional description
   * @returns The created set, or existing set if it already exists
   */
  createSet: (
    modelKey: string,
    name: string,
    description?: string
  ) => Promise<{ set: EmbeddingSetInfo; created: boolean }>;

  /**
   * Gets coverage statistics for embedding sets.
   * Returns a map of setId -> coverage stats.
   */
  getCoverageStats?: () => Promise<Record<string, EmbeddingSetCoverage>>;
  /**
   * Lists all embedding sets.
   */
  listSets: () => Promise<EmbeddingSetInfo[]>;

  /**
   * Optional logger for debugging.
   */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * Core list embedding sets execution logic.
 */
async function runListEmbeddingSets(
  input: ListEmbeddingSetsInput,
  deps: EmbeddingSetsToolDependencies
): Promise<ListEmbeddingSetsToolResult> {
  deps.logger?.debug('Listing embedding sets', { includeStats: input.includeStats });

  const sets = await deps.listSets();

  deps.logger?.debug('Listed embedding sets', { count: sets.length });

  // Build result with only defined properties (exactOptionalPropertyTypes compliance)
  const result: ListEmbeddingSetsToolResult = {
    count: sets.length,
    sets,
  };

  if (input.includeStats && deps.getCoverageStats) {
    result.coverageStats = await deps.getCoverageStats();
  }

  return result;
}

/**
 * Core create embedding set execution logic.
 */
async function runCreateEmbeddingSet(
  input: CreateEmbeddingSetInput,
  deps: EmbeddingSetsToolDependencies
): Promise<CreateEmbeddingSetToolResult> {
  deps.logger?.debug('Creating embedding set', {
    modelKey: input.modelKey,
    name: input.name,
  });

  const { set, created } = await deps.createSet(input.modelKey, input.name, input.description);

  const message = created
    ? `Created embedding set "${set.name}" with ${set.dimensions} dimensions.`
    : `Embedding set "${set.name}" already exists.`;

  deps.logger?.debug('Embedding set operation complete', { created, setId: set.id });

  return {
    created,
    message,
    set,
  };
}

/**
 * Mastra tool type for list.
 */
interface ListMastraTool {
  description: string;
  execute: (context: ToolContext<ListEmbeddingSetsInput>) => Promise<ListEmbeddingSetsToolResult>;
  id: string;
  inputSchema: typeof ListEmbeddingSetsInputSchema;
}

/**
 * Mastra tool type for create.
 */
interface CreateMastraTool {
  description: string;
  execute: (context: ToolContext<CreateEmbeddingSetInput>) => Promise<CreateEmbeddingSetToolResult>;
  id: string;
  inputSchema: typeof CreateEmbeddingSetInputSchema;
}

/**
 * Creates a Mastra-compatible list embedding sets tool.
 *
 * @example
 * ```typescript
 * const tool = createListEmbeddingSetsTool({
 *   listSets: async () => repository.findAll(),
 * });
 * ```
 */
export function createListEmbeddingSetsTool(deps: EmbeddingSetsToolDependencies): ListMastraTool {
  return {
    description:
      'List all available embedding collections. ' +
      'Shows model configuration, dimensions, and optionally coverage statistics.',
    execute: async (context: ToolContext<ListEmbeddingSetsInput>) => {
      try {
        return await runListEmbeddingSets(context.context, deps);
      } catch (error) {
        handleToolError(
          error,
          SAFE_EMBEDDING_SETS_ERRORS,
          EMBEDDING_SETS_ERROR_MESSAGES.listFailed,
          deps.logger
        );
      }
    },
    id: LIST_EMBEDDING_SETS_TOOL_ID,
    inputSchema: ListEmbeddingSetsInputSchema,
  };
}

/**
 * Creates a Mastra-compatible create embedding set tool.
 *
 * @example
 * ```typescript
 * const tool = createCreateEmbeddingSetTool({
 *   createSet: async (modelKey, name, description) =>
 *     repository.getOrCreateSet(modelKey, modelId, dimensions, distance, { name, description }),
 * });
 * ```
 */
export function createCreateEmbeddingSetTool(
  deps: EmbeddingSetsToolDependencies
): CreateMastraTool {
  return {
    description:
      'Create a new embedding collection for storing document vectors. ' +
      'Requires approval before execution. Returns the created set or existing set if duplicate.',
    execute: async (context: ToolContext<CreateEmbeddingSetInput>) => {
      try {
        return await runCreateEmbeddingSet(context.context, deps);
      } catch (error) {
        handleToolError(
          error,
          SAFE_EMBEDDING_SETS_ERRORS,
          EMBEDDING_SETS_ERROR_MESSAGES.createFailed,
          deps.logger
        );
      }
    },
    id: CREATE_EMBEDDING_SET_TOOL_ID,
    inputSchema: CreateEmbeddingSetInputSchema,
  };
}

/**
 * Type for tools input (matching Mastra pattern).
 */
export type ToolsInput = Record<string, ListMastraTool | CreateMastraTool>;

/**
 * Builds a tools object with the embedding sets tools added to a base set.
 */
export function buildToolsWithEmbeddingSets(
  deps: EmbeddingSetsToolDependencies,
  base: ToolsInput = {}
): ToolsInput {
  return {
    ...base,
    [LIST_EMBEDDING_SETS_TOOL_ID]: createListEmbeddingSetsTool(deps),
    [CREATE_EMBEDDING_SET_TOOL_ID]: createCreateEmbeddingSetTool(deps),
  };
}

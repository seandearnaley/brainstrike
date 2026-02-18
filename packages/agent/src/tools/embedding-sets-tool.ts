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
  listFailed: 'Failed to list embedding sets. Please try again.',
  createFailed: 'Failed to create embedding set. Please try again.',
  invalidModelKey: 'The specified model key is not valid.',
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
  /** Unique identifier */
  id: string;
  /** Model key (provider::model format) */
  modelKey: string;
  /** Model identifier */
  modelId: string;
  /** Vector dimensions */
  dimensions: number;
  /** Distance metric */
  distance: string;
  /** Human-readable name */
  name?: string;
  /** Description */
  description?: string;
  /** Tags for categorization */
  tags?: string;
  /** Category */
  category?: string;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Coverage statistics for an embedding set.
 */
export interface EmbeddingSetCoverage {
  /** Total chunks in the set */
  totalChunks: number;
  /** Chunks with embeddings */
  embeddedChunks: number;
  /** Coverage percentage (0-100) */
  coveragePercent: number;
}

/**
 * Result returned by the list embedding sets tool.
 */
export interface ListEmbeddingSetsToolResult {
  /** List of embedding sets */
  sets: EmbeddingSetInfo[];
  /** Total count */
  count: number;
  /** Coverage stats per set (if includeStats was true) */
  coverageStats?: Record<string, EmbeddingSetCoverage>;
}

/**
 * Result returned by the create embedding set tool.
 */
export interface CreateEmbeddingSetToolResult {
  /** Whether the set was created (false if already existed) */
  created: boolean;
  /** The created or existing embedding set */
  set: EmbeddingSetInfo;
  /** Human-readable message */
  message: string;
}

/**
 * Dependencies required by the embedding sets tools.
 * Platform-specific implementations provide these callbacks.
 */
export interface EmbeddingSetsToolDependencies {
  /**
   * Lists all embedding sets.
   */
  listSets: () => Promise<EmbeddingSetInfo[]>;

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
    sets,
    count: sets.length,
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
    set,
    message,
  };
}

/**
 * Mastra tool type for list.
 */
interface ListMastraTool {
  id: string;
  description: string;
  inputSchema: typeof ListEmbeddingSetsInputSchema;
  execute: (context: ToolContext<ListEmbeddingSetsInput>) => Promise<ListEmbeddingSetsToolResult>;
}

/**
 * Mastra tool type for create.
 */
interface CreateMastraTool {
  id: string;
  description: string;
  inputSchema: typeof CreateEmbeddingSetInputSchema;
  execute: (context: ToolContext<CreateEmbeddingSetInput>) => Promise<CreateEmbeddingSetToolResult>;
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
    id: LIST_EMBEDDING_SETS_TOOL_ID,
    description:
      'List all available embedding collections. ' +
      'Shows model configuration, dimensions, and optionally coverage statistics.',
    inputSchema: ListEmbeddingSetsInputSchema,
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
    id: CREATE_EMBEDDING_SET_TOOL_ID,
    description:
      'Create a new embedding collection for storing document vectors. ' +
      'Requires approval before execution. Returns the created set or existing set if duplicate.',
    inputSchema: CreateEmbeddingSetInputSchema,
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

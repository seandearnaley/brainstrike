/**
 * File Tree Tool
 *
 * Platform-agnostic tool for querying imported file trees and searching files.
 * Uses dependency injection for cross-platform compatibility.
 *
 * @see retrieval-tool.ts for the DI pattern reference
 */

import type { QueryFileTreeInput } from './schemas';
import { QueryFileTreeInputSchema } from './schemas';
import { handleToolError, type ToolContext } from './types';

/** Tool identifier used in the Mastra tools registry */
export const QUERY_FILE_TREE_TOOL_ID = 'brainstrike.queryFileTree' as const;

/**
 * Safe error messages that can be shown to users.
 */
export const FILE_TREE_ERROR_MESSAGES = {
  pathNotFound: 'The specified path was not found in imported files.',
  patternInvalid: 'The glob pattern is invalid.',
  queryFailed: 'Failed to query file tree. Please try again.',
  tooManyResults: 'Query returned too many results. Try a more specific path or pattern.',
} as const;

export const SAFE_FILE_TREE_ERRORS = new Set<string>(Object.values(FILE_TREE_ERROR_MESSAGES));

/**
 * File entry in the tree.
 */
export interface FileEntry {
  /** Child count for directories */
  childCount?: number;
  /** Unique file record ID */
  id: string;
  /** Whether the file has been chunked */
  isChunked: boolean;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Modification timestamp */
  modifiedAt?: string;
  /** File name */
  name: string;
  /** Full path */
  path: string;
  /** File size in bytes (null for directories) */
  size: number | null;
  /** Token count if processed (null if not counted) */
  tokenCount: number | null;
}

/**
 * Result returned by the file tree tool.
 */
export interface QueryFileTreeToolResult {
  /** Total count of entries */
  count: number;
  /** Files and directories matching the query */
  entries: FileEntry[];
  /** Maximum depth traversed */
  maxDepth: number;
  /** Query path (resolved) */
  path: string;
  /** Pattern used for filtering */
  pattern: string | null;
  /** Human-readable summary */
  summary: string;
  /** Whether results were truncated */
  truncated: boolean;
}

/**
 * Dependencies required by the file tree tool.
 * Platform-specific implementations provide these callbacks.
 */
export interface FileTreeToolDependencies {
  /**
   * Gets the root paths of all imported directories.
   */
  getRootPaths?: () => Promise<string[]>;
  /**
   * Lists files in the specified path.
   * @param path - Directory path to query (empty string for root)
   * @param options - Query options
   */
  listFiles: (
    path: string,
    options: {
      pattern?: string;
      maxDepth?: number;
      includeHidden?: boolean;
      limit?: number;
    }
  ) => Promise<{
    entries: FileEntry[];
    truncated: boolean;
  }>;

  /**
   * Optional logger for debugging.
   */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/** Maximum entries to return by default */
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_DEPTH = 3;

/**
 * Generate a human-readable summary.
 */
function generateSummary(
  path: string,
  entries: FileEntry[],
  truncated: boolean,
  pattern: string | null
): string {
  const fileCount = entries.filter((e) => !e.isDirectory).length;
  const dirCount = entries.filter((e) => e.isDirectory).length;

  const parts: string[] = [];

  if (path) {
    parts.push(`Path: ${path}`);
  } else {
    parts.push('Root level');
  }

  if (pattern) {
    parts.push(`Pattern: ${pattern}`);
  }

  parts.push(`${fileCount} files, ${dirCount} directories`);

  if (truncated) {
    parts.push('(results truncated)');
  }

  return parts.join(' | ');
}

/**
 * Core file tree query execution logic.
 */
async function runQueryFileTree(
  input: QueryFileTreeInput,
  deps: FileTreeToolDependencies
): Promise<QueryFileTreeToolResult> {
  const path = input.path ?? '';
  const pattern = input.pattern ?? null;
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const includeHidden = input.includeHidden ?? false;

  deps.logger?.debug('Querying file tree', { includeHidden, maxDepth, path, pattern });

  // Build options object with only defined properties (exactOptionalPropertyTypes compliance)
  const options: {
    pattern?: string;
    maxDepth?: number;
    includeHidden?: boolean;
    limit?: number;
  } = {
    includeHidden,
    limit: DEFAULT_LIMIT,
    maxDepth,
  };
  if (pattern !== null) {
    options.pattern = pattern;
  }

  const { entries, truncated } = await deps.listFiles(path, options);

  const summary = generateSummary(path, entries, truncated, pattern);

  deps.logger?.debug('File tree query complete', { count: entries.length, truncated });

  return {
    count: entries.length,
    entries,
    maxDepth,
    path,
    pattern,
    summary,
    truncated,
  };
}

/**
 * Mastra tool type.
 */
interface MastraTool {
  description: string;
  execute: (context: ToolContext<QueryFileTreeInput>) => Promise<QueryFileTreeToolResult>;
  id: string;
  inputSchema: typeof QueryFileTreeInputSchema;
}

/**
 * Creates a Mastra-compatible file tree query tool.
 *
 * @example
 * ```typescript
 * const tool = createQueryFileTreeTool({
 *   listFiles: async (path, options) => fileExplorer.query(path, options),
 * });
 * ```
 */
export function createQueryFileTreeTool(deps: FileTreeToolDependencies): MastraTool {
  return {
    description:
      'Query the imported file tree to list directories and search for files. ' +
      'Can filter by path and glob patterns. Shows file metadata and chunking status.',
    execute: async (context: ToolContext<QueryFileTreeInput>) => {
      try {
        return await runQueryFileTree(context.context, deps);
      } catch (error) {
        handleToolError(
          error,
          SAFE_FILE_TREE_ERRORS,
          FILE_TREE_ERROR_MESSAGES.queryFailed,
          deps.logger
        );
      }
    },
    id: QUERY_FILE_TREE_TOOL_ID,
    inputSchema: QueryFileTreeInputSchema,
  };
}

/**
 * Type for tools input (matching Mastra pattern).
 */
export type ToolsInput = Record<string, MastraTool>;

/**
 * Builds a tools object with the file tree tool added to a base set.
 */
export function buildToolsWithFileTree(
  deps: FileTreeToolDependencies,
  base: ToolsInput = {}
): ToolsInput {
  return {
    ...base,
    [QUERY_FILE_TREE_TOOL_ID]: createQueryFileTreeTool(deps),
  };
}

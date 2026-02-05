/**
 * Native tool executor for the Tool Playground.
 * Executes self-contained web tools that don't require database access.
 */
import {
  docSummaryExecute,
  docSummaryInputSchema,
  searchDocsExecute,
  searchDocsInputSchema,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils';

// ============================================================================
// Types
// ============================================================================

export type ToolExecutionResult<T = unknown> =
  | {
      success: true;
      result: T;
      durationMs: number;
    }
  | {
      success: false;
      error: string;
      durationMs: number;
    };

// ============================================================================
// Constants
// ============================================================================

const logger = createLogger('NativeToolExecutor');

/**
 * Set of tool IDs that can be executed natively (without database access).
 * These tools are self-contained, deterministic, and safe to run in the renderer.
 */
const EXECUTABLE_NATIVE_TOOLS = new Set(['web.searchDocs', 'web.docSummary']);

// ============================================================================
// Public API
// ============================================================================

/**
 * Checks if a tool ID is an executable native tool.
 * Native tools are self-contained and don't require database access.
 */
export function isExecutableNativeTool(toolId: string): boolean {
  return EXECUTABLE_NATIVE_TOOLS.has(toolId);
}

/**
 * Executes a native tool with the given input.
 * Returns a result object with success status, result/error, and duration.
 */
export async function executeNativeTool(
  toolId: string,
  input: unknown
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();

  try {
    if (!isExecutableNativeTool(toolId)) {
      return {
        success: false,
        error: `Tool "${toolId}" is not supported for native execution`,
        durationMs: Date.now() - startedAt,
      };
    }

    if (toolId === 'web.searchDocs') {
      const parsed = searchDocsInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          success: false,
          error: `Invalid input: ${parsed.error.message}`,
          durationMs: Date.now() - startedAt,
        };
      }
      const result = await searchDocsExecute(parsed.data);
      const durationMs = Date.now() - startedAt;
      logger.info('Native tool executed', { toolId, durationMs });
      return {
        success: true,
        result,
        durationMs,
      };
    }

    if (toolId === 'web.docSummary') {
      const parsed = docSummaryInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          success: false,
          error: `Invalid input: ${parsed.error.message}`,
          durationMs: Date.now() - startedAt,
        };
      }
      const result = await docSummaryExecute(parsed.data);
      const durationMs = Date.now() - startedAt;
      logger.info('Native tool executed', { toolId, durationMs });
      return {
        success: true,
        result,
        durationMs,
      };
    }

    // This should never be reached due to the isExecutableNativeTool check
    return {
      success: false,
      error: `Tool "${toolId}" is not supported for native execution`,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Native tool execution failed', {
      toolId,
      error: errorMessage,
    });
    return {
      success: false,
      error: errorMessage,
      durationMs: Date.now() - startedAt,
    };
  }
}

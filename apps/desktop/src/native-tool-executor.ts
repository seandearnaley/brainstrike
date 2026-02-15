/**
 * Native tool executor for the Tool Playground.
 * Executes self-contained native tools that can run in the main process.
 */
import { createLogger } from '@brainstrike/utils';
import type { z } from 'zod';

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

interface ToolDefinition {
  schema: z.ZodType<unknown>;
  execute: (input: unknown) => Promise<unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const logger = createLogger('NativeToolExecutor');

/**
 * Registry of executable native tools.
 * Intentionally empty: Brainstrike native tools currently require live workspace context
 * and execute through the assistant runtime (not the settings playground bridge).
 */
const NATIVE_TOOLS: Record<string, ToolDefinition> = {};

// ============================================================================
// Public API
// ============================================================================

/**
 * Checks if a tool ID is an executable native tool.
 * Native tools are self-contained and don't require database access.
 */
export function isExecutableNativeTool(toolId: string): boolean {
  return toolId in NATIVE_TOOLS;
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

  const tool = NATIVE_TOOLS[toolId];
  if (!tool) {
    return {
      success: false,
      error: `Tool "${toolId}" is not supported for native execution`,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid input: ${parsed.error.message}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const result = await tool.execute(parsed.data);
    const durationMs = Date.now() - startedAt;
    logger.info('Native tool executed', { toolId, durationMs });

    return {
      success: true,
      result,
      durationMs,
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

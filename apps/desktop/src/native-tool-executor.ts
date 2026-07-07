/**
 * Native tool executor for the Tool Playground.
 * Executes self-contained native tools that can run in the main process.
 */
import { createLogger } from '@brainstrike/utils/logger';
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
  execute: (input: unknown) => Promise<unknown>;
  schema: z.ZodType<unknown>;
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
      durationMs: Date.now() - startedAt,
      error: `Tool "${toolId}" is not supported for native execution`,
      success: false,
    };
  }

  try {
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      return {
        durationMs: Date.now() - startedAt,
        error: `Invalid input: ${parsed.error.message}`,
        success: false,
      };
    }

    const result = await tool.execute(parsed.data);
    const durationMs = Date.now() - startedAt;
    logger.info('Native tool executed', { durationMs, toolId });

    return {
      durationMs,
      result,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Native tool execution failed', {
      error: errorMessage,
      toolId,
    });
    return {
      durationMs: Date.now() - startedAt,
      error: errorMessage,
      success: false,
    };
  }
}

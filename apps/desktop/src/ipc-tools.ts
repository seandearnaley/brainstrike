/**
 * IPC Handlers for Tool Execution
 *
 * Provides the bridge between renderer process (Tool Playground) and
 * tool execution in the main process.
 */

import { isNativeTool } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/utils';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { callTool } from './mcp';
import { executeNativeTool, isExecutableNativeTool } from './native-tool-executor';

const logger = createLogger('IpcTools');

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const MAX_INPUT_DEPTH = 12;
const MAX_INPUT_SIZE = 1_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonValue(value: unknown, depth: number, visited: WeakSet<object>): value is JsonValue {
  if (depth >= MAX_INPUT_DEPTH) {
    return false;
  }

  if (value === null) {
    return true;
  }

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return true;
  }

  if (valueType === 'number') {
    return Number.isFinite(value);
  }

  if (valueType !== 'object') {
    return false;
  }

  const objectValue = value as object;
  if (visited.has(objectValue)) {
    return false;
  }
  visited.add(objectValue);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item, depth + 1, visited)) {
        return false;
      }
    }
    return true;
  }

  if (!isPlainObject(value)) {
    return false;
  }

  for (const entry of Object.values(value)) {
    if (!isJsonValue(entry, depth + 1, visited)) {
      return false;
    }
  }

  return true;
}

function sanitizeMcpInput(
  input: unknown
): { ok: true; value: Record<string, JsonValue> } | { ok: false; error: string } {
  let serializedSize = 0;
  try {
    const serialized = JSON.stringify(input);
    serializedSize = serialized.length;
  } catch {
    return {
      ok: false,
      error: 'Tool input must be JSON-serializable.',
    };
  }

  if (serializedSize > MAX_INPUT_SIZE) {
    return {
      ok: false,
      error: `Tool input exceeds ${MAX_INPUT_SIZE} bytes.`,
    };
  }

  if (!isPlainObject(input)) {
    return {
      ok: false,
      error: 'Tool input must be a JSON object.',
    };
  }

  const visited = new WeakSet<object>();
  if (!isJsonValue(input, 0, visited)) {
    return {
      ok: false,
      error: 'Tool input must be JSON-serializable (no functions, symbols, or non-finite numbers).',
    };
  }

  return { ok: true, value: input as Record<string, JsonValue> };
}

/**
 * Result of executing a tool via IPC.
 */
type ToolExecutionResult<T = unknown> =
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

/**
 * Register IPC handlers for tool execution.
 */
export function registerToolsIpcHandlers(): void {
  logger.debug('Registering tools IPC handlers');

  ipcMain.handle(
    'tools:execute',
    async (
      _event: IpcMainInvokeEvent,
      toolId: unknown,
      input: unknown
    ): Promise<ToolExecutionResult> => {
      const startTime = performance.now();
      const normalizedToolId = typeof toolId === 'string' ? toolId.trim() : '';
      if (!normalizedToolId) {
        return {
          success: false,
          error: 'Invalid tool ID.',
          durationMs: Math.round(performance.now() - startTime),
        };
      }
      logger.debug('Executing tool', { toolId: normalizedToolId });

      try {
        // Check if it's an executable native tool (currently none are exposed in playground)
        if (isExecutableNativeTool(normalizedToolId)) {
          const sanitizedInput = sanitizeMcpInput(input);
          if (!sanitizedInput.ok) {
            logger.warn('Rejected native tool input', {
              toolId: normalizedToolId,
              error: sanitizedInput.error,
            });
            return {
              success: false,
              error: sanitizedInput.error,
              durationMs: Math.round(performance.now() - startTime),
            };
          }
          return await executeNativeTool(normalizedToolId, sanitizedInput.value);
        }

        // Check if it's a native tool that requires workspace/database context (brainstrike.*)
        // These can't be executed in the playground - they need the full runtime
        if (isNativeTool(normalizedToolId)) {
          return {
            success: false,
            error: `Tool "${normalizedToolId}" requires database access and cannot be tested in the playground. This tool works during actual assistant conversations.`,
            durationMs: Math.round(performance.now() - startTime),
          };
        }

        // Try MCP tool execution (for tools from MCP servers)
        const sanitizedInput = sanitizeMcpInput(input);
        if (!sanitizedInput.ok) {
          logger.warn('Rejected tool input', {
            toolId: normalizedToolId,
            error: sanitizedInput.error,
          });
          return {
            success: false,
            error: sanitizedInput.error,
            durationMs: Math.round(performance.now() - startTime),
          };
        }

        const result = await callTool(normalizedToolId, sanitizedInput.value);
        const durationMs = Math.round(performance.now() - startTime);
        logger.info('Tool executed', {
          toolId: normalizedToolId,
          durationMs,
          source: 'mcp',
        });

        return {
          success: true,
          result,
          durationMs,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
        logger.error('Tool execution failed', { toolId: normalizedToolId, error: errorMessage });

        return {
          success: false,
          error: errorMessage,
          durationMs: Math.round(performance.now() - startTime),
        };
      }
    }
  );
}

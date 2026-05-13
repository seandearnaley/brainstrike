/**
 * IPC Handlers for Tool Execution
 *
 * Provides the bridge between renderer process (Tool Playground) and
 * tool execution in the main process.
 */

import type { RuntimeData } from '@brainstrike/agent';
import { isNativeTool } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/utils/logger';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { buildDesktopAssistantTools } from './assistant-server/assistant-tools';
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

function sanitizeRuntimeData(input: unknown): Partial<RuntimeData> | undefined {
  if (!isPlainObject(input)) {
    return;
  }

  const runtimeData: Partial<RuntimeData> = {};

  if (typeof input['workspaceRootPath'] === 'string') {
    runtimeData.workspaceRootPath = input['workspaceRootPath'];
  }
  if (typeof input['selectionFolderId'] === 'string') {
    runtimeData.selectionFolderId = input['selectionFolderId'];
  }
  if (Array.isArray(input['selectionFilePaths'])) {
    const selectionFilePaths = input['selectionFilePaths'].filter(
      (value): value is string => typeof value === 'string'
    );
    if (selectionFilePaths.length > 0) {
      runtimeData.selectionFilePaths = selectionFilePaths;
    }
  }
  if (typeof input['workspaceIndexEmbeddingSetId'] === 'string') {
    runtimeData.workspaceIndexEmbeddingSetId = input['workspaceIndexEmbeddingSetId'];
  }
  if (typeof input['workspaceIndexingEnabled'] === 'boolean') {
    runtimeData.workspaceIndexingEnabled = input['workspaceIndexingEnabled'];
  }
  if (typeof input['workspaceIndexingMode'] === 'string') {
    runtimeData.workspaceIndexingMode = input['workspaceIndexingMode'];
  }
  if (typeof input['workspaceIndexingPaused'] === 'boolean') {
    runtimeData.workspaceIndexingPaused = input['workspaceIndexingPaused'];
  }

  return Object.keys(runtimeData).length > 0 ? runtimeData : undefined;
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

function buildDuration(startTime: number): number {
  return Math.round(performance.now() - startTime);
}

function buildFailureResult(startTime: number, error: string): ToolExecutionResult {
  return {
    success: false,
    error,
    durationMs: buildDuration(startTime),
  };
}

function sanitizeToolInput(
  startTime: number,
  toolId: string,
  input: unknown,
  logScope: 'assistant-runtime' | 'mcp' | 'native'
): { ok: true; value: Record<string, JsonValue> } | { ok: false; result: ToolExecutionResult } {
  const sanitizedInput = sanitizeMcpInput(input);
  if (sanitizedInput.ok) {
    return sanitizedInput;
  }

  logger.warn(`Rejected ${logScope} tool input`, {
    toolId,
    error: sanitizedInput.error,
  });
  return {
    ok: false,
    result: buildFailureResult(startTime, sanitizedInput.error),
  };
}

async function tryExecuteAssistantRuntimeTool(
  startTime: number,
  toolId: string,
  input: unknown,
  runtimeData: Partial<RuntimeData> | undefined
): Promise<ToolExecutionResult | null> {
  const assistantTool = buildDesktopAssistantTools(runtimeData)[toolId];
  if (!assistantTool?.execute) {
    return null;
  }

  const sanitizedInput = sanitizeToolInput(startTime, toolId, input, 'assistant-runtime');
  if (!sanitizedInput.ok) {
    return sanitizedInput.result;
  }

  const result = await assistantTool.execute(sanitizedInput.value, undefined);
  return {
    success: true,
    result,
    durationMs: buildDuration(startTime),
  };
}

async function executeMcpTool(
  startTime: number,
  toolId: string,
  input: unknown
): Promise<ToolExecutionResult> {
  const sanitizedInput = sanitizeToolInput(startTime, toolId, input, 'mcp');
  if (!sanitizedInput.ok) {
    return sanitizedInput.result;
  }

  const result = await callTool(toolId, sanitizedInput.value);
  const durationMs = buildDuration(startTime);
  logger.info('Tool executed', {
    toolId,
    durationMs,
    source: 'mcp',
  });

  return {
    success: true,
    result,
    durationMs,
  };
}

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
      input: unknown,
      runtimeDataInput?: unknown
    ): Promise<ToolExecutionResult> => {
      const startTime = performance.now();
      const normalizedToolId = typeof toolId === 'string' ? toolId.trim() : '';
      if (!normalizedToolId) {
        return buildFailureResult(startTime, 'Invalid tool ID.');
      }
      logger.debug('Executing tool', { toolId: normalizedToolId });
      const runtimeData = sanitizeRuntimeData(runtimeDataInput);

      try {
        if (isExecutableNativeTool(normalizedToolId)) {
          const sanitizedInput = sanitizeToolInput(startTime, normalizedToolId, input, 'native');
          if (!sanitizedInput.ok) {
            return sanitizedInput.result;
          }
          return await executeNativeTool(normalizedToolId, sanitizedInput.value);
        }

        if (isNativeTool(normalizedToolId)) {
          const assistantRuntimeResult = await tryExecuteAssistantRuntimeTool(
            startTime,
            normalizedToolId,
            input,
            runtimeData
          );
          if (assistantRuntimeResult) {
            return assistantRuntimeResult;
          }

          return buildFailureResult(
            startTime,
            `Tool "${normalizedToolId}" requires database access and cannot be tested in the playground. This tool works during actual assistant conversations.`
          );
        }

        return await executeMcpTool(startTime, normalizedToolId, input);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
        logger.error('Tool execution failed', { toolId: normalizedToolId, error: errorMessage });
        return buildFailureResult(startTime, errorMessage);
      }
    }
  );
}

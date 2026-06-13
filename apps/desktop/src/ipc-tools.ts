/**
 * IPC Handlers for Tool Execution
 *
 * Provides the bridge between renderer process (Tool Playground) and
 * tool execution in the main process.
 */

import type { RuntimeData } from '@brainstrike/agent';
import { isNativeTool, NATIVE_TOOL_DEFAULTS } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/utils/logger';
import { ipcMain } from 'electron';
import { buildDesktopAssistantTools } from './assistant-server/assistant-tools';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { callTool } from './mcp';
import { executeNativeTool, isExecutableNativeTool } from './native-tool-executor';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const logger = createLogger('IpcTools');

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type RuntimeWorkspaceContext = NonNullable<RuntimeData['workspaceContext']>;
type RuntimeWorkspaceContextFile = NonNullable<RuntimeWorkspaceContext['files']>[number];
type RuntimeWorkspaceContextRange = NonNullable<RuntimeWorkspaceContextFile['ranges']>[number];
type RuntimeAgentLoop = NonNullable<RuntimeData['agentLoop']>;

const MAX_INPUT_DEPTH = 12;
const MAX_INPUT_SIZE = 1_000_000;
// Keep this boundary allowlist in sync with BackgroundIndexingMode in
// @brainstrike/preferences when additional workspace indexing modes are added.
const ALLOWED_WORKSPACE_INDEXING_MODES = new Set(['root-folder-cache']);
const ALLOWED_NATIVE_TOOL_IDS = new Set(Object.keys(NATIVE_TOOL_DEFAULTS));

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

function isFiniteTokenValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readOptionalTokenValue(
  source: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = source[key];
  if (value === undefined) {
    return;
  }
  if (value === null) {
    return null;
  }
  return isFiniteTokenValue(value) ? value : undefined;
}

function readOptionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalPositiveInteger(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sanitizeWorkspaceContextRange(input: unknown): RuntimeWorkspaceContextRange | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const startLine = input['startLine'];
  const endLine = input['endLine'];
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return null;
  }

  const range: RuntimeWorkspaceContextRange = { startLine, endLine };
  const approxTokens = readOptionalTokenValue(input, 'approxTokens');
  if (approxTokens !== undefined) {
    range.approxTokens = approxTokens;
  }
  const isActive = readOptionalBoolean(input, 'isActive');
  if (isActive !== undefined) {
    range.isActive = isActive;
  }
  return range;
}

function sanitizeWorkspaceContextFile(input: unknown): RuntimeWorkspaceContextFile | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const pathValue = input['path'];
  if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
    return null;
  }

  const file: RuntimeWorkspaceContextFile = { path: pathValue };
  // Multi-root (Phase 6): optional root identity for citation disambiguation.
  const rootIdValue = input['rootId'];
  if (typeof rootIdValue === 'string' && rootIdValue.length > 0) {
    file.rootId = rootIdValue;
  }
  const rootDisplayNameValue = input['rootDisplayName'];
  if (typeof rootDisplayNameValue === 'string' && rootDisplayNameValue.length > 0) {
    file.rootDisplayName = rootDisplayNameValue;
  }
  const approxTokens = readOptionalTokenValue(input, 'approxTokens');
  if (approxTokens !== undefined) {
    file.approxTokens = approxTokens;
  }
  const outputApproxTokens = readOptionalTokenValue(input, 'outputApproxTokens');
  if (outputApproxTokens !== undefined) {
    file.outputApproxTokens = outputApproxTokens;
  }
  const rangesValue = input['ranges'];
  if (rangesValue !== undefined) {
    if (!Array.isArray(rangesValue)) {
      return null;
    }
    const ranges: RuntimeWorkspaceContextRange[] = [];
    for (const rangeValue of rangesValue) {
      const range = sanitizeWorkspaceContextRange(rangeValue);
      if (!range) {
        return null;
      }
      ranges.push(range);
    }
    file.ranges = ranges;
  }
  return file;
}

function sanitizeWorkspaceContext(input: unknown): RuntimeWorkspaceContext | undefined {
  if (!isPlainObject(input)) {
    return;
  }

  const workspaceContext: RuntimeWorkspaceContext = {};
  const filesValue = input['files'];
  if (filesValue !== undefined) {
    if (!Array.isArray(filesValue)) {
      return;
    }
    const files: RuntimeWorkspaceContextFile[] = [];
    for (const fileValue of filesValue) {
      const file = sanitizeWorkspaceContextFile(fileValue);
      if (!file) {
        return;
      }
      files.push(file);
    }
    workspaceContext.files = files;
  }

  const includeProjectTree = readOptionalBoolean(input, 'includeProjectTree');
  if (includeProjectTree !== undefined) {
    workspaceContext.includeProjectTree = includeProjectTree;
  }
  const projectTreeApproxTokens = readOptionalTokenValue(input, 'projectTreeApproxTokens');
  if (projectTreeApproxTokens !== undefined) {
    workspaceContext.projectTreeApproxTokens = projectTreeApproxTokens;
  }
  const projectTreeTokenCountLoading = readOptionalBoolean(input, 'projectTreeTokenCountLoading');
  if (projectTreeTokenCountLoading !== undefined) {
    workspaceContext.projectTreeTokenCountLoading = projectTreeTokenCountLoading;
  }
  const selectedOutputApproxTokens = readOptionalTokenValue(input, 'selectedOutputApproxTokens');
  if (selectedOutputApproxTokens !== undefined) {
    workspaceContext.selectedOutputApproxTokens = selectedOutputApproxTokens;
  }
  const selectedSourceApproxTokens = readOptionalTokenValue(input, 'selectedSourceApproxTokens');
  if (selectedSourceApproxTokens !== undefined) {
    workspaceContext.selectedSourceApproxTokens = selectedSourceApproxTokens;
  }
  const tokenBudget = input['tokenBudget'];
  if (tokenBudget !== undefined) {
    if (!isFiniteTokenValue(tokenBudget)) {
      return;
    }
    workspaceContext.tokenBudget = tokenBudget;
  }
  const useTapestryRanges = readOptionalBoolean(input, 'useTapestryRanges');
  if (useTapestryRanges !== undefined) {
    workspaceContext.useTapestryRanges = useTapestryRanges;
  }

  return workspaceContext;
}

function sanitizeAgentLoop(input: unknown): RuntimeAgentLoop | undefined {
  if (!isPlainObject(input)) {
    return;
  }

  const agentLoop: RuntimeAgentLoop = {};
  const maxSteps = readOptionalPositiveInteger(input, 'maxSteps');
  if (maxSteps !== undefined) {
    agentLoop.maxSteps = maxSteps;
  }
  const inputTokenLimit = readOptionalPositiveInteger(input, 'inputTokenLimit');
  if (inputTokenLimit !== undefined) {
    agentLoop.inputTokenLimit = inputTokenLimit;
  }

  return Object.keys(agentLoop).length > 0 ? agentLoop : undefined;
}

function sanitizeWorkspaceIndexingMode(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const workspaceIndexingMode = value.trim();
  if (ALLOWED_WORKSPACE_INDEXING_MODES.has(workspaceIndexingMode)) {
    return workspaceIndexingMode;
  }
  logger.warn('Rejected invalid runtime workspaceIndexingMode.', { workspaceIndexingMode });
  return;
}

function sanitizeEnabledNativeToolIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }

  const rejectedNativeToolIds: string[] = [];
  const enabledNativeToolIds: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const toolId = item.trim();
    if (toolId.length === 0) {
      continue;
    }
    if (!ALLOWED_NATIVE_TOOL_IDS.has(toolId)) {
      rejectedNativeToolIds.push(toolId);
      continue;
    }
    enabledNativeToolIds.push(toolId);
  }
  if (rejectedNativeToolIds.length > 0) {
    logger.warn('Rejected unknown enabled native tool ids at IPC boundary.', {
      toolIds: rejectedNativeToolIds,
    });
  }
  return enabledNativeToolIds;
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
  const workspaceIndexingMode = sanitizeWorkspaceIndexingMode(input['workspaceIndexingMode']);
  if (workspaceIndexingMode) {
    runtimeData.workspaceIndexingMode = workspaceIndexingMode;
  }
  if (typeof input['workspaceIndexingPaused'] === 'boolean') {
    runtimeData.workspaceIndexingPaused = input['workspaceIndexingPaused'];
  }
  if (input['workspaceContext'] !== undefined) {
    const workspaceContext = sanitizeWorkspaceContext(input['workspaceContext']);
    if (workspaceContext) {
      runtimeData.workspaceContext = workspaceContext;
    } else {
      logger.warn('Rejected invalid runtime workspaceContext metadata.');
    }
  }
  const enabledNativeToolIds = sanitizeEnabledNativeToolIds(input['enabledNativeToolIds']);
  if (enabledNativeToolIds) {
    runtimeData.enabledNativeToolIds = enabledNativeToolIds;
  }
  if (input['agentLoop'] !== undefined) {
    const agentLoop = sanitizeAgentLoop(input['agentLoop']);
    if (agentLoop) {
      runtimeData.agentLoop = agentLoop;
    } else {
      logger.warn('Rejected invalid runtime agentLoop metadata.');
    }
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

interface ToolsIpcDependencies {
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
}

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
  runtimeData: Partial<RuntimeData> | undefined,
  dependencies: ToolsIpcDependencies
): Promise<ToolExecutionResult | null> {
  const assistantTool = buildDesktopAssistantTools(runtimeData, {
    embeddingHostManager: dependencies.embeddingHostManager,
  })[toolId];
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
export function registerToolsIpcHandlers(dependencies: ToolsIpcDependencies = {}): () => void {
  logger.debug('Registering tools IPC handlers');
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'tools',
    DESKTOP_PRELOAD_IPC_CHANNELS.tools.execute,
    async (
      _event,
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
            runtimeData,
            dependencies
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

  return () => {
    registry.unregisterAll();
  };
}

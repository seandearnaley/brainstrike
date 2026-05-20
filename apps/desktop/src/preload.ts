// Electron preload script - must use CommonJS syntax
const { contextBridge, ipcRenderer, clipboard } = require('electron');
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
const ASSISTANT_ROOT_TREE_SELECTION_EVENT = 'assistant:root-tree-selection-update';
const ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT = 'assistant:preview-context-selection-update';
const ASSISTANT_WORKSPACE_CONTEXT_SELECTION_EVENT = 'assistant:workspace-context-selection-update';
const ASSISTANT_WORKSPACE_CONTEXT_TAPESTRY_EVENT = 'assistant:workspace-context-tapestry-update';
const MCP_TOOLS_UPDATED_EVENT = 'mcp:tools:updated' as const;
const DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL = 'db:managed-cache:apply-batch' as const;
const DB_SCHEDULER_SNAPSHOT_CHANNEL = 'db:scheduler:snapshot' as const;
const LOGGING_GET_PREFERENCES_CHANNEL = 'logging:get-preferences' as const;
const LOGGING_SET_PREFERENCES_CHANNEL = 'logging:set-preferences' as const;
const LOGGING_SELECT_DESTINATION_CHANNEL = 'logging:select-destination' as const;
const LOGGING_OPEN_DESTINATION_CHANNEL = 'logging:open-destination' as const;
const LOGGING_GET_BUFFERED_LOGS_CHANNEL = 'logging:get-buffered-logs' as const;
const LOGGING_INGEST_BUFFERED_RECORD_CHANNEL = 'logging:ingest-buffered-record' as const;
const LOGGING_PREFERENCES_UPDATED_EVENT = 'logging:preferences-updated' as const;
const DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL = 'desktop-diagnostics:get-snapshot' as const;

import type { ApplyManagedCacheBatchArgs } from '@brainstrike/db';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
  DatabaseWorkOptions,
} from '@brainstrike/types';
import type {
  LayoutLoadResult,
  LayoutPersistenceResult,
  PanelPersistenceState,
} from '@brainstrike/ui';
import type { LogRecord } from '@brainstrike/utils/logger';
import type { LoggingPreferences } from '@brainstrike/utils/logging-preferences';
import type { DesktopPlatformDiagnosticsSnapshot } from './desktop-platform-diagnostics';
import type {
  EmbeddingHostBackfillRequest,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
} from './embedding-host-shared';
import type { LoggingSettingsPayload } from './logging-shared';

// Sandboxed preloads cannot depend on additional local modules at runtime.
// Keep all IPC contracts used here self-contained in this file.
const FILE_READ_ERROR_CODE_TOO_LARGE = 'TOO_LARGE' as const;
const EMBEDDING_HOST_STATUS_EVENT = 'embedding-host:status' as const;
const EMBEDDING_HOST_COMMAND_EVENT = 'embedding-host:command' as const;
const EMBEDDING_HOST_REPORT_STATUS_CHANNEL = 'embedding-host:report-status' as const;
const EMBEDDING_HOST_ENSURE_STARTED_CHANNEL = 'embedding-host:ensure-started' as const;
const EMBEDDING_HOST_STOP_CHANNEL = 'embedding-host:stop' as const;
const EMBEDDING_HOST_RESET_CHANNEL = 'embedding-host:reset' as const;
const EMBEDDING_HOST_GET_STATUS_CHANNEL = 'embedding-host:get-status' as const;
const EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL = 'embedding-host:enqueue-backfill' as const;
const EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT = 'embedding-host:backfill-progress' as const;
const EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT =
  'embedding-host:query-embedding-request' as const;
const EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL =
  'embedding-host:report-query-embedding-response' as const;
const EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL =
  'embedding-host:get-backfills-in-flight' as const;
const EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL = 'embedding-host:cancel-all-backfills' as const;
const EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL = 'embedding-host:cancel-backfill' as const;
const CHUNKING_HOST_STATUS_EVENT = 'chunking-host:status' as const;
const CHUNKING_HOST_REQUEST_EVENT = 'chunking-host:request' as const;
const CHUNKING_HOST_PROGRESS_EVENT = 'chunking-host:progress' as const;
const CHUNKING_HOST_REPORT_STATUS_CHANNEL = 'chunking-host:report-status' as const;
const CHUNKING_HOST_REPORT_RESPONSE_CHANNEL = 'chunking-host:report-response' as const;
const CHUNKING_HOST_ENSURE_STARTED_CHANNEL = 'chunking-host:ensure-started' as const;
const CHUNKING_HOST_STOP_CHANNEL = 'chunking-host:stop' as const;
const CHUNKING_HOST_RESET_CHANNEL = 'chunking-host:reset' as const;
const CHUNKING_HOST_GET_STATUS_CHANNEL = 'chunking-host:get-status' as const;
const CHUNKING_HOST_CHUNK_FILE_CHANNEL = 'chunking-host:chunk-file' as const;
const CHUNKING_HOST_CHUNK_BATCH_CHANNEL = 'chunking-host:chunk-batch' as const;
const PARSER_HOST_PARSE_CHANNEL = 'parser-host:parse' as const;
const AGENT_CHAT_CHANNEL = 'agent:chat' as const;
const ASSISTANT_GET_URL_CHANNEL = 'assistant:get-url' as const;
const MCP_CONFIG_GET_CHANNEL = 'mcp:config:get' as const;
const MCP_CONFIG_WATCH_CHANNEL = 'mcp:config:watch' as const;
const MCP_CONFIG_UNWATCH_CHANNEL = 'mcp:config:unwatch' as const;
const MCP_CONFIG_GET_PATH_CHANNEL = 'mcp:config:getPath' as const;
const MCP_CONFIG_SET_PATH_CHANNEL = 'mcp:config:setPath' as const;
const MCP_CONFIG_READ_TEXT_CHANNEL = 'mcp:config:readText' as const;
const MCP_CONFIG_WRITE_TEXT_CHANNEL = 'mcp:config:writeText' as const;
const MCP_CONFIG_SELECT_PATH_CHANNEL = 'mcp:config:selectPath' as const;
const MCP_CONFIG_CREATE_SAMPLE_CHANNEL = 'mcp:config:createSample' as const;
const MCP_TOOLS_LIST_CHANNEL = 'mcp:tools:list' as const;
const MCP_TOOLS_ENABLE_CHANNEL = 'mcp:tools:enable' as const;
const MCP_TOOLS_DISABLE_CHANNEL = 'mcp:tools:disable' as const;
const MCP_TOOLS_ENABLE_SERVER_CHANNEL = 'mcp:tools:enableServer' as const;
const MCP_TOOLS_DISABLE_SERVER_CHANNEL = 'mcp:tools:disableServer' as const;
const MCP_TOOLS_RESET_CHANNEL = 'mcp:tools:reset' as const;
const MCP_TOOLS_GET_STATS_CHANNEL = 'mcp:tools:getStats' as const;
const TOOLS_EXECUTE_CHANNEL = 'tools:execute' as const;
const LLM_HOST_STATUS_EVENT = 'llm-host:status' as const;
const LLM_HOST_REQUEST_EVENT = 'llm-host:request' as const;
const LLM_HOST_PROGRESS_EVENT = 'llm-host:progress' as const;
const LLM_HOST_REPORT_STATUS_CHANNEL = 'llm-host:report-status' as const;
const LLM_HOST_REPORT_PROGRESS_CHANNEL = 'llm-host:report-progress' as const;
const LLM_HOST_REPORT_RESPONSE_CHANNEL = 'llm-host:report-response' as const;
const LLM_HOST_ENSURE_STARTED_CHANNEL = 'llm-host:ensure-started' as const;
const LLM_HOST_STOP_CHANNEL = 'llm-host:stop' as const;
const LLM_HOST_RESET_CHANNEL = 'llm-host:reset' as const;
const LLM_HOST_GET_STATUS_CHANNEL = 'llm-host:get-status' as const;
const LLM_HOST_CANCEL_CHANNEL = 'llm-host:cancel' as const;
const LLM_HOST_WARMUP_CHANNEL = 'llm-host:warmup' as const;
const LLM_HOST_GENERATE_CHANNEL = 'llm-host:generate' as const;
const APP_LIFECYCLE_NOTE_RELOAD_INTENT_CHANNEL = 'app:lifecycle:note-reload-intent' as const;
const DESKTOP_TEST_MODE =
  process.argv.includes('--test-mode') || process.env['ELECTRON_IS_E2E_TEST'] === 'true';
const EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED =
  DESKTOP_TEST_MODE && process.env['BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES'] === '1';
const EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE =
  'External local runtime probing is disabled for deterministic desktop E2E.';

if (DESKTOP_TEST_MODE) {
  contextBridge.exposeInMainWorld('__brainstrike_e2e_expose_file_explorer_store__', true);
}

interface DbLiveUpdatePayload {
  id: number;
  results: unknown;
}

type DbLiveUpdateCallback = (payload: DbLiveUpdatePayload) => void;

const dbLiveUpdateCallbacks = new Set<DbLiveUpdateCallback>();
let dbLiveUpdateIpcListener: ((_event: unknown, payload: DbLiveUpdatePayload) => void) | null =
  null;

function subscribeToDbLiveUpdates(callback: DbLiveUpdateCallback): () => void {
  dbLiveUpdateCallbacks.add(callback);

  if (!dbLiveUpdateIpcListener) {
    dbLiveUpdateIpcListener = (_event: unknown, payload: DbLiveUpdatePayload) => {
      for (const subscriber of Array.from(dbLiveUpdateCallbacks)) {
        try {
          subscriber(payload);
        } catch (error) {
          ipcRenderer.send(LOGGING_INGEST_BUFFERED_RECORD_CHANNEL, {
            level: 'error' as LogRecord['level'],
            timestamp: Date.now(),
            args: ['[preload] db live-query subscriber threw:', error],
            bindings: { runtime: 'electron-renderer' },
            message: 'DB live-query subscriber threw',
            scope: 'Preload',
          } satisfies LogRecord);
        }
      }
    };
    ipcRenderer.on('db:live-query:update', dbLiveUpdateIpcListener);
  }

  return () => {
    dbLiveUpdateCallbacks.delete(callback);
    if (dbLiveUpdateCallbacks.size === 0 && dbLiveUpdateIpcListener) {
      ipcRenderer.removeListener('db:live-query:update', dbLiveUpdateIpcListener);
      dbLiveUpdateIpcListener = null;
    }
  };
}

function disabledPreloadBridges(): Set<string> {
  if (!DESKTOP_TEST_MODE) {
    return new Set();
  }
  return new Set(
    (process.env['BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES'] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
}

const disabledBridgeNames = disabledPreloadBridges();

function shouldExposeBridge(name: string): boolean {
  return !disabledBridgeNames.has(name);
}

function createDisabledLocalRuntimeAvailability() {
  return {
    state: 'unavailable' as const,
    checkedAt: Date.now(),
    message: EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE,
  };
}

function createDisabledLocalRuntimeCatalog(runtimeId: string) {
  return {
    state: 'failed' as const,
    runtime: runtimeId,
    checkedAt: Date.now(),
    availability: createDisabledLocalRuntimeAvailability(),
    message: EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE,
  };
}

type EmbeddingHostLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
type ChunkingHostLifecycleState = EmbeddingHostLifecycleState;
type LlmHostLifecycleState = EmbeddingHostLifecycleState;

interface EmbeddingHostStatus {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly runtimeKind: 'embedding-host';
  readonly state: EmbeddingHostLifecycleState;
}

interface EmbeddingHostCommand {
  readonly channel: 'control';
  readonly payload: {
    readonly action: 'reset' | 'stop';
  };
  readonly requestId: string;
  readonly runtimeId: string;
  readonly type: 'request';
}

interface EmbeddingHostBackfillProgress {
  readonly current: number;
  readonly embeddingSetId: string;
  readonly message?: string;
  readonly requestId: string;
  readonly stage: string;
  readonly total: number;
}

interface EmbeddingHostBackfillInfo {
  readonly embeddingSetId: string;
  readonly progress: { current: number; total: number } | null;
  readonly requestId: string;
}

interface ChunkingHostStatus {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly runtimeKind: 'chunking-host';
  readonly state: ChunkingHostLifecycleState;
}

interface ChunkingHostFilePayload {
  readonly content: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly fileRecordId: string;
}

interface ChunkingHostChunkFileRequest extends ChunkingHostFilePayload {
  readonly kind: 'chunk-file';
  readonly options: unknown;
  readonly requestId: string;
}

interface ChunkingHostChunkBatchRequest {
  readonly files: readonly ChunkingHostFilePayload[];
  readonly kind: 'chunk-batch';
  readonly options: unknown;
  readonly requestId: string;
}

interface ChunkingHostRequest {
  readonly channel: 'chunk';
  readonly payload: ChunkingHostChunkBatchRequest | ChunkingHostChunkFileRequest;
  readonly requestId: string;
  readonly runtimeId: string;
  readonly type: 'request';
}

interface ChunkingHostProgressEvent {
  readonly channel: 'chunk' | 'chunk-file-complete' | 'chunk-file-error';
  readonly payload:
    | {
        readonly chunksCreated: number;
        readonly currentIndex?: number;
        readonly fileRecordId: string;
        readonly totalFiles?: number;
      }
    | {
        readonly fileRecordId: string;
        readonly result: unknown;
      }
    | {
        readonly errorMessage: string;
        readonly fileRecordId: string;
      };
  readonly requestId: string;
  readonly runtimeId: string;
  readonly type: 'progress';
}

interface ChunkingHostResponseReport {
  readonly channel:
    | 'chunk'
    | 'chunk-batch-complete'
    | 'chunk-error'
    | 'chunk-file-complete'
    | 'chunk-file-error'
    | 'chunk-result';
  readonly payload: Record<string, unknown>;
  readonly requestId: string;
  readonly runtimeId: string;
  readonly type: 'error' | 'progress' | 'result';
}

interface LlmHostStatus {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly runtimeKind: 'llm-host';
  readonly state: LlmHostLifecycleState;
}

interface LlmHostRequest {
  readonly channel: 'llm';
  readonly payload: {
    readonly clientRequestId?: string;
    readonly kind: 'generate' | 'warmup';
    readonly modelId: string;
    readonly messages?: unknown[];
    readonly options?: unknown;
  };
  readonly requestId: string;
  readonly runtimeId: string;
  readonly type: 'request';
}

interface LlmHostResponseReport {
  readonly channel: 'llm-error' | 'llm-progress' | 'llm-result';
  readonly payload: Record<string, unknown>;
  readonly requestId: string;
  readonly runtimeId: string;
  readonly type: 'error' | 'progress' | 'result';
}

// NOTE: preload is sandboxed CJS and can't import from workspace TS files,
// so these constants are intentionally duplicated from
// `apps/desktop/src/file-read-errors.ts`. Keep in sync.
const FILE_READ_ERROR_CODE_NOT_FOUND = 'NOT_FOUND' as const;

interface FileReadErrorPayload {
  code: typeof FILE_READ_ERROR_CODE_TOO_LARGE | typeof FILE_READ_ERROR_CODE_NOT_FOUND;
  message: string;
}

function isFileReadErrorPayload(value: unknown): value is FileReadErrorPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as {
    code?: unknown;
    message?: unknown;
  };
  return (
    (candidate.code === FILE_READ_ERROR_CODE_TOO_LARGE ||
      candidate.code === FILE_READ_ERROR_CODE_NOT_FOUND) &&
    typeof candidate.message === 'string'
  );
}

function unwrapFileReadResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (isFileReadErrorPayload(result)) {
    const error = new Error(result.message) as Error & { code?: string };
    error.code = result.code;
    throw error;
  }

  throw new Error('Invalid response from file read IPC handler');
}

// Expose storage APIs to renderer
if (shouldExposeBridge('electronAPI')) {
  contextBridge.exposeInMainWorld('electronAPI', {
    storage: {
      getItem: (key: string) => ipcRenderer.invoke('storage:getItem', key),
      setItem: (key: string, value: string) => ipcRenderer.invoke('storage:setItem', key, value),
      removeItem: (key: string) => ipcRenderer.invoke('storage:removeItem', key),
      clear: () => ipcRenderer.invoke('storage:clear'),
      getAllKeys: () => ipcRenderer.invoke('storage:getAllKeys'),
    },
    fileSystem: {
      requestDirectoryAccess: () => ipcRenderer.invoke('fs:requestDirectoryAccess'),
      readDirectory: (handle: DirectoryHandle) => ipcRenderer.invoke('fs:readDirectory', handle),
      readFile: async (handle: FileHandle) => {
        const result = await ipcRenderer.invoke('fs:readFile', handle);
        return unwrapFileReadResult(result);
      },
      readFileByPath: async (absolutePath: string) => {
        const result = await ipcRenderer.invoke('fs:readFileByPath', absolutePath);
        return unwrapFileReadResult(result);
      },
      exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
      restoreLastFolder: () => ipcRenderer.invoke('fs:restoreLastFolder'),
      saveLastFolder: (folderPath: string) => ipcRenderer.invoke('fs:saveLastFolder', folderPath),
    },
    // Panel layout persistence
    saveLayout: (state: PanelPersistenceState): Promise<LayoutPersistenceResult> =>
      ipcRenderer.invoke('layout:save', state),
    loadLayout: (): Promise<LayoutLoadResult> => ipcRenderer.invoke('layout:load'),
    // Database operations
    db: {
      applyManagedCacheBatch: (
        payload: ApplyManagedCacheBatchArgs,
        options?: DatabaseWorkOptions
      ) => ipcRenderer.invoke(DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL, payload, options),
      ping: () => ipcRenderer.invoke('db:ping'),
      diagnostics: () => ipcRenderer.invoke('db:diagnostics'),
      schedulerSnapshot: () => ipcRenderer.invoke(DB_SCHEDULER_SNAPSHOT_CHANNEL),
      query: (sql: string, params?: unknown[], options?: DatabaseWorkOptions) =>
        ipcRenderer.invoke('db:query', sql, params, options),
      exec: (sql: string, params?: unknown[], options?: DatabaseWorkOptions) =>
        ipcRenderer.invoke('db:exec', sql, params, options),
      test: () => ipcRenderer.invoke('db:test'),
      clearAll: (confirmationToken?: string) =>
        ipcRenderer.invoke('db:clearAll', confirmationToken),
      resetLocal: () => ipcRenderer.invoke('db:resetLocal'),
    },
    dbLive: {
      start: (
        options: {
          query: string;
          params?: readonly unknown[];
          key?: string;
          mode?: 'query' | 'incremental';
          offset?: number;
          limit?: number;
        },
        workOptions?: DatabaseWorkOptions
      ) => ipcRenderer.invoke('db:live-query:start', options, workOptions),
      stop: (id: number) => ipcRenderer.invoke('db:live-query:stop', id),
      refresh: (
        payload: { id: number; offset?: number; limit?: number },
        options?: DatabaseWorkOptions
      ) => ipcRenderer.invoke('db:live-query:refresh', payload, options),
      onUpdate: (callback: (payload: { id: number; results: unknown }) => void) =>
        subscribeToDbLiveUpdates(callback),
    },
    // Database path (legacy - kept for compatibility)
    getUserDataPath: () => ipcRenderer.invoke('db:getUserDataPath'),
  });
}

// Secure Secrets API
contextBridge.exposeInMainWorld('secrets', {
  saveKey: (provider: string, value: string) => ipcRenderer.invoke('secrets:save', provider, value),
  getKey: (provider: string) => ipcRenderer.invoke('secrets:get', provider),
  deleteKey: (provider: string) => ipcRenderer.invoke('secrets:delete', provider),
  list: () => ipcRenderer.invoke('secrets:list'),
  listStored: () => ipcRenderer.invoke('secrets:listStored'),
  clearAll: () => ipcRenderer.invoke('secrets:clearAll', SECRETS_CLEAR_CONFIRMATION_TOKEN),
});

// Settings Store API (factory reset support)
contextBridge.exposeInMainWorld('settings', {
  clearAll: () => ipcRenderer.invoke('settings:clearAll'),
});

contextBridge.exposeInMainWorld('desktopLifecycle', {
  noteReloadIntent: (reason: string) =>
    ipcRenderer.invoke(APP_LIFECYCLE_NOTE_RELOAD_INTENT_CHANNEL, reason),
  isTestMode: DESKTOP_TEST_MODE,
});

// Parser host bridge — exposed for the chunking-host renderer so its
// chunking-worker (Web Worker context) can route parse requests through the
// preload-bridged IPC channel instead of trying to `import('electron')` from
// the worker realm (which fails under contextIsolation+sandbox). The worker
// postMessages a parse request to its parent (the renderer), the renderer
// calls window.parserHost.parse(request) here, and posts the response back
// to the worker. See packages/chunking-worker/src/parsers/oxc-ipc-adapter.ts
// and the bridge handler in packages/file-import/src/chunking-worker-context.tsx.
contextBridge.exposeInMainWorld('parserHost', {
  parse: (request: unknown) => ipcRenderer.invoke(PARSER_HOST_PARSE_CHANNEL, request),
});

// Local Agent API (non-streaming aggregate; renderer can pseudo-stream chunks)
contextBridge.exposeInMainWorld('agent', {
  chat: (messages: unknown[], runtime?: unknown) =>
    ipcRenderer.invoke(AGENT_CHAT_CHANNEL, messages, runtime),
});

// MCP Config API (desktop-only)
contextBridge.exposeInMainWorld('mcp', {
  getConfig: () => ipcRenderer.invoke(MCP_CONFIG_GET_CHANNEL),
  watch: () => ipcRenderer.invoke(MCP_CONFIG_WATCH_CHANNEL),
  unwatch: () => ipcRenderer.invoke(MCP_CONFIG_UNWATCH_CHANNEL),
  getPath: () => ipcRenderer.invoke(MCP_CONFIG_GET_PATH_CHANNEL),
  setPath: (configPath: string | null) =>
    ipcRenderer.invoke(MCP_CONFIG_SET_PATH_CHANNEL, configPath),
  readConfigText: () => ipcRenderer.invoke(MCP_CONFIG_READ_TEXT_CHANNEL),
  writeConfigText: (content: string) => ipcRenderer.invoke(MCP_CONFIG_WRITE_TEXT_CHANNEL, content),
  selectPath: () => ipcRenderer.invoke(MCP_CONFIG_SELECT_PATH_CHANNEL),
  createSampleConfig: () => ipcRenderer.invoke(MCP_CONFIG_CREATE_SAMPLE_CHANNEL),
  // Tool management
  listTools: () => ipcRenderer.invoke(MCP_TOOLS_LIST_CHANNEL),
  enableTools: (toolIds: string[]) => ipcRenderer.invoke(MCP_TOOLS_ENABLE_CHANNEL, toolIds),
  disableTools: (toolIds: string[]) => ipcRenderer.invoke(MCP_TOOLS_DISABLE_CHANNEL, toolIds),
  enableServerTools: (serverName: string) =>
    ipcRenderer.invoke(MCP_TOOLS_ENABLE_SERVER_CHANNEL, serverName),
  disableServerTools: (serverName: string) =>
    ipcRenderer.invoke(MCP_TOOLS_DISABLE_SERVER_CHANNEL, serverName),
  resetTools: () => ipcRenderer.invoke(MCP_TOOLS_RESET_CHANNEL),
  getToolStats: () => ipcRenderer.invoke(MCP_TOOLS_GET_STATS_CHANNEL),
  onToolsUpdated: (
    callback: (
      tools: Record<
        string,
        Array<{
          id: string;
          serverName: string;
          description?: string;
          inputSchema?: unknown;
          enabled: boolean;
          discoveredAt: number;
        }>
      >
    ) => void
  ) => {
    const listener = (
      _event: unknown,
      tools: Record<
        string,
        Array<{
          id: string;
          serverName: string;
          description?: string;
          inputSchema?: unknown;
          enabled: boolean;
          discoveredAt: number;
        }>
      >
    ) => callback(tools);
    ipcRenderer.on(MCP_TOOLS_UPDATED_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(MCP_TOOLS_UPDATED_EVENT, listener);
    };
  },
});

// Tool execution API (for playground testing)
contextBridge.exposeInMainWorld('tools', {
  execute: (toolId: string, input: unknown, runtimeData?: Record<string, unknown>) =>
    ipcRenderer.invoke(TOOLS_EXECUTE_CHANNEL, toolId, input, runtimeData),
  onRootTreeSelectionUpdate: (callback: (payload: AssistantSelectionUpdatePayload) => void) => {
    const listener = (_event: unknown, payload: AssistantSelectionUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(ASSISTANT_ROOT_TREE_SELECTION_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(ASSISTANT_ROOT_TREE_SELECTION_EVENT, listener);
    };
  },
  onPreviewContextSelectionUpdate: (
    callback: (payload: AssistantSelectionUpdatePayload) => void
  ) => {
    const listener = (_event: unknown, payload: AssistantSelectionUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT, listener);
    };
  },
  onWorkspaceContextSelectionUpdate: (
    callback: (payload: AssistantWorkspaceContextSelectionUpdatePayload) => void
  ) => {
    const listener = (_event: unknown, payload: AssistantWorkspaceContextSelectionUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(ASSISTANT_WORKSPACE_CONTEXT_SELECTION_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(ASSISTANT_WORKSPACE_CONTEXT_SELECTION_EVENT, listener);
    };
  },
  onWorkspaceContextTapestryUpdate: (
    callback: (payload: AssistantWorkspaceTapestryUpdatePayload) => void
  ) => {
    const listener = (_event: unknown, payload: AssistantWorkspaceTapestryUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(ASSISTANT_WORKSPACE_CONTEXT_TAPESTRY_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(ASSISTANT_WORKSPACE_CONTEXT_TAPESTRY_EVENT, listener);
    };
  },
});

// Assistant UI (data stream) endpoint helper
contextBridge.exposeInMainWorld('assistant', {
  getUrl: () => ipcRenderer.invoke(ASSISTANT_GET_URL_CHANNEL),
});

// Main-process bridge for local-runtime probes. See ipc-runtime.ts for the
// rationale: Chromium's CORS enforcement inside the renderer blocks fetches
// to Ollama/LM Studio by default (the daemons' OLLAMA_ORIGINS / CORS config
// doesn't list an Electron renderer origin). The main process isn't subject
// to that policy, so we run probe + catalog fetch there and pass the
// typed result back over IPC.
if (shouldExposeBridge('runtime')) {
  contextBridge.exposeInMainWorld(
    'runtime',
    EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED
      ? {
          probe: () => Promise.resolve(createDisabledLocalRuntimeAvailability()),
          listModels: (runtimeId: string) =>
            Promise.resolve(createDisabledLocalRuntimeCatalog(runtimeId)),
          resolveOllamaCapabilities: (modelId: string) =>
            Promise.resolve({
              state: 'unavailable' as const,
              checkedAt: Date.now(),
              endpoint: 'disabled-by-e2e',
              message: EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE,
              modelId,
            }),
          verifyEmbeddingDimensions: () =>
            Promise.resolve({
              state: 'failed' as const,
              checkedAt: Date.now(),
              message: EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE,
            }),
        }
      : {
          probe: (runtimeId: string, options: unknown) =>
            ipcRenderer.invoke('runtime:probe', runtimeId, options),
          listModels: (runtimeId: string, options: unknown) =>
            ipcRenderer.invoke('runtime:listModels', runtimeId, options),
          resolveOllamaCapabilities: (modelId: string, options: unknown) =>
            ipcRenderer.invoke('runtime:resolveOllamaCapabilities', modelId, options),
          verifyEmbeddingDimensions: (runtimeId: string, modelId: string, options: unknown) =>
            ipcRenderer.invoke('runtime:verifyEmbeddingDimensions', runtimeId, modelId, options),
        }
  );
}

if (shouldExposeBridge('logging')) {
  contextBridge.exposeInMainWorld('logging', {
    getPreferences: (): Promise<LoggingSettingsPayload> =>
      ipcRenderer.invoke(LOGGING_GET_PREFERENCES_CHANNEL),
    setPreferences: (preferences: LoggingPreferences): Promise<LoggingSettingsPayload> =>
      ipcRenderer.invoke(LOGGING_SET_PREFERENCES_CHANNEL, preferences),
    selectDestination: (): Promise<string | null> =>
      ipcRenderer.invoke(LOGGING_SELECT_DESTINATION_CHANNEL),
    openDestination: (target: string | null): Promise<boolean> =>
      ipcRenderer.invoke(LOGGING_OPEN_DESTINATION_CHANNEL, target ?? null),
    getBufferedLogs: (): Promise<LogRecord[]> =>
      ipcRenderer.invoke(LOGGING_GET_BUFFERED_LOGS_CHANNEL),
    ingestBufferedRecord: (record: LogRecord): void => {
      ipcRenderer.send(LOGGING_INGEST_BUFFERED_RECORD_CHANNEL, record);
    },
    onPreferencesUpdated: (callback: (preferences: LoggingPreferences) => void) => {
      const listener = (_event: unknown, prefs: LoggingPreferences) => callback(prefs);
      ipcRenderer.on(LOGGING_PREFERENCES_UPDATED_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(LOGGING_PREFERENCES_UPDATED_EVENT, listener);
      };
    },
  });
}

if (shouldExposeBridge('desktopDiagnostics')) {
  contextBridge.exposeInMainWorld('desktopDiagnostics', {
    getSnapshot: (): Promise<DesktopPlatformDiagnosticsSnapshot> =>
      ipcRenderer.invoke(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL),
  });
}

// Power state events (suspend/resume awareness for GPU keep-alive, etc.)
contextBridge.exposeInMainWorld('power', {
  onPowerState: (callback: (state: 'suspend' | 'resume') => void) => {
    const listener = (_event: unknown, state: 'suspend' | 'resume') => callback(state);
    ipcRenderer.on('app:power-state', listener);
    return () => {
      ipcRenderer.removeListener('app:power-state', listener);
    };
  },
});

contextBridge.exposeInMainWorld('embeddingHost', {
  ensureStarted: (): Promise<EmbeddingHostStatus> =>
    ipcRenderer.invoke(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL),
  enqueueBackfill: (request: EmbeddingHostBackfillRequest) =>
    ipcRenderer.invoke(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL, request),
  cancelBackfill: (embeddingSetId: string): Promise<void> =>
    ipcRenderer.invoke(EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL, embeddingSetId),
  cancelAllBackfills: (): Promise<void> =>
    ipcRenderer.invoke(EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL),
  getBackfillsInFlight: (): Promise<EmbeddingHostBackfillInfo[]> =>
    ipcRenderer.invoke(EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL),
  stop: (): Promise<EmbeddingHostStatus> => ipcRenderer.invoke(EMBEDDING_HOST_STOP_CHANNEL),
  reset: (): Promise<EmbeddingHostStatus> => ipcRenderer.invoke(EMBEDDING_HOST_RESET_CHANNEL),
  getStatus: (): Promise<EmbeddingHostStatus> =>
    ipcRenderer.invoke(EMBEDDING_HOST_GET_STATUS_CHANNEL),
  onBackfillProgress: (callback: (progress: EmbeddingHostBackfillProgress) => void) => {
    const listener = (_event: unknown, progress: EmbeddingHostBackfillProgress) =>
      callback(progress);
    ipcRenderer.on(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, listener);
    };
  },
  reportStatus: (status: EmbeddingHostStatus): void => {
    ipcRenderer.send(EMBEDDING_HOST_REPORT_STATUS_CHANNEL, status);
  },
  onStatus: (callback: (status: EmbeddingHostStatus) => void) => {
    const listener = (_event: unknown, status: EmbeddingHostStatus) => callback(status);
    ipcRenderer.on(EMBEDDING_HOST_STATUS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(EMBEDDING_HOST_STATUS_EVENT, listener);
    };
  },
  onCommand: (callback: (command: EmbeddingHostCommand) => void) => {
    const listener = (_event: unknown, command: EmbeddingHostCommand) => callback(command);
    ipcRenderer.on(EMBEDDING_HOST_COMMAND_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(EMBEDDING_HOST_COMMAND_EVENT, listener);
    };
  },
  onQueryEmbeddingRequest: (callback: (request: EmbeddingHostQueryEmbeddingRequest) => void) => {
    const listener = (_event: unknown, request: EmbeddingHostQueryEmbeddingRequest) =>
      callback(request);
    ipcRenderer.on(EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT, listener);
    };
  },
  reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport): void => {
    ipcRenderer.send(EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL, response);
  },
});

contextBridge.exposeInMainWorld('chunkingHost', {
  ensureStarted: (): Promise<ChunkingHostStatus> =>
    ipcRenderer.invoke(CHUNKING_HOST_ENSURE_STARTED_CHANNEL),
  stop: (): Promise<ChunkingHostStatus> => ipcRenderer.invoke(CHUNKING_HOST_STOP_CHANNEL),
  reset: (): Promise<ChunkingHostStatus> => ipcRenderer.invoke(CHUNKING_HOST_RESET_CHANNEL),
  getStatus: (): Promise<ChunkingHostStatus> =>
    ipcRenderer.invoke(CHUNKING_HOST_GET_STATUS_CHANNEL),
  chunkFile: (request: ChunkingHostChunkFileRequest) =>
    ipcRenderer.invoke(CHUNKING_HOST_CHUNK_FILE_CHANNEL, request),
  chunkBatch: (request: ChunkingHostChunkBatchRequest) =>
    ipcRenderer.invoke(CHUNKING_HOST_CHUNK_BATCH_CHANNEL, request),
  reportStatus: (status: ChunkingHostStatus): void => {
    ipcRenderer.send(CHUNKING_HOST_REPORT_STATUS_CHANNEL, status);
  },
  reportResponse: (response: ChunkingHostResponseReport): void => {
    ipcRenderer.send(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL, response);
  },
  onStatus: (callback: (status: ChunkingHostStatus) => void) => {
    const listener = (_event: unknown, status: ChunkingHostStatus) => callback(status);
    ipcRenderer.on(CHUNKING_HOST_STATUS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(CHUNKING_HOST_STATUS_EVENT, listener);
    };
  },
  onProgress: (callback: (progress: ChunkingHostProgressEvent) => void) => {
    const listener = (_event: unknown, progress: ChunkingHostProgressEvent) => callback(progress);
    ipcRenderer.on(CHUNKING_HOST_PROGRESS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(CHUNKING_HOST_PROGRESS_EVENT, listener);
    };
  },
  onRequest: (callback: (request: ChunkingHostRequest) => void) => {
    const listener = (_event: unknown, request: ChunkingHostRequest) => callback(request);
    ipcRenderer.on(CHUNKING_HOST_REQUEST_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(CHUNKING_HOST_REQUEST_EVENT, listener);
    };
  },
});

contextBridge.exposeInMainWorld('llmHost', {
  ensureStarted: (): Promise<LlmHostStatus> => ipcRenderer.invoke(LLM_HOST_ENSURE_STARTED_CHANNEL),
  stop: (): Promise<LlmHostStatus> => ipcRenderer.invoke(LLM_HOST_STOP_CHANNEL),
  reset: (): Promise<LlmHostStatus> => ipcRenderer.invoke(LLM_HOST_RESET_CHANNEL),
  getStatus: (): Promise<LlmHostStatus> => ipcRenderer.invoke(LLM_HOST_GET_STATUS_CHANNEL),
  cancel: (requestId: string) => ipcRenderer.invoke(LLM_HOST_CANCEL_CHANNEL, requestId),
  warmup: (payload: { modelId: string; requestId?: string } | string) =>
    ipcRenderer.invoke(
      LLM_HOST_WARMUP_CHANNEL,
      typeof payload === 'string'
        ? payload
        : {
            modelId: payload.modelId,
            ...(payload.requestId === undefined ? {} : { clientRequestId: payload.requestId }),
          }
    ),
  generate: (payload: {
    requestId?: string;
    modelId: string;
    messages: unknown[];
    options?: unknown;
  }) =>
    ipcRenderer.invoke(LLM_HOST_GENERATE_CHANNEL, {
      kind: 'generate',
      ...(payload.requestId === undefined ? {} : { clientRequestId: payload.requestId }),
      modelId: payload.modelId,
      messages: payload.messages,
      ...(payload.options === undefined ? {} : { options: payload.options }),
    }),
  reportStatus: (status: LlmHostStatus): void => {
    ipcRenderer.send(LLM_HOST_REPORT_STATUS_CHANNEL, status);
  },
  reportProgress: (progress: LlmHostResponseReport): void => {
    ipcRenderer.send(LLM_HOST_REPORT_PROGRESS_CHANNEL, progress);
  },
  reportResponse: (response: LlmHostResponseReport): void => {
    ipcRenderer.send(LLM_HOST_REPORT_RESPONSE_CHANNEL, response);
  },
  onStatus: (callback: (status: LlmHostStatus) => void) => {
    const listener = (_event: unknown, status: LlmHostStatus) => callback(status);
    ipcRenderer.on(LLM_HOST_STATUS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(LLM_HOST_STATUS_EVENT, listener);
    };
  },
  onRequest: (callback: (request: LlmHostRequest) => void) => {
    const listener = (_event: unknown, request: LlmHostRequest) => callback(request);
    ipcRenderer.on(LLM_HOST_REQUEST_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(LLM_HOST_REQUEST_EVENT, listener);
    };
  },
  onProgress: (callback: (progress: LlmHostResponseReport) => void) => {
    const listener = (_event: unknown, progress: LlmHostResponseReport) => callback(progress);
    ipcRenderer.on(LLM_HOST_PROGRESS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(LLM_HOST_PROGRESS_EVENT, listener);
    };
  },
});

// System Clipboard helper (renderer-friendly)
contextBridge.exposeInMainWorld('clipboard', {
  writeText: (text: string) => {
    try {
      clipboard.writeText(String(text ?? ''));
      return true;
    } catch {
      return false;
    }
  },
  readText: () => {
    try {
      return clipboard.readText();
    } catch {
      return '';
    }
  },
});

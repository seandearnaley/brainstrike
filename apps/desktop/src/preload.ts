// Electron preload script - must use CommonJS syntax
const { contextBridge, ipcRenderer } = require('electron');
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
const ASSISTANT_ROOT_TREE_SELECTION_EVENT = 'assistant:root-tree-selection-update' as const;
const ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT =
  'assistant:preview-context-selection-update' as const;
const ASSISTANT_WORKSPACE_CONTEXT_SELECTION_EVENT =
  'assistant:workspace-context-selection-update' as const;
const ASSISTANT_WORKSPACE_CONTEXT_TAPESTRY_EVENT =
  'assistant:workspace-context-tapestry-update' as const;
const MCP_TOOLS_UPDATED_EVENT = 'mcp:tools:updated' as const;
const DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL = 'db:managed-cache:apply-batch' as const;
const DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL =
  'db:managed-cache:invalidate-by-identity' as const;
const DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL =
  'db:chunks:insert-and-enqueue-embedding-jobs' as const;
const DB_SCHEDULER_SNAPSHOT_CHANNEL = 'db:scheduler:snapshot' as const;
const DB_CLEAR_ALL_CHANNEL = 'db:clearAll' as const;
const DB_DIAGNOSTICS_CHANNEL = 'db:diagnostics' as const;
const DB_EXEC_CHANNEL = 'db:exec' as const;
const DB_GET_USER_DATA_PATH_CHANNEL = 'db:getUserDataPath' as const;
const DB_LIVE_QUERY_REFRESH_CHANNEL = 'db:live-query:refresh' as const;
const DB_LIVE_QUERY_START_CHANNEL = 'db:live-query:start' as const;
const DB_LIVE_QUERY_STOP_CHANNEL = 'db:live-query:stop' as const;
const DB_LIVE_QUERY_UPDATE_EVENT = 'db:live-query:update' as const;
const DB_PING_CHANNEL = 'db:ping' as const;
const DB_QUERY_CHANNEL = 'db:query' as const;
const DB_RESET_LOCAL_CHANNEL = 'db:resetLocal' as const;
const DB_TEST_CHANNEL = 'db:test' as const;
const DB_TRANSACTION_CHANNEL = 'db:transaction' as const;
const FILE_SYSTEM_ADD_ROOT_CHANNEL = 'fs:addRoot' as const;
const FILE_SYSTEM_EXISTS_CHANNEL = 'fs:exists' as const;
const FILE_SYSTEM_READ_DIRECTORY_CHANNEL = 'fs:readDirectory' as const;
const FILE_SYSTEM_READ_FILE_BY_PATH_CHANNEL = 'fs:readFileByPath' as const;
const FILE_SYSTEM_READ_FILE_CHANNEL = 'fs:readFile' as const;
const FILE_SYSTEM_REMOVE_ROOT_CHANNEL = 'fs:removeRoot' as const;
const FILE_SYSTEM_REQUEST_DIRECTORY_ACCESS_CHANNEL = 'fs:requestDirectoryAccess' as const;
const FILE_SYSTEM_RESTORE_LAST_FOLDER_CHANNEL = 'fs:restoreLastFolder' as const;
const FILE_SYSTEM_RESTORE_ROOTS_CHANNEL = 'fs:restoreRoots' as const;
const FILE_SYSTEM_SAVE_LAST_FOLDER_CHANNEL = 'fs:saveLastFolder' as const;
const LAYOUT_LOAD_CHANNEL = 'layout:load' as const;
const LAYOUT_SAVE_CHANNEL = 'layout:save' as const;
const RUNTIME_LIST_MODELS_CHANNEL = 'runtime:listModels' as const;
const RUNTIME_PROBE_CHANNEL = 'runtime:probe' as const;
const RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL = 'runtime:resolveOllamaCapabilities' as const;
const RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL = 'runtime:verifyEmbeddingDimensions' as const;
const SECRETS_CLEAR_ALL_CHANNEL = 'secrets:clearAll' as const;
const SECRETS_DELETE_CHANNEL = 'secrets:delete' as const;
const SECRETS_GET_CHANNEL = 'secrets:get' as const;
const SECRETS_LIST_CHANNEL = 'secrets:list' as const;
const SECRETS_LIST_STORED_CHANNEL = 'secrets:listStored' as const;
const SECRETS_SAVE_CHANNEL = 'secrets:save' as const;
const SETTINGS_CLEAR_ALL_CHANNEL = 'settings:clearAll' as const;
const STORAGE_CLEAR_CHANNEL = 'storage:clear' as const;
const STORAGE_GET_ALL_KEYS_CHANNEL = 'storage:getAllKeys' as const;
const STORAGE_GET_ITEM_CHANNEL = 'storage:getItem' as const;
const STORAGE_REMOVE_ITEM_CHANNEL = 'storage:removeItem' as const;
const STORAGE_SET_ITEM_CHANNEL = 'storage:setItem' as const;
const APP_POWER_SNAPSHOT_CHANNEL = 'app:power-snapshot' as const;
const APP_POWER_STATE_EVENT = 'app:power-state' as const;
const COMMAND_PALETTE_OPEN_EVENT = 'command-palette:open' as const;
const QUICK_OPEN_OPEN_EVENT = 'quick-open:open' as const;
const LOGGING_GET_PREFERENCES_CHANNEL = 'logging:get-preferences' as const;
const LOGGING_SET_PREFERENCES_CHANNEL = 'logging:set-preferences' as const;
const LOGGING_SELECT_DESTINATION_CHANNEL = 'logging:select-destination' as const;
const LOGGING_OPEN_DESTINATION_CHANNEL = 'logging:open-destination' as const;
const LOGGING_GET_BUFFERED_LOGS_CHANNEL = 'logging:get-buffered-logs' as const;
const LOGGING_INGEST_BUFFERED_RECORD_CHANNEL = 'logging:ingest-buffered-record' as const;
const LOGGING_PREFERENCES_UPDATED_EVENT = 'logging:preferences-updated' as const;
const DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL = 'desktop-diagnostics:get-snapshot' as const;
const SHELL_OPEN_EXTERNAL_CHANNEL = 'shell:open-external' as const;
const SHELL_OPEN_PATH_CHANNEL = 'shell:open-path' as const;
const SHELL_SHOW_ITEM_IN_FOLDER_CHANNEL = 'shell:show-item-in-folder' as const;
const CLIPBOARD_WRITE_TEXT_CHANNEL = 'clipboard:write-text' as const;
const ASSISTANT_CHECKPOINT_REVERT_ENTRY_CHANNEL = 'assistant-checkpoint:revert-entry' as const;
const ASSISTANT_CHECKPOINT_REVERT_RUN_CHANNEL = 'assistant-checkpoint:revert-run' as const;
const GIT_STATUS_CHANNEL = 'git:status' as const;
const GIT_DIFF_CHANNEL = 'git:diff' as const;
const GIT_STAGE_CHANNEL = 'git:stage' as const;
const GIT_UNSTAGE_CHANNEL = 'git:unstage' as const;
const GIT_COMMIT_CHANNEL = 'git:commit' as const;
const GIT_AHEAD_BEHIND_CHANNEL = 'git:aheadBehind' as const;
const GIT_PUSH_CHANNEL = 'git:push' as const;
const GIT_PULL_CHANNEL = 'git:pull' as const;
const TERMINAL_CREATE_CHANNEL = 'terminal:create' as const;
const TERMINAL_WRITE_CHANNEL = 'terminal:write' as const;
const TERMINAL_RESIZE_CHANNEL = 'terminal:resize' as const;
const TERMINAL_DESTROY_CHANNEL = 'terminal:destroy' as const;
const TERMINAL_DATA_EVENT = 'terminal:data' as const;
const TERMINAL_EXIT_EVENT = 'terminal:exit' as const;

import type {
  ApplyManagedCacheBatchArgs,
  ApplyManagedCacheInvalidationsArgs,
  ManagedCacheInvalidationResult,
} from '@brainstrike/db';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
  DatabaseWorkOptions,
  ElectronChunkInsert,
  ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
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
  EmbeddingHostQueryEmbeddingPayload,
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
const EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL = 'embedding-host:query-embedding' as const;
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
            args: ['[preload] db live-query subscriber threw:', error],
            bindings: { runtime: 'electron-renderer' },
            level: 'error' as LogRecord['level'],
            message: 'DB live-query subscriber threw',
            scope: 'Preload',
            timestamp: Date.now(),
          } satisfies LogRecord);
        }
      }
    };
    ipcRenderer.on(DB_LIVE_QUERY_UPDATE_EVENT, dbLiveUpdateIpcListener);
  }

  return () => {
    dbLiveUpdateCallbacks.delete(callback);
    if (dbLiveUpdateCallbacks.size === 0 && dbLiveUpdateIpcListener) {
      ipcRenderer.removeListener(DB_LIVE_QUERY_UPDATE_EVENT, dbLiveUpdateIpcListener);
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

function assertPreloadNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function assertPreloadPositiveInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(message);
  }
  return value as number;
}

function assertEmbeddingHostQueryEmbeddingPayload(
  value: unknown
): EmbeddingHostQueryEmbeddingPayload {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding host query embedding payload must be an object.');
  }
  const payload = value as Record<string, unknown>;
  return {
    dimensions: assertPreloadPositiveInteger(
      payload['dimensions'],
      'Embedding host query embedding payload.dimensions must be a positive integer.'
    ),
    modelId: assertPreloadNonEmptyString(
      payload['modelId'],
      'Embedding host query embedding payload.modelId must be a non-empty string.'
    ),
    modelKey: assertPreloadNonEmptyString(
      payload['modelKey'],
      'Embedding host query embedding payload.modelKey must be a non-empty string.'
    ),
    query: assertPreloadNonEmptyString(
      payload['query'],
      'Embedding host query embedding payload.query must be a non-empty string.'
    ),
  };
}

function createDisabledLocalRuntimeAvailability() {
  return {
    checkedAt: Date.now(),
    message: EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE,
    state: 'unavailable' as const,
  };
}

function createDisabledLocalRuntimeCatalog(runtimeId: string) {
  return {
    availability: createDisabledLocalRuntimeAvailability(),
    checkedAt: Date.now(),
    message: EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE,
    runtime: runtimeId,
    state: 'failed' as const,
  };
}

type EmbeddingHostLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
type ChunkingHostLifecycleState = EmbeddingHostLifecycleState;
type LlmHostLifecycleState = EmbeddingHostLifecycleState;

interface EmbeddingHostStatus {
  readonly active: boolean;
  readonly embeddingRuntime?: {
    readonly actualWorkerMetadata: {
      readonly device: 'webgpu' | 'wasm';
      readonly dtype: string;
      readonly fallbackApplied: boolean;
    } | null;
    readonly backendMismatch: boolean;
    readonly selectedDevicePreference: 'webgpu' | 'wasm';
  };
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
    // Database operations
    db: {
      applyManagedCacheBatch: (
        payload: ApplyManagedCacheBatchArgs,
        options?: DatabaseWorkOptions
      ) => ipcRenderer.invoke(DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL, payload, options),
      clearAll: (confirmationToken?: string) =>
        ipcRenderer.invoke(DB_CLEAR_ALL_CHANNEL, confirmationToken),
      diagnostics: () => ipcRenderer.invoke(DB_DIAGNOSTICS_CHANNEL),
      exec: (sql: string, params?: unknown[], options?: DatabaseWorkOptions) =>
        ipcRenderer.invoke(DB_EXEC_CHANNEL, sql, params, options),
      insertChunksAndEnqueueEmbeddingJobs: (
        chunks: readonly ElectronChunkInsert[],
        fileRecordId: string,
        options: ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
        workOptions?: DatabaseWorkOptions
      ): Promise<void> =>
        ipcRenderer.invoke(
          DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL,
          { chunks, fileRecordId, options },
          workOptions
        ),
      invalidateManagedCacheEntriesByIdentity: (
        payload: ApplyManagedCacheInvalidationsArgs,
        options?: DatabaseWorkOptions
      ): Promise<ManagedCacheInvalidationResult> =>
        ipcRenderer.invoke(
          DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL,
          payload,
          options
        ),
      ping: () => ipcRenderer.invoke(DB_PING_CHANNEL),
      query: (sql: string, params?: unknown[], options?: DatabaseWorkOptions) =>
        ipcRenderer.invoke(DB_QUERY_CHANNEL, sql, params, options),
      resetLocal: () => ipcRenderer.invoke(DB_RESET_LOCAL_CHANNEL),
      // Atomic transaction over IPC (#1141): ships an ordered statement list to main
      // to run inside one pglite.transaction() and return statements[resultIndex] rows.
      runTransaction: (
        statements: {
          expectedRowCount?: number;
          params?: unknown[];
          rowCountMismatchError?: string;
          sql: string;
        }[],
        resultIndex: number,
        options?: DatabaseWorkOptions
      ) => ipcRenderer.invoke(DB_TRANSACTION_CHANNEL, statements, resultIndex, options),
      schedulerSnapshot: () => ipcRenderer.invoke(DB_SCHEDULER_SNAPSHOT_CHANNEL),
      test: () => ipcRenderer.invoke(DB_TEST_CHANNEL),
    },
    dbLive: {
      onUpdate: (callback: (payload: { id: number; results: unknown }) => void) =>
        subscribeToDbLiveUpdates(callback),
      refresh: (
        payload: { id: number; offset?: number; limit?: number },
        options?: DatabaseWorkOptions
      ) => ipcRenderer.invoke(DB_LIVE_QUERY_REFRESH_CHANNEL, payload, options),
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
      ) => ipcRenderer.invoke(DB_LIVE_QUERY_START_CHANNEL, options, workOptions),
      stop: (id: number) => ipcRenderer.invoke(DB_LIVE_QUERY_STOP_CHANNEL, id),
    },
    fileSystem: {
      addRoot: () => ipcRenderer.invoke(FILE_SYSTEM_ADD_ROOT_CHANNEL),
      exists: (path: string) => ipcRenderer.invoke(FILE_SYSTEM_EXISTS_CHANNEL, path),
      readDirectory: (handle: DirectoryHandle) =>
        ipcRenderer.invoke(FILE_SYSTEM_READ_DIRECTORY_CHANNEL, handle),
      readFile: async (handle: FileHandle) => {
        const result = await ipcRenderer.invoke(FILE_SYSTEM_READ_FILE_CHANNEL, handle);
        return unwrapFileReadResult(result);
      },
      readFileByPath: async (absolutePath: string) => {
        const result = await ipcRenderer.invoke(
          FILE_SYSTEM_READ_FILE_BY_PATH_CHANNEL,
          absolutePath
        );
        return unwrapFileReadResult(result);
      },
      removeRoot: (rootId: string) => ipcRenderer.invoke(FILE_SYSTEM_REMOVE_ROOT_CHANNEL, rootId),
      requestDirectoryAccess: () =>
        ipcRenderer.invoke(FILE_SYSTEM_REQUEST_DIRECTORY_ACCESS_CHANNEL),
      restoreLastFolder: () => ipcRenderer.invoke(FILE_SYSTEM_RESTORE_LAST_FOLDER_CHANNEL),
      restoreRoots: () => ipcRenderer.invoke(FILE_SYSTEM_RESTORE_ROOTS_CHANNEL),
      saveLastFolder: (folderPath: string) =>
        ipcRenderer.invoke(FILE_SYSTEM_SAVE_LAST_FOLDER_CHANNEL, folderPath),
    },
    // Database path (legacy - kept for compatibility)
    getUserDataPath: () => ipcRenderer.invoke(DB_GET_USER_DATA_PATH_CHANNEL),
    loadLayout: (): Promise<LayoutLoadResult> => ipcRenderer.invoke(LAYOUT_LOAD_CHANNEL),
    // Panel layout persistence
    saveLayout: (state: PanelPersistenceState): Promise<LayoutPersistenceResult> =>
      ipcRenderer.invoke(LAYOUT_SAVE_CHANNEL, state),
    storage: {
      clear: () => ipcRenderer.invoke(STORAGE_CLEAR_CHANNEL),
      getAllKeys: () => ipcRenderer.invoke(STORAGE_GET_ALL_KEYS_CHANNEL),
      getItem: (key: string) => ipcRenderer.invoke(STORAGE_GET_ITEM_CHANNEL, key),
      removeItem: (key: string) => ipcRenderer.invoke(STORAGE_REMOVE_ITEM_CHANNEL, key),
      setItem: (key: string, value: string) =>
        ipcRenderer.invoke(STORAGE_SET_ITEM_CHANNEL, key, value),
    },
  });
}

// Secure Secrets API
contextBridge.exposeInMainWorld('secrets', {
  clearAll: () => ipcRenderer.invoke(SECRETS_CLEAR_ALL_CHANNEL, SECRETS_CLEAR_CONFIRMATION_TOKEN),
  deleteKey: (provider: string) => ipcRenderer.invoke(SECRETS_DELETE_CHANNEL, provider),
  getKey: (provider: string) => ipcRenderer.invoke(SECRETS_GET_CHANNEL, provider),
  list: () => ipcRenderer.invoke(SECRETS_LIST_CHANNEL),
  listStored: () => ipcRenderer.invoke(SECRETS_LIST_STORED_CHANNEL),
  saveKey: (provider: string, value: string) =>
    ipcRenderer.invoke(SECRETS_SAVE_CHANNEL, provider, value),
});

// Settings Store API (factory reset support)
contextBridge.exposeInMainWorld('settings', {
  clearAll: () => ipcRenderer.invoke(SETTINGS_CLEAR_ALL_CHANNEL),
});

contextBridge.exposeInMainWorld('desktopLifecycle', {
  isTestMode: DESKTOP_TEST_MODE,
  noteReloadIntent: (reason: string) =>
    ipcRenderer.invoke(APP_LIFECYCLE_NOTE_RELOAD_INTENT_CHANNEL, reason),
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
  createSampleConfig: () => ipcRenderer.invoke(MCP_CONFIG_CREATE_SAMPLE_CHANNEL),
  disableServerTools: (serverName: string) =>
    ipcRenderer.invoke(MCP_TOOLS_DISABLE_SERVER_CHANNEL, serverName),
  disableTools: (toolIds: string[]) => ipcRenderer.invoke(MCP_TOOLS_DISABLE_CHANNEL, toolIds),
  enableServerTools: (serverName: string) =>
    ipcRenderer.invoke(MCP_TOOLS_ENABLE_SERVER_CHANNEL, serverName),
  enableTools: (toolIds: string[]) => ipcRenderer.invoke(MCP_TOOLS_ENABLE_CHANNEL, toolIds),
  getConfig: () => ipcRenderer.invoke(MCP_CONFIG_GET_CHANNEL),
  getPath: () => ipcRenderer.invoke(MCP_CONFIG_GET_PATH_CHANNEL),
  getToolStats: () => ipcRenderer.invoke(MCP_TOOLS_GET_STATS_CHANNEL),
  // Tool management
  listTools: () => ipcRenderer.invoke(MCP_TOOLS_LIST_CHANNEL),
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
  readConfigText: () => ipcRenderer.invoke(MCP_CONFIG_READ_TEXT_CHANNEL),
  resetTools: () => ipcRenderer.invoke(MCP_TOOLS_RESET_CHANNEL),
  selectPath: () => ipcRenderer.invoke(MCP_CONFIG_SELECT_PATH_CHANNEL),
  setPath: (configPath: string | null) =>
    ipcRenderer.invoke(MCP_CONFIG_SET_PATH_CHANNEL, configPath),
  unwatch: () => ipcRenderer.invoke(MCP_CONFIG_UNWATCH_CHANNEL),
  watch: () => ipcRenderer.invoke(MCP_CONFIG_WATCH_CHANNEL),
  writeConfigText: (content: string) => ipcRenderer.invoke(MCP_CONFIG_WRITE_TEXT_CHANNEL, content),
});

// Tool execution API (for playground testing)
contextBridge.exposeInMainWorld('tools', {
  execute: (toolId: string, input: unknown, runtimeData?: Record<string, unknown>) =>
    ipcRenderer.invoke(TOOLS_EXECUTE_CHANNEL, toolId, input, runtimeData),
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
  onRootTreeSelectionUpdate: (callback: (payload: AssistantSelectionUpdatePayload) => void) => {
    const listener = (_event: unknown, payload: AssistantSelectionUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(ASSISTANT_ROOT_TREE_SELECTION_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(ASSISTANT_ROOT_TREE_SELECTION_EVENT, listener);
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
          listModels: (runtimeId: string) =>
            Promise.resolve(createDisabledLocalRuntimeCatalog(runtimeId)),
          probe: () => Promise.resolve(createDisabledLocalRuntimeAvailability()),
          resolveOllamaCapabilities: (modelId: string) =>
            Promise.resolve({
              checkedAt: Date.now(),
              endpoint: 'disabled-by-e2e',
              message: EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE,
              modelId,
              state: 'unavailable' as const,
            }),
          verifyEmbeddingDimensions: () =>
            Promise.resolve({
              checkedAt: Date.now(),
              message: EXTERNAL_LOCAL_RUNTIME_PROBES_DISABLED_MESSAGE,
              state: 'failed' as const,
            }),
        }
      : {
          listModels: (runtimeId: string, options: unknown) =>
            ipcRenderer.invoke(RUNTIME_LIST_MODELS_CHANNEL, runtimeId, options),
          probe: (runtimeId: string, options: unknown) =>
            ipcRenderer.invoke(RUNTIME_PROBE_CHANNEL, runtimeId, options),
          resolveOllamaCapabilities: (modelId: string, options: unknown) =>
            ipcRenderer.invoke(RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL, modelId, options),
          verifyEmbeddingDimensions: (runtimeId: string, modelId: string, options: unknown) =>
            ipcRenderer.invoke(
              RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL,
              runtimeId,
              modelId,
              options
            ),
        }
  );
}

if (shouldExposeBridge('logging')) {
  contextBridge.exposeInMainWorld('logging', {
    getBufferedLogs: (): Promise<LogRecord[]> =>
      ipcRenderer.invoke(LOGGING_GET_BUFFERED_LOGS_CHANNEL),
    getPreferences: (): Promise<LoggingSettingsPayload> =>
      ipcRenderer.invoke(LOGGING_GET_PREFERENCES_CHANNEL),
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
    openDestination: (target: string | null): Promise<boolean> =>
      ipcRenderer.invoke(LOGGING_OPEN_DESTINATION_CHANNEL, target ?? null),
    selectDestination: (): Promise<string | null> =>
      ipcRenderer.invoke(LOGGING_SELECT_DESTINATION_CHANNEL),
    setPreferences: (preferences: LoggingPreferences): Promise<LoggingSettingsPayload> =>
      ipcRenderer.invoke(LOGGING_SET_PREFERENCES_CHANNEL, preferences),
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
  getSnapshot: () => ipcRenderer.invoke(APP_POWER_SNAPSHOT_CHANNEL),
  onPowerState: (callback: (state: 'suspend' | 'resume') => void) => {
    const listener = (_event: unknown, state: 'suspend' | 'resume') => callback(state);
    ipcRenderer.on(APP_POWER_STATE_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(APP_POWER_STATE_EVENT, listener);
    };
  },
});

// ⌘K command palette: the app menu's Cmd+K accelerator pushes this event to the
// focused window so the renderer (visible-UI root) can open the palette. Mirrors
// the other one-way main→renderer `on*` bridges (e.g. power.onPowerState).
contextBridge.exposeInMainWorld('commandPalette', {
  onOpen: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(COMMAND_PALETTE_OPEN_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(COMMAND_PALETTE_OPEN_EVENT, listener);
    };
  },
});

// ⌘P quick-open: the app menu's Cmd+P accelerator pushes this event to the
// focused window so the renderer (visible-UI root) opens the quick-open finder.
// Mirrors the commandPalette one-way main→renderer bridge.
contextBridge.exposeInMainWorld('quickOpen', {
  onOpen: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(QUICK_OPEN_OPEN_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(QUICK_OPEN_OPEN_EVENT, listener);
    };
  },
});

contextBridge.exposeInMainWorld('embeddingHost', {
  cancelAllBackfills: (): Promise<void> =>
    ipcRenderer.invoke(EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL),
  cancelBackfill: (embeddingSetId: string): Promise<void> =>
    ipcRenderer.invoke(EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL, embeddingSetId),
  enqueueBackfill: (request: EmbeddingHostBackfillRequest) =>
    ipcRenderer.invoke(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL, request),
  ensureStarted: (): Promise<EmbeddingHostStatus> =>
    ipcRenderer.invoke(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL),
  getBackfillsInFlight: (): Promise<EmbeddingHostBackfillInfo[]> =>
    ipcRenderer.invoke(EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL),
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
  onStatus: (callback: (status: EmbeddingHostStatus) => void) => {
    const listener = (_event: unknown, status: EmbeddingHostStatus) => callback(status);
    ipcRenderer.on(EMBEDDING_HOST_STATUS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(EMBEDDING_HOST_STATUS_EVENT, listener);
    };
  },
  queryEmbedding: (payload: EmbeddingHostQueryEmbeddingPayload): Promise<number[]> =>
    ipcRenderer.invoke(
      EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
      assertEmbeddingHostQueryEmbeddingPayload(payload)
    ),
  reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport): void => {
    ipcRenderer.send(EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL, response);
  },
  reportStatus: (status: EmbeddingHostStatus): void => {
    ipcRenderer.send(EMBEDDING_HOST_REPORT_STATUS_CHANNEL, status);
  },
  reset: (): Promise<EmbeddingHostStatus> => ipcRenderer.invoke(EMBEDDING_HOST_RESET_CHANNEL),
  stop: (): Promise<EmbeddingHostStatus> => ipcRenderer.invoke(EMBEDDING_HOST_STOP_CHANNEL),
});

contextBridge.exposeInMainWorld('chunkingHost', {
  chunkBatch: (request: ChunkingHostChunkBatchRequest) =>
    ipcRenderer.invoke(CHUNKING_HOST_CHUNK_BATCH_CHANNEL, request),
  chunkFile: (request: ChunkingHostChunkFileRequest) =>
    ipcRenderer.invoke(CHUNKING_HOST_CHUNK_FILE_CHANNEL, request),
  ensureStarted: (): Promise<ChunkingHostStatus> =>
    ipcRenderer.invoke(CHUNKING_HOST_ENSURE_STARTED_CHANNEL),
  getStatus: (): Promise<ChunkingHostStatus> =>
    ipcRenderer.invoke(CHUNKING_HOST_GET_STATUS_CHANNEL),
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
  onStatus: (callback: (status: ChunkingHostStatus) => void) => {
    const listener = (_event: unknown, status: ChunkingHostStatus) => callback(status);
    ipcRenderer.on(CHUNKING_HOST_STATUS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(CHUNKING_HOST_STATUS_EVENT, listener);
    };
  },
  reportResponse: (response: ChunkingHostResponseReport): void => {
    ipcRenderer.send(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL, response);
  },
  reportStatus: (status: ChunkingHostStatus): void => {
    ipcRenderer.send(CHUNKING_HOST_REPORT_STATUS_CHANNEL, status);
  },
  reset: (): Promise<ChunkingHostStatus> => ipcRenderer.invoke(CHUNKING_HOST_RESET_CHANNEL),
  stop: (): Promise<ChunkingHostStatus> => ipcRenderer.invoke(CHUNKING_HOST_STOP_CHANNEL),
});

contextBridge.exposeInMainWorld('llmHost', {
  cancel: (requestId: string) => ipcRenderer.invoke(LLM_HOST_CANCEL_CHANNEL, requestId),
  ensureStarted: (): Promise<LlmHostStatus> => ipcRenderer.invoke(LLM_HOST_ENSURE_STARTED_CHANNEL),
  generate: (payload: {
    requestId?: string;
    modelId: string;
    messages: unknown[];
    options?: unknown;
  }) =>
    ipcRenderer.invoke(LLM_HOST_GENERATE_CHANNEL, {
      kind: 'generate',
      ...(payload.requestId === undefined ? {} : { clientRequestId: payload.requestId }),
      messages: payload.messages,
      modelId: payload.modelId,
      ...(payload.options === undefined ? {} : { options: payload.options }),
    }),
  getStatus: (): Promise<LlmHostStatus> => ipcRenderer.invoke(LLM_HOST_GET_STATUS_CHANNEL),
  onProgress: (callback: (progress: LlmHostResponseReport) => void) => {
    const listener = (_event: unknown, progress: LlmHostResponseReport) => callback(progress);
    ipcRenderer.on(LLM_HOST_PROGRESS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(LLM_HOST_PROGRESS_EVENT, listener);
    };
  },
  onRequest: (callback: (request: LlmHostRequest) => void) => {
    const listener = (_event: unknown, request: LlmHostRequest) => callback(request);
    ipcRenderer.on(LLM_HOST_REQUEST_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(LLM_HOST_REQUEST_EVENT, listener);
    };
  },
  onStatus: (callback: (status: LlmHostStatus) => void) => {
    const listener = (_event: unknown, status: LlmHostStatus) => callback(status);
    ipcRenderer.on(LLM_HOST_STATUS_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(LLM_HOST_STATUS_EVENT, listener);
    };
  },
  reportProgress: (progress: LlmHostResponseReport): void => {
    ipcRenderer.send(LLM_HOST_REPORT_PROGRESS_CHANNEL, progress);
  },
  reportResponse: (response: LlmHostResponseReport): void => {
    ipcRenderer.send(LLM_HOST_REPORT_RESPONSE_CHANNEL, response);
  },
  reportStatus: (status: LlmHostStatus): void => {
    ipcRenderer.send(LLM_HOST_REPORT_STATUS_CHANNEL, status);
  },
  reset: (): Promise<LlmHostStatus> => ipcRenderer.invoke(LLM_HOST_RESET_CHANNEL),
  stop: (): Promise<LlmHostStatus> => ipcRenderer.invoke(LLM_HOST_STOP_CHANNEL),
  warmup: (payload: { modelId: string; requestId?: string } | string) =>
    ipcRenderer.invoke(
      LLM_HOST_WARMUP_CHANNEL,
      typeof payload === 'string'
        ? payload
        : {
            kind: 'warmup',
            modelId: payload.modelId,
            ...(payload.requestId === undefined ? {} : { clientRequestId: payload.requestId }),
          }
    ),
});

// System Clipboard helper (renderer-friendly). Writes go through main over
// IPC: sandboxed preloads cannot require Electron's clipboard module, so a
// direct module call here silently fails on real (non-test-mode) builds.
contextBridge.exposeInMainWorld('clipboard', {
  writeText: (text: string) => ipcRenderer.invoke(CLIPBOARD_WRITE_TEXT_CHANNEL, text),
});

// Edit checkpoint (undo of agent file edits) — invoke-only revert bridge. Desktop
// only: web never defines this (no assistant server / main process).
contextBridge.exposeInMainWorld('assistantCheckpoints', {
  revertEntry: (id: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke(ASSISTANT_CHECKPOINT_REVERT_ENTRY_CHANNEL, {
      force: options?.force ?? false,
      id,
    }),
  revertRun: (runId: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke(ASSISTANT_CHECKPOINT_REVERT_RUN_CHANNEL, {
      force: options?.force ?? false,
      runId,
    }),
});

// Platform shell bridge: reveal/open absolute paths in the OS file manager.
if (shouldExposeBridge('platform')) {
  contextBridge.exposeInMainWorld('platform', {
    openExternal: (url: string) => ipcRenderer.invoke(SHELL_OPEN_EXTERNAL_CHANNEL, url),
    openPath: (absolutePath: string) => ipcRenderer.invoke(SHELL_OPEN_PATH_CHANNEL, absolutePath),
    showItemInFolder: (absolutePath: string) =>
      ipcRenderer.invoke(SHELL_SHOW_ITEM_IN_FOLDER_CHANNEL, absolutePath),
  });
}

// Git bridge (desktop-only): typed git operations on a workspace root. Every
// call passes the durable `rootId` (DB roots.id) — main resolves + containment-
// checks it to an absolute cwd and runs git via execFile (no shell). Web never
// constructs this bridge (there is no preload), so `window.git` is simply
// absent there; consumers must capability-check `window.git` rather than
// `isElectron()`. The Git panel UI lands in a later PR.
if (shouldExposeBridge('git')) {
  contextBridge.exposeInMainWorld('git', {
    aheadBehind: (rootId: string) => ipcRenderer.invoke(GIT_AHEAD_BEHIND_CHANNEL, rootId),
    commit: (rootId: string, params: { message: string }) =>
      ipcRenderer.invoke(GIT_COMMIT_CHANNEL, rootId, params),
    diff: (rootId: string, params?: { path?: string; staged?: boolean; untracked?: boolean }) =>
      ipcRenderer.invoke(GIT_DIFF_CHANNEL, rootId, params ?? {}),
    pull: (rootId: string) => ipcRenderer.invoke(GIT_PULL_CHANNEL, rootId),
    push: (rootId: string) => ipcRenderer.invoke(GIT_PUSH_CHANNEL, rootId),
    stage: (rootId: string, params?: { path?: string }) =>
      ipcRenderer.invoke(GIT_STAGE_CHANNEL, rootId, params ?? {}),
    status: (rootId: string) => ipcRenderer.invoke(GIT_STATUS_CHANNEL, rootId),
    unstage: (rootId: string, params?: { path?: string }) =>
      ipcRenderer.invoke(GIT_UNSTAGE_CHANNEL, rootId, params ?? {}),
  });
}

// Terminal bridge (desktop-only): a PTY backend for a future TerminalPanel.
// `create` pins the shell cwd to a validated workspace `rootId` (main resolves
// + containment-checks it, no shell-string injection in the spawn). Output and
// exit are pushed one-way to THIS renderer over `terminal:data` / `terminal:exit`;
// `onData`/`onExit` register a listener and return an unsubscribe fn. Web never
// constructs this bridge (no preload), so consumers must capability-check
// `window.terminal`. The xterm UI lands in the next PR.
if (shouldExposeBridge('terminal')) {
  contextBridge.exposeInMainWorld('terminal', {
    create: (params: { rootId: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, params),
    destroy: (params: { terminalId: string }) =>
      ipcRenderer.invoke(TERMINAL_DESTROY_CHANNEL, params),
    onData: (callback: (event: { terminalId: string; data: string }) => void) => {
      const listener = (_event: unknown, payload: { terminalId: string; data: string }) =>
        callback(payload);
      ipcRenderer.on(TERMINAL_DATA_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(TERMINAL_DATA_EVENT, listener);
      };
    },
    onExit: (
      callback: (event: { terminalId: string; exitCode: number; signal: number | null }) => void
    ) => {
      const listener = (
        _event: unknown,
        payload: { terminalId: string; exitCode: number; signal: number | null }
      ) => callback(payload);
      ipcRenderer.on(TERMINAL_EXIT_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(TERMINAL_EXIT_EVENT, listener);
      };
    },
    resize: (params: { terminalId: string; cols: number; rows: number }) =>
      ipcRenderer.invoke(TERMINAL_RESIZE_CHANNEL, params),
    write: (params: { terminalId: string; data: string }) =>
      ipcRenderer.invoke(TERMINAL_WRITE_CHANNEL, params),
  });
}

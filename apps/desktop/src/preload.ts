// Electron preload script. `electron` is the ONE runtime require a sandboxed
// preload can resolve; every other import below is either type-only (erased)
// or a PURE relative module that `scripts/build-main-config.mjs` inlines into
// dist/preload.js (BST-1648). preload-sandbox-imports.test.ts walks that
// graph, and build-main.mjs refuses a bundle that requires anything else.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

import { clipboardContract } from './ipc-domains/clipboard.contract';
import { contextFilesContract } from './ipc-domains/context-files.contract';
import { skillsContract } from './ipc-domains/skills.contract';
import { userCommandsContract } from './ipc-domains/user-commands.contract';
import { userPersonasContract } from './ipc-domains/user-personas.contract';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { MAIN_OWNED_DESKTOP_STORAGE_KEYS } from './platform/desktop-storage-authority';
import { createBridgeExposer } from './platform/ipc-bridge';

type GitDiffParams = import('@brainstrike/types').GitDiffParams;
type EmbeddingTelemetrySnapshot =
  import('@brainstrike/embedding-worker').EmbeddingTelemetrySnapshot;
type StructuredFileDiffParams = import('@brainstrike/types').StructuredFileDiffParams;
type Changeset = import('@brainstrike/types').Changeset;
type WorktreeAdoptParams = import('@brainstrike/types').WorktreeAdoptParams;
type AssistantRewindMode = import('@brainstrike/assistant-contract').AssistantRewindMode;
type McpConfigStatus = import('./ipc-mcp').McpConfigStatus;
type McpContentIpcResponse = import('./mcp/content-ipc').McpContentIpcResponse;
type McpHostSnapshot = import('@brainstrike/assistant-contract').McpHostSnapshot;
type McpExtensionEnablement = import('@brainstrike/assistant-contract').McpExtensionEnablement;
type McpAppBridge = import('@brainstrike/assistant-contract').McpAppBridge;
type McpAppOrigin = import('@brainstrike/assistant-contract').McpAppOrigin;
type McpAppShellPrepareRequest =
  import('@brainstrike/assistant-contract').McpAppShellPrepareRequest;
type McpAppShellReleaseRequest =
  import('@brainstrike/assistant-contract').McpAppShellReleaseRequest;
type McpAppPrepareRequest = import('@brainstrike/assistant-contract').McpAppPrepareRequest;
type McpAppExecuteRequest = import('@brainstrike/assistant-contract').McpAppExecuteRequest;
type McpAppReleaseRequest = import('@brainstrike/assistant-contract').McpAppReleaseRequest;
type McpHostControlRequest = import('@brainstrike/assistant-contract').McpHostControlRequest;
type McpElicitationPresentationWire =
  import('@brainstrike/assistant-contract').McpElicitationPresentationWire;
type McpElicitationRetiredWire =
  import('@brainstrike/assistant-contract').McpElicitationRetiredWire;
type McpElicitationSettlement = import('@brainstrike/assistant-contract').McpElicitationSettlement;
type McpHostWatchEvent = import('@brainstrike/assistant-contract').McpHostWatchEvent;
type McpTaskActionRequest = import('@brainstrike/assistant-contract').McpTaskActionRequest;
type McpTaskActionResult = import('@brainstrike/assistant-contract').McpTaskActionResult;
type McpTaskBridge = import('@brainstrike/assistant-contract').McpTaskBridge;
type McpTaskListResult = import('@brainstrike/assistant-contract').McpTaskListResult;
type McpTaskStatusChangedEvent =
  import('@brainstrike/assistant-contract').McpTaskStatusChangedEvent;
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
// Contract-derived bridges (BST-1648): `exposeBridge(name, contract)` exposes
// exactly `Object.keys(contract)`, each routed to its manifest channel with
// the ONE `IpcResult` unwrap. Pinned by preload-contract-bridges.test.ts.
const exposeBridge = createBridgeExposer({ contextBridge, ipcRenderer });
// This set only selects the E2E-only seed channel; MAIN validates the exact
// authoritative allowlist again on every call.
const MAIN_OWNED_DESKTOP_STORAGE_KEYS_FOR_E2E = new Set<string>(MAIN_OWNED_DESKTOP_STORAGE_KEYS);

import type {
  ApplyManagedCacheBatchArgs,
  ApplyManagedCacheInvalidationsArgs,
  ManagedCacheInvalidationResult,
} from '@brainstrike/db';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { LoggingPreferences, LogRecord } from '@brainstrike/logging';
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
import type { DesktopPlatformDiagnosticsSnapshot } from './desktop-platform-diagnostics';
import type { MainLogWindowRequest, MainLogWindowResult } from './diagnostics/main-log-window';
import type { ProcessCounterSnapshot } from './diagnostics/process-counter-ring';
import type {
  EmbeddingHostBackfillRequest,
  EmbeddingHostQueryEmbeddingPayload,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
} from './embedding-host-shared';
import type { LoggingSettingsPayload } from './logging-shared';

// BST-338 preload duplicate contract: sandboxed preloads cannot import the
// canonical runtime module. This code and the file-read payload declarations
// below intentionally duplicate `file-read-errors.ts`; conformance tests
// source-evaluate this preload's own constants and predicate.
const FILE_READ_ERROR_CODE_TOO_LARGE = 'TOO_LARGE' as const;
/**
 * `mcp:content:*` failures travel as a result envelope (a thrown Error would
 * reach the renderer as Electron's formatted string, main-process stack
 * included). Rebuild a clean Error carrying only the fixed taxonomy.
 */
const unwrapMcpContent = async (
  response: Promise<McpContentIpcResponse>
): Promise<Extract<McpContentIpcResponse, { ok: true }>['result']> => {
  const settled = await response;
  if (settled.ok) {
    return settled.result;
  }
  throw Object.assign(
    new Error(`${settled.error.message} (${settled.error.category} · ${settled.error.code})`),
    { category: settled.error.category, code: settled.error.code }
  );
};

const readMcpAppResource = async (origin: McpAppOrigin): Promise<string> => {
  const snapshot = (await ipcRenderer.invoke(
    DESKTOP_IPC_CHANNELS.mcp.statusGet
  )) as McpHostSnapshot;
  const server = snapshot.servers.find(
    ({ configuredServerId }) => configuredServerId === origin.serverId
  );
  if (!server) {
    throw new Error(`MCP Apps server "${origin.serverId}" has no live content authority`);
  }
  const response = await unwrapMcpContent(
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.contentReadResource, {
      authority: { configuredServerId: origin.serverId, generation: server.generation },
      uri: origin.resourceUri,
    })
  );
  if (response.type !== 'resources/read') {
    throw new Error('MCP Apps resource read returned an unexpected operation type');
  }
  const content = response.result.contents.find(({ uri }) => uri === origin.resourceUri);
  if (!(content && 'text' in content) || typeof content.text !== 'string') {
    throw new Error(`MCP Apps resource "${origin.resourceUri}" has no text content`);
  }
  if (content.mimeType !== origin.mimeType) {
    throw new Error(
      `MCP Apps resource "${origin.resourceUri}" MIME type must be "${origin.mimeType}"`
    );
  }
  return content.text;
};
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
          ipcRenderer.send(DESKTOP_IPC_CHANNELS.logging.ingestBufferedRecord, {
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
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.db.liveQueryUpdate, dbLiveUpdateIpcListener);
  }

  return () => {
    dbLiveUpdateCallbacks.delete(callback);
    if (dbLiveUpdateCallbacks.size === 0 && dbLiveUpdateIpcListener) {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.db.liveQueryUpdate, dbLiveUpdateIpcListener);
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
    readonly telemetry: EmbeddingTelemetrySnapshot;
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

// See the BST-338 preload duplicate contract beside the first duplicated code.
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
      ) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.applyManagedCacheBatch, payload, options),
      clearAll: (confirmationToken?: string) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.clearAll, confirmationToken),
      diagnostics: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.diagnostics),
      exec: (sql: string, params?: unknown[], options?: DatabaseWorkOptions) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.exec, sql, params, options),
      insertChunksAndEnqueueEmbeddingJobs: (
        chunks: readonly ElectronChunkInsert[],
        fileRecordId: string,
        options: ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
        workOptions?: DatabaseWorkOptions
      ): Promise<void> =>
        ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.db.insertChunksAndEnqueueEmbeddingJobs,
          { chunks, fileRecordId, options },
          workOptions
        ),
      invalidateManagedCacheEntriesByIdentity: (
        payload: ApplyManagedCacheInvalidationsArgs,
        options?: DatabaseWorkOptions
      ): Promise<ManagedCacheInvalidationResult> =>
        ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity,
          payload,
          options
        ),
      ping: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.ping),
      query: (sql: string, params?: unknown[], options?: DatabaseWorkOptions) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.query, sql, params, options),
      resetLocal: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.resetLocal),
      // Atomic transaction over IPC (#1141): ships an ordered statement list to main
      // to run inside one pglite.transaction() and return statements[resultIndex] rows.
      runTransaction: (
        statements: {
          params?: unknown[];
          sql: string;
        }[],
        resultIndex: number,
        options?: DatabaseWorkOptions
      ) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.transaction, statements, resultIndex, options),
      schedulerSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.schedulerSnapshot),
      test: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.test),
    },
    dbLive: {
      onUpdate: (callback: (payload: { id: number; results: unknown }) => void) =>
        subscribeToDbLiveUpdates(callback),
      refresh: (
        payload: { id: number; offset?: number; limit?: number },
        options?: DatabaseWorkOptions
      ) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.liveQueryRefresh, payload, options),
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
      ) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.liveQueryStart, options, workOptions),
      stop: (id: number) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.liveQueryStop, id),
    },
    fileSystem: {
      addRoot: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.addRoot),
      addRootByPath: (path: string) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.addRootByPath, path),
      exists: (path: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.exists, path),
      getWatcherTelemetry: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.watchTelemetry),
      listRecentRoots: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.listRecentRoots),
      // One-way main→renderer watch pushes (fs:watch-event). Mirrors the other
      // subscribe-returns-unsubscribe bridges (e.g. power.onPowerState).
      onWatchEvent: (
        callback: (event: import('@brainstrike/types').FileSystemWatchEvent) => void
      ) => {
        const listener = (
          _event: unknown,
          payload: import('@brainstrike/types').FileSystemWatchEvent
        ) => callback(payload);
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.files.watchEvent, listener);
        return () => {
          ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.files.watchEvent, listener);
        };
      },
      // One-way main→renderer typed watcher health pushes (fs:watch-health,
      // BST-568 slice 3).
      onWatchHealth: (
        callback: (event: import('@brainstrike/types').WatcherHealthEvent) => void
      ) => {
        const listener = (
          _event: unknown,
          payload: import('@brainstrike/types').WatcherHealthEvent
        ) => callback(payload);
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.files.watchHealth, listener);
        return () => {
          ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.files.watchHealth, listener);
        };
      },
      readDirectory: (handle: DirectoryHandle) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.readDirectory, handle),
      readFile: async (handle: FileHandle) => {
        const result = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.readFile, handle);
        return unwrapFileReadResult(result);
      },
      readFileByAbsolutePath: async (absolutePath: string, rootPath: string, rootId: string) => {
        const result = await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.files.readFileByAbsolutePath,
          absolutePath,
          rootPath,
          rootId
        );
        return unwrapFileReadResult(result);
      },
      readFileByPath: async (absolutePath: string) => {
        const result = await ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.files.readFileByPath,
          absolutePath
        );
        return unwrapFileReadResult(result);
      },
      removeRoot: (rootId: string) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.removeRoot, rootId),
      requestDirectoryAccess: () =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.requestDirectoryAccess),
      restoreLastFolder: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.restoreLastFolder),
      restoreRoots: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.restoreRoots),
      retryWatch: (watchId: string) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.watchRetry, watchId),
      saveLastFolder: (folderPath: string) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.saveLastFolder, folderPath),
      unwatchDirectory: (watchId: string) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.unwatch, watchId),
      watchDirectory: (handle: DirectoryHandle) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.watch, handle),
    },
    // Database path (legacy - kept for compatibility)
    getUserDataPath: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.getUserDataPath),
    loadLayout: (): Promise<LayoutLoadResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.preferences.layoutLoad),
    // Panel layout persistence
    saveLayout: (state: PanelPersistenceState): Promise<LayoutPersistenceResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.preferences.layoutSave, state),
    storage: {
      clear: () =>
        ipcRenderer.invoke(
          DESKTOP_TEST_MODE
            ? DESKTOP_IPC_CHANNELS.storage.clearAllForE2e
            : DESKTOP_IPC_CHANNELS.storage.clear
        ),
      getAllKeys: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.storage.getAllKeys),
      getItem: (key: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.storage.getItem, key),
      removeItem: (key: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.storage.removeItem, key),
      setItem: (key: string, value: string) =>
        ipcRenderer.invoke(
          DESKTOP_TEST_MODE && MAIN_OWNED_DESKTOP_STORAGE_KEYS_FOR_E2E.has(key)
            ? DESKTOP_IPC_CHANNELS.storage.seedMainOwnedForE2e
            : DESKTOP_IPC_CHANNELS.storage.setItem,
          key,
          value
        ),
    },
  });
}

// Secure Secrets API
contextBridge.exposeInMainWorld('secrets', {
  clearAll: () =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.clearAll, SECRETS_CLEAR_CONFIRMATION_TOKEN),
  deleteKey: (provider: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.delete, provider),
  getCredential: (provider: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.getCredential, provider),
  getKey: (provider: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.get, provider),
  list: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.list),
  listStored: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.listStored),
  saveCredential: (provider: string, credential: unknown) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.saveCredential, provider, credential),
  saveKey: (provider: string, value: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.save, provider, value),
});

// Env bootstrap visibility bridge (BST-1363). Read-only and NAMES-ONLY: the
// main-process projection reports which .env files loaded, their paths, the
// line-precise parse failures, and the NAMES of allow-listed variables that
// are set — never a variable's value. Shape defined ONCE in
// @brainstrike/assistant-contract env-bootstrap-bridge.ts (EnvBootstrapBridge).
contextBridge.exposeInMainWorld('envBootstrap', {
  read: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.envBootstrap),
});

// Provider OAuth bridge (BST-1355). Status-only by contract: every method
// resolves a token-free ProviderAuthStatus; token material NEVER crosses IPC
// (legal gate BST-1351 constraint 3). Shape defined ONCE in
// @brainstrike/assistant-contract provider-auth.ts (ProviderAuthBridge).
contextBridge.exposeInMainWorld('providerAuth', {
  cancel: (provider: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.providerAuth.cancel, provider),
  disconnect: (provider: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.providerAuth.disconnect, provider),
  start: (provider: string, method?: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.providerAuth.start, provider, method),
  status: (provider: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.providerAuth.status, provider),
});

// Settings Store API (factory reset support)
contextBridge.exposeInMainWorld('settings', {
  clearAll: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.preferences.settingsClearAll),
});

contextBridge.exposeInMainWorld('desktopLifecycle', {
  isTestMode: DESKTOP_TEST_MODE,
  noteReloadIntent: (reason: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtime.noteReloadIntent, reason),
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
  parse: (request: unknown) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.parserHostParse, request),
});

// Local Agent API (non-streaming aggregate; renderer can pseudo-stream chunks)
contextBridge.exposeInMainWorld('agent', {
  chat: (messages: unknown[], runtime?: unknown) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.agent.chat, messages, runtime),
});

// MCP Config API (desktop-only)
contextBridge.exposeInMainWorld('mcp', {
  apps: {
    execute: (request: McpAppExecuteRequest) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.appsExecute, request),
    prepare: (request: McpAppPrepareRequest) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.appsPrepare, request),
    prepareShell: (request: McpAppShellPrepareRequest) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.appsPrepareShell, request),
    readResource: (origin: McpAppOrigin) => readMcpAppResource(origin),
    release: (request: McpAppReleaseRequest) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.appsRelease, request),
    releaseShell: (request: McpAppShellReleaseRequest) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.appsReleaseShell, request),
  } satisfies McpAppBridge,
  complete: (request: unknown) =>
    unwrapMcpContent(ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.contentComplete, request)),
  controlServer: (request: McpHostControlRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.lifecycleControl, request),
  createSampleConfig: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configCreateSample),
  disableServerTools: (serverName: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.toolsDisableServer, serverName),
  disableTools: (toolIds: string[]) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.toolsDisable, toolIds),
  enableServerTools: (serverName: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.toolsEnableServer, serverName),
  enableTools: (toolIds: string[]) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.toolsEnable, toolIds),
  getConfig: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configGet),
  getExtensionPreferences: (): Promise<McpExtensionEnablement> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.extensionsGet),
  getPath: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configGetPath),
  getPrompt: (request: unknown) =>
    unwrapMcpContent(ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.contentGetPrompt, request)),
  getServerStatusSnapshot: (): Promise<McpHostSnapshot> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.statusGet),
  getToolStats: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.toolsGetStats),
  // Tool management
  listTools: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.toolsList),
  onConfigUpdated: (callback: (config: McpConfigStatus) => void) => {
    const listener = (_event: unknown, config: McpConfigStatus) => callback(config);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.configUpdated, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.configUpdated, listener);
    };
  },
  onElicitationRequested: (callback: (presentation: McpElicitationPresentationWire) => void) => {
    const listener = (_event: unknown, presentation: McpElicitationPresentationWire) =>
      callback(presentation);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.elicitationRequested, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.elicitationRequested, listener);
    };
  },
  onElicitationRetired: (callback: (retired: McpElicitationRetiredWire) => void) => {
    const listener = (_event: unknown, retired: McpElicitationRetiredWire) => callback(retired);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.elicitationRetired, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.elicitationRetired, listener);
    };
  },
  onExtensionPreferencesUpdated: (callback: (preferences: McpExtensionEnablement) => void) => {
    const listener = (_event: unknown, preferences: McpExtensionEnablement) =>
      callback(preferences);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.extensionsUpdated, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.extensionsUpdated, listener);
    };
  },
  onServerStatusUpdated: (callback: (event: McpHostWatchEvent) => void) => {
    const listener = (_event: unknown, event: McpHostWatchEvent) => callback(event);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.statusUpdated, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.statusUpdated, listener);
    };
  },
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
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.toolsUpdated, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.toolsUpdated, listener);
    };
  },
  readConfigText: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configReadText),
  readResource: (request: unknown) =>
    unwrapMcpContent(ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.contentReadResource, request)),
  resetTools: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.toolsReset),
  selectPath: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configSelectPath),
  setExtensionPreferences: (preferences: McpExtensionEnablement): Promise<McpExtensionEnablement> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.extensionsSet, preferences),
  setPath: (configPath: string | null) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configSetPath, configPath),
  settleElicitation: (settlement: McpElicitationSettlement) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.elicitationSettle, settlement),
  // Durable MCP Tasks (BST-1566): visible UI only; hidden hosts never receive it.
  tasks: {
    act: (request: McpTaskActionRequest): Promise<McpTaskActionResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.taskAct, request),
    list: (): Promise<McpTaskListResult> => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.taskList),
    onStatusChanged: (callback: (event: McpTaskStatusChangedEvent) => void) => {
      const listener = (_event: unknown, event: McpTaskStatusChangedEvent) => callback(event);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.taskStatusChanged, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.taskStatusChanged, listener);
      };
    },
  } satisfies McpTaskBridge,
  unwatch: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configUnwatch),
  watch: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configWatch),
  writeConfigText: (content: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.configWriteText, content),
});

// Assistant selection events. Tool execution deliberately stays behind the
// server-owned assistant permission engine and is not exposed to renderers.
contextBridge.exposeInMainWorld('tools', {
  onPreviewContextSelectionUpdate: (
    callback: (payload: AssistantSelectionUpdatePayload) => void
  ) => {
    const listener = (_event: unknown, payload: AssistantSelectionUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.agent.previewContextSelectionUpdate, listener);
    return () => {
      ipcRenderer.removeListener(
        DESKTOP_IPC_CHANNELS.agent.previewContextSelectionUpdate,
        listener
      );
    };
  },
  onRootTreeSelectionUpdate: (callback: (payload: AssistantSelectionUpdatePayload) => void) => {
    const listener = (_event: unknown, payload: AssistantSelectionUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.agent.rootTreeSelectionUpdate, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.agent.rootTreeSelectionUpdate, listener);
    };
  },
  onWorkspaceContextSelectionUpdate: (
    callback: (payload: AssistantWorkspaceContextSelectionUpdatePayload) => void
  ) => {
    const listener = (_event: unknown, payload: AssistantWorkspaceContextSelectionUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.agent.workspaceContextSelectionUpdate, listener);
    return () => {
      ipcRenderer.removeListener(
        DESKTOP_IPC_CHANNELS.agent.workspaceContextSelectionUpdate,
        listener
      );
    };
  },
  onWorkspaceContextTapestryUpdate: (
    callback: (payload: AssistantWorkspaceTapestryUpdatePayload) => void
  ) => {
    const listener = (_event: unknown, payload: AssistantWorkspaceTapestryUpdatePayload) =>
      callback(payload);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.agent.workspaceContextTapestryUpdate, listener);
    return () => {
      ipcRenderer.removeListener(
        DESKTOP_IPC_CHANNELS.agent.workspaceContextTapestryUpdate,
        listener
      );
    };
  },
});

// Assistant UI (data stream) endpoint helper. getAuth returns { url, token },
// { startupError } when the server failed to start, or null while starting;
// every renderer request to the assistant server must send the token — see
// assistant-contract assistant-auth (AssistantServerAuthResult).
contextBridge.exposeInMainWorld('assistant', {
  getAuth: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.agent.assistantGetAuth),
  getUrl: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.agent.assistantGetUrl),
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
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtime.listModels, runtimeId, options),
          probe: (runtimeId: string, options: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtime.probe, runtimeId, options),
          resolveOllamaCapabilities: (modelId: string, options: unknown) =>
            ipcRenderer.invoke(
              DESKTOP_IPC_CHANNELS.runtime.resolveOllamaCapabilities,
              modelId,
              options
            ),
          verifyEmbeddingDimensions: (runtimeId: string, modelId: string, options: unknown) =>
            ipcRenderer.invoke(
              DESKTOP_IPC_CHANNELS.runtime.verifyEmbeddingDimensions,
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
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.getBufferedLogs),
    getPreferences: (): Promise<LoggingSettingsPayload> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.getPreferences),
    ingestBufferedRecord: (record: LogRecord): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.logging.ingestBufferedRecord, record);
    },
    onDurableRecord: (listener: (record: LogRecord) => void) => {
      const ipcListener = (_event: unknown, record: LogRecord) => listener(record);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.logging.durableRecord, ipcListener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.logging.durableRecord, ipcListener);
      };
    },
    onPreferencesUpdated: (callback: (preferences: LoggingPreferences) => void) => {
      const listener = (_event: unknown, prefs: LoggingPreferences) => callback(prefs);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.logging.preferencesUpdated, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.logging.preferencesUpdated, listener);
      };
    },
    openDestination: (target: string | null): Promise<boolean> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.openDestination, target ?? null),
    selectDestination: (): Promise<string | null> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.selectDestination),
    setPreferences: (preferences: LoggingPreferences): Promise<LoggingSettingsPayload> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.setPreferences, preferences),
  });
}

if (shouldExposeBridge('desktopDiagnostics')) {
  contextBridge.exposeInMainWorld('desktopDiagnostics', {
    getSnapshot: (): Promise<DesktopPlatformDiagnosticsSnapshot> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.getSnapshot),
    readMainLogWindow: (request: MainLogWindowRequest): Promise<MainLogWindowResult> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow, request),
    readProcessCounters: (): Promise<ProcessCounterSnapshot> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters),
  });
}

// Power state events (suspend/resume awareness for GPU keep-alive, etc.)
contextBridge.exposeInMainWorld('power', {
  getSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtime.powerSnapshot),
  onPowerState: (callback: (state: 'suspend' | 'resume') => void) => {
    const listener = (_event: unknown, state: 'suspend' | 'resume') => callback(state);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.runtime.powerState, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtime.powerState, listener);
    };
  },
});

// ⌘K command palette: the app menu's Cmd+K accelerator pushes this event to the
// focused window so the renderer (visible-UI root) can open the palette. Mirrors
// the other one-way main→renderer `on*` bridges (e.g. power.onPowerState).
contextBridge.exposeInMainWorld('commandPalette', {
  onOpen: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.commandPalette.open, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.commandPalette.open, listener);
    };
  },
});

// ⌘P quick-open: the app menu's Cmd+P accelerator pushes this event to the
// focused window so the renderer (visible-UI root) opens the quick-open finder.
// Mirrors the commandPalette one-way main→renderer bridge.
contextBridge.exposeInMainWorld('quickOpen', {
  onOpen: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.quickOpen.open, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.quickOpen.open, listener);
    };
  },
});

// Low-friction folder connection (BST-1393, spec §7): the app menu's
// Open Folder… / Open Recent, `brainstrike <path>` argv, macOS open-file, and
// resolving a Finder-dropped folder to an absolute path. The two `on*` members
// mirror commandPalette/quickOpen; `getDroppedPath` is preload-local.
let workspaceResetGenerationPayload: unknown = { resetGeneration: null };
ipcRenderer.on(
  DESKTOP_IPC_CHANNELS.workspace.factoryResetGeneration,
  (_event: unknown, payload: unknown) => {
    // Echo the payload unchanged. Main validates it strictly so malformed
    // wiring becomes an immediate reset diagnostic rather than being silently
    // normalized into a timeout.
    workspaceResetGenerationPayload = payload;
  }
);

if (shouldExposeBridge('workspace')) {
  contextBridge.exposeInMainWorld('workspace', {
    getDroppedPath: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        // Documented throw: the argument was not a File. Reported as "no
        // path", which the renderer counts and states — never a silent skip.
        return '';
      }
    },
    // The one renderer→main member of this bridge: fire-and-forget, no
    // response expected. `WorkspaceConnectHost` calls this the instant it
    // subscribes to `onOpenPath`, so main can gate delivery on the renderer
    // actually being ready to receive rather than merely having loaded.
    notifyOpenPathReady: (): void => {
      ipcRenderer.send(
        DESKTOP_IPC_CHANNELS.workspace.openPathReady,
        workspaceResetGenerationPayload
      );
    },
    onOpenFolderPicker: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.workspace.openFolderPicker, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.workspace.openFolderPicker, listener);
      };
    },
    onOpenPath: (callback: (request: unknown) => void) => {
      const listener = (_event: unknown, request: unknown) => callback(request);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.workspace.openPath, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.workspace.openPath, listener);
      };
    },
  });
}

contextBridge.exposeInMainWorld('embeddingHost', {
  cancelAllBackfills: (): Promise<void> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.cancelAllBackfills),
  cancelBackfill: (embeddingSetId: string): Promise<void> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.cancelBackfill, embeddingSetId),
  enqueueBackfill: (request: EmbeddingHostBackfillRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.enqueueBackfill, request),
  ensureStarted: (): Promise<EmbeddingHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.ensureStarted),
  getBackfillsInFlight: (): Promise<EmbeddingHostBackfillInfo[]> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.getBackfillsInFlight),
  getStatus: (): Promise<EmbeddingHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.getStatus),
  onBackfillProgress: (callback: (progress: EmbeddingHostBackfillProgress) => void) => {
    const listener = (_event: unknown, progress: EmbeddingHostBackfillProgress) =>
      callback(progress);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.embeddingHost.backfillProgress, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.embeddingHost.backfillProgress, listener);
    };
  },
  onCommand: (callback: (command: EmbeddingHostCommand) => void) => {
    const listener = (_event: unknown, command: EmbeddingHostCommand) => callback(command);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.embeddingHost.command, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.embeddingHost.command, listener);
    };
  },
  onQueryEmbeddingRequest: (callback: (request: EmbeddingHostQueryEmbeddingRequest) => void) => {
    const listener = (_event: unknown, request: EmbeddingHostQueryEmbeddingRequest) =>
      callback(request);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbeddingRequest, listener);
    return () => {
      ipcRenderer.removeListener(
        DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbeddingRequest,
        listener
      );
    };
  },
  onStatus: (callback: (status: EmbeddingHostStatus) => void) => {
    const listener = (_event: unknown, status: EmbeddingHostStatus) => callback(status);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.embeddingHost.status, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.embeddingHost.status, listener);
    };
  },
  queryEmbedding: (payload: EmbeddingHostQueryEmbeddingPayload): Promise<number[]> =>
    ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding,
      assertEmbeddingHostQueryEmbeddingPayload(payload)
    ),
  reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport): void => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.embeddingHost.reportQueryEmbeddingResponse, response);
  },
  reportStatus: (status: EmbeddingHostStatus): void => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.embeddingHost.reportStatus, status);
  },
  reset: (): Promise<EmbeddingHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.reset),
  stop: (): Promise<EmbeddingHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.stop),
});

contextBridge.exposeInMainWorld('chunkingHost', {
  chunkBatch: (request: ChunkingHostChunkBatchRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chunkingHost.chunkBatch, request),
  chunkFile: (request: ChunkingHostChunkFileRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chunkingHost.chunkFile, request),
  ensureStarted: (): Promise<ChunkingHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chunkingHost.ensureStarted),
  getStatus: (): Promise<ChunkingHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chunkingHost.getStatus),
  onProgress: (callback: (progress: ChunkingHostProgressEvent) => void) => {
    const listener = (_event: unknown, progress: ChunkingHostProgressEvent) => callback(progress);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.chunkingHost.progress, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.chunkingHost.progress, listener);
    };
  },
  onRequest: (callback: (request: ChunkingHostRequest) => void) => {
    const listener = (_event: unknown, request: ChunkingHostRequest) => callback(request);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.chunkingHost.request, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.chunkingHost.request, listener);
    };
  },
  onStatus: (callback: (status: ChunkingHostStatus) => void) => {
    const listener = (_event: unknown, status: ChunkingHostStatus) => callback(status);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.chunkingHost.status, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.chunkingHost.status, listener);
    };
  },
  reportResponse: (response: ChunkingHostResponseReport): void => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.chunkingHost.reportResponse, response);
  },
  reportStatus: (status: ChunkingHostStatus): void => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.chunkingHost.reportStatus, status);
  },
  reset: (): Promise<ChunkingHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chunkingHost.reset),
  stop: (): Promise<ChunkingHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chunkingHost.stop),
});

contextBridge.exposeInMainWorld('llmHost', {
  cancel: (requestId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.llmHost.cancel, requestId),
  ensureStarted: (): Promise<LlmHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.llmHost.ensureStarted),
  generate: (payload: {
    requestId?: string;
    modelId: string;
    messages: unknown[];
    options?: unknown;
  }) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.llmHost.generate, {
      kind: 'generate',
      ...(payload.requestId === undefined ? {} : { clientRequestId: payload.requestId }),
      messages: payload.messages,
      modelId: payload.modelId,
      ...(payload.options === undefined ? {} : { options: payload.options }),
    }),
  getStatus: (): Promise<LlmHostStatus> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.llmHost.getStatus),
  onProgress: (callback: (progress: LlmHostResponseReport) => void) => {
    const listener = (_event: unknown, progress: LlmHostResponseReport) => callback(progress);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.llmHost.progress, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.llmHost.progress, listener);
    };
  },
  onRequest: (callback: (request: LlmHostRequest) => void) => {
    const listener = (_event: unknown, request: LlmHostRequest) => callback(request);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.llmHost.request, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.llmHost.request, listener);
    };
  },
  onStatus: (callback: (status: LlmHostStatus) => void) => {
    const listener = (_event: unknown, status: LlmHostStatus) => callback(status);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.llmHost.status, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.llmHost.status, listener);
    };
  },
  reportProgress: (progress: LlmHostResponseReport): void => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.llmHost.reportProgress, progress);
  },
  reportResponse: (response: LlmHostResponseReport): void => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.llmHost.reportResponse, response);
  },
  reportStatus: (status: LlmHostStatus): void => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.llmHost.reportStatus, status);
  },
  reset: (): Promise<LlmHostStatus> => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.llmHost.reset),
  stop: (): Promise<LlmHostStatus> => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.llmHost.stop),
  warmup: (payload: { modelId: string; requestId?: string } | string) =>
    ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.llmHost.warmup,
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
exposeBridge('clipboard', clipboardContract);

// File-export save bridge (desktop-only): writes export bytes into the OS
// Downloads folder from MAIN, bypassing Chromium's blob-download pipeline
// (a blob download whose URL is revoked mid-flight can wedge permanently and
// jam later downloads). Web never defines this; `@brainstrike/utils`'s
// `downloadBlobFile` capability-checks `window.fileExports` and falls back to
// the anchor path there.
if (shouldExposeBridge('fileExports')) {
  contextBridge.exposeInMainWorld('fileExports', {
    saveToDownloads: (payload: { bytes: Uint8Array; filename: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.fileExports.saveToDownloads, payload),
  });
}

// Edit checkpoint (undo of agent file edits) — invoke-only revert bridge. Desktop
// only: web never defines this (no assistant server / main process).
contextBridge.exposeInMainWorld('assistantCheckpoints', {
  availability: (threadId: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.assistantCheckpoint.availability, { threadId }),
  revertEntry: (id: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.assistantCheckpoint.revertEntry, {
      force: options?.force ?? false,
      id,
    }),
  revertRun: (runId: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.assistantCheckpoint.revertRun, {
      force: options?.force ?? false,
      runId,
    }),
});

// Platform shell bridge: reveal/open absolute paths in the OS file manager.
if (shouldExposeBridge('platform')) {
  contextBridge.exposeInMainWorld('platform', {
    openExternal: (url: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.shell.openExternal, url),
    openPath: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.shell.openPath, absolutePath),
    showItemInFolder: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.shell.showItemInFolder, absolutePath),
  });
}

// Git bridge (desktop-only): typed git operations on a workspace root. Every
// call passes the durable `rootId` (DB roots.id) — main resolves + containment-
// checks it to an absolute cwd and runs git via execFile (no shell). Web never
// constructs this bridge (there is no preload), so `window.git` is simply
// absent there; consumers must capability-check `window.git` rather than
// `isElectron()`.
if (shouldExposeBridge('git')) {
  contextBridge.exposeInMainWorld('git', {
    aheadBehind: (rootId: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.aheadBehind, rootId),
    commit: (rootId: string, params: { description?: string; summary: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.commit, rootId, params),
    commitFiles: (rootId: string, params: { commit: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.commitFiles, rootId, params),
    createBranch: (rootId: string, params: { branch: string; startPoint?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.createBranch, rootId, params),
    diff: (rootId: string, params: GitDiffParams) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.diff, rootId, params),
    fetch: (rootId: string, params: { remote: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.fetch, rootId, params),
    history: (rootId: string, params: { limit: number; offset: number; ref?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.history, rootId, params),
    pull: (rootId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.pull, rootId),
    push: (rootId: string, params?: { remote?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.push, rootId, params ?? {}),
    repository: (rootId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.repository, rootId),
    stage: (rootId: string, params?: { path?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.stage, rootId, params ?? {}),
    status: (rootId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.status, rootId),
    structuredFileDiff: (rootId: string, params: StructuredFileDiffParams) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.structuredFileDiff, rootId, params),
    switchBranch: (rootId: string, params: { branch: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.switchBranch, rootId, params),
    unstage: (rootId: string, params?: { path?: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.git.unstage, rootId, params ?? {}),
  });
}

// Changeset diff bridge (desktop-only, BST-1113): resolves any `Changeset`
// (agent-run / run-range / git-scope) to an eager `ChangesetView` and loads
// per-file `StructuredFileDiff`s lazily. Web never constructs this bridge
// (there is no preload), so `window.changes` is simply absent there;
// consumers must capability-check `window.changes` rather than
// `isElectron()`. Backed by ChangesetDiffService via the `changes` IPC
// domain (changes-ipc-handlers.ts).
if (shouldExposeBridge('changes')) {
  contextBridge.exposeInMainWorld('changes', {
    // Conversation Rewind (BST-1115 W5 T4). `mode` is required on apply —
    // there is no default that silently reverts files (Amendment 1).
    applyRewind: (payload: {
      acknowledgeConflicts?: boolean;
      messageId: string;
      mode: AssistantRewindMode;
      threadId: string;
    }) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.changes.applyRewind, payload),
    fileDiff: (rootId: string, changeset: Changeset, path: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.changes.fileDiff, rootId, changeset, path),
    // Ends the redo window (BST-1115 W5 T4b). Fired by the renderer when a
    // USER-authored message starts a new run; a thread with no outstanding
    // rewind answers `finalized: false` and writes nothing.
    finalizeRewinds: (payload: { threadId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.changes.finalizeRewinds, payload),
    // Repository/worktree topology for the Changes surface (BST-1114 T0).
    // `{ maxAgeMs: 0 }` forces a rebuild that started after the call — the
    // seam a renderer that just registered a root uses to get its repository
    // discovered and watched (BST-1397).
    inventory: (options?: { maxAgeMs?: number }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.changes.inventory, options),
    // One-way main→renderer live-refresh pushes (changes:invalidated,
    // BST-1161 spec §6): external git activity on a repository. Returns the
    // unsubscribe function (terminal onData precedent).
    onInvalidated: (
      callback: (event: import('@brainstrike/types').ChangesInvalidationEvent) => void
    ) => {
      const listener = (
        _event: unknown,
        payload: import('@brainstrike/types').ChangesInvalidationEvent
      ) => callback(payload);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.changes.invalidated, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.changes.invalidated, listener);
      };
    },
    redoRewind: (payload: { acknowledgeConflicts?: boolean; rewindId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.changes.redoRewind, payload),
    resolveView: (rootId: string, changeset: Changeset) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.changes.resolveView, rootId, changeset),
    rewindPreview: (payload: { threadId: string } & ({ messageId: string } | { runId: string })) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.changes.rewindPreview, payload),
  });
}

// Managed-worktree bridge (desktop-only, BST-1390): create / list / archive /
// restore linked worktrees and read the managed-directory settings. Web never
// constructs this bridge, so `window.worktrees` is simply absent there;
// consumers capability-check it rather than `isElectron()`.
if (shouldExposeBridge('worktrees')) {
  contextBridge.exposeInMainWorld('worktrees', {
    adopt: (params: WorktreeAdoptParams) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.adopt, params),
    archive: (params: {
      confirmIgnoredEntries?: string;
      force?: boolean;
      runId?: string;
      worktreeId: string;
    }) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.archive, params),
    checkoutStatus: (params: { path: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.checkoutStatus, params),
    create: (params: unknown) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.create, params),
    createBranchHere: (params: { branch: string; worktreeId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.createBranchHere, params),
    createContext: (params: { rootId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.createContext, params),
    getSettings: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.getSettings),
    inspectArchive: (params: { worktreeId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.inspectArchive, params),
    list: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.list),
    listManagedPaths: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.managedPaths),
    restore: (params: { worktreeId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.restore, params),
    setSettings: (params: {
      managedDirectory: string | null;
      setupCommand: readonly string[] | null | 'disabled';
    }) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.worktrees.setSettings, params),
  });
}

// Forge (pull request) bridge (desktop-only, BST-1391): PR identity + status
// for a workspace root, backed by the main-process ForgeService and the `gh`
// CLI. Web never constructs this bridge (there is no preload), so
// `window.forge` is simply absent there; consumers must capability-check
// `window.forge` rather than `isElectron()`.
if (shouldExposeBridge('forge')) {
  contextBridge.exposeInMainWorld('forge', {
    identity: (rootId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.forge.identity, rootId),
    // One-way main→renderer pushes (forge:prUpdated): a forge observation
    // changed. Returns the unsubscribe function (changes.onInvalidated
    // precedent).
    onPrUpdated: (callback: (event: import('@brainstrike/types').ForgePrUpdatedEvent) => void) => {
      const listener = (
        _event: unknown,
        payload: import('@brainstrike/types').ForgePrUpdatedEvent
      ) => callback(payload);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.forge.prUpdated, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.forge.prUpdated, listener);
      };
    },
    prStatus: (rootId: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.forge.prStatus, rootId),
    refresh: (
      rootId: string,
      params: { readonly reason: import('@brainstrike/types').ForgeRendererRefreshReason }
    ) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.forge.refresh, rootId, params),
  });
}

// Embedded browser pane bridge (BST-1174). Every invoke returns the main-side
// `{ ok, value } | { ok: false, error }` result; the bridge UNWRAPS it and
// throws on `ok: false` — the renderer only ever passes well-formed args, so a
// rejection is a programming error worth surfacing, never a silent no-op.
if (shouldExposeBridge('browser')) {
  const unwrapBrowserResult = <T>(result: unknown): T => {
    if (typeof result === 'object' && result !== null && 'ok' in result) {
      const typed = result as { ok: boolean; value?: T; error?: string };
      if (typed.ok) {
        return typed.value as T;
      }
      throw new Error(`browser bridge call failed: ${typed.error ?? 'unknown error'}`);
    }
    throw new Error('browser bridge returned a malformed result');
  };
  contextBridge.exposeInMainWorld('browser', {
    closeTab: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.closeTab, tabId)
        .then(unwrapBrowserResult<void>),
    createTab: (url?: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.createTab, url)
        .then(unwrapBrowserResult<string>),
    goBack: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.goBack, tabId)
        .then(unwrapBrowserResult<void>),
    goForward: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.goForward, tabId)
        .then(unwrapBrowserResult<void>),
    listTabs: () =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.listTabs)
        .then(unwrapBrowserResult<unknown[]>),
    navigate: (tabId: string, url: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.navigate, tabId, url)
        .then(unwrapBrowserResult<void>),
    // One-way main→renderer tab-state pushes (browser:tabsChanged). Subscribe-
    // returns-unsubscribe, mirroring changes.onInvalidated / fs.onWatchEvent.
    onTabsChanged: (callback: (tabs: unknown[]) => void) => {
      const listener = (_event: unknown, tabs: unknown[]) => callback(tabs);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.browser.tabsChanged, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.browser.tabsChanged, listener);
      };
    },
    reload: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.reload, tabId)
        .then(unwrapBrowserResult<void>),
    selectTab: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.selectTab, tabId)
        .then(unwrapBrowserResult<void>),
    setBounds: (rect: { height: number; width: number; x: number; y: number }) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.setBounds, rect)
        .then(unwrapBrowserResult<void>),
    setOccluded: (occluded: boolean) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.setOccluded, occluded)
        .then(unwrapBrowserResult<void>),
  });
}

// Hooks trust-review bridge (desktop). Capability-gated: the Hooks settings
// panel reads a project root's `.brainstrike/hooks.json` (content + sha256) to
// display before the user approves it. The server remains the trust authority.
if (shouldExposeBridge('hooks')) {
  contextBridge.exposeInMainWorld('hooks', {
    getProjectHooksForReview: (rootId: string, absPath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.hooks.getProjectHooksForReview, rootId, absPath),
    // Maps mounted-root absolute paths → their DB `roots.id` so the assistant
    // wrapper can SCOPE the hook-trust attestation to currently-mounted roots
    // (a disconnected root's grant is never presented to the server).
    resolveTrustedRootIds: (absPaths: readonly string[]) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.hooks.resolveTrustedRootIds, absPaths),
  });
}

// Workspace context-files bridge (desktop). Capability-gated: the Workspace
// Instructions settings panel scans each mounted root's detected
// AGENTS.md/AGENT.md/CLAUDE.md (size + token estimate + injection status) so the
// user can opt an oversized file in. Web never constructs this bridge.
if (shouldExposeBridge('contextFiles')) {
  exposeBridge('contextFiles', contextFilesContract);
}

// User-defined slash command discovery bridge (desktop-only). Capability-gated:
// the composer's "/" menu calls `list` to load prompt-template commands scanned
// from `.brainstrike/commands` + `.claude/commands`. Web never constructs this
// bridge (no preload), so consumers must capability-check `window.userCommands`
// rather than `isElectron()`.
if (shouldExposeBridge('userCommands')) {
  exposeBridge('userCommands', userCommandsContract);
}

// Agent Skills discovery bridge (desktop-only). Capability-gated: the Settings
// → Skills panel and the composer's "/" menu call `scan` to list every skill
// discovered across `.brainstrike/skills` + `.claude/skills` (mounted roots +
// home). Web never constructs this bridge (no preload), so consumers must
// capability-check `window.skills` rather than `isElectron()`.
if (shouldExposeBridge('skills')) {
  exposeBridge('skills', skillsContract);
}

// Subagent persona discovery bridge (desktop-only). Capability-gated: the
// Settings -> Subagents panel calls `list` to show built-in + user-defined
// personas scanned from `.brainstrike/agents`. Web never constructs this
// bridge (no preload), so consumers must capability-check
// `window.assistantPersonas` rather than `isElectron()`.
if (shouldExposeBridge('assistantPersonas')) {
  exposeBridge('assistantPersonas', userPersonasContract);
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
    create: (params: { rootId: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.terminal.create, params),
    destroy: (params: { terminalId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.terminal.destroy, params),
    onData: (callback: (event: { terminalId: string; data: string }) => void) => {
      const listener = (_event: unknown, payload: { terminalId: string; data: string }) =>
        callback(payload);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.terminal.data, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.terminal.data, listener);
      };
    },
    onExit: (
      callback: (event: { terminalId: string; exitCode: number; signal: number | null }) => void
    ) => {
      const listener = (
        _event: unknown,
        payload: { terminalId: string; exitCode: number; signal: number | null }
      ) => callback(payload);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.terminal.exit, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.terminal.exit, listener);
      };
    },
    resize: (params: { terminalId: string; cols: number; rows: number }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.terminal.resize, params),
    write: (params: { terminalId: string; data: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.terminal.write, params),
  });
}

// Command-session inventory bridge (desktop-only). These sessions are owned by
// the main-process assistant runtime and intentionally survive renderer reloads.
// The bridge exposes workspace-scoped observation/control only; web omits it.
if (shouldExposeBridge('commandSessions')) {
  contextBridge.exposeInMainWorld('commandSessions', {
    list: (params: { rootId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.commandSessions.list, params),
    read: (params: { rootId: string; sessionId: string; cursor?: number }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.commandSessions.read, params),
    remove: (params: { rootId: string; sessionId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.commandSessions.remove, params),
    stop: (params: { rootId: string; sessionId: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.commandSessions.stop, params),
    write: (params: { rootId: string; sessionId: string; data: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.commandSessions.write, params),
  });
}

// Notes vault bridge (desktop-only): Node-fs backend for the markdown notes
// vault, per packages/notes-vault/src/desktop/bridge-contract.ts. Every path is
// containment-checked in main against the APPROVED vault roots; every method
// resolves to a structured NotesVaultResult (never throws across IPC).
// pickDirectory resolves { ok: true, value: null } when the user cancels the
// native dialog. Watch change pushes arrive one-way on `notes-vault:changed`
// for THIS renderer only; `onChanged` registers a listener and returns an
// unsubscribe fn. Web never constructs this bridge (no preload), so consumers
// must capability-check `window.notesVault` rather than `isElectron()`.
if (shouldExposeBridge('notesVault')) {
  contextBridge.exposeInMainWorld('notesVault', {
    createDirectory: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.createDirectory, absolutePath),
    deleteEntry: (absolutePath: string, options: { recursive: boolean }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.deleteEntry, absolutePath, options),
    ensureDefaultVault: () =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.ensureDefaultVault),
    listDirectory: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.listDirectory, absolutePath),
    onChanged: (callback: (event: { watchId: string }) => void) => {
      const listener = (_event: unknown, payload: { watchId: string }) => callback(payload);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.notesVault.changed, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.notesVault.changed, listener);
      };
    },
    pickDirectory: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.pickDirectory),
    readFile: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.readFile, absolutePath),
    registerRoot: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.registerRoot, absolutePath),
    rename: (fromPath: string, toPath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.rename, fromPath, toPath),
    statEntry: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.statEntry, absolutePath),
    unwatch: (watchId: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.unwatch, watchId),
    watch: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.watch, absolutePath),
    writeFile: (absolutePath: string, content: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.notesVault.writeFile, absolutePath, content),
  });
}

// Electron preload script. `electron` is the ONE runtime require a sandboxed
// preload can resolve; every other import below is either type-only (erased)
// or a PURE relative module that `scripts/build-main-config.mjs` inlines into
// dist/preload.js (BST-1648). preload-sandbox-imports.test.ts walks that
// graph, and build-main.mjs refuses a bundle that requires anything else.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

import { changesContract } from './ipc-domains/changes.contract';
import { clipboardContract } from './ipc-domains/clipboard.contract';
import { commandSessionsContract } from './ipc-domains/command-sessions.contract';
import { contextFilesContract } from './ipc-domains/context-files.contract';
import {
  type DatabaseLiveBridge,
  type DatabaseLiveQueryUpdate,
  type DatabasePathBridge,
  databaseContract,
  databaseIntegrityContract,
  databaseLiveContract,
  databasePathContract,
} from './ipc-domains/database.contract';
import { fileSystemContract, fileSystemWatchContract } from './ipc-domains/file-system.contract';
import { forgeContract } from './ipc-domains/forge.contract';
import { gitContract } from './ipc-domains/git.contract';
import { indexSearchContract } from './ipc-domains/index-search.contract';
import {
  mcpAppsContract,
  mcpContentContract,
  mcpContract,
  mcpElicitationContract,
  mcpPathSelectionContract,
  mcpTasksContract,
} from './ipc-domains/mcp.contract';
import { notesVaultContract } from './ipc-domains/notes-vault.contract';
import { skillsContract } from './ipc-domains/skills.contract';
import {
  layoutContract,
  settingsContract,
  storageContract,
} from './ipc-domains/storage-preferences.contract';
import { terminalContract } from './ipc-domains/terminal.contract';
import { userCommandsContract } from './ipc-domains/user-commands.contract';
import { userPersonasContract } from './ipc-domains/user-personas.contract';
import { windowFocusContract } from './ipc-domains/window-focus.contract';
import { worktreesContract } from './ipc-domains/worktrees.contract';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { MAIN_OWNED_DESKTOP_STORAGE_KEYS } from './platform/desktop-storage-authority';
import { createBridgeExposer, createIpcBridge } from './platform/ipc-bridge';

type McpContentIpcResponse = import('./ipc-domains/mcp.contract').McpContentIpcResponse;
type McpHostSnapshot = import('@brainstrike/assistant-contract').McpHostSnapshot;
type McpAppBridge = import('@brainstrike/assistant-contract').McpAppBridge;
type McpAppOrigin = import('@brainstrike/assistant-contract').McpAppOrigin;
type McpTaskBridge = import('@brainstrike/assistant-contract').McpTaskBridge;
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
// Contract-derived bridges (BST-1648): `exposeBridge(name, contract)` exposes
// exactly `Object.keys(contract)`, each routed to its manifest channel with
// the ONE `IpcResult` unwrap. Pinned by preload-contract-bridges.test.ts.
const exposeBridge = createBridgeExposer({ contextBridge, ipcRenderer });
// This set only selects the E2E-only seed channel; MAIN validates the exact
// authoritative allowlist again on every call.
const MAIN_OWNED_DESKTOP_STORAGE_KEYS_FOR_E2E = new Set<string>(MAIN_OWNED_DESKTOP_STORAGE_KEYS);

import type { FileHandle } from '@brainstrike/file-system';
import type { LoggingPreferences, LogRecord } from '@brainstrike/logging';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';
import type {
  ChunkingHostChunkBatchRequest,
  ChunkingHostChunkFileByIdRequest,
  ChunkingHostChunkFileRequest,
  ChunkingHostProgressEvent,
  ChunkingHostRequest,
  ChunkingHostResponseReport,
  ChunkingHostStatus,
} from './chunking-host-shared';
import type { DesktopPlatformDiagnosticsSnapshot } from './desktop-platform-diagnostics';
import type { MainLogWindowRequest, MainLogWindowResult } from './diagnostics/main-log-window';
import type { ProcessCounterSnapshot } from './diagnostics/process-counter-ring';
import type {
  EmbeddingHostBackfillInfo,
  EmbeddingHostBackfillProgress,
  EmbeddingHostBackfillRequest,
  EmbeddingHostCommand,
  EmbeddingHostDocumentEmbeddingsCancel,
  EmbeddingHostDocumentEmbeddingsPayload,
  EmbeddingHostDocumentEmbeddingsRequest,
  EmbeddingHostDocumentEmbeddingsResponseReport,
  EmbeddingHostQueryEmbeddingCancel,
  EmbeddingHostQueryEmbeddingPayload,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
  EmbeddingHostStatus,
} from './embedding-host-shared';
import type { LoggingSettingsPayload } from './logging-shared';
import {
  assertDesktopElectronApiKeyParity,
  type VisibleChunkingHostBridge,
  type VisibleDesktopElectronApi,
  type VisibleEmbeddingHostBridge,
} from './types/desktop-electron-api';

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
  const snapshot = (await mcpRootBridge.getServerStatusSnapshot()) as McpHostSnapshot;
  const server = snapshot.servers.find(
    ({ configuredServerId }) => configuredServerId === origin.serverId
  );
  if (!server) {
    throw new Error(`MCP Apps server "${origin.serverId}" has no live content authority`);
  }
  const response = await unwrapMcpContent(
    mcpContentBridge.readResource({
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

type DbLiveUpdateCallback = (payload: DatabaseLiveQueryUpdate) => void;

const dbLiveUpdateCallbacks = new Set<DbLiveUpdateCallback>();
let dbLiveUpdateIpcListener: ((_event: unknown, payload: DatabaseLiveQueryUpdate) => void) | null =
  null;

function subscribeToDbLiveUpdates(callback: DbLiveUpdateCallback): () => void {
  dbLiveUpdateCallbacks.add(callback);

  if (!dbLiveUpdateIpcListener) {
    dbLiveUpdateIpcListener = (_event: unknown, payload: DatabaseLiveQueryUpdate) => {
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
    ipcRenderer.on(databaseLiveContract.onUpdate.channel, dbLiveUpdateIpcListener);
  }

  return () => {
    dbLiveUpdateCallbacks.delete(callback);
    if (dbLiveUpdateCallbacks.size === 0 && dbLiveUpdateIpcListener) {
      ipcRenderer.removeListener(databaseLiveContract.onUpdate.channel, dbLiveUpdateIpcListener);
      dbLiveUpdateIpcListener = null;
    }
  };
}

const databaseBridge = createIpcBridge(
  ipcRenderer,
  databaseContract
) as unknown as VisibleDesktopElectronApi['db'];
const databasePathBridge: DatabasePathBridge = createIpcBridge(ipcRenderer, databasePathContract);
const databaseLiveBridge: DatabaseLiveBridge = {
  ...createIpcBridge(ipcRenderer, databaseLiveContract),
  onUpdate: subscribeToDbLiveUpdates,
};

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

// The preload cannot import the bare verified resolver. Preserve all pins for
// authoritative main/renderer verification instead of projecting to legacy fields.
function assertPreloadQueryInferencePlan(
  value: unknown
): NonNullable<EmbeddingHostQueryEmbeddingPayload['inferencePlan']> {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Native pinned query inferencePlan must be a complete object.');
  }
  const plan = value as Record<string, unknown>;
  const device = plan['device'];
  const dtype = plan['dtype'];
  if (
    !(
      (device === 'wasm' || device === 'webgpu') &&
      (dtype === 'q8' || dtype === 'fp16' || dtype === 'fp32') &&
      plan['dimensions'] === 384
    )
  ) {
    throw new Error(
      'Native pinned query inferencePlan requires explicit device, dtype and dimensions.'
    );
  }
  return {
    device,
    dimensions: 384,
    dtype,
    modelId: assertPreloadNonEmptyString(
      plan['modelId'],
      'Native pinned query inferencePlan requires modelId.'
    ),
    revision: assertPreloadNonEmptyString(
      plan['revision'],
      'Native pinned query inferencePlan requires revision.'
    ),
  };
}

function assertEmbeddingHostQueryEmbeddingPayload(
  value: unknown
): EmbeddingHostQueryEmbeddingPayload {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding host query embedding payload must be an object.');
  }
  const payload = value as Record<string, unknown>;
  const inferencePlan = Object.hasOwn(payload, 'inferencePlan')
    ? assertPreloadQueryInferencePlan(payload['inferencePlan'])
    : undefined;
  return {
    ...(inferencePlan ? { inferencePlan } : {}),
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

function assertPreloadDocumentPayload(
  value: EmbeddingHostDocumentEmbeddingsPayload
): EmbeddingHostDocumentEmbeddingsPayload {
  const inferencePlan = assertPreloadQueryInferencePlan(value.inferencePlan);
  if (inferencePlan.modelId !== value.modelId || inferencePlan.dimensions !== value.dimensions) {
    throw new Error('Document inferencePlan must match model and dimensions.');
  }
  if (
    !(
      Array.isArray(value.texts) &&
      value.texts.length > 0 &&
      value.texts.length <= 64 &&
      value.texts.every((text) => typeof text === 'string' && text.trim().length > 0)
    )
  ) {
    throw new Error('Document embeddings require 1 to 64 non-empty texts.');
  }
  return {
    dimensions: value.dimensions,
    inferencePlan,
    modelId: value.modelId,
    modelKey: assertPreloadNonEmptyString(value.modelKey, 'Document modelKey must be non-empty.'),
    texts: [...value.texts],
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

type LlmHostLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

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
  const layoutBridge = createIpcBridge(ipcRenderer, layoutContract);
  const storageBridge = createIpcBridge(ipcRenderer, storageContract);
  const electronAPI = {
    // Database invokes are contract-derived. Live updates keep the intentional
    // single IPC listener fan-out below while their channel/type comes from the
    // same contract as main registration.
    db: databaseBridge,
    dbLive: databaseLiveBridge,
    fileSystem: {
      ...createIpcBridge(ipcRenderer, fileSystemContract),
      ...createIpcBridge(ipcRenderer, fileSystemWatchContract),
      // File reads intentionally retain the preload decoder that turns the
      // established wire payload into the public string-or-clean-Error API.
      readFile: async (handle: FileHandle) => {
        const result = await ipcRenderer.invoke(fileSystemContract.readFile.channel, handle);
        return unwrapFileReadResult(result);
      },
      readFileByAbsolutePath: async (absolutePath: string, rootPath: string, rootId: string) => {
        const result = await ipcRenderer.invoke(
          fileSystemContract.readFileByAbsolutePath.channel,
          absolutePath,
          rootPath,
          rootId
        );
        return unwrapFileReadResult(result);
      },
      readFileByPath: async (absolutePath: string) => {
        const result = await ipcRenderer.invoke(
          fileSystemContract.readFileByPath.channel,
          absolutePath
        );
        return unwrapFileReadResult(result);
      },
    },
    // Database path (legacy - kept for compatibility)
    getUserDataPath: databasePathBridge.getUserDataPath,
    loadLayout: layoutBridge.loadLayout,
    // Panel layout persistence
    saveLayout: layoutBridge.saveLayout,
    storage: {
      clear: () =>
        DESKTOP_TEST_MODE
          ? ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.storage.clearAllForE2e)
          : storageBridge.clear(),
      getAllKeys: storageBridge.getAllKeys,
      getItem: storageBridge.getItem,
      removeItem: storageBridge.removeItem,
      setItem: (key: string, value: string) =>
        DESKTOP_TEST_MODE && MAIN_OWNED_DESKTOP_STORAGE_KEYS_FOR_E2E.has(key)
          ? ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.storage.seedMainOwnedForE2e, key, value)
          : storageBridge.setItem(key, value),
    },
  } satisfies VisibleDesktopElectronApi;
  assertDesktopElectronApiKeyParity('visible-ui', electronAPI);
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
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
exposeBridge('settings', settingsContract);
if (shouldExposeBridge('indexSearch')) {
  exposeBridge('indexSearch', indexSearchContract);
}

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

// MCP Config API (desktop-only). The channel methods and subscriptions are
// derived from pure contracts. `apps.readResource` stays a composed preload
// operation: it resolves the live server generation before using the content
// contract, so there is intentionally no dedicated IPC channel for it.
const mcpRootBridge = createIpcBridge(ipcRenderer, mcpContract);
const mcpPathSelectionBridge = createIpcBridge(ipcRenderer, mcpPathSelectionContract);
const mcpContentBridge = createIpcBridge(ipcRenderer, mcpContentContract);
const mcpElicitationBridge = createIpcBridge(ipcRenderer, mcpElicitationContract);
const mcpAppsBridge = createIpcBridge(ipcRenderer, mcpAppsContract);
const mcpTasksBridge = createIpcBridge(ipcRenderer, mcpTasksContract);
contextBridge.exposeInMainWorld('mcp', {
  ...mcpRootBridge,
  ...mcpPathSelectionBridge,
  apps: {
    ...mcpAppsBridge,
    readResource: (origin: McpAppOrigin) => readMcpAppResource(origin),
  } satisfies McpAppBridge,
  complete: (request: unknown) => unwrapMcpContent(mcpContentBridge.complete(request)),
  getPrompt: (request: unknown) => unwrapMcpContent(mcpContentBridge.getPrompt(request)),
  readResource: (request: unknown) => unwrapMcpContent(mcpContentBridge.readResource(request)),
  ...mcpElicitationBridge,
  tasks: mcpTasksBridge satisfies McpTaskBridge,
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

const embeddingHost = {
  cancelAllBackfills: (): Promise<void> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.cancelAllBackfills),
  cancelBackfill: (embeddingSetId: string): Promise<void> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.cancelBackfill, embeddingSetId),
  cancelDocumentEmbeddings: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.embeddingHost.cancelDocumentEmbeddings,
      assertPreloadNonEmptyString(requestId, 'Document cancellation requestId must be non-empty.')
    ),
  documentEmbeddings: (
    payload: EmbeddingHostDocumentEmbeddingsPayload,
    options: { requestId: string }
  ): Promise<number[][]> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddings, {
      payload: assertPreloadDocumentPayload(payload),
      requestId: assertPreloadNonEmptyString(
        options.requestId,
        'Document requestId must be non-empty.'
      ),
    }),
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
  onDocumentEmbeddingsCancel: (
    callback: (notice: EmbeddingHostDocumentEmbeddingsCancel) => void
  ) => {
    const listener = (_event: unknown, notice: EmbeddingHostDocumentEmbeddingsCancel) =>
      callback(notice);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddingsCancel, listener);
    return () =>
      ipcRenderer.removeListener(
        DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddingsCancel,
        listener
      );
  },
  onDocumentEmbeddingsRequest: (
    callback: (request: EmbeddingHostDocumentEmbeddingsRequest) => void
  ) => {
    const listener = (_event: unknown, request: EmbeddingHostDocumentEmbeddingsRequest) =>
      callback(request);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddingsRequest, listener);
    return () => {
      ipcRenderer.removeListener(
        DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddingsRequest,
        listener
      );
    };
  },
  onQueryEmbeddingCancel: (callback: (notice: EmbeddingHostQueryEmbeddingCancel) => void) => {
    const listener = (_event: unknown, notice: EmbeddingHostQueryEmbeddingCancel) =>
      callback(notice);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbeddingCancel, listener);
    return () =>
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbeddingCancel, listener);
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
  reportDocumentEmbeddingsResponse: (
    response: EmbeddingHostDocumentEmbeddingsResponseReport
  ): void => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.embeddingHost.reportDocumentEmbeddingsResponse, response);
  },
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
} satisfies VisibleEmbeddingHostBridge;
contextBridge.exposeInMainWorld('embeddingHost', embeddingHost);

const chunkingHost = {
  chunkBatch: (request: ChunkingHostChunkBatchRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chunkingHost.chunkBatch, request),
  chunkFile: (request: ChunkingHostChunkFileByIdRequest | ChunkingHostChunkFileRequest) =>
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
} satisfies VisibleChunkingHostBridge;
contextBridge.exposeInMainWorld('chunkingHost', chunkingHost);

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

// Native window focus (BST-1864, desktop-only): `isFocused()` reads THIS window's
// OS focus and `onChange` receives every focus/blur push. `useAppActive()` in
// `@brainstrike/hooks` capability-checks `window.windowFocus`: keyboard focus in
// the browser pane's WebContentsView (or docked DevTools) makes the renderer's own
// `document.hasFocus()` false while the window is still the focused OS window.
// Web has no preload, so it keeps `document.hasFocus()`.
if (shouldExposeBridge('windowFocus')) {
  exposeBridge('windowFocus', windowFocusContract);
}

// Database integrity state (BST-1870, desktop-only): `getState()` reads the
// main-owned snapshot and `onChanged` receives every change. `@brainstrike/db`
// capability-checks `window.databaseIntegrity`; the embedding host gets its own
// copy from hidden-preload.ts, the other hidden hosts get none, and web has no
// preload at all.
if (shouldExposeBridge('databaseIntegrity')) {
  exposeBridge('databaseIntegrity', databaseIntegrityContract);
}

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
  exposeBridge('git', gitContract);
}

// Changeset diff bridge (desktop-only, BST-1113): resolves any `Changeset`
// (agent-run / run-range / git-scope) to an eager `ChangesetView` and loads
// per-file `StructuredFileDiff`s lazily. Web never constructs this bridge
// (there is no preload), so `window.changes` is simply absent there;
// consumers must capability-check `window.changes` rather than
// `isElectron()`. Backed by ChangesetDiffService via the `changes` IPC
// domain (changes-ipc-handlers.ts).
if (shouldExposeBridge('changes')) {
  exposeBridge('changes', changesContract);
}

// Managed-worktree bridge (desktop-only, BST-1390): create / list / archive /
// restore linked worktrees and read the managed-directory settings. Web never
// constructs this bridge, so `window.worktrees` is simply absent there;
// consumers capability-check it rather than `isElectron()`.
if (shouldExposeBridge('worktrees')) {
  exposeBridge('worktrees', worktreesContract);
}

// Forge (pull request) bridge (desktop-only, BST-1391): PR identity + status
// for a workspace root, backed by the main-process ForgeService and the `gh`
// CLI. Web never constructs this bridge (there is no preload), so
// `window.forge` is simply absent there; consumers must capability-check
// `window.forge` rather than `isElectron()`.
if (shouldExposeBridge('forge')) {
  exposeBridge('forge', forgeContract);
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
  exposeBridge('terminal', terminalContract);
}

// Command-session inventory bridge (desktop-only). These sessions are owned by
// the main-process assistant runtime and intentionally survive renderer reloads.
// The bridge exposes workspace-scoped observation/control only; web omits it.
if (shouldExposeBridge('commandSessions')) {
  exposeBridge('commandSessions', commandSessionsContract);
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
  exposeBridge('notesVault', notesVaultContract);
}

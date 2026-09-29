// Narrow Electron preload for renderer-only chunking, embedding, and local-LLM hosts.
// Main selects the role with a BrowserWindow additionalArgument; an absent,
// duplicated, or unknown role is a packaging error and fails closed.
const { contextBridge, ipcRenderer } = require('electron');

import {
  databaseChunkingContract,
  databaseEmbeddingContract,
  databaseIntegrityContract,
} from './ipc-domains/database.contract';
import { vectorPreferencesContract } from './ipc-domains/storage-preferences.contract';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createIpcBridge } from './platform/ipc-bridge';
import {
  assertDesktopElectronApiKeyParity,
  type ChunkingHostElectronApi,
  type ChunkingHostRuntimeBridge,
  type EmbeddingHostElectronApi,
  type EmbeddingHostRuntimeBridge,
} from './types/desktop-electron-api';

type ChunkingHostRequest = import('./chunking-host-shared').ChunkingHostRequest;
type ChunkingHostResponseReport = import('./chunking-host-shared').ChunkingHostResponseReport;
type ChunkingHostStatus = import('./chunking-host-shared').ChunkingHostStatus;
type EmbeddingHostCommand = import('./embedding-host-shared').EmbeddingHostCommand;
type EmbeddingHostQueryEmbeddingRequest =
  import('./embedding-host-shared').EmbeddingHostQueryEmbeddingRequest;
type EmbeddingHostQueryEmbeddingResponseReport =
  import('./embedding-host-shared').EmbeddingHostQueryEmbeddingResponseReport;
type EmbeddingHostStatus = import('./embedding-host-shared').EmbeddingHostStatus;
type LlmHostRequest = import('./llm-host-shared').LlmHostRequest;
type LlmHostResponseReport = import('./llm-host-shared').LlmHostResponseReport;
type LlmHostStatus = import('./llm-host-shared').LlmHostStatus;

type HiddenRendererRole = 'chunking-host' | 'embedding-host' | 'llm-host';

const HIDDEN_RENDERER_ROLE_ARGUMENT = '--brainstrike-hidden-renderer-role=' as const;

function resolveHiddenRendererRole(argv: readonly string[]): HiddenRendererRole {
  const roleArguments = argv.filter((argument) =>
    argument.startsWith(HIDDEN_RENDERER_ROLE_ARGUMENT)
  );
  if (roleArguments.length !== 1) {
    throw new Error(
      'Hidden renderer preload requires exactly one brainstrike-hidden-renderer-role argument.'
    );
  }
  const role = roleArguments[0]?.slice(HIDDEN_RENDERER_ROLE_ARGUMENT.length);
  if (role === 'chunking-host' || role === 'embedding-host' || role === 'llm-host') {
    return role;
  }
  throw new Error(`Hidden renderer preload received unsupported role: ${String(role)}`);
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

function exposeLoggingBridge(): void {
  contextBridge.exposeInMainWorld('logging', {
    getPreferences: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.getPreferences),
    ingestBufferedRecord: (record: unknown): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.logging.ingestBufferedRecord, record);
    },
    onPreferencesUpdated: (callback: (preferences: unknown) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.logging.preferencesUpdated, callback),
  });
}

function exposeChunkingHostBridge(): void {
  const db = createIpcBridge(
    ipcRenderer,
    databaseChunkingContract
  ) as unknown as ChunkingHostElectronApi['db'];
  const chunkingHost = {
    onRequest: (callback: (request: ChunkingHostRequest) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.chunkingHost.request, callback),
    reportResponse: (response: ChunkingHostResponseReport): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.chunkingHost.reportResponse, response);
    },
    reportStatus: (status: ChunkingHostStatus): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.chunkingHost.reportStatus, status);
    },
  } satisfies ChunkingHostRuntimeBridge;
  contextBridge.exposeInMainWorld('chunkingHost', chunkingHost);
  contextBridge.exposeInMainWorld('parserHost', {
    parse: (request: unknown) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.parserHostParse, request),
  });
  const electronAPI = {
    db,
  } satisfies ChunkingHostElectronApi;
  assertDesktopElectronApiKeyParity('chunking-host', electronAPI);
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
}

/**
 * The embedding host's `electronAPI` surface: the database capabilities the
 * renderer-owned queue needs, plus the scoped vector-preferences capability
 * (BST-1380). The host must resolve its device preference from the SAME
 * canonical record the visible UI writes; it deliberately does NOT receive the
 * visible UI's unrestricted `storage` bridge, and these channels carry no key
 * because main pins the record server-side.
 */
function exposeEmbeddingElectronApiBridge(): void {
  const db = createIpcBridge(
    ipcRenderer,
    databaseEmbeddingContract
  ) as unknown as EmbeddingHostElectronApi['db'];
  const vectorPreferences = createIpcBridge(ipcRenderer, vectorPreferencesContract);
  const electronAPI = {
    db,
    vectorPreferences,
  } satisfies EmbeddingHostElectronApi;
  assertDesktopElectronApiKeyParity('embedding-host', electronAPI);
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
}

function exposeEmbeddingHostBridge(): void {
  exposeEmbeddingElectronApiBridge();
  const embeddingHost = {
    onCommand: (callback: (command: EmbeddingHostCommand) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.embeddingHost.command, callback),
    onQueryEmbeddingRequest: (callback: (request: EmbeddingHostQueryEmbeddingRequest) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbeddingRequest, callback),
    reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.embeddingHost.reportQueryEmbeddingResponse, response);
    },
    reportStatus: (status: EmbeddingHostStatus): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.embeddingHost.reportStatus, status);
    },
  } satisfies EmbeddingHostRuntimeBridge;
  contextBridge.exposeInMainWorld('embeddingHost', embeddingHost);
  // BST-1870: the claim permit parks while database integrity is contained, so
  // the host reads the main-owned state. Read-only; chunking/LLM hosts get none.
  contextBridge.exposeInMainWorld(
    'databaseIntegrity',
    createIpcBridge(ipcRenderer, databaseIntegrityContract)
  );
  contextBridge.exposeInMainWorld('power', {
    getSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtime.powerSnapshot),
    onPowerState: (callback: (state: 'resume' | 'suspend') => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.runtime.powerState, callback),
  });
}

function exposeLlmHostBridge(): void {
  contextBridge.exposeInMainWorld('llmHost', {
    onRequest: (callback: (request: LlmHostRequest) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.llmHost.request, callback),
    reportProgress: (progress: LlmHostResponseReport): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.llmHost.reportProgress, progress);
    },
    reportResponse: (response: LlmHostResponseReport): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.llmHost.reportResponse, response);
    },
    reportStatus: (status: LlmHostStatus): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.llmHost.reportStatus, status);
    },
  });
}

const hiddenRendererRole = resolveHiddenRendererRole(process.argv);
exposeLoggingBridge();
if (hiddenRendererRole === 'chunking-host') {
  exposeChunkingHostBridge();
} else if (hiddenRendererRole === 'embedding-host') {
  exposeEmbeddingHostBridge();
} else {
  exposeLlmHostBridge();
}

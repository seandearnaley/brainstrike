// Narrow Electron preload for renderer-only chunking, embedding, and local-LLM hosts.
// Main selects the role with a BrowserWindow additionalArgument; an absent,
// duplicated, or unknown role is a packaging error and fails closed.
const { contextBridge, ipcRenderer } = require('electron');

import { modelCatalogContract } from './ipc-domains/model-catalog.contract';
import { sourceFilesContract } from './ipc-domains/source-files.contract';
import { vectorPreferencesContract } from './ipc-domains/storage-preferences.contract';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createIpcBridge } from './platform/ipc-bridge';
import {
  assertDesktopElectronApiKeyParity,
  type ChunkingHostRuntimeBridge,
  type EmbeddingHostElectronApi,
  type EmbeddingHostRuntimeBridge,
} from './types/desktop-electron-api';

type ChunkingHostRequest = import('./chunking-host-shared').ChunkingHostRequest;
type ChunkingHostResponseReport = import('./chunking-host-shared').ChunkingHostResponseReport;
type ChunkingHostStatus = import('./chunking-host-shared').ChunkingHostStatus;
type EmbeddingHostCommand = import('./embedding-host-shared').EmbeddingHostCommand;
type EmbeddingHostDocumentEmbeddingsRequest =
  import('./embedding-host-shared').EmbeddingHostDocumentEmbeddingsRequest;
type EmbeddingHostDocumentEmbeddingsCancel =
  import('./embedding-host-shared').EmbeddingHostDocumentEmbeddingsCancel;
type EmbeddingHostDocumentEmbeddingsResponseReport =
  import('./embedding-host-shared').EmbeddingHostDocumentEmbeddingsResponseReport;
type EmbeddingHostQueryEmbeddingRequest =
  import('./embedding-host-shared').EmbeddingHostQueryEmbeddingRequest;
type EmbeddingHostQueryEmbeddingCancel =
  import('./embedding-host-shared').EmbeddingHostQueryEmbeddingCancel;
type EmbeddingHostQueryEmbeddingResponseReport =
  import('./embedding-host-shared').EmbeddingHostQueryEmbeddingResponseReport;
type EmbeddingHostStatus = import('./embedding-host-shared').EmbeddingHostStatus;
type EmbeddingHostWebGpuAdapterRequest =
  import('./embedding-host-webgpu-adapter').EmbeddingHostWebGpuAdapterRequest;
type EmbeddingHostWebGpuAdapterResponseReport =
  import('./embedding-host-webgpu-adapter').EmbeddingHostWebGpuAdapterResponseReport;
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
  contextBridge.exposeInMainWorld(
    'sourceFiles',
    createIpcBridge(ipcRenderer, { read: sourceFilesContract.read })
  );
}

/**
 * The native inference host needs only the scoped vector-preferences capability
 * (BST-1380). The host must resolve its device preference from the SAME
 * canonical record the visible UI writes; it deliberately does NOT receive the
 * visible UI's unrestricted `storage` bridge, and these channels carry no key
 * because main pins the record server-side.
 */
function exposeEmbeddingElectronApiBridge(): void {
  const vectorPreferences = createIpcBridge(ipcRenderer, vectorPreferencesContract);
  const electronAPI = {
    vectorPreferences,
  } satisfies EmbeddingHostElectronApi;
  assertDesktopElectronApiKeyParity('embedding-host', electronAPI);
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
}

function exposeEmbeddingHostBridge(): void {
  contextBridge.exposeInMainWorld(
    'modelCatalog',
    createIpcBridge(ipcRenderer, { read: modelCatalogContract.read })
  );
  exposeEmbeddingElectronApiBridge();
  const embeddingHost = {
    onCommand: (callback: (command: EmbeddingHostCommand) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.embeddingHost.command, callback),
    onDocumentEmbeddingsCancel: (
      callback: (notice: EmbeddingHostDocumentEmbeddingsCancel) => void
    ) => subscribe(DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddingsCancel, callback),
    onDocumentEmbeddingsRequest: (
      callback: (request: EmbeddingHostDocumentEmbeddingsRequest) => void
    ) => subscribe(DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddingsRequest, callback),
    onQueryEmbeddingCancel: (callback: (notice: EmbeddingHostQueryEmbeddingCancel) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbeddingCancel, callback),
    onQueryEmbeddingRequest: (callback: (request: EmbeddingHostQueryEmbeddingRequest) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbeddingRequest, callback),
    // BST-1993: the host answers Main's WebGPU adapter request on its own channel.
    onWebgpuAdapterRequest: (callback: (request: EmbeddingHostWebGpuAdapterRequest) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.embeddingHost.webgpuAdapterRequest, callback),
    reportDocumentEmbeddingsResponse: (
      response: EmbeddingHostDocumentEmbeddingsResponseReport
    ): void => {
      ipcRenderer.send(
        DESKTOP_IPC_CHANNELS.embeddingHost.reportDocumentEmbeddingsResponse,
        response
      );
    },
    reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.embeddingHost.reportQueryEmbeddingResponse, response);
    },
    reportStatus: (status: EmbeddingHostStatus): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.embeddingHost.reportStatus, status);
    },
    reportWebgpuAdapterResponse: (response: EmbeddingHostWebGpuAdapterResponseReport): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.embeddingHost.reportWebgpuAdapterResponse, response);
    },
  } satisfies EmbeddingHostRuntimeBridge;
  contextBridge.exposeInMainWorld('embeddingHost', embeddingHost);
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

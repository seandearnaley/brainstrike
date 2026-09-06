// Narrow Electron preload for renderer-only chunking, embedding, and local-LLM hosts.
// Main selects the role with a BrowserWindow additionalArgument; an absent,
// duplicated, or unknown role is a packaging error and fails closed.
const { contextBridge, ipcRenderer } = require('electron');

import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';

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
  contextBridge.exposeInMainWorld('chunkingHost', {
    onRequest: (callback: (request: ChunkingHostRequest) => void) =>
      subscribe(DESKTOP_IPC_CHANNELS.chunkingHost.request, callback),
    reportResponse: (response: ChunkingHostResponseReport): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.chunkingHost.reportResponse, response);
    },
    reportStatus: (status: ChunkingHostStatus): void => {
      ipcRenderer.send(DESKTOP_IPC_CHANNELS.chunkingHost.reportStatus, status);
    },
  });
  contextBridge.exposeInMainWorld('parserHost', {
    parse: (request: unknown) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.files.parserHostParse, request),
  });
  contextBridge.exposeInMainWorld('electronAPI', {
    db: {
      query: (sql: string, params?: unknown[], options?: unknown) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.query, sql, params, options),
    },
  });
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
  contextBridge.exposeInMainWorld('electronAPI', {
    db: {
      applyManagedCacheBatch: (payload: unknown, options?: unknown) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.applyManagedCacheBatch, payload, options),
      diagnostics: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.diagnostics),
      exec: (sql: string, params?: unknown[], options?: unknown) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.exec, sql, params, options),
      insertChunksAndEnqueueEmbeddingJobs: (
        chunks: readonly unknown[],
        fileRecordId: string,
        options: unknown,
        workOptions?: unknown
      ) =>
        ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.db.insertChunksAndEnqueueEmbeddingJobs,
          { chunks, fileRecordId, options },
          workOptions
        ),
      invalidateManagedCacheEntriesByIdentity: (payload: unknown, options?: unknown) =>
        ipcRenderer.invoke(
          DESKTOP_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity,
          payload,
          options
        ),
      query: (sql: string, params?: unknown[], options?: unknown) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.query, sql, params, options),
      runTransaction: (
        statements: ReadonlyArray<{ params?: unknown[]; sql: string }>,
        resultIndex: number,
        options?: unknown
      ) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.transaction, statements, resultIndex, options),
      schedulerSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.schedulerSnapshot),
      test: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.db.test),
    },
    vectorPreferences: {
      clear: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.vectorPreferences.clear),
      read: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.vectorPreferences.read),
      write: (value: string) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.vectorPreferences.write, value),
    },
  });
}

function exposeEmbeddingHostBridge(): void {
  exposeEmbeddingElectronApiBridge();
  contextBridge.exposeInMainWorld('embeddingHost', {
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
  });
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

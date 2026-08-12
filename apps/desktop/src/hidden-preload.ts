// Narrow Electron preload for renderer-only chunking, embedding, and local-LLM hosts.
// Main selects the role with a BrowserWindow additionalArgument; an absent,
// duplicated, or unknown role is a packaging error and fails closed.
const { contextBridge, ipcRenderer } = require('electron');

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
const DESKTOP_PRELOAD_IPC_CHANNELS = {
  db: {
    applyManagedCacheBatch: 'db:managed-cache:apply-batch',
    diagnostics: 'db:diagnostics',
    exec: 'db:exec',
    insertChunksAndEnqueueEmbeddingJobs: 'db:chunks:insert-and-enqueue-embedding-jobs',
    invalidateManagedCacheEntriesByIdentity: 'db:managed-cache:invalidate-by-identity',
    query: 'db:query',
    schedulerSnapshot: 'db:scheduler:snapshot',
    test: 'db:test',
    transaction: 'db:transaction',
  },
  files: {
    parserHostParse: 'parser-host:parse',
  },
  runtime: {
    powerSnapshot: 'app:power-snapshot',
    powerState: 'app:power-state',
  },
} as const;
const CHUNKING_HOST_REQUEST_EVENT = 'chunking-host:request' as const;
const CHUNKING_HOST_REPORT_RESPONSE_CHANNEL = 'chunking-host:report-response' as const;
const CHUNKING_HOST_REPORT_STATUS_CHANNEL = 'chunking-host:report-status' as const;
const EMBEDDING_HOST_COMMAND_EVENT = 'embedding-host:command' as const;
const EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT =
  'embedding-host:query-embedding-request' as const;
const EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL =
  'embedding-host:report-query-embedding-response' as const;
const EMBEDDING_HOST_REPORT_STATUS_CHANNEL = 'embedding-host:report-status' as const;
const LLM_HOST_REQUEST_EVENT = 'llm-host:request' as const;
const LLM_HOST_REPORT_PROGRESS_CHANNEL = 'llm-host:report-progress' as const;
const LLM_HOST_REPORT_RESPONSE_CHANNEL = 'llm-host:report-response' as const;
const LLM_HOST_REPORT_STATUS_CHANNEL = 'llm-host:report-status' as const;
const LOGGING_GET_PREFERENCES_CHANNEL = 'logging:get-preferences' as const;
const LOGGING_INGEST_BUFFERED_RECORD_CHANNEL = 'logging:ingest-buffered-record' as const;
const LOGGING_PREFERENCES_UPDATED_EVENT = 'logging:preferences-updated' as const;

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
    getPreferences: () => ipcRenderer.invoke(LOGGING_GET_PREFERENCES_CHANNEL),
    ingestBufferedRecord: (record: unknown): void => {
      ipcRenderer.send(LOGGING_INGEST_BUFFERED_RECORD_CHANNEL, record);
    },
    onPreferencesUpdated: (callback: (preferences: unknown) => void) =>
      subscribe(LOGGING_PREFERENCES_UPDATED_EVENT, callback),
  });
}

function exposeChunkingHostBridge(): void {
  contextBridge.exposeInMainWorld('chunkingHost', {
    onRequest: (callback: (request: ChunkingHostRequest) => void) =>
      subscribe(CHUNKING_HOST_REQUEST_EVENT, callback),
    reportResponse: (response: ChunkingHostResponseReport): void => {
      ipcRenderer.send(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL, response);
    },
    reportStatus: (status: ChunkingHostStatus): void => {
      ipcRenderer.send(CHUNKING_HOST_REPORT_STATUS_CHANNEL, status);
    },
  });
  contextBridge.exposeInMainWorld('parserHost', {
    parse: (request: unknown) =>
      ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.files.parserHostParse, request),
  });
  contextBridge.exposeInMainWorld('electronAPI', {
    db: {
      query: (sql: string, params?: unknown[], options?: unknown) =>
        ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.db.query, sql, params, options),
    },
  });
}

function exposeEmbeddingDatabaseBridge(): void {
  contextBridge.exposeInMainWorld('electronAPI', {
    db: {
      applyManagedCacheBatch: (payload: unknown, options?: unknown) =>
        ipcRenderer.invoke(
          DESKTOP_PRELOAD_IPC_CHANNELS.db.applyManagedCacheBatch,
          payload,
          options
        ),
      diagnostics: () => ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.db.diagnostics),
      exec: (sql: string, params?: unknown[], options?: unknown) =>
        ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.db.exec, sql, params, options),
      insertChunksAndEnqueueEmbeddingJobs: (
        chunks: readonly unknown[],
        fileRecordId: string,
        options: unknown,
        workOptions?: unknown
      ) =>
        ipcRenderer.invoke(
          DESKTOP_PRELOAD_IPC_CHANNELS.db.insertChunksAndEnqueueEmbeddingJobs,
          { chunks, fileRecordId, options },
          workOptions
        ),
      invalidateManagedCacheEntriesByIdentity: (payload: unknown, options?: unknown) =>
        ipcRenderer.invoke(
          DESKTOP_PRELOAD_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity,
          payload,
          options
        ),
      query: (sql: string, params?: unknown[], options?: unknown) =>
        ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.db.query, sql, params, options),
      runTransaction: (
        statements: ReadonlyArray<{ params?: unknown[]; sql: string }>,
        resultIndex: number,
        options?: unknown
      ) =>
        ipcRenderer.invoke(
          DESKTOP_PRELOAD_IPC_CHANNELS.db.transaction,
          statements,
          resultIndex,
          options
        ),
      schedulerSnapshot: () =>
        ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.db.schedulerSnapshot),
      test: () => ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.db.test),
    },
  });
}

function exposeEmbeddingHostBridge(): void {
  exposeEmbeddingDatabaseBridge();
  contextBridge.exposeInMainWorld('embeddingHost', {
    onCommand: (callback: (command: EmbeddingHostCommand) => void) =>
      subscribe(EMBEDDING_HOST_COMMAND_EVENT, callback),
    onQueryEmbeddingRequest: (callback: (request: EmbeddingHostQueryEmbeddingRequest) => void) =>
      subscribe(EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT, callback),
    reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport): void => {
      ipcRenderer.send(EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL, response);
    },
    reportStatus: (status: EmbeddingHostStatus): void => {
      ipcRenderer.send(EMBEDDING_HOST_REPORT_STATUS_CHANNEL, status);
    },
  });
  contextBridge.exposeInMainWorld('power', {
    getSnapshot: () => ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerSnapshot),
    onPowerState: (callback: (state: 'resume' | 'suspend') => void) =>
      subscribe(DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerState, callback),
  });
}

function exposeLlmHostBridge(): void {
  contextBridge.exposeInMainWorld('llmHost', {
    onRequest: (callback: (request: LlmHostRequest) => void) =>
      subscribe(LLM_HOST_REQUEST_EVENT, callback),
    reportProgress: (progress: LlmHostResponseReport): void => {
      ipcRenderer.send(LLM_HOST_REPORT_PROGRESS_CHANNEL, progress);
    },
    reportResponse: (response: LlmHostResponseReport): void => {
      ipcRenderer.send(LLM_HOST_REPORT_RESPONSE_CHANNEL, response);
    },
    reportStatus: (status: LlmHostStatus): void => {
      ipcRenderer.send(LLM_HOST_REPORT_STATUS_CHANNEL, status);
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

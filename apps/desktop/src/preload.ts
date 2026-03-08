// Electron preload script - must use CommonJS syntax
const { contextBridge, ipcRenderer, clipboard } = require('electron');
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
const ASSISTANT_ROOT_TREE_SELECTION_EVENT = 'assistant:root-tree-selection-update';
const ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT = 'assistant:preview-context-selection-update';

import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { AssistantSelectionUpdatePayload } from '@brainstrike/types';
import type {
  LayoutLoadResult,
  LayoutPersistenceResult,
  PanelPersistenceState,
} from '@brainstrike/ui';
import type { LoggingPreferences, LogRecord } from '@brainstrike/utils';
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
const APP_LIFECYCLE_NOTE_RELOAD_INTENT_CHANNEL = 'app:lifecycle:note-reload-intent' as const;

type EmbeddingHostLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
type ChunkingHostLifecycleState = EmbeddingHostLifecycleState;

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

interface FileReadErrorPayload {
  code: typeof FILE_READ_ERROR_CODE_TOO_LARGE;
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
  return candidate.code === FILE_READ_ERROR_CODE_TOO_LARGE && typeof candidate.message === 'string';
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
    ping: () => ipcRenderer.invoke('db:ping'),
    diagnostics: () => ipcRenderer.invoke('db:diagnostics'),
    query: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:query', sql, params),
    exec: (sql: string) => ipcRenderer.invoke('db:exec', sql),
    test: () => ipcRenderer.invoke('db:test'),
    clearAll: (confirmationToken?: string) => ipcRenderer.invoke('db:clearAll', confirmationToken),
    resetLocal: () => ipcRenderer.invoke('db:resetLocal'),
  },
  dbLive: {
    start: (options: {
      query: string;
      params?: readonly unknown[];
      key?: string;
      mode?: 'query' | 'incremental';
      offset?: number;
      limit?: number;
    }) => ipcRenderer.invoke('db:live-query:start', options),
    stop: (id: number) => ipcRenderer.invoke('db:live-query:stop', id),
    refresh: (payload: { id: number; offset?: number; limit?: number }) =>
      ipcRenderer.invoke('db:live-query:refresh', payload),
    onUpdate: (callback: (payload: { id: number; results: unknown }) => void) => {
      const listener = (_event: unknown, data: { id: number; results: unknown }) => callback(data);
      ipcRenderer.on('db:live-query:update', listener);
      return () => {
        ipcRenderer.removeListener('db:live-query:update', listener);
      };
    },
  },
  // Database path (legacy - kept for compatibility)
  getUserDataPath: () => ipcRenderer.invoke('db:getUserDataPath'),
});

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
});

// Local Agent API (non-streaming aggregate; renderer can pseudo-stream chunks)
contextBridge.exposeInMainWorld('agent', {
  chat: (messages: unknown[], runtime?: unknown) =>
    ipcRenderer.invoke('agent:chat', messages, runtime),
});

// MCP Config API (desktop-only)
contextBridge.exposeInMainWorld('mcp', {
  getConfig: () => ipcRenderer.invoke('mcp:config:get'),
  watch: () => ipcRenderer.invoke('mcp:config:watch'),
  unwatch: () => ipcRenderer.invoke('mcp:config:unwatch'),
  getPath: () => ipcRenderer.invoke('mcp:config:getPath'),
  setPath: (configPath: string | null) => ipcRenderer.invoke('mcp:config:setPath', configPath),
  readConfigText: () => ipcRenderer.invoke('mcp:config:readText'),
  writeConfigText: (content: string) => ipcRenderer.invoke('mcp:config:writeText', content),
  selectPath: () => ipcRenderer.invoke('mcp:config:selectPath'),
  createSampleConfig: () => ipcRenderer.invoke('mcp:config:createSample'),
  // Tool management
  listTools: () => ipcRenderer.invoke('mcp:tools:list'),
  enableTools: (toolIds: string[]) => ipcRenderer.invoke('mcp:tools:enable', toolIds),
  disableTools: (toolIds: string[]) => ipcRenderer.invoke('mcp:tools:disable', toolIds),
  enableServerTools: (serverName: string) =>
    ipcRenderer.invoke('mcp:tools:enableServer', serverName),
  disableServerTools: (serverName: string) =>
    ipcRenderer.invoke('mcp:tools:disableServer', serverName),
  resetTools: () => ipcRenderer.invoke('mcp:tools:reset'),
  getToolStats: () => ipcRenderer.invoke('mcp:tools:getStats'),
});

// Tool execution API (for playground testing)
contextBridge.exposeInMainWorld('tools', {
  execute: (toolId: string, input: unknown) => ipcRenderer.invoke('tools:execute', toolId, input),
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
});

// Assistant UI (data stream) endpoint helper
contextBridge.exposeInMainWorld('assistant', {
  getUrl: () => ipcRenderer.invoke('assistant:get-url'),
});

contextBridge.exposeInMainWorld('logging', {
  getPreferences: (): Promise<LoggingSettingsPayload> =>
    ipcRenderer.invoke('logging:get-preferences'),
  setPreferences: (preferences: LoggingPreferences): Promise<LoggingSettingsPayload> =>
    ipcRenderer.invoke('logging:set-preferences', preferences),
  selectDestination: (): Promise<string | null> => ipcRenderer.invoke('logging:select-destination'),
  openDestination: (target: string | null): Promise<boolean> =>
    ipcRenderer.invoke('logging:open-destination', target ?? null),
  getBufferedLogs: (): Promise<LogRecord[]> => ipcRenderer.invoke('logging:get-buffered-logs'),
  ingestBufferedRecord: (record: LogRecord): void => {
    ipcRenderer.send('logging:ingest-buffered-record', record);
  },
  onPreferencesUpdated: (callback: (preferences: LoggingPreferences) => void) => {
    const listener = (_event: unknown, prefs: LoggingPreferences) => callback(prefs);
    ipcRenderer.on('logging:preferences-updated', listener);
    return () => {
      ipcRenderer.removeListener('logging:preferences-updated', listener);
    };
  },
});

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
  enqueueBackfill: (embeddingSetId: string) =>
    ipcRenderer.invoke(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL, embeddingSetId),
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

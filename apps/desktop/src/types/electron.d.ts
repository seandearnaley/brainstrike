import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
  IFileNode,
} from '@brainstrike/types';
import type {
  ChunkingHostChunkBatchRequest,
  ChunkingHostChunkFileByIdRequest,
  ChunkingHostChunkFileRequest,
  ChunkingHostProgressEvent,
  ChunkingHostRequest,
  ChunkingHostResponseReport,
  ChunkingHostStatus,
} from '../chunking-host-shared';
import type {
  LayoutLoadResult,
  LayoutPersistenceResult,
  PanelPersistenceState,
} from '@brainstrike/ui';
import type { LogRecord } from '@brainstrike/utils/logger';
import type { LoggingPreferences } from '@brainstrike/utils/logging-preferences';
import type {
  WorkspaceIndexingIdleState,
  WorkspaceIndexingPowerSource,
  WorkspaceIndexingThermalState,
} from '@brainstrike/utils/workspace-indexing-qos';
import type { ChunkResult } from '@brainstrike/chunking-worker';
import type {
  EmbeddingHostBackfillRequest,
  EmbeddingHostBackfillInfo,
  EmbeddingHostBackfillProgress,
  EmbeddingHostCommand,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
  EmbeddingHostStatus,
} from '../embedding-host-shared';
import type { LlmHostRequest, LlmHostResponseReport, LlmHostStatus } from '../llm-host-shared';

import type { DesktopPlatformDiagnosticsSnapshot } from '../desktop-platform-diagnostics';
import type { LoggingSettingsPayload } from '../logging-shared';

interface QueryResult {
  fields?: { name: string; dataType: string }[];
  rows: unknown[];
}

interface ElectronLiveQueryResults {
  limit?: number;
  offset?: number;
  rows: unknown[];
  totalCount?: number;
}

// Type definitions for the Electron API exposed via contextBridge
declare global {
  interface Window {
    agent: {
      chat: <T = unknown>(messages: T[], runtime?: unknown) => Promise<unknown[]>; // StreamChunk[] shape
    };
    chunkingHost: {
      ensureStarted: () => Promise<ChunkingHostStatus>;
      stop: () => Promise<ChunkingHostStatus>;
      reset: () => Promise<ChunkingHostStatus>;
      getStatus: () => Promise<ChunkingHostStatus>;
      chunkFile: (
        request: ChunkingHostChunkFileByIdRequest | ChunkingHostChunkFileRequest
      ) => Promise<ChunkResult>;
      chunkBatch: (request: ChunkingHostChunkBatchRequest) => Promise<readonly ChunkResult[]>;
      reportStatus: (status: ChunkingHostStatus) => void;
      reportResponse: (response: ChunkingHostResponseReport) => void;
      onStatus: (callback: (status: ChunkingHostStatus) => void) => () => void;
      onProgress: (callback: (progress: ChunkingHostProgressEvent) => void) => () => void;
      onRequest: (callback: (request: ChunkingHostRequest) => void) => () => void;
    };
    desktopDiagnostics?: {
      getSnapshot: () => Promise<DesktopPlatformDiagnosticsSnapshot>;
    };
    desktopLifecycle?: {
      isTestMode: boolean;
      noteReloadIntent: (reason: string) => Promise<void>;
    };
    electronAPI: {
      storage: {
        getItem: (key: string) => Promise<string | null>;
        setItem: (key: string, value: string) => Promise<void>;
        removeItem: (key: string) => Promise<void>;
        clear: () => Promise<void>;
        getAllKeys: () => Promise<string[]>;
      };
      fileSystem: {
        requestDirectoryAccess: () => Promise<DirectoryHandle>;
        readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>;
        readFile: (handle: FileHandle) => Promise<string>;
        exists: (path: string) => Promise<boolean>;
        restoreLastFolder: () => Promise<DirectoryHandle | null>;
        saveLastFolder: (folderPath: string) => Promise<void>;
      };
      // Database operations
      db: {
        query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
        exec: (sql: string) => Promise<void>;
        test: () => Promise<{ success: boolean; message: string; dbLocation: string }>;
        clearAll: (confirmationToken?: string) => Promise<{
          success: boolean;
          message?: string;
          deletedFiles?: number;
          deletedChunks?: number;
        }>;
        resetLocal: () => Promise<{ success: boolean; message?: string }>;
      };
      dbLive: {
        start: (options: {
          query: string;
          params?: readonly unknown[];
          key?: string;
          mode?: 'query' | 'incremental';
          offset?: number;
          limit?: number;
        }) => Promise<{ id: number; initialResults: ElectronLiveQueryResults }>;
        stop: (id: number) => Promise<{ success: boolean } | undefined>;
        refresh: (payload: { id: number; offset?: number; limit?: number }) => Promise<{
          success: boolean;
          message?: string;
        }>;
        onUpdate: (
          callback: (payload: { id: number; results: ElectronLiveQueryResults }) => void
        ) => () => void;
      };
      // Layout persistence methods
      saveLayout: (state: PanelPersistenceState) => Promise<LayoutPersistenceResult>;
      loadLayout: () => Promise<LayoutLoadResult>;
      // Database path method (legacy)
      getUserDataPath: () => Promise<string>;
    };
    embeddingHost: {
      ensureStarted: () => Promise<EmbeddingHostStatus>;
      enqueueBackfill: (request: EmbeddingHostBackfillRequest) => Promise<{ requestId: string }>;
      cancelBackfill: (embeddingSetId: string) => Promise<void>;
      cancelAllBackfills: () => Promise<void>;
      getBackfillsInFlight: () => Promise<EmbeddingHostBackfillInfo[]>;
      stop: () => Promise<EmbeddingHostStatus>;
      reset: () => Promise<EmbeddingHostStatus>;
      getStatus: () => Promise<EmbeddingHostStatus>;
      reportStatus: (status: EmbeddingHostStatus) => void;
      onBackfillProgress: (
        callback: (progress: EmbeddingHostBackfillProgress) => void
      ) => () => void;
      onStatus: (callback: (status: EmbeddingHostStatus) => void) => () => void;
      onCommand: (callback: (command: EmbeddingHostCommand) => void) => () => void;
      onQueryEmbeddingRequest: (
        callback: (request: EmbeddingHostQueryEmbeddingRequest) => void
      ) => () => void;
      reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport) => void;
    };
    llmHost: {
      ensureStarted: () => Promise<LlmHostStatus>;
      stop: () => Promise<LlmHostStatus>;
      reset: () => Promise<LlmHostStatus>;
      getStatus: () => Promise<LlmHostStatus>;
      cancel: (requestId: string) => Promise<void>;
      warmup: (payload: { modelId: string; requestId?: string } | string) => Promise<void>;
      generate: (payload: {
        requestId?: string;
        modelId: string;
        messages: unknown[];
        options?: unknown;
      }) => Promise<unknown>;
      reportStatus: (status: LlmHostStatus) => void;
      reportProgress: (progress: LlmHostResponseReport) => void;
      reportResponse: (response: LlmHostResponseReport) => void;
      onStatus: (callback: (status: LlmHostStatus) => void) => () => void;
      onRequest: (callback: (request: LlmHostRequest) => void) => () => void;
      onProgress: (callback: (progress: LlmHostResponseReport) => void) => () => void;
    };
    logging: {
      getPreferences: () => Promise<LoggingSettingsPayload>;
      setPreferences: (preferences: LoggingPreferences) => Promise<LoggingSettingsPayload>;
      selectDestination: () => Promise<string | null>;
      openDestination: (target: string | null) => Promise<boolean>;
      getBufferedLogs: () => Promise<LogRecord[]>;
      ingestBufferedRecord: (record: LogRecord) => void;
      onPreferencesUpdated: (
        callback: (preferences: LoggingPreferences) => void
      ) => (() => void) | undefined;
    };
    mcp: {
      getConfig: () => Promise<{
        path: string;
        exists: boolean;
        servers?: { name: string; transport: 'stdio' | 'sse' }[];
        loadedAt?: number;
        error?: string;
      }>;
      watch: () => Promise<{ watching: boolean }>;
      unwatch: () => Promise<{ watching: false }>;
      getPath: () => Promise<string>;
      setPath: (configPath: string | null) => Promise<{ success: boolean; path: string }>;
      readConfigText: () => Promise<{
        path: string;
        exists: boolean;
        created: boolean;
        content: string;
      }>;
      writeConfigText: (
        content: string
      ) => Promise<
        { success: true; path: string } | { success: false; path: string; error: string }
      >;
      selectPath: () => Promise<string | null>;
      createSampleConfig: () => Promise<{ success: boolean; path: string; error?: string }>;
      // Tool management
      listTools: () => Promise<{
        [serverName: string]: Array<{
          id: string;
          serverName: string;
          description?: string;
          inputSchema?: unknown;
          enabled: boolean;
          discoveredAt: number;
        }>;
      }>;
      enableTools: (toolIds: string[]) => Promise<void>;
      disableTools: (toolIds: string[]) => Promise<void>;
      enableServerTools: (serverName: string) => Promise<void>;
      disableServerTools: (serverName: string) => Promise<void>;
      resetTools: () => Promise<void>;
      getToolStats: () => Promise<{
        total: number;
        enabled: number;
        disabled: number;
        servers: number;
      }>;
      onToolsUpdated: (
        callback: (tools: {
          [serverName: string]: Array<{
            id: string;
            serverName: string;
            description?: string;
            inputSchema?: unknown;
            enabled: boolean;
            discoveredAt: number;
          }>;
        }) => void
      ) => () => void;
    };
    platform?: {
      openPath: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
      showItemInFolder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
    };
    power: {
      getSnapshot: () => Promise<{
        idleState: WorkspaceIndexingIdleState;
        idleTimeMs: number;
        powerSource: WorkspaceIndexingPowerSource;
        sampledAt: number;
        thermalState: WorkspaceIndexingThermalState;
      }>;
      onPowerState: (callback: (state: 'resume' | 'suspend') => void) => () => void;
    };
    secrets: {
      saveKey: (
        provider: string,
        value: string
      ) => Promise<true | { ok: false; error: 'encryption_unavailable' | 'unknown_error' }>;
      getKey: (provider: string) => Promise<string | null>;
      deleteKey: (provider: string) => Promise<boolean>;
      list: () => Promise<string[]>;
      listStored: () => Promise<string[]>;
      clearAll: (confirmationToken?: string) => Promise<{ success: boolean; message?: string }>;
    };
    tools: {
      execute: (
        toolId: string,
        input: unknown,
        runtimeData?: Record<string, unknown>
      ) => Promise<
        | {
            success: true;
            result: unknown;
            durationMs: number;
          }
        | {
            success: false;
            error: string;
            durationMs: number;
          }
      >;
      onRootTreeSelectionUpdate: (
        callback: (payload: AssistantSelectionUpdatePayload) => void
      ) => (() => void) | undefined;
      onPreviewContextSelectionUpdate: (
        callback: (payload: AssistantSelectionUpdatePayload) => void
      ) => (() => void) | undefined;
      onWorkspaceContextSelectionUpdate: (
        callback: (payload: AssistantWorkspaceContextSelectionUpdatePayload) => void
      ) => (() => void) | undefined;
      onWorkspaceContextTapestryUpdate: (
        callback: (payload: AssistantWorkspaceTapestryUpdatePayload) => void
      ) => (() => void) | undefined;
    };
  }
}

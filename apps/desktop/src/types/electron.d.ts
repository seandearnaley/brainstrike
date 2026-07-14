import type {
  AssistantPersonasListResult,
  UserSlashCommandsListResult,
} from '@brainstrike/assistant-contract';
import type { ChunkResult } from '@brainstrike/chunking-worker';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
  DatabaseWorkOptions,
  ElectronChunkInsert,
  ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
  GitAheadBehind,
  GitCommitFile,
  GitCommitResult,
  GitDiff,
  GitDiffParams,
  GitHistoryPage,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitSwitchBranchResult,
  IFileNode,
} from '@brainstrike/types';
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
import type {
  ChunkingHostChunkBatchRequest,
  ChunkingHostChunkFileByIdRequest,
  ChunkingHostChunkFileRequest,
  ChunkingHostProgressEvent,
  ChunkingHostRequest,
  ChunkingHostResponseReport,
  ChunkingHostStatus,
} from '../chunking-host-shared';
import type { DesktopPlatformDiagnosticsSnapshot } from '../desktop-platform-diagnostics';
import type {
  EmbeddingHostBackfillInfo,
  EmbeddingHostBackfillProgress,
  EmbeddingHostBackfillRequest,
  EmbeddingHostCommand,
  EmbeddingHostQueryEmbeddingPayload,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
  EmbeddingHostStatus,
} from '../embedding-host-shared';
import type { LlmHostRequest, LlmHostResponseReport, LlmHostStatus } from '../llm-host-shared';
import type { LoggingSettingsPayload } from '../logging-shared';
import type {
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResult,
} from '../terminal-ipc-handlers';

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
    /**
     * Desktop-only subagent persona discovery bridge. Absent on web (no
     * preload) — consumers MUST capability-check `window.assistantPersonas`.
     * The Settings -> Subagents panel calls `list` to show built-in +
     * user-defined personas (including invalid files with their error).
     */
    assistantPersonas?: {
      list: () => Promise<AssistantPersonasListResult>;
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
    commandPalette?: {
      onOpen: (callback: () => void) => () => void;
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
        insertChunksAndEnqueueEmbeddingJobs: (
          chunks: readonly ElectronChunkInsert[],
          fileRecordId: string,
          options: ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
          workOptions?: DatabaseWorkOptions
        ) => Promise<void>;
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
      // Resolves { canceled: true } for a deliberate backfill cancellation — the
      // main-process handler swallows the cancellation sentinel rather than
      // rejecting (a rejection makes Electron log "Error occurred in handler").
      enqueueBackfill: (
        request: EmbeddingHostBackfillRequest
      ) => Promise<{ requestId: string } | { canceled: true }>;
      cancelBackfill: (embeddingSetId: string) => Promise<void>;
      cancelAllBackfills: () => Promise<void>;
      getBackfillsInFlight: () => Promise<EmbeddingHostBackfillInfo[]>;
      queryEmbedding: (payload: EmbeddingHostQueryEmbeddingPayload) => Promise<number[]>;
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
    /**
     * Desktop-only git bridge. Absent on web (no preload) — consumers MUST
     * capability-check `window.git` rather than `isElectron()`. Every call takes
     * the durable workspace `rootId`; main resolves + containment-checks it to an
     * absolute cwd and runs git via execFile (no shell). Each method resolves to
     * a structured `GitResult` (never throws across IPC).
     */
    git?: {
      status: (rootId: string) => Promise<GitResult<GitStatus>>;
      diff: (rootId: string, params: GitDiffParams) => Promise<GitResult<GitDiff>>;
      stage: (rootId: string, params?: { path?: string }) => Promise<GitResult<null>>;
      unstage: (rootId: string, params?: { path?: string }) => Promise<GitResult<null>>;
      commit: (
        rootId: string,
        params: { description?: string; summary: string }
      ) => Promise<GitResult<GitCommitResult>>;
      commitDiff: (
        rootId: string,
        params: { commit: string; originalPath?: string; path: string }
      ) => Promise<GitResult<GitDiff>>;
      commitFiles: (
        rootId: string,
        params: { commit: string }
      ) => Promise<GitResult<readonly GitCommitFile[]>>;
      aheadBehind: (rootId: string) => Promise<GitResult<GitAheadBehind>>;
      fetch: (rootId: string, params: { remote: string }) => Promise<GitResult<GitPushPullResult>>;
      history: (
        rootId: string,
        params: { limit: number; offset: number; ref?: string }
      ) => Promise<GitResult<GitHistoryPage>>;
      push: (rootId: string, params?: { remote?: string }) => Promise<GitResult<GitPushPullResult>>;
      pull: (rootId: string) => Promise<GitResult<GitPushPullResult>>;
      repository: (rootId: string) => Promise<GitResult<GitRepository>>;
      switchBranch: (
        rootId: string,
        params: { branch: string }
      ) => Promise<GitResult<GitSwitchBranchResult>>;
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
        servers?: { name: string; transport: 'sse' | 'stdio' | 'streamable-http' }[];
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
      onConfigUpdated: (
        callback: (config: {
          path: string;
          exists: boolean;
          servers?: { name: string; transport: 'sse' | 'stdio' | 'streamable-http' }[];
          loadedAt?: number;
          error?: string;
        }) => void
      ) => () => void;
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
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
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
    quickOpen?: {
      onOpen: (callback: () => void) => () => void;
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
    /**
     * Desktop-only terminal (PTY) bridge. Absent on web (no preload) — consumers
     * MUST capability-check `window.terminal`. `create` pins the shell cwd to a
     * validated workspace `rootId` (main resolves + containment-checks it). pty
     * output/exit are pushed one-way to THIS renderer; `onData`/`onExit` register
     * a listener and return an unsubscribe fn. Invoke calls resolve to a
     * structured `TerminalResult` (never throw across IPC).
     */
    terminal?: {
      create: (params: {
        rootId: string;
        cols?: number;
        rows?: number;
      }) => Promise<TerminalResult<TerminalCreateResult>>;
      write: (params: { terminalId: string; data: string }) => Promise<TerminalResult>;
      resize: (params: {
        terminalId: string;
        cols: number;
        rows: number;
      }) => Promise<TerminalResult>;
      destroy: (params: { terminalId: string }) => Promise<TerminalResult>;
      onData: (callback: (event: TerminalDataEvent) => void) => () => void;
      onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
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
    /**
     * Desktop-only user-defined slash command discovery bridge. Absent on web
     * (no preload) — consumers MUST capability-check `window.userCommands`. The
     * composer's "/" menu calls `list` to load prompt-template commands scanned
     * from `.brainstrike/commands` + `.claude/commands`.
     */
    userCommands?: {
      list: () => Promise<UserSlashCommandsListResult>;
    };
  }
}

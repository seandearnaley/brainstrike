import type {
  AssistantPersonasListResult,
  AssistantRewindFinalization,
  AssistantRewindMode,
  AssistantRewindPreviewResult,
  AssistantRewindRedoResult,
  AssistantRewindResult,
  SkillsScanResultSummary,
  UserSlashCommandsListResult,
} from '@brainstrike/assistant-contract';
import type { ChunkResult } from '@brainstrike/chunking-worker';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  WorkspaceIndexingIdleState,
  WorkspaceIndexingPowerSource,
  WorkspaceIndexingThermalState,
} from '@brainstrike/indexing-contract/workspace-indexing-qos';
import type { LoggingPreferences, LogRecord } from '@brainstrike/logging';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
  Changeset,
  ChangesetView,
  DatabaseWorkOptions,
  ElectronChunkInsert,
  ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
  GitAheadBehind,
  GitCommitFile,
  GitCommitResult,
  GitDiff,
  GitDiffParams,
  GitHistoryPage,
  GitInventory,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitSwitchBranchResult,
  IFileNode,
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '@brainstrike/types';
import type {
  LayoutLoadResult,
  LayoutPersistenceResult,
  PanelPersistenceState,
} from '@brainstrike/ui';
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
  CommandSessionIpcResult,
  CommandSessionListParams,
  CommandSessionReadPage,
  CommandSessionReadParams,
  CommandSessionWriteParams,
} from '../command-session-ipc-handlers';
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
  NotesVaultChangedEvent,
  NotesVaultEntry,
  NotesVaultResult,
  NotesVaultRoot,
} from '../notes-vault-ipc-handlers';
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
    /**
     * Embedded browser pane bridge (BST-1174). Desktop-only; absent on web.
     * MUST stay in sync with `BrowserBridge` in
     * `@brainstrike/app-shell` `browser-pane/browser-bridge.ts` — a method
     * present on one side only disables the whole pane surface via
     * `resolveBrowserBridge()`.
     */
    browser?: {
      createTab: (url?: string) => Promise<string>;
      closeTab: (tabId: string) => Promise<void>;
      selectTab: (tabId: string) => Promise<void>;
      navigate: (tabId: string, url: string) => Promise<void>;
      goBack: (tabId: string) => Promise<void>;
      goForward: (tabId: string) => Promise<void>;
      reload: (tabId: string) => Promise<void>;
      setBounds: (rect: { height: number; width: number; x: number; y: number }) => Promise<void>;
      setOccluded: (occluded: boolean) => Promise<void>;
      listTabs: () => Promise<
        ReadonlyArray<{
          active: boolean;
          canGoBack: boolean;
          canGoForward: boolean;
          tabId: string;
          title: string;
          url: string;
        }>
      >;
      /** One-way main→renderer tab-state pushes. Returns unsubscribe. */
      onTabsChanged: (
        listener: (
          tabs: ReadonlyArray<{
            active: boolean;
            canGoBack: boolean;
            canGoForward: boolean;
            tabId: string;
            title: string;
            url: string;
          }>
        ) => void
      ) => () => void;
    };
    /**
     * Desktop-only changeset diff bridge (BST-1113/BST-1114). Resolves any
     * `Changeset` (agent-run / run-range / git-scope) to an eager
     * `ChangesetView` and loads per-file `StructuredFileDiff`s lazily.
     * Absent on web (no preload) — consumers MUST capability-check
     * `window.changes` rather than `isElectron()`.
     *
     * ⚠️ MUST stay in sync with `ChangesBridge` in
     * `packages/app-shell/src/changes/changes-bridge.ts` (the ambient module
     * shims in `app-shell-shims.d.ts` keep this file from importing the type
     * directly). `resolveChangesBridge()` rejects a bridge missing any
     * method, so a method declared here but absent from the preload — or vice
     * versa — disables the Changes surface at runtime.
     */
    changes?: {
      /** Conversation Rewind: apply (BST-1115 W5 T4). */
      applyRewind: (payload: {
        acknowledgeConflicts?: boolean;
        messageId: string;
        mode: AssistantRewindMode;
        threadId: string;
      }) => Promise<GitResult<AssistantRewindResult>>;
      fileDiff: (
        rootId: string,
        changeset: Changeset,
        path: string
      ) => Promise<GitResult<StructuredFileDiff>>;
      /**
       * Conversation Rewind: end the redo window for a thread (W5 T4b). Fired
       * when a USER-authored message starts a new run. `value.finalized ===
       * false` means the thread had no outstanding rewind — the ordinary case,
       * not a failure.
       */
      finalizeRewinds: (payload: {
        threadId: string;
      }) => Promise<GitResult<AssistantRewindFinalization>>;
      inventory: () => Promise<GitResult<GitInventory>>;
      /**
       * Live-refresh push subscription (BST-1161, spec §6): external git
       * activity on a repository. Returns the unsubscribe function.
       */
      onInvalidated: (
        callback: (event: import('@brainstrike/types').ChangesInvalidationEvent) => void
      ) => () => void;
      /** Conversation Rewind: undo the newest rewind, one level, until finalization. */
      redoRewind: (payload: {
        acknowledgeConflicts?: boolean;
        rewindId: string;
      }) => Promise<GitResult<AssistantRewindRedoResult>>;
      resolveView: (rootId: string, changeset: Changeset) => Promise<GitResult<ChangesetView>>;
      /** Conversation Rewind: pre-apply preview (range, tombstones, conflicts, view). */
      rewindPreview: (
        payload: { threadId: string } & ({ messageId: string } | { runId: string })
      ) => Promise<GitResult<AssistantRewindPreviewResult>>;
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
    /** Desktop-only view/control bridge for assistant-owned persistent commands. */
    commandSessions?: {
      list: (params: CommandSessionListParams) => Promise<
        CommandSessionIpcResult<{
          readonly rootId: string;
          readonly sessions: readonly import('../assistant-server/command-session-manager').CommandSessionInfo[];
        }>
      >;
      read: (
        params: CommandSessionReadParams
      ) => Promise<CommandSessionIpcResult<CommandSessionReadPage>>;
      remove: (
        params: import('../command-session-ipc-handlers').CommandSessionIdentityParams
      ) => Promise<CommandSessionIpcResult>;
      stop: (
        params: import('../command-session-ipc-handlers').CommandSessionIdentityParams
      ) => Promise<CommandSessionIpcResult>;
      write: (params: CommandSessionWriteParams) => Promise<CommandSessionIpcResult>;
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
     * Desktop-only file-export save bridge. Absent on web (no preload) —
     * consumers MUST capability-check `window.fileExports` (which
     * `@brainstrike/utils`'s `downloadBlobFile` does; call sites should go
     * through it rather than this bridge directly). Saves export bytes into
     * the OS Downloads folder from MAIN, bypassing Chromium's fragile
     * blob-download pipeline. Never overwrites: collisions get a ` (n)`
     * counter. Resolves a structured result (never throws across IPC).
     */
    fileExports?: {
      saveToDownloads: (payload: { bytes: Uint8Array; filename: string }) => Promise<{
        error?: string;
        ok: boolean;
        path?: string;
      }>;
    };
    /**
     * Desktop-only git bridge. Absent on web (no preload) — consumers MUST
     * capability-check `window.git` rather than `isElectron()`. Every call takes
     * the durable workspace `rootId`; main resolves + containment-checks it to an
     * absolute cwd and runs git via execFile (no shell). Each method resolves to
     * a structured `GitResult` (never throws across IPC).
     *
     * ⚠️ MUST stay in sync with `GitBridge` in
     * `packages/app-shell/src/git-panel/git-bridge.ts`; `resolveGitBridge()`
     * rejects a bridge missing any method.
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
      structuredFileDiff: (
        rootId: string,
        params: StructuredFileDiffParams
      ) => Promise<GitResult<StructuredFileDiff>>;
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
      onDurableRecord: (listener: (record: LogRecord) => void) => () => void;
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
    /**
     * Desktop-only notes vault bridge (see
     * packages/notes-vault/src/desktop/bridge-contract.ts). Absent on web (no
     * preload) — consumers MUST capability-check `window.notesVault`. Every
     * path is containment-checked in main against the APPROVED vault roots;
     * every method resolves to a structured `NotesVaultResult` (never throws
     * across IPC). `pickDirectory` resolves `{ ok: true, value: null }` when
     * the user cancels. `onChanged` registers a listener for one-way
     * `notes-vault:changed` pushes and returns an unsubscribe fn.
     */
    notesVault?: {
      createDirectory: (path: string) => Promise<NotesVaultResult<null>>;
      deleteEntry: (
        path: string,
        options: { recursive: boolean }
      ) => Promise<NotesVaultResult<null>>;
      rename: (fromPath: string, toPath: string) => Promise<NotesVaultResult<null>>;
      ensureDefaultVault: () => Promise<NotesVaultResult<NotesVaultRoot>>;
      pickDirectory: () => Promise<NotesVaultResult<NotesVaultRoot | null>>;
      registerRoot: (path: string) => Promise<NotesVaultResult<NotesVaultRoot>>;
      listDirectory: (path: string) => Promise<NotesVaultResult<NotesVaultEntry[]>>;
      statEntry: (path: string) => Promise<NotesVaultResult<NotesVaultEntry | null>>;
      readFile: (path: string) => Promise<NotesVaultResult<string>>;
      writeFile: (
        path: string,
        content: string
      ) => Promise<NotesVaultResult<{ lastModified: number }>>;
      watch: (path: string) => Promise<NotesVaultResult<{ watchId: string }>>;
      unwatch: (watchId: string) => Promise<NotesVaultResult<null>>;
      onChanged: (callback: (event: NotesVaultChangedEvent) => void) => () => void;
    };
    /**
     * OS shell integration bridge. Absent on web (no preload) — consumers MUST
     * capability-check `window.platform`.
     *
     * ⚠️ MUST stay in sync with `PlatformBridge` in
     * `packages/app-shell/src/platform-bridge.ts` (the ambient module shims in
     * `app-shell-shims.d.ts` keep this file from importing the type directly).
     * `resolvePlatformBridge()` rejects a bridge missing any method, so a
     * method declared here but absent from the preload — or vice versa —
     * disables shell actions AND markdown preview at runtime.
     */
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
    /**
     * Provider OAuth bridge (BST-1355). Shape defined ONCE in
     * `@brainstrike/assistant-contract/provider-auth` (`ProviderAuthBridge`);
     * the preload-runtime contract test pins the exposed key set to
     * `PROVIDER_AUTH_BRIDGE_REQUIRED_METHODS`. Status-only: token material
     * never crosses IPC. Absent on web — consumers capability-check it.
     */
    providerAuth?: import('@brainstrike/assistant-contract/provider-auth').ProviderAuthBridge;
    quickOpen?: {
      onOpen: (callback: () => void) => () => void;
    };
    /**
     * Secure secrets bridge (BST-1348). The shape is defined ONCE in
     * `@brainstrike/assistant-contract/secrets-bridge` — the preload
     * implements it and the preload-runtime contract test pins the exposed
     * key set to `SECRETS_BRIDGE_REQUIRED_METHODS`.
     */
    secrets: import('@brainstrike/assistant-contract/secrets-bridge').SecretsBridge;
    /**
     * Desktop-only Agent Skills discovery bridge. Absent on web (no preload) —
     * consumers MUST capability-check `window.skills`. The Settings → Skills
     * panel and the composer's "/" menu call `scan` to list every skill
     * discovered across `.brainstrike/skills` + `.claude/skills`.
     *
     * ⚠️ MUST stay in sync with `SkillsBridge` in
     * `packages/assistant-contract/src/skills-bridge.ts` (shared by app-shell
     * and settings-ui); `resolveSkillsBridge()` rejects a bridge missing any
     * method.
     */
    skills?: {
      scan: () => Promise<SkillsScanResultSummary>;
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
     *
     * ⚠️ MUST stay in sync with `UserCommandsBridge` in
     * `packages/app-shell/src/user-commands-bridge.ts`;
     * `resolveUserCommandsBridge()` rejects a bridge missing any method.
     */
    userCommands?: {
      list: () => Promise<UserSlashCommandsListResult>;
    };
  }
}

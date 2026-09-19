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
  DatabaseWorkOptions,
  ElectronChunkInsert,
  ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
  IFileNode,
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
import type { DesktopPlatformDiagnosticsSnapshot } from '../desktop-platform-diagnostics';
import type { MainLogWindowRequest, MainLogWindowResult } from '../diagnostics/main-log-window';
import type { ProcessCounterSnapshot } from '../diagnostics/process-counter-ring';
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
import type { changesContract } from '../ipc-domains/changes.contract';
import type { clipboardContract } from '../ipc-domains/clipboard.contract';
import type { commandSessionsContract } from '../ipc-domains/command-sessions.contract';
import type { contextFilesContract } from '../ipc-domains/context-files.contract';
import type { forgeContract } from '../ipc-domains/forge.contract';
import type { gitContract } from '../ipc-domains/git.contract';
import type { McpBridge } from '../ipc-domains/mcp.contract';
import type { notesVaultContract } from '../ipc-domains/notes-vault.contract';
import type { skillsContract } from '../ipc-domains/skills.contract';
import type { terminalContract } from '../ipc-domains/terminal.contract';
import type { userCommandsContract } from '../ipc-domains/user-commands.contract';
import type { userPersonasContract } from '../ipc-domains/user-personas.contract';
import type { worktreesContract } from '../ipc-domains/worktrees.contract';
import type { LlmHostRequest, LlmHostResponseReport, LlmHostStatus } from '../llm-host-shared';
import type { LoggingSettingsPayload } from '../logging-shared';
import type { Bridge } from '../platform/ipc-contract';

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
    assistantPersonas?: Bridge<typeof userPersonasContract>;
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
    /** Desktop-only Changes bridge, derived from its pure IPC contract. */
    changes?: Bridge<typeof changesContract>;
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
    /** Desktop-only clipboard write bridge, derived from its contract (BST-1648). */
    clipboard?: Bridge<typeof clipboardContract>;
    commandPalette?: {
      onOpen: (callback: () => void) => () => void;
    };
    /** Desktop-only view/control bridge for assistant-owned persistent commands. */
    commandSessions?: Bridge<typeof commandSessionsContract>;
    /**
     * Desktop-only workspace context-files scan bridge (Settings → Workspace
     * Instructions), derived from its contract (BST-1648) and pinned equal
     * to `ContextFilesBridge` in `@brainstrike/assistant-contract`.
     */
    contextFiles?: Bridge<typeof contextFilesContract>;
    desktopDiagnostics?: {
      getSnapshot: () => Promise<DesktopPlatformDiagnosticsSnapshot>;
      readMainLogWindow: (request: MainLogWindowRequest) => Promise<MainLogWindowResult>;
      readProcessCounters: () => Promise<ProcessCounterSnapshot>;
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
     * Env bootstrap visibility bridge (BST-1363). Shape defined ONCE in
     * `@brainstrike/assistant-contract/env-bootstrap-bridge`
     * (`EnvBootstrapBridge`); the preload-runtime contract test pins the
     * exposed key set to `ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHODS`. Read-only
     * and names-only: variable VALUES never cross this bridge. Absent on web
     * — the settings section is gated on this bridge existing, never on an
     * `isElectron()` check.
     */
    envBootstrap?: import('@brainstrike/assistant-contract/env-bootstrap-bridge').EnvBootstrapBridge;
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
    /** Desktop-only forge bridge, derived from its pure IPC contract. */
    forge?: Bridge<typeof forgeContract>;
    /**
     * Desktop-only git bridge. Absent on web (no preload) — consumers MUST
     * capability-check `window.git` rather than `isElectron()`. Every call takes
     * the durable workspace `rootId`; main resolves + containment-checks it to an
     * absolute cwd and runs git via execFile (no shell). Valid calls resolve to
     * a structured `GitResult`; structurally malformed direct IPC input rejects.
     *
     * The surface is derived from the pure desktop contract, whose compile-time
     * proof keeps it equal to app-shell's `GitBridge`.
     */
    git?: Bridge<typeof gitContract>;
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
    mcp: McpBridge;
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
    notesVault?: Bridge<typeof notesVaultContract>;
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
     * Derived from the desktop contract (BST-1648), which is itself pinned
     * equal to `SkillsBridge` in `@brainstrike/assistant-contract` — nothing
     * here can drift from the preload.
     */
    skills?: Bridge<typeof skillsContract>;
    /**
     * Desktop-only terminal (PTY) bridge. Absent on web (no preload) — consumers
     * MUST capability-check `window.terminal`. `create` pins the shell cwd to a
     * validated workspace `rootId` (main resolves + containment-checks it). pty
     * output/exit are pushed one-way to THIS renderer; `onData`/`onExit` register
     * a listener and return an unsubscribe fn. Valid invoke calls resolve to a
     * structured `TerminalResult`; structurally malformed direct IPC rejects
     * before handler entry.
     */
    terminal?: Bridge<typeof terminalContract>;
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
     * Derived from the desktop contract (BST-1648), which is itself pinned
     * equal to app-shell's `UserCommandsBridge` — nothing here can drift.
     */
    userCommands?: Bridge<typeof userCommandsContract>;
    /**
     * Low-friction folder connection (BST-1393). Absent on web — consumers
     * capability-check it via `resolveWorkspaceConnectBridge()`. The exposed
     * key set is pinned to `WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS` by the
     * preload-runtime contract test.
     */
    workspace?: import('@brainstrike/app-shell/workspace-connect/workspace-connect-bridge').WorkspaceConnectBridge;
    /** Desktop-only managed-worktree bridge, derived from its pure IPC contract. */
    worktrees?: Bridge<typeof worktreesContract>;
  }
}

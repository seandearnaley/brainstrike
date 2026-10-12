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
} from '@brainstrike/types';
import type { DesktopPlatformDiagnosticsSnapshot } from '../desktop-platform-diagnostics';
import type { MainLogWindowRequest, MainLogWindowResult } from '../diagnostics/main-log-window';
import type { ProcessCounterSnapshot } from '../diagnostics/process-counter-ring';
import type { changesContract } from '../ipc-domains/changes.contract';
import type { clipboardContract } from '../ipc-domains/clipboard.contract';
import type { commandSessionsContract } from '../ipc-domains/command-sessions.contract';
import type { contextFilesContract } from '../ipc-domains/context-files.contract';
import type { databaseIntegrityContract } from '../ipc-domains/database.contract';
import type { forgeContract } from '../ipc-domains/forge.contract';
import type { gitContract } from '../ipc-domains/git.contract';
import type { McpBridge } from '../ipc-domains/mcp.contract';
import type { notesVaultContract } from '../ipc-domains/notes-vault.contract';
import type { skillsContract } from '../ipc-domains/skills.contract';
import type { settingsContract } from '../ipc-domains/storage-preferences.contract';
import type { terminalContract } from '../ipc-domains/terminal.contract';
import type { userCommandsContract } from '../ipc-domains/user-commands.contract';
import type { userPersonasContract } from '../ipc-domains/user-personas.contract';
import type { windowFocusContract } from '../ipc-domains/window-focus.contract';
import type { worktreesContract } from '../ipc-domains/worktrees.contract';
import type { LlmHostRequest, LlmHostResponseReport, LlmHostStatus } from '../llm-host-shared';
import type { LoggingSettingsPayload } from '../logging-shared';
import type { Bridge } from '../platform/ipc-contract';
import type {
  ChunkingHostRuntimeBridge,
  DesktopElectronApi,
  EmbeddingHostRuntimeBridge,
  VisibleChunkingHostBridge,
  VisibleEmbeddingHostBridge,
} from './desktop-electron-api';

// Type definitions for the Electron API exposed via contextBridge
declare global {
  interface Window {
    agent: {
      chat: <T = unknown>(messages: T[], runtime?: unknown) => Promise<unknown[]>; // StreamChunk[] shape
    };
    agentHost?: { connect(requestId: string): Promise<void> };
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
    chunkingHost?: ChunkingHostRuntimeBridge | VisibleChunkingHostBridge;
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
    /**
     * Desktop-only database integrity state (BST-1870), derived from its pure IPC
     * contract, which is itself pinned to `DesktopDatabaseIntegrityBridge` in
     * `@brainstrike/db`. Held by the visible UI and the embedding host; absent on
     * web and in the other hidden hosts.
     */
    databaseIntegrity?: Bridge<typeof databaseIntegrityContract>;
    desktopDiagnostics?: {
      getSnapshot: () => Promise<DesktopPlatformDiagnosticsSnapshot>;
      readMainLogWindow: (request: MainLogWindowRequest) => Promise<MainLogWindowResult>;
      readProcessCounters: () => Promise<ProcessCounterSnapshot>;
    };
    desktopLifecycle?: {
      isTestMode: boolean;
      noteReloadIntent: (reason: string) => Promise<void>;
    };
    electronAPI?: DesktopElectronApi;
    embeddingHost?: EmbeddingHostRuntimeBridge | VisibleEmbeddingHostBridge;
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
    indexSearch?: import('@brainstrike/indexing-contract/indexer-client').IndexSearchCapability &
      import('@brainstrike/indexing-contract/indexer-client').IndexRootRegistrationCapability;
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
    /** Desktop settings reset capability, derived from its pure contract. */
    settings?: Bridge<typeof settingsContract>;
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
     * Desktop-only native window focus (BST-1864), derived from its pure IPC
     * contract, which is itself pinned to `WindowFocusBridge` in `@brainstrike/utils`.
     * Absent on web — `useAppActive()` capability-checks it.
     */
    windowFocus?: Bridge<typeof windowFocusContract>;
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

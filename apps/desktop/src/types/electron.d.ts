import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { LoggingPreferences, LoggingPreferencesPatch, LogRecord } from '@brainstrike/logging';
import type {
  DiagnosticEventsReader,
  mainDiagnosticEventsReader,
} from '../assistant-server/query-diagnostics-tool';
import type { BrowserTabState } from '../browser/browser-view-manager';
import type { DesktopPlatformDiagnosticsSnapshot } from '../desktop-platform-diagnostics';
import type { CrashDumpListing } from '../diagnostics/crash-dumps';
import type { MainLogWindowRequest, MainLogWindowResult } from '../diagnostics/main-log-window';
import type { ProcessCounterSnapshot } from '../diagnostics/process-counter-ring';
import type { agentHostRecoveryContract } from '../ipc-domains/agent-host-recovery.contract';
import type { appLifetimeContract } from '../ipc-domains/app-lifetime.contract';
import type { appUpdatesContract } from '../ipc-domains/app-updates.contract';
import type { clipboardContract } from '../ipc-domains/clipboard.contract';
import type { McpBridge } from '../ipc-domains/mcp.contract';
import type { modelCatalogContract } from '../ipc-domains/model-catalog.contract';
import type { threadGroupsContract } from '../ipc-domains/thread-groups.contract';
import type { viewFilterPresetsContract } from '../ipc-domains/view-filter-presets.contract';
import type { windowFocusContract } from '../ipc-domains/window-focus.contract';
import type { LoggingSettingsPayload } from '../logging-shared';
import type { TransportBridge } from '../platform/ipc-contract';
import type { VisibleDesktopElectronApi } from './desktop-electron-api';

// Type definitions for the Electron API exposed via contextBridge
declare global {
  interface Window {
    agentHost?: {
      connect(requestId: string): Promise<BoundaryResult<void>>;
      onPrepareClose(prepare: () => Promise<void>): () => void;
    };
    /** Desktop-only recovery actions for a damaged state store (BST-1880). */
    agentHostRecovery?: TransportBridge<typeof agentHostRecoveryContract>;
    /**
     * Desktop-only: Settings › Startup (ADR-0033). Whether closing the last window keeps the
     * app running in the tray, and whether it opens at login.
     */
    appLifetime?: TransportBridge<typeof appLifetimeContract>;
    /** Desktop-only: the app menu's Settings… item. */
    appMenu?: {
      onOpenSettings: (callback: () => void) => () => void;
    };
    /**
     * Desktop-only: Settings › Updates. Whether update checks offer betas (BST-2367),
     * and the update status with Check now and Restart to update (BST-2356).
     */
    appUpdates?: TransportBridge<typeof appUpdatesContract>;
    /**
     * Embedded browser bridge (BST-1174). Desktop-only; absent on web.
     * MUST stay in sync with `BrowserBridge` in
     * `@brainstrike/app-shell` `browser-pane/browser-bridge.ts` — a method
     * present on one side only disables every browser tab via
     * `resolveBrowserBridge()`.
     */
    browser?: {
      createTab: (threadId: string, url?: string) => Promise<string>;
      closeTab: (tabId: string) => Promise<void>;
      showTab: (tabId: string) => Promise<void>;
      navigate: (tabId: string, url: string) => Promise<void>;
      goBack: (tabId: string) => Promise<void>;
      goForward: (tabId: string) => Promise<void>;
      reload: (tabId: string) => Promise<void>;
      setBounds: (rect: { height: number; width: number; x: number; y: number }) => Promise<void>;
      setOccluded: (occluded: boolean) => Promise<void>;
      listTabs: () => Promise<readonly BrowserTabState[]>;
      /** One-way main→renderer tab-state pushes. Returns unsubscribe. */
      onTabsChanged: (listener: (tabs: readonly BrowserTabState[]) => void) => () => void;
    };
    /** Desktop-only clipboard write bridge, derived from its contract (BST-1648). */
    clipboard?: TransportBridge<typeof clipboardContract>;
    commandPalette?: {
      onOpen: (callback: () => void) => () => void;
    };
    desktopDiagnostics?: DiagnosticEventsReader & {
      getUnseenCounts: typeof mainDiagnosticEventsReader.getUnseenCounts;
      getSnapshot: () => Promise<BoundaryResult<DesktopPlatformDiagnosticsSnapshot>>;
      listCrashDumps: () => Promise<BoundaryResult<CrashDumpListing>>;
      readMainLogWindow: (
        request: MainLogWindowRequest
      ) => Promise<BoundaryResult<MainLogWindowResult>>;
      readProcessCounters: () => Promise<BoundaryResult<ProcessCounterSnapshot>>;
    };
    desktopLifecycle?: {
      isTestMode: boolean;
      noteReloadIntent: (reason: string) => Promise<void>;
      requestReload: (reason: string) => Promise<void>;
    };
    electronAPI?: VisibleDesktopElectronApi;
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
    logging: {
      getPreferences: () => Promise<BoundaryResult<LoggingSettingsPayload>>;
      setPreferences: (
        patch: LoggingPreferencesPatch
      ) => Promise<BoundaryResult<LoggingSettingsPayload>>;
      selectDestination: () => Promise<BoundaryResult<string | null>>;
      openDestination: (target: string | null) => Promise<BoundaryResult<boolean>>;
      getBufferedLogs: () => Promise<BoundaryResult<LogRecord[]>>;
      onDurableRecord: (listener: (record: LogRecord) => void) => () => void;
      onPreferencesUpdated: (
        callback: (preferences: LoggingPreferences) => void
      ) => (() => void) | undefined;
    };
    mcp: McpBridge;
    modelCatalog?: TransportBridge<typeof modelCatalogContract>;
    /**
     * OS shell integration bridge. Absent on web (no preload) — consumers MUST
     * capability-check `window.platform`.
     *
     * ⚠️ MUST stay in sync with `PlatformBridge` in
     * `packages/app-shell/src/platform-bridge.ts`.
     * `resolvePlatformBridge()` rejects a bridge missing any method, so a
     * method declared here but absent from the preload — or vice versa —
     * disables shell actions AND markdown preview at runtime.
     */
    platform?: {
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
      openPath: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
      showItemInFolder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
    };
    /**
     * Secure secrets bridge (BST-1348). The shape is defined ONCE in
     * `@brainstrike/assistant-contract/secrets-bridge` — the preload
     * implements it and the preload-runtime contract test pins the exposed
     * key set to `SECRETS_BRIDGE_REQUIRED_METHODS`.
     */
    secrets: import('@brainstrike/assistant-contract/secrets-bridge').SecretsBridge;
    threadGroups?: TransportBridge<typeof threadGroupsContract>;
    viewFilterPresets?: TransportBridge<typeof viewFilterPresetsContract>;
    /**
     * Desktop-only native window focus (BST-1864), derived from its pure IPC
     * contract, which is itself pinned to `WindowFocusBridge` in `@brainstrike/utils`.
     * Absent on web — `useAppActive()` capability-checks it.
     */
    windowFocus?: TransportBridge<typeof windowFocusContract>;
    /**
     * Low-friction folder connection (BST-1393). Absent on web — consumers
     * capability-check it via `resolveWorkspaceConnectBridge()`. The exposed
     * key set is pinned to `WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS` by the
     * preload-runtime contract test.
     */
    workspace?: import('@brainstrike/app-shell/workspace-connect/workspace-connect-bridge').WorkspaceConnectBridge;
  }
}

import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { LoggingPreferences, LoggingPreferencesPatch, LogRecord } from '@brainstrike/logging';
import type { DiagnosticEventsQueryFilter } from '@brainstrike/utils/diagnostics';
import type {
  DiagnosticEventsReader,
  mainDiagnosticEventsReader,
} from './assistant-server/query-diagnostics-tool';
import type { DesktopPlatformDiagnosticsSnapshot } from './desktop-platform-diagnostics';
import type { CrashDumpListing } from './diagnostics/crash-dumps';
import type { MainLogWindowRequest, MainLogWindowResult } from './diagnostics/main-log-window';
import type { ProcessCounterSnapshot } from './diagnostics/process-counter-ring';
import { getFactoryResetUnavailableReason } from './factory-reset-availability';
import { agentHostRecoveryContract } from './ipc-domains/agent-host-recovery.contract';
import { appLifetimeContract } from './ipc-domains/app-lifetime.contract';
import { appUpdatesContract } from './ipc-domains/app-updates.contract';
import { clipboardContract } from './ipc-domains/clipboard.contract';
import { contentClearContract } from './ipc-domains/content-clear.contract';
import { type DatabasePathBridge, databasePathContract } from './ipc-domains/database.contract';
import { factoryResetContract } from './ipc-domains/factory-reset.contract';
import { fileSystemContract } from './ipc-domains/file-system.contract';
import { indexSearchContract } from './ipc-domains/index-search.contract';
import { mcpAppsContract, mcpPathSelectionContract } from './ipc-domains/mcp.contract';
import { modelCatalogContract } from './ipc-domains/model-catalog.contract';
import { threadGroupsContract } from './ipc-domains/thread-groups.contract';
import { viewFilterPresetsContract } from './ipc-domains/view-filter-presets.contract';
import { windowFocusContract } from './ipc-domains/window-focus.contract';
import type { LoggingSettingsPayload } from './logging-shared';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import {
  createBridgeExposer,
  createDesktopIpcTransport,
  createIpcBridge,
} from './platform/ipc-bridge';
import {
  assertDesktopElectronApiKeyParity,
  type VisibleDesktopElectronApi,
} from './types/desktop-electron-api';

// Electron preload script. `electron` is the ONE runtime require a sandboxed
// preload can resolve; every import above is either type-only (erased)
// or a PURE relative module that `scripts/build-main-config.mjs` inlines into
// dist/preload.js (BST-1648). build-main.mjs refuses a bundle that requires
// anything else.
const electron = require('electron');
const { contextBridge, webUtils } = electron;

type McpAppShellBridge = import('@brainstrike/assistant-contract').McpAppShellBridge;
// The preload's ONE connection to Main: every call and push below rides it by method name.
const ipcRenderer = createDesktopIpcTransport(electron.ipcRenderer);
// Contract-derived bridges (BST-1648): `exposeBridge(name, contract)` exposes
// exactly `Object.keys(contract)`, each routed to its manifest channel with
// unchanged result envelope. Pinned by preload-contract-bridges.test.ts.
const exposeBridge = createBridgeExposer({ contextBridge, ipcRenderer });
// Only the visible preload receives this client transport. Main authorizes the
// requesting frame before transferring a port; the host authenticates commands.
const frameClosePreparations = new Set<() => Promise<void>>();
/**
 * A failed preparation crosses to Main as text. The context bridge copies only an error's
 * message, so the renderer's aggregates name their causes in it.
 */
const describeCloseFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
contextBridge.exposeInMainWorld('agentHost', {
  connect: (requestId: string): Promise<BoundaryResult<void>> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.agent.hostConnect, requestId),
  onPrepareClose: (prepare: () => Promise<void>): (() => void) => {
    frameClosePreparations.add(prepare);
    return () => frameClosePreparations.delete(prepare);
  },
});
ipcRenderer.on(
  DESKTOP_IPC_CHANNELS.agent.prepareClose,
  (event: { ports: readonly MessagePort[] }) => {
    const reply = event.ports[0];
    if (!reply) {
      throw new Error('Renderer close preparation has no private reply port');
    }
    const preparation = Promise.allSettled(
      [...frameClosePreparations].map(async (prepare) => await prepare())
    );
    void preparation.then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [describeCloseFailure(result.reason)] : []
      );
      reply.postMessage(failures.length === 0 ? { prepared: true } : { failures, prepared: false });
      reply.close();
    });
  }
);
ipcRenderer.on(
  DESKTOP_IPC_CHANNELS.agent.hostConnected,
  (event: { ports: readonly MessagePort[] }, payload: unknown) => {
    window.postMessage({ payload, type: 'agent-host/connected' }, '*', [...event.ports]);
  }
);
ipcRenderer.on(DESKTOP_IPC_CHANNELS.agent.hostDisconnected, (_event: unknown, payload: unknown) => {
  window.postMessage({ payload, type: 'agent-host/disconnected' }, '*');
});
const DESKTOP_TEST_MODE =
  process.argv.includes('--test-mode') || process.env['ELECTRON_IS_E2E_TEST'] === 'true';

if (DESKTOP_TEST_MODE) {
  contextBridge.exposeInMainWorld('__brainstrike_e2e_expose_file_explorer_store__', true);
}

const databasePathBridge: DatabasePathBridge = createIpcBridge(ipcRenderer, databasePathContract);

function disabledPreloadBridges(): Set<string> {
  if (!DESKTOP_TEST_MODE) {
    return new Set();
  }
  return new Set(
    (process.env['BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES'] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
}

const disabledBridgeNames = disabledPreloadBridges();

function shouldExposeBridge(name: string): boolean {
  return !disabledBridgeNames.has(name);
}

if (shouldExposeBridge('electronAPI')) {
  const electronAPI = {
    content: createIpcBridge(ipcRenderer, contentClearContract),
    factoryReset: {
      ...createIpcBridge(ipcRenderer, factoryResetContract),
      unavailableReason: getFactoryResetUnavailableReason(process.platform),
    },
    fileSystem: createIpcBridge(ipcRenderer, fileSystemContract),
    // Current profile path, independent of database engine ownership.
    getUserDataPath: databasePathBridge.getUserDataPath,
  } satisfies VisibleDesktopElectronApi;
  assertDesktopElectronApiKeyParity(electronAPI);
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
}

// Secure Secrets API
contextBridge.exposeInMainWorld('secrets', {
  deleteKey: (provider: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.delete, provider),
  getCredential: (provider: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.getCredential, provider),
  getKey: (provider: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.get, provider),
  list: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.list),
  listStored: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.listStored),
  saveCredential: (provider: string, credential: unknown) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.saveCredential, provider, credential),
  saveKey: (provider: string, value: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.save, provider, value),
});

// Env bootstrap visibility bridge (BST-1363). Read-only and NAMES-ONLY: the
// main-process projection reports which .env files loaded, their paths, the
// line-precise parse failures, and the NAMES of allow-listed variables that
// are set — never a variable's value. Shape defined ONCE in
// @brainstrike/assistant-contract env-bootstrap-bridge.ts (EnvBootstrapBridge).
contextBridge.exposeInMainWorld('envBootstrap', {
  read: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.secrets.envBootstrap),
});

if (shouldExposeBridge('indexSearch')) {
  exposeBridge('indexSearch', indexSearchContract);
}

contextBridge.exposeInMainWorld('desktopLifecycle', {
  isTestMode: DESKTOP_TEST_MODE,
  noteReloadIntent: (reason: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtime.noteReloadIntent, reason),
  requestReload: (reason: string): Promise<void> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtime.requestReload, reason),
});

// The MCP config picker and MCP App shell (desktop-only), derived from pure
// contracts. MCP settings, status, Tasks cards, global server input and
// content, an App's document included, belong to the agent host.
const mcpPathSelectionBridge = createIpcBridge(ipcRenderer, mcpPathSelectionContract);
const mcpAppsBridge = createIpcBridge(ipcRenderer, mcpAppsContract);
contextBridge.exposeInMainWorld('mcp', {
  ...mcpPathSelectionBridge,
  apps: mcpAppsBridge satisfies McpAppShellBridge,
});

if (shouldExposeBridge('logging')) {
  contextBridge.exposeInMainWorld('logging', {
    getBufferedLogs: (): Promise<BoundaryResult<LogRecord[]>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.getBufferedLogs),
    getPreferences: (): Promise<BoundaryResult<LoggingSettingsPayload>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.getPreferences),
    onDurableRecord: (listener: (record: LogRecord) => void) => {
      const ipcListener = (_event: unknown, record: LogRecord) => listener(record);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.logging.durableRecord, ipcListener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.logging.durableRecord, ipcListener);
      };
    },
    onPreferencesUpdated: (callback: (preferences: LoggingPreferences) => void) => {
      const listener = (_event: unknown, prefs: LoggingPreferences) => callback(prefs);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.logging.preferencesUpdated, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.logging.preferencesUpdated, listener);
      };
    },
    openDestination: (target: string | null): Promise<BoundaryResult<boolean>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.openDestination, target ?? null),
    selectDestination: (): Promise<BoundaryResult<string | null>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.selectDestination),
    setPreferences: (
      patch: LoggingPreferencesPatch
    ): Promise<BoundaryResult<LoggingSettingsPayload>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logging.setPreferences, patch),
  });
}

if (shouldExposeBridge('desktopDiagnostics')) {
  contextBridge.exposeInMainWorld('desktopDiagnostics', {
    countByFingerprint: (
      fingerprint: string,
      sinceMs: number
    ): ReturnType<DiagnosticEventsReader['countByFingerprint']> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.countByFingerprint, {
        fingerprint,
        sinceMs,
      }),
    getSnapshot: (): Promise<BoundaryResult<DesktopPlatformDiagnosticsSnapshot>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.getSnapshot),
    getUnseenCounts: (
      sinceMs: number
    ): ReturnType<typeof mainDiagnosticEventsReader.getUnseenCounts> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.getUnseenCounts, sinceMs),
    listCrashDumps: (): Promise<BoundaryResult<CrashDumpListing>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.listCrashDumps),
    queryEvents: (
      filter: DiagnosticEventsQueryFilter
    ): ReturnType<DiagnosticEventsReader['queryEvents']> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.queryEvents, filter),
    readMainLogWindow: (
      request: MainLogWindowRequest
    ): Promise<BoundaryResult<MainLogWindowResult>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow, request),
    readProcessCounters: (): Promise<BoundaryResult<ProcessCounterSnapshot>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters),
  });
}

// ⌘K command palette: the app menu's Cmd+K accelerator pushes this event to the
// focused window so the renderer can open the palette.
contextBridge.exposeInMainWorld('commandPalette', {
  onOpen: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.commandPalette.open, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.commandPalette.open, listener);
    };
  },
});

// The app menu's Settings… item (⌘, / Ctrl+,) pushes this event to the focused
// window so the renderer can open Settings.
contextBridge.exposeInMainWorld('appMenu', {
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.appMenu.openSettings, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.appMenu.openSettings, listener);
    };
  },
});

// Low-friction folder connection (BST-1393, spec §7): the app menu's
// Open Folder… / Open Recent, `brainstrike <path>` argv, macOS open-file, and
// resolving a Finder-dropped folder to an absolute path. The two `on*` members
// mirror commandPalette; `getDroppedPath` is preload-local.
let workspaceResetGenerationPayload: unknown = { resetGeneration: null };
let workspaceOpenPathReady = false;
const sendOpenPathReady = (): void => {
  void ipcRenderer.invoke(
    DESKTOP_IPC_CHANNELS.workspace.openPathReady,
    workspaceResetGenerationPayload
  );
};
ipcRenderer.on(
  DESKTOP_IPC_CHANNELS.workspace.factoryResetGeneration,
  (_event: unknown, payload: unknown) => {
    // Echo the payload unchanged. Main validates it strictly so malformed
    // wiring becomes an immediate reset diagnostic rather than being silently
    // normalized into a timeout.
    workspaceResetGenerationPayload = payload;
    // The renderer can be ready before Main's challenge arrives (Main pushes it at
    // dom-ready); answer it now so readiness does not depend on that order.
    if (workspaceOpenPathReady) {
      sendOpenPathReady();
    }
  }
);

if (shouldExposeBridge('workspace')) {
  contextBridge.exposeInMainWorld('workspace', {
    getDroppedPath: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        // Documented throw: the argument was not a File. Reported as "no
        // path", which the renderer counts and states — never a silent skip.
        return '';
      }
    },
    // The one renderer→main member of this bridge; a refusal surfaces as an
    // unhandled rejection. `WorkspaceConnectHost` calls this the instant it
    // subscribes to `onOpenPath`, so main can gate delivery on the renderer
    // actually being ready to receive rather than merely having loaded.
    notifyOpenPathReady: (): void => {
      workspaceOpenPathReady = true;
      sendOpenPathReady();
    },
    onOpenFolderPicker: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.workspace.openFolderPicker, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.workspace.openFolderPicker, listener);
      };
    },
    onOpenPath: (callback: (request: unknown) => void) => {
      const listener = (_event: unknown, request: unknown) => callback(request);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.workspace.openPath, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.workspace.openPath, listener);
      };
    },
  });
}

// System Clipboard helper (renderer-friendly). Writes go through main over
// IPC: sandboxed preloads cannot require Electron's clipboard module, so a
// direct module call here silently fails on real (non-test-mode) builds.
exposeBridge('clipboard', clipboardContract);

// Native window focus (BST-1864, desktop-only): `isFocused()` reads THIS window's
// OS focus and `onChange` receives every focus/blur push. `useAppActive()` in
// `@brainstrike/hooks` capability-checks `window.windowFocus`: keyboard focus in
// the browser pane's WebContentsView (or docked DevTools) makes the renderer's own
// `document.hasFocus()` false while the window is still the focused OS window.
// Web has no preload, so it keeps `document.hasFocus()`.
if (shouldExposeBridge('windowFocus')) {
  exposeBridge('windowFocus', windowFocusContract);
}

// A damaged state store's recovery actions (BST-1880): restart the agent host this
// app launched, and show the profile's data folder. Desktop-only.
if (shouldExposeBridge('agentHostRecovery')) {
  exposeBridge('agentHostRecovery', agentHostRecoveryContract);
}

// Settings › Startup (ADR-0033, desktop-only): keep running in the tray, open at login.
if (shouldExposeBridge('appLifetime')) {
  exposeBridge('appLifetime', appLifetimeContract);
}

// Settings › Updates (BST-2367, desktop-only): whether update checks offer betas.
if (shouldExposeBridge('appUpdates')) {
  exposeBridge('appUpdates', appUpdatesContract);
}

// File-export save bridge (desktop-only): writes export bytes into the OS
// Downloads folder from MAIN, bypassing Chromium's blob-download pipeline
// (a blob download whose URL is revoked mid-flight can wedge permanently and
// jam later downloads). Web never defines this; `@brainstrike/utils`'s
// `downloadBlobFile` capability-checks `window.fileExports` and falls back to
// the anchor path there.
if (shouldExposeBridge('fileExports')) {
  contextBridge.exposeInMainWorld('fileExports', {
    saveToDownloads: (payload: { bytes: Uint8Array; filename: string }) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.fileExports.saveToDownloads, payload),
  });
}

// Platform shell bridge: reveal/open absolute paths in the OS file manager.
if (shouldExposeBridge('platform')) {
  contextBridge.exposeInMainWorld('platform', {
    openExternal: (url: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.shell.openExternal, url),
    openPath: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.shell.openPath, absolutePath),
    showItemInFolder: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.shell.showItemInFolder, absolutePath),
  });
}

// Embedded browser bridge (BST-1174). Every invoke returns the main-side
// `{ ok, value } | { ok: false, error }` result; the bridge UNWRAPS it and
// throws on `ok: false` — the renderer only ever passes well-formed args, so a
// rejection is a programming error worth surfacing, never a silent no-op.
if (shouldExposeBridge('browser')) {
  const unwrapBrowserResult = <T>(result: unknown): T => {
    if (typeof result === 'object' && result !== null && 'ok' in result) {
      const typed = result as { ok: boolean; value?: T; error?: string };
      if (typed.ok) {
        return typed.value as T;
      }
      throw new Error(`browser bridge call failed: ${typed.error ?? 'unknown error'}`);
    }
    throw new Error('browser bridge returned a malformed result');
  };
  contextBridge.exposeInMainWorld('browser', {
    closeTab: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.closeTab, tabId)
        .then(unwrapBrowserResult<void>),
    createTab: (threadId: string, url?: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.createTab, threadId, url)
        .then(unwrapBrowserResult<string>),
    goBack: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.goBack, tabId)
        .then(unwrapBrowserResult<void>),
    goForward: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.goForward, tabId)
        .then(unwrapBrowserResult<void>),
    listTabs: () =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.listTabs)
        .then(unwrapBrowserResult<unknown[]>),
    navigate: (tabId: string, url: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.navigate, tabId, url)
        .then(unwrapBrowserResult<void>),
    // One-way main→renderer tab-state pushes (browser:tabsChanged). Subscribe-
    // returns-unsubscribe, mirroring changes.onInvalidated / fs.onWatchEvent.
    onTabsChanged: (callback: (tabs: unknown[]) => void) => {
      const listener = (_event: unknown, tabs: unknown[]) => callback(tabs);
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.browser.tabsChanged, listener);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.browser.tabsChanged, listener);
      };
    },
    reload: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.reload, tabId)
        .then(unwrapBrowserResult<void>),
    setBounds: (rect: { height: number; width: number; x: number; y: number }) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.setBounds, rect)
        .then(unwrapBrowserResult<void>),
    setOccluded: (occluded: boolean) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.setOccluded, occluded)
        .then(unwrapBrowserResult<void>),
    showTab: (tabId: string) =>
      ipcRenderer
        .invoke(DESKTOP_IPC_CHANNELS.browser.showTab, tabId)
        .then(unwrapBrowserResult<void>),
  });
}

// Hooks trust-review bridge (desktop). Capability-gated: the Hooks settings
// panel reads a project root's `.brainstrike/hooks.json` (content + sha256 and
// the host's trust) to display before the user approves it. The agent host owns
// the trust and re-hashes the file on every approval and every run.
if (shouldExposeBridge('hooks')) {
  contextBridge.exposeInMainWorld('hooks', {
    getProjectHooksForReview: (rootId: string, absPath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.hooks.getProjectHooksForReview, rootId, absPath),
    trustProjectHooks: (absPath: string, sha256: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.hooks.trustProjectHooks, absPath, sha256),
    untrustProjectHooks: (absPath: string) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.hooks.untrustProjectHooks, absPath),
  });
}

if (shouldExposeBridge('threadGroups')) {
  exposeBridge('threadGroups', threadGroupsContract);
}
if (shouldExposeBridge('viewFilterPresets')) {
  exposeBridge('viewFilterPresets', viewFilterPresetsContract);
}

if (shouldExposeBridge('modelCatalog')) {
  exposeBridge('modelCatalog', modelCatalogContract);
}

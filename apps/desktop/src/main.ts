// Side-effect import, deliberately FIRST: wraps WebAssembly before any other
// import (tokenizers, xxhash-wasm) can instantiate a module.
import './diagnostics/install-webassembly-counter';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { detectDeprecatedProviderEnvVars } from '@brainstrike/assistant-contract/provider-metadata';
import { loadWorkspaceRootsFromCatalog } from '@brainstrike/assistant-service/node-workspace-services';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { clearReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import {
  addLogListener,
  createLogger,
  type FileTransportConfig,
  initializeLogging,
  LogBuffer,
} from '@brainstrike/logging';
import { app, BrowserWindow, dialog, Menu, powerMonitor, session, shell } from 'electron';
import ElectronStore from 'electron-store';
import { registerAgentHostClientIpc } from './agent-host-client-ipc';
import { createAgentHostMainClient } from './agent-host-main-client';
import { bindDesktopPlatformPort } from './agent-host-platform/desktop-platform-port';
import { productionDesktopCapabilities } from './agent-host-platform/production-desktop-capabilities';
import { createDesktopWorkspaceRootCatalog } from './agent-host-platform/workspace-root-client';
import { restartLaunchedAgentHost } from './agent-host-restart';
import { type AppLifetime, createAppLifetime } from './app-lifetime';
import {
  notify,
  resolveBackgroundPresence,
  resolveLoginItems,
  wasLaunchedAtLogin,
} from './app-lifetime-electron';
import { createAppUpdates } from './app-update';
import { checkForUpdatesFromMenu, offerMoveToApplicationsFolder } from './app-update-dialogs';
import { readUpdatePreferences, writeUpdatePreferences } from './app-update-preferences';
import { isAppWindowSender } from './app-windows';
import { buildFileMenuTemplate } from './application-file-menu';
import {
  buildAboutPanelOptions,
  buildFileMenuClosingItems,
  buildHelpMenuTemplate,
  buildMacAppMenuTemplate,
  buildMacWindowMenuTemplate,
  releaseNotesUrl,
} from './application-menu';
import { registerAssetProtocol } from './asset-protocol';
import { createBrowserPaneHost } from './browser/browser-pane-host';
import {
  clearActiveBrowserPaneHost,
  setActiveBrowserPaneHost,
} from './browser/browser-pane-registry';
import { createBrowserIpcHandlers } from './browser-ipc-handlers';
import { registerCanvasProtocol } from './canvas-protocol';
import { closeDesktopRenderers } from './close-desktop-renderers';
import { createWindow, noteNextWindowReload } from './create-window';
import { joinProfileDirectory } from './database-location';
import { getDesktopBootstrapRuntime } from './desktop-bootstrap-runtime';
import { getDesktopCrashRecoverySnapshot } from './desktop-crash-recovery';
import {
  resolveDesktopDatabaseLocation,
  resolveDesktopDatabaseProfileDirectory,
} from './desktop-database-location';
import { getDesktopLoginShellEnvironment } from './desktop-env';
import { buildDesktopEnvBootstrapReport } from './desktop-env-report';
import { serializeDesktopError } from './desktop-error-serialization';
import { createDesktopHookTrust } from './desktop-hook-trust';
import { resolveDesktopRendererLaunchMode } from './desktop-launch-mode';
import { createDesktopProfileResetOwner } from './desktop-profile-reset-owner';
import {
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
} from './desktop-renderer-target';
import { DESKTOP_DEV_RENDERER_URL } from './desktop-renderer-url';
import { getDesktopResetDiagnosticsSnapshot } from './desktop-reset-diagnostics';
import { createDesktopFactoryResetHandler, type DesktopResetMode } from './desktop-reset-platform';
import { createDesktopResetResume } from './desktop-reset-resume';
import {
  isDesktopShuttingDown,
  isExpectedShutdownRefusal,
  markDesktopShuttingDown,
} from './desktop-shutdown-state';
import { listCrashDumps } from './diagnostics/crash-dumps';
import {
  createErrorLogSink,
  ERROR_LOG_FILE_NAME,
  type ErrorLogSinkHandle,
  listErrorLogFilePaths,
} from './diagnostics/error-log-sink';
import { resolveMainLogTransportPath } from './diagnostics/main-log-transport-path';
import { readMainLogWindow } from './diagnostics/main-log-window';
import { MAIN_WATCHDOG_CHECK_INTERVAL_MS } from './diagnostics/main-watchdog-core';
import { resolveMainWatchdogWorkerPath } from './diagnostics/main-watchdog-path';
import {
  createMainWatchdogAttachmentLifecycle,
  createMainWatchdogRuntime,
  runMainWatchdogPowerTransition,
  startMainWatchdogBeforeWindow,
} from './diagnostics/main-watchdog-runtime';
import {
  PROCESS_COUNTER_RING_CAPACITY,
  ProcessCounterRing,
} from './diagnostics/process-counter-ring';
import { createProcessCounterSampler } from './diagnostics/process-counter-sampler';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from './diagnostics/rotating-file-sink';
import { installWebAssemblyCounter } from './diagnostics/webassembly-counter';
import { resolveBuiltRendererPath } from './dist-root';
import {
  admitDocumentClose,
  type DocumentUnloadOwner,
  flushDocumentBeforeUnload,
  installDocumentUnload,
  reloadDocument,
  visibleDocumentWindows,
} from './document-unload';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';
import { createFactoryResetRendererReplacementCoordinator } from './factory-reset-renderer-replacement';
import { resolveFolderCandidatesFromArgv } from './folder-argv';
import {
  createHostProfileAdmission,
  reportAgentHostStartupFailure as reportHostStartupFailure,
} from './host-profile-admission';
import { registerAgentHostRecoveryIpcHandlers } from './ipc-agent-host-recovery';
import { registerAppLifetimeIpcHandlers } from './ipc-app-lifetime';
import { registerAppUpdatesIpcHandlers } from './ipc-app-updates';
import { registerBrowserIpcHandlers } from './ipc-browser';
import { registerClipboardIpcHandlers } from './ipc-clipboard';
import { registerDesktopDiagnosticsIpcHandlers } from './ipc-desktop-diagnostics';
import { pickWorkspaceFolder } from './ipc-domains/file-system-ipc';
import { registerFileExportsIpcHandlers } from './ipc-file-exports';
import { createApplicationIpcDomain, registerIpcHandlers } from './ipc-handlers';
import { registerHooksIpcHandlers } from './ipc-hooks';
import {
  cleanupMcpRuntimeForShutdown,
  registerMcpIpcHandlers,
  resetMcpRuntimeForFactoryReset,
  resumeMcpRuntimeAfterFactoryReset,
  suspendMcpSurfacesForContentClear,
} from './ipc-mcp';
import { registerModelCatalogIpc } from './ipc-model-catalog';
import { registerSecretsIpcHandlers } from './ipc-secrets';
import { registerShellIpcHandlers } from './ipc-shell';
import { registerThreadGroupsIpc } from './ipc-thread-groups';
import { registerViewFilterPresetsIpc } from './ipc-view-filter-presets';
import { lifecycleDelaySeam } from './lifecycle-delay-seam';
import { registerLoggingIpcHandlers } from './logging-ipc';
import {
  createDesktopGracefulShutdown,
  type DesktopShutdownRunPlan,
} from './main/desktop-graceful-shutdown';
import { createDisposerStack, type DisposerHandle } from './main/disposer-stack';
import {
  createDesktopLoggingPreferencesController,
  readConsoleLevelOverride,
} from './main/logging-preferences';
import { installShutdownSignalHandlers } from './main/shutdown-signals';
import { registerMainPlatformIpcHandlers } from './main-platform-ipc';
import { isMainProcessHealthDegraded } from './main-process-health-log-level';
import { getMcpAppShellRegistry, registerMcpAppShellProtocol } from './mcp/apps-shell-protocol';
import { createDesktopMcpPlatformCapabilities } from './mcp/desktop-host-platform';
import { getMainMcpHostControl } from './mcp/main-host-control';
import { createDesktopModelCatalog } from './model-catalog';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { pushToRenderer } from './platform/desktop-ipc-push';
import { prepareDocumentUnload } from './prepare-document-unload';
import { registerRendererProtocol } from './renderer-protocol';
import { createSafeStorageCredentialCipher } from './safe-storage-credential-cipher';
import { trashScratchFolder } from './scratch-folder-trash';
import { createDesktopSettingsSecrets } from './secrets';
import { setupSecurity } from './setup-security';
import { markRendererFirstPaint, readStartupTimeline } from './startup-timeline';
import type { DesktopSettingsStoreSchema } from './store-schema';
import { resolveThirdPartyNoticesPath } from './third-party-notices-path';
import { registerWindowFocusIpcHandlers } from './window-focus-ipc';
import { readStoredWindowState, registerWindowStatePersistence } from './window-state';
import { enqueueFolderCandidates, filterDirectoryOpenCandidates } from './workspace-open-queue';
import { registerWorkspaceOpenReadyIpcHandlers } from './workspace-open-ready-ipc';

const desktopBootstrap = getDesktopBootstrapRuntime();
const MAIN_ENTRY_PATH = desktopBootstrap.mainEntryPath;
const desktopEnvLoadResult = desktopBootstrap.environment;
const disableFileLogs = process.env['BRAINSTRIKE_DISABLE_FILE_LOGS'] === '1';

function tryShowStartupErrorDialog(message: string): void {
  try {
    if (typeof dialog?.showErrorBox === 'function') {
      dialog.showErrorBox('Brainstrike failed to start', message);
    }
  } catch (dialogError) {
    logger.error('Failed to show startup error dialog', {
      dialogError,
      message,
    });
  }
}

// Defer getPath call until app is ready - calling at module load time fails
let logFilePath: string | null = null;
function getLogFilePath(): string | null {
  if (disableFileLogs) {
    return null;
  }
  // CRITICAL: app.getPath() throws before app.ready - return null and configure later
  if (!app.isReady()) {
    return null;
  }
  if (logFilePath === null) {
    logFilePath = path.join(app.getPath('logs'), 'brainstrike.log');
  }
  return logFilePath;
}

function createMainLogTransportConfig(): Pick<FileTransportConfig, 'options' | 'target'> {
  return {
    options: {
      maxBytes: DEFAULT_MAX_BYTES,
      maxFiles: DEFAULT_MAX_FILES,
    },
    target: resolveMainLogTransportPath(app.getAppPath(), app.isPackaged),
  };
}

// Defer ElectronStore creation until app is ready
// CRITICAL: ElectronStore uses app.getPath('userData') internally, which fails before app.ready
let _settingsStore: ElectronStore<DesktopSettingsStoreSchema> | null = null;
function getSettingsStore(): ElectronStore<DesktopSettingsStoreSchema> | null {
  if (!_settingsStore) {
    // Return null before app.ready - callers must handle this gracefully
    if (!app.isReady()) {
      return null;
    }
    _settingsStore = new ElectronStore<DesktopSettingsStoreSchema>({
      name: 'brainstrike-settings',
    });
  }
  return _settingsStore;
}

function requireSettingsStore(): ElectronStore<DesktopSettingsStoreSchema> {
  const store = getSettingsStore();
  if (!store) {
    throw new Error('The settings store opens only once the app is ready.');
  }
  return store;
}

const logger = createLogger('DesktopMain');
// BST-2356: the launch check, a check every few hours, Check for Updates… and
// Restart to update. The factory reset below stops it for the rest of the launch.
const appUpdates = createAppUpdates();
// Preference STATE lives in main/logging-preferences.ts (BST-1648 step 4);
// the boot ORDER below is unchanged: controller (initial set) → watchdog →
// log buffer → initializeLogging → applyInitial. The watchdog hook is a
// closure over `mainWatchdogRuntime`, which is constructed a few lines down
// and only ever reached from a later IPC-driven update.
const loggingPreferences = createDesktopLoggingPreferencesController({
  app,
  consoleLevelOverride: readConsoleLevelOverride(process.env['LOG_LEVEL']),
  createMainLogTransportConfig,
  disableFileLogs,
  getLogFilePath,
  getSettingsStore,
  logger,
  onFilePreferencesApplied: (file) => {
    mainWatchdogRuntime.configureLogging(file);
  },
  showItemInFolder: (target) => shell.showItemInFolder(target),
  showSaveDialog: (options) => dialog.showSaveDialog(options),
});
const loggingOptions = loggingPreferences.createInitializeLoggingOptions();
const mainWatchdogRuntime = createMainWatchdogRuntime({
  onDeliveryError: ({ error, message }) => {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        messageType: message.type,
      },
      'main-thread watchdog message delivery failed'
    );
  },
});
const mainWatchdogAttachment = createMainWatchdogAttachmentLifecycle(mainWatchdogRuntime);

// Captured at module evaluation — BEFORE app.whenReady() and therefore before
// any renderer (the only run-row minter) can exist. The thread-run startup
// reaper's evidence rule compares run started_at stamps against this instant;
// see assistant-server/thread-run-startup-reaper.ts.
logger.debug('Main process started');
const mainLogBuffer = new LogBuffer({ size: 3000 });
// Same counter the first-import side-effect module installed (idempotent).
const mainWebAssemblyCounter = installWebAssemblyCounter();
const processCounterRing = new ProcessCounterRing(PROCESS_COUNTER_RING_CAPACITY);

const processCounterSampler = createProcessCounterSampler({
  counter: mainWebAssemblyCounter,
  ring: processCounterRing,
});
const removeLogBufferListener = addLogListener((record) => {
  mainLogBuffer.push(record);
});

try {
  initializeLogging(loggingOptions);
} catch (error) {
  logger.error('Failed to initialize structured logging; continuing with console-only logs.', {
    error,
  });
}

loggingPreferences.applyInitial();

// BST-1330: gates the developer-menu database reset so a repeat accelerator
// press surfaces "already in progress" instead of the reset barrier's throw.
let developerDatabaseResetInFlight = false;
// ADR-0029 stage 4: the agent host's recent-folders ledger, as it last told Main
// (`platform/workspace/roots-changed`). The File menu reads this copy; the ledger
// is the host's. A change before the menu exists is kept here and the menu's first
// build reads it; only that grant's OS recent-document entry is not added.
let workspaceRecentRootPaths: readonly string[] = [];
/** The menu's follower of the host's changes: a grant's OS recent document, and a rebuild. */
let workspaceRootsMenuSubscriber:
  | ((change: { readonly grantedPath?: string; readonly recentChanged: boolean }) => void)
  | null = null;
// The ONE holder of IPC-domain disposers (BST-1648 step 4): every
// registerXIpcHandlers(...) disposer is pushed here and `will-quit` unwinds
// the stack (LIFO, throw-isolated) — no per-domain `let unregisterX` slot.
const ipcDisposers = createDisposerStack();
// Per-window: the embedded browser pane's IPC is bound to the CURRENT visible
// window (rebound on a macOS dock-reopen), so its handle is kept to retire the
// previous binding before the next one is added.
let browserIpcDisposer: DisposerHandle | null = null;
// Flight Recorder P2a Task 3: the durable NDJSON backstop for warn+ records
// from main AND from the renderer over IPC (see
// registerLoggingIpcHandlers' recordDurableLog below). Constructed at
// app-ready when file logging isn't disabled; closed as the last graceful-
// shutdown step so it captures failures from every earlier step.
let errorLogSink: ErrorLogSinkHandle | null = null;
let allowImmediateQuit = false;
let gracefulShutdownInFlight = false;
let initialWindowCreation: Promise<BrowserWindow | undefined> | undefined;
const FACTORY_RESET_RENDERER_READY_TIMEOUT_MS = 30_000 as const;
// ADR-0033: whether the app stays running without a window, and its tray. Started at ready,
// before the first window, so every window's close can ask it.
let appLifetime: AppLifetime | undefined;
function requireAppLifetime(): AppLifetime {
  if (!appLifetime) {
    throw new Error('The app lifetime starts once the app is ready.');
  }
  return appLifetime;
}
// Shows the app's window, opening one when none is open (tray, second launch). Set at ready.
let openMainWindow: (() => void) | undefined;

/** Every unload of a visible document flushes it first (ADR-0026 R1, `document-unload.ts`). */
function documentUnloadOwner(): DocumentUnloadOwner<BrowserWindow> {
  return {
    // Resolved when a document unloads, not when its window is created.
    delays: { delay: (point) => lifecycleDelaySeam().delay(point) },
    isQuitting: isDesktopShuttingDown,
    quit: () => app.quit(),
    quitsWithLastWindow: () => requireAppLifetime().quitsWithLastWindow(),
    visibleWindows: visibleDocumentWindows,
  };
}

/** Menu Reload and a renderer's reload request: flush the document, then replace it. */
function reloadVisibleDocument(window: BrowserWindow, reason: string, source: 'main' | 'renderer') {
  void reloadDocument(window, documentUnloadOwner(), () => {
    noteNextWindowReload(window, { reason, source });
    window.webContents.reload();
  });
}

let completeFactoryResetRendererReplacement:
  | ((signal: AbortSignal, mode: DesktopResetMode) => Promise<void>)
  | null = null;

// One shutdown run's step BODIES, built when the run starts so they capture
// its state. They live here beside the module state they read and clear. The
// keys are sorted, not ordered: the run ORDER, failure isolation and logs are
// `main/desktop-graceful-shutdown.ts`'s
// `DESKTOP_SHUTDOWN_STEP_ORDER`, which is where a new step is ordered.
function planDesktopShutdownRun(): DesktopShutdownRunPlan {
  return {
    // `desktop-graceful-shutdown.ts` runs it after every ordered step settled.
    // `database-drain` has already stopped what issues database work, so this
    // is the host close alone.
    closeDatabase: () => hostProfile.retire(),
    // Runs last, after the aggregate failure warn (the shutdown module logs
    // it first): the durable NDJSON file is the last writer standing, so it
    // stays open to capture every earlier failure. The handle is nulled from
    // a `finally` so a throwing `close()` still leaves `errorLogSink` cleared
    // rather than a stale handle that later `recordDurableLog` calls would
    // treat as still open.
    closeErrorLogSink: () => {
      const sinkToClose = errorLogSink;
      try {
        sinkToClose?.close();
      } finally {
        errorLogSink = null;
      }
    },
    steps: {
      // Stops everything that issues database work. It does NOT close the
      // database: that is `closeDatabase` below, a slice that always runs.
      'database-drain': () => {
        processCounterSampler.stop();
      },
      // Finish accepted deletion; terminal quit cancels replacement startup.
      'factory-reset': () => handleResetLocal.close(),
      'file-system': () => applicationIpcDomain.close(),
      'host-profile': async () => {
        await agentHostMainClient.close();
        // Retire the profile before joining the renderer's in-flight host connect:
        // a host start that fails during shutdown is then never retried as a second host.
        await hostProfile.retire();
        await agentHostClientIpc.close();
      },
      'main-catalog': () => workspaceRootCatalog.prepareClose(),
      // Wrapped: the cleanup's optional parameter is the runtime, not a signal.
      'mcp-runtime': () => cleanupMcpRuntimeForShutdown(),
      // before-quit postpones Electron's own window close. Join the renderer
      // producers first, while their DB/chunking/assistant dependencies still
      // live. Every window is joined to `closed`: a renderer that cannot
      // answer is destroyed by its own ladder, never abandoned (ADR-0026).
      renderers: async () => {
        // The admitted reset has joined. Fence new profile work while an
        // initial load finishes, before closing the window it is creating.
        hostProfile.fenceTerminal();
        await initialWindowCreation;
        const windows = BrowserWindow.getAllWindows();
        const preparations = await Promise.allSettled(
          windows
            .filter((window) => !window.isDestroyed() && isAppWindowSender(window.webContents.id))
            .map((window) => prepareDocumentUnload(window, lifecycleDelaySeam()))
        );
        // Prepared or not, quit closes them: past the user-close interception.
        for (const window of windows) {
          admitDocumentClose(window);
        }
        const closes = await Promise.allSettled([closeDesktopRenderers(windows)]);
        const rejections = [...preparations, ...closes].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        // A renderer that a signal to Main's process group ended is retired, not failed (BST-2285).
        const retired = rejections.filter(isExpectedShutdownRefusal);
        if (retired.length > 0) {
          logger.info('Renderers ended before acknowledging their producers; retired', {
            errors: retired,
          });
        }
        const failures = rejections.filter((error) => !isExpectedShutdownRefusal(error));
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Desktop renderer producers failed to close');
        }
      },
    },
  };
}

const gracefulShutdown = createDesktopGracefulShutdown({
  // Only for an orchestration that broke before its steps could run.
  exitProcess: (code) => process.exit(code),
  logger,
  markShuttingDown: markDesktopShuttingDown,
  planRun: planDesktopShutdownRun,
  // Fence the profile owner before any renderer can request more work. The tray goes with it,
  // so its Open item cannot start a window once quit has begun.
  retireBackgroundAdmission: () => {
    hostProfile.fenceTerminal();
    appLifetime?.close();
  },
});

async function handleShutdownSignal(signal: NodeJS.Signals): Promise<void> {
  logger.warn('Received shutdown signal, attempting graceful desktop shutdown', { signal });

  // The graceful run joins every step and resolves even when cleanup fails, so we
  // always continue to quit once it settled.
  await gracefulShutdown.run('signal');

  allowImmediateQuit = true;
  app.quit();
}

// Called from `app.whenReady()`, never at module scope. Electron converts the FIRST
// SIGINT/SIGTERM/SIGHUP into `app.quit()` with its own one-shot handler, installed before ready:
// a JS listener registered earlier is replaced by it and never runs (measured, Electron 44.4.5),
// and a second signal then takes the default action and kills main mid-shutdown. One registered
// here replaces Electron's, and the persistent listeners take every later signal.
function registerShutdownSignalHandlers(): void {
  // A unit test that imports this module must install nothing on the test
  // runner's own process; the E2E launch also runs under NODE_ENV=test but is the
  // real app and must exercise the handlers.
  if (process.env['NODE_ENV'] === 'test' && !isElectronE2ETestMode()) {
    return;
  }
  // Loud, but never a boot failure: the boot `catch` below quits the app. A signal whose listeners
  // were not yet removed still quits through Electron's own handler (`before-quit`); one whose
  // listeners were removed takes its default action and skips the graceful run.
  try {
    installShutdownSignalHandlers({
      logger,
      onFirstSignal: (signal) => {
        void handleShutdownSignal(signal);
      },
      signals: ['SIGINT', 'SIGTERM', 'SIGHUP'],
      target: process,
    });
  } catch (error) {
    try {
      logger.error(
        'Failed to install the shutdown signal handlers; a signal may skip the graceful shutdown',
        { error }
      );
    } catch {
      // A throwing logger must not escape into the boot callback either.
    }
  }
}

const fileSystem = new ElectronFileSystemAdapter();

const profileReset = createDesktopProfileResetOwner({
  profilePath: () => {
    const location = resolveDesktopDatabaseLocation();
    return joinProfileDirectory(location.rootPath, location.profile);
  },
  retireProfile: () => hostProfile.retire(),
});

const handleResetLocal = createDesktopFactoryResetHandler({
  clearRetainedContent: async () => {
    const result = await hostProfile.clearAndRetireContent();
    for (const filePath of listErrorLogFilePaths(
      path.join(app.getPath('logs'), ERROR_LOG_FILE_NAME)
    )) {
      await rm(filePath, { force: true });
    }
    return result;
  },
  completeSuccessfulReset: async (signal, mode) => {
    const completeRendererReplacement = completeFactoryResetRendererReplacement;
    if (completeRendererReplacement === null) {
      throw new Error('Factory reset renderer replacement coordinator is unavailable');
    }
    await completeRendererReplacement(signal, mode);
  },
  crashDumpsPath: app.getPath('crashDumps'),
  // The durable NDJSON backstop (Flight Recorder P2a) is a plaintext mirror
  // of `brainstrike_diagnostic_events`, which factory reset already wipes —
  // without this, the mirror would survive inside the preserved `logs`
  // folder while the DB rows it mirrors do not (see desktop-factory-reset.ts).
  errorLogFilePaths: listErrorLogFilePaths(path.join(app.getPath('logs'), ERROR_LOG_FILE_NAME)),
  logger,
  prepareDatabaseProfileReset: () => profileReset.prepare(),
  resetLocalDatabase: (lease) => profileReset.clear(lease),
  resumeAfterReset: createDesktopResetResume({
    resumeMcp: (outcome) => resumeMcpRuntimeAfterFactoryReset(getMainMcpHostControl(), outcome),
    resumeProfile: (signal) => hostProfile.resume(signal),
  }),
  runtimes: [
    {
      name: 'mcp-runtime',
      stop: async () => {
        await resetMcpRuntimeForFactoryReset(getMainMcpHostControl());
        logger.info('MCP settings retired for the factory reset');
      },
      stopForContent: suspendMcpSurfacesForContentClear,
    },
    // In-memory diagnostics ring: a factory reset must not carry the previous
    // profile's process samples into the next one.
    {
      name: 'process-counter-ring',
      stop: () => {
        processCounterRing.clear();
        return Promise.resolve();
      },
    },
    {
      name: 'read-workspace-file-cursors',
      stop: clearReadWorkspaceFileCursorRegistry,
    },
    // The OS login item lives outside userData: a factory reset turns it off, its default.
    // Clearing content keeps settings, so it keeps this one too.
    {
      name: 'app-lifetime',
      stop: () => appLifetime?.factoryReset() ?? Promise.resolve(),
      stopForContent: () => Promise.resolve(),
    },
    // electron-updater's cache (a downloaded update and its pending-install
    // record) lives outside userData. Clearing content retains it: an update
    // is not profile content.
    {
      name: 'app-update',
      stop: appUpdates.clearForReset,
      stopForContent: () => Promise.resolve(),
    },
    // Close (never null) the durable NDJSON sink before the purge below runs
    // (`errorLogFilePaths`, run inside `resetDesktopApplicationData` AFTER
    // every runtime here has stopped): purging the file out from under a
    // still-open fd would delete-while-open on POSIX (orphaning the fd —
    // later warn+ records silently stop landing on disk until rotation or
    // process exit) or fail the delete outright on Windows (while reset
    // still reports success). Deliberately does NOT null `errorLogSink`,
    // unlike the graceful-shutdown step below: `RotatingFileSink.close()`
    // documents (and its own tests exercise) a `writeLine` after `close()`
    // transparently reopening the file, so the very next warn+ record
    // recreates `brainstrike-errors.ndjson` from scratch post-reset instead
    // of the sink going permanently silent. See its doc comment and
    // docs/agents/platform-contracts.md's P2a section.
    {
      name: 'error-log-sink',
      stop: () => {
        errorLogSink?.close();
        return Promise.resolve();
      },
    },
  ],
  sessionDataPath: app.getPath('sessionData'),
  userDataPath: app.getPath('userData'),
});

ipcDisposers.add(
  'logging',
  registerLoggingIpcHandlers({
    getBufferedLogs: () => mainLogBuffer.getRecords(),
    getState: loggingPreferences.getSettingsPayload,
    openDestination: loggingPreferences.openDestination,
    recordDurableLog: (record) => errorLogSink?.recordLogRecord(record),
    selectDestination: loggingPreferences.selectDestination,
    setPreferences: loggingPreferences.applyAndPersist,
  })
);
// Settings › Updates (BST-2367, BST-2356): the next update check applies the beta choice.
ipcDisposers.add(
  'app-updates',
  registerAppUpdatesIpcHandlers({
    checkNow: appUpdates.check,
    getPreferences: () => readUpdatePreferences(requireSettingsStore(), app.getVersion()),
    getStatus: appUpdates.status,
    restartToUpdate: appUpdates.restartToInstall,
    setBetaUpdates: (betaUpdates) =>
      writeUpdatePreferences(requireSettingsStore(), { betaUpdates }),
  })
);

// Settings › Startup (ADR-0033): keep running in the tray, open at login.
ipcDisposers.add(
  'app-lifetime',
  registerAppLifetimeIpcHandlers({
    setKeepRunningInTray: (enabled) => requireAppLifetime().setKeepRunningInTray(enabled),
    setOpenAtLogin: (enabled) => requireAppLifetime().setOpenAtLogin(enabled),
    settings: () => requireAppLifetime().settings(),
  })
);

const hostProfile = createHostProfileAdmission(desktopBootstrap.profile);
/**
 * A factory reset retires the profile until it reopens it, after its replacement renderer is
 * ready: a window's reads and clients wait for that reopen, not into the fence.
 */
async function acquireProfileAfterReset() {
  await handleResetLocal.idle();
  return await hostProfile.acquire();
}
// Register IPC handlers early to avoid renderer calls racing registration during startup.
const workspaceRootCatalog = createDesktopWorkspaceRootCatalog(acquireProfileAfterReset);
const modelCatalog = createDesktopModelCatalog(workspaceRootCatalog);
const applicationIpcDomain = createApplicationIpcDomain({
  getUserDataPath: () => app.getPath('userData'),
  onClearContent: async () => {
    const result = await handleResetLocal.clearContent();
    if (!result.success) {
      throw new Error(result.message ?? 'Content clearing failed.');
    }
  },
  onResetLocal: () => handleResetLocal.reset(),
});
/** The host's open folders changed (ADR-0029 stage 4): File > Open Recent follows. */
function onWorkspaceRootsChanged(change: {
  readonly grantedPath?: string;
  readonly recentPaths: readonly string[];
}): void {
  // Any change to the ledger rebuilds File > Open Recent, granted or not: the host's first
  // publish at launch, a removal, and the empty ledger after a factory reset.
  const recentChanged =
    change.recentPaths.length !== workspaceRecentRootPaths.length ||
    change.recentPaths.some((recentPath, index) => recentPath !== workspaceRecentRootPaths[index]);
  workspaceRecentRootPaths = change.recentPaths;
  workspaceRootsMenuSubscriber?.({
    ...(change.grantedPath ? { grantedPath: change.grantedPath } : {}),
    recentChanged,
  });
}
export function reportAgentHostStartupFailure(error: unknown): void {
  reportHostStartupFailure(error, isDesktopShuttingDown(), logger);
}
const agentHostPrivateClients = desktopBootstrap.privateClients;
// Main's own desktop-origin client: Settings credential writes reach the host,
// their single owner, through it.
const agentHostMainClient = createAgentHostMainClient(
  hostProfile.acquire,
  agentHostPrivateClients.open
);
// The host owns hook trust.
const desktopHookTrust = createDesktopHookTrust((method, params) =>
  agentHostMainClient.request(method, params)
);
const agentHostClientIpc = registerAgentHostClientIpc(
  acquireProfileAfterReset,
  agentHostPrivateClients.open
);
ipcDisposers.add('agent-host-client', agentHostClientIpc.unregister);
// BST-1880: the damaged-store notice's actions. A restart stops the host this
// app launched, which relaunches for the next client as after a crash, so its
// state store reopens and checks itself again.
ipcDisposers.add(
  'agent-host-recovery',
  registerAgentHostRecoveryIpcHandlers({
    restartHost: () =>
      restartLaunchedAgentHost({
        acquireProfile: () => hostProfile.acquire(),
        logger,
        stopLaunchedHost: agentHostPrivateClients.stopForRelaunch,
      }),
    showDataFolder: async () => {
      const failure = await shell.openPath(resolveDesktopDatabaseProfileDirectory());
      if (failure) {
        throw new Error(failure);
      }
    },
  })
);
ipcDisposers.add('main', () => {
  // The graceful filesystem step joins physical retirement. This late ledger
  // entry repeats idempotent bookkeeping and reports any retained cleanup error.
  applicationIpcDomain.close().catch((error: unknown) => {
    logger.error('Application IPC domain cleanup failed during will-quit', { error });
  });
});
ipcDisposers.add(
  'desktop-diagnostics',
  registerDesktopDiagnosticsIpcHandlers({
    crashDumps: {
      list: () => listCrashDumps(app.getPath('crashDumps')),
    },
    crashRecovery: {
      getSnapshot: getDesktopCrashRecoverySnapshot,
    },
    database: { getDiagnostics: () => agentHostMainClient.request('host/status', {}) },
    databaseIntegrity: null,
    logging: {
      getState: loggingPreferences.getSettingsPayload,
    },
    mainLog: {
      readWindow: (request) => {
        const mainLogFilePath = getLogFilePath();
        if (mainLogFilePath === null) {
          throw new Error('Main log file logging is disabled; no log window is available.');
        }
        return readMainLogWindow({ logFilePath: mainLogFilePath, request });
      },
    },
    processCounters: {
      getSnapshot: () => ({
        installedAt: mainWebAssemblyCounter.snapshot().installedAt,
        samples: processCounterRing.list(),
      }),
    },
    reset: {
      getSnapshot: () => getDesktopResetDiagnosticsSnapshot(app.getPath('userData')),
    },
  })
);
ipcDisposers.add('shell', registerShellIpcHandlers());
ipcDisposers.add('clipboard', registerClipboardIpcHandlers());
ipcDisposers.add('window-focus', registerWindowFocusIpcHandlers());
ipcDisposers.add('file-exports', registerFileExportsIpcHandlers());
ipcDisposers.add('hooks', registerHooksIpcHandlers(desktopHookTrust, workspaceRootCatalog));
ipcDisposers.add('thread-groups', registerThreadGroupsIpc(workspaceRootCatalog));
ipcDisposers.add('view-filter-presets', registerViewFilterPresetsIpc(workspaceRootCatalog));
ipcDisposers.add('model-catalog', registerModelCatalogIpc(modelCatalog));

// Add global error handlers to catch silent crashes
process.on('uncaughtException', (error) => {
  const serializedError =
    error instanceof Error
      ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        }
      : { value: String(error) };
  logger.error({ error: serializedError }, 'Uncaught exception');
  // biome-ignore lint/suspicious/noConsole: Uncaught exception details must be visible even if structured logging output is truncated.
  console.error('[DesktopMain] Uncaught exception', serializedError);
});

process.on('unhandledRejection', (reason, promise) => {
  const serializedReason =
    reason instanceof Error
      ? {
          message: reason.message,
          name: reason.name,
          stack: reason.stack,
        }
      : { value: String(reason) };
  logger.error({ promise, reason: serializedReason }, 'Unhandled promise rejection');
  // biome-ignore lint/suspicious/noConsole: Unhandled rejection details must be visible even if structured logging output is truncated.
  console.error('[DesktopMain] Unhandled promise rejection', {
    promise,
    reason: serializedReason,
  });
});

const singleInstanceLockAcquired = desktopBootstrap.singleInstanceLockAcquired;

if (singleInstanceLockAcquired) {
  const e2eTestMode = isElectronE2ETestMode();

  const workspaceOpenQueue = desktopBootstrap.workspaceOpenQueue;

  // Renderer→main ready ping (`WorkspaceConnectHost`, immediately after it
  // subscribes via `onOpenPath`). Registered ONCE here, at module scope,
  // through `workspace-open-ready-ipc.ts`'s registrar — `main.ts` itself must
  // never register a raw Electron IPC event/handle listener directly
  // (`runtime-host-boundary.test.ts`'s "keeps main process startup free of ad
  // hoc IPC registration"). `createMainWindow` runs again on every
  // `app.on('activate')` recreation, so per-window routing happens via this
  // Map (keyed by `webContents.id`, populated/cleaned up per window below)
  // rather than by registering the channel a second time, which the registry
  // rejects.
  const workspaceOpenReadyCallbacksByWebContentsId = new Map<number, () => void>();
  const bindWorkspaceOpenWindow = (win: BrowserWindow): void => {
    const contents = win.webContents;
    const webContentsId = contents.id;
    let loadFinished = false;
    let rendererReady = false;
    const maybeAttach = () => {
      if (!(loadFinished && rendererReady)) {
        return;
      }
      workspaceOpenQueue.attach({
        isDestroyed: () => contents.isDestroyed(),
        send: (method, payload) => pushToRenderer(contents, method, payload),
      });
    };

    // Bind before the first navigation: React can subscribe and ping while
    // document resources are still loading. Both gates must see that load.
    contents.on('did-start-loading', () => {
      loadFinished = false;
      workspaceOpenQueue.detach();
    });
    contents.on('did-start-navigation', (details) => {
      // Subframe and same-document navigation preserve the existing listener.
      if (details.isMainFrame && !details.isSameDocument) {
        rendererReady = false;
      }
    });
    // Unlike did-finish-load, this pairs with did-start-loading for subframes.
    contents.on('did-stop-loading', () => {
      loadFinished = true;
      maybeAttach();
    });
    workspaceOpenReadyCallbacksByWebContentsId.set(webContentsId, () => {
      rendererReady = true;
      maybeAttach();
    });
    win.once('closed', () => {
      workspaceOpenReadyCallbacksByWebContentsId.delete(webContentsId);
      workspaceOpenQueue.detach();
    });
  };

  const factoryResetRendererReplacement = createFactoryResetRendererReplacementCoordinator({
    noteNextWindowReload: (window) => {
      noteNextWindowReload(window, { reason: 'factory-reset', source: 'main' });
    },
    timeoutMs: FACTORY_RESET_RENDERER_READY_TIMEOUT_MS,
  });
  ipcDisposers.add(
    'workspace-open-ready',
    registerWorkspaceOpenReadyIpcHandlers({
      onOpenPathReady: (signal) => {
        if (signal.kind === 'invalid') {
          logger.error(
            { diagnostic: signal.diagnostic, senderWebContentsId: signal.senderWebContentsId },
            'Invalid renderer readiness acknowledgement'
          );
        } else {
          workspaceOpenReadyCallbacksByWebContentsId.get(signal.senderWebContentsId)?.();
        }
        factoryResetRendererReplacement.handleRendererReady(signal);
      },
    })
  );

  completeFactoryResetRendererReplacement = async (signal, mode) => {
    await factoryResetRendererReplacement.replace(BrowserWindow.getAllWindows(), {
      // Content clearing keeps configuration, so only a factory reset wipes the
      // storage the renderer's preferences live in. clearData skips the app's own
      // non-web scheme; clearStorageData reaches it.
      ...(mode === 'factory'
        ? { clearSessionStorage: () => session.defaultSession.clearStorageData() }
        : {}),
      signal,
    });
  };

  // A second launch shows the app's window, opening one while the app runs in the tray.
  desktopBootstrap.bindSecondInstanceFocus(() => openMainWindow?.());

  app.whenReady().then(async () => {
    if (isDesktopShuttingDown()) {
      return;
    }
    registerShutdownSignalHandlers();
    try {
      logger.debug('App ready, starting initialization...');

      const launchMode = resolveDesktopRendererLaunchMode({
        argv: process.argv,
        isPackaged: app.isPackaged,
        isTestMode: e2eTestMode,
      });
      logger.debug('Resolved desktop launch mode', { launchMode });

      // The ONE renderer target for this process (BST-1641). The window
      // (`create-window.ts`) loads the document it names, and the
      // IPC sender-frame allowlist that every desktop IPC call is checked
      // against (`event.senderFrame.url`) is derived from this
      // same object — there is no second launch-mode derivation to drift.
      // Configured here, after the launch mode is known and before any
      // BrowserWindow exists: a loader that ran first would throw
      // "not configured" at load time, and no authorized invoke can ever be
      // evaluated against an unconfigured (fail-closed) allowlist.
      const rendererTarget = createDesktopRendererTarget({
        builtRendererPath: resolveBuiltRendererPath(),
        devRendererUrl: DESKTOP_DEV_RENDERER_URL,
        launchMode,
      });
      configureDesktopRendererTarget(rendererTarget);
      registerRendererProtocol(rendererTarget);
      // Start the profile's host before catalog discovery and renderer hydration.
      const agentHostProfile = hostProfile.acquire().catch(reportAgentHostStartupFailure);
      logger.debug('Configured desktop renderer target', { rendererTarget });

      // Register the root-validated `brainstrike-asset://` protocol now that the
      // app is ready (protocol.handle requires ready). The resolver validates
      // renderer-supplied paths against the DB `roots` table — the SAME source
      // the git/read/search tools use — resolving the DB lazily per request.
      registerAssetProtocol({
        listRoots: () => loadWorkspaceRootsFromCatalog(workspaceRootCatalog),
      });

      // Static Canvas sandbox shell (BST-1173); no DB dependency, serves one
      // reviewed document with its own CSP header (see canvas-protocol.ts).
      registerCanvasProtocol();

      // Per-mount MCP App sandbox shells (BST-1572): the renderer registers
      // each shell over the visible-UI `mcp:apps:prepareShell` IPC and this
      // handler serves it on its own origin with header-delivered policies.
      registerMcpAppShellProtocol(getMcpAppShellRegistry());

      // Keep macOS desktop E2E runs invisible while Playwright drives the hidden window.
      if (e2eTestMode && process.platform === 'darwin') {
        app.setActivationPolicy?.('accessory');
        app.dock?.hide();
      }

      // The settings store and app.getPath() are available now: apply the stored preferences.
      const enabledLogFile = loggingPreferences.applyAfterReady();
      if (enabledLogFile) {
        logger.debug('File logging enabled after app.ready', { logFile: enabledLogFile });
      }
      void loggingPreferences.verifyActiveLogFile('app-ready');

      // Construct the durable NDJSON backstop now that app.getPath() is
      // available (same app-ready gate as file logging above). Skipped
      // entirely under BRAINSTRIKE_DISABLE_FILE_LOGS=1 — every desktop
      // test:e2e* script sets it, and this must not start writing files
      // during those Playwright lanes.
      //
      // sessionId is a fresh per-launch randomUUID(), stable for the process
      // but INDEPENDENT of the diagnostic session id a renderer's
      // DiagnosticSinkBridge stamps on its own `diagnostic_events` DB rows
      // (getDiagnosticSessionId() in packages/app-shell). This is
      // deliberate, per the Flight Recorder P2a design — the NDJSON
      // backstop and the database-backed sink are independent failure
      // domains — but it means a line in this file and a DB row cannot be
      // joined on `sessionId` alone.
      if (!disableFileLogs) {
        errorLogSink = createErrorLogSink({
          appVersion: app.getVersion(),
          filePath: path.join(app.getPath('logs'), ERROR_LOG_FILE_NAME),
          platform: `${process.platform}-${process.arch}`,
          sessionId: randomUUID(),
        });
      }

      for (const failure of desktopEnvLoadResult.failures) {
        logger.error('Desktop environment file rejected', failure);
      }
      // Never the printed environment itself: it holds the user's secrets.
      const loginShell = getDesktopLoginShellEnvironment();
      if (loginShell.status === 'failed') {
        logger.error('Login shell environment unavailable; children keep the launch environment', {
          message: loginShell.message,
          shell: loginShell.shell,
        });
      } else if (loginShell.status === 'resolved') {
        logger.info('Login shell environment applied', {
          durationMs: loginShell.durationMs,
          shell: loginShell.shell,
        });
      } else {
        logger.info('Login shell environment skipped', { reason: loginShell.reason });
      }

      // BST-1361: deprecated env names are detected ONCE per launch from this
      // process's own environment (files were applied by main-bootstrap) and
      // surfaced through /assistant/status; they never authenticate. Invoked
      // INSIDE app-ready (review 10i) so a hypothetical registry-authoring
      // throw surfaces through the normal startup error path instead of a
      // pre-ready module-evaluation crash.
      const deprecatedEnvVarReports = detectDeprecatedProviderEnvVars(process.env);
      if (deprecatedEnvVarReports.length > 0) {
        // Names only — never values. Logged once per launch (BST-1361).
        logger.warn('Deprecated provider environment variables are set and will not authenticate', {
          deprecatedEnvVars: deprecatedEnvVarReports.map(
            ({ envVar, replacement }) => `${envVar} -> ${replacement}`
          ),
        });
      }

      logger.debug('Setting up IPC handlers that require app readiness...');
      // Settings reads the profile store directly and writes through the host,
      // the single credential writer.
      const secretsService = createDesktopSettingsSecrets({
        deleteCredential: async (account) =>
          (await agentHostMainClient.request('auth/credential/delete', { account })).deleted,
        setCredential: async (account, credential) => {
          await agentHostMainClient.request('auth/credential/set', { account, credential });
        },
      });
      ipcDisposers.add(
        'secrets',
        registerSecretsIpcHandlers(secretsService, {
          envFileFailures: desktopEnvLoadResult.failures,
          // Projected per invoke from the RECORDED bootstrap result — loading is
          // never re-run (initializeDesktopEnvironment throws on double-init).
          readEnvBootstrapReport: () =>
            buildDesktopEnvBootstrapReport({
              appRoot: app.getAppPath(),
              env: process.env,
              isPackaged: app.isPackaged,
              loginShell,
              result: desktopEnvLoadResult,
              userDataPath: app.getPath('userData'),
            }),
        })
      );
      ipcDisposers.add('mcp', registerMcpIpcHandlers({ runtime: getMainMcpHostControl() }));
      logger.debug('Ready-dependent IPC handlers registered successfully');
      // Setup security before creating windows
      setupSecurity();
      logger.debug('Security setup complete');

      // The application menu (BST-2355) follows each platform: macOS has its app
      // and Window menus, Windows and Linux end File with Settings… and Quit, and
      // the Developer utilities ship only in unpackaged builds.
      const isMac = process.platform === 'darwin';
      app.setAboutPanelOptions(buildAboutPanelOptions(app.name, app.getVersion()));
      const editAndViewMenus: Electron.MenuItemConstructorOptions[] = [
        // Electron's own Edit menu for the platform: Paste and Match Style and
        // Speech on macOS, Delete everywhere.
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            {
              accelerator: process.platform === 'darwin' ? 'Cmd+K' : 'Ctrl+K',
              click: (_menuItem, browserWindow) => {
                // Route to the FOCUSED window only, so the palette opens where
                // the user is looking.
                const targetWindow =
                  browserWindow instanceof BrowserWindow
                    ? browserWindow
                    : BrowserWindow.getFocusedWindow();
                if (!targetWindow || targetWindow.isDestroyed()) {
                  return;
                }
                pushToRenderer(targetWindow.webContents, DESKTOP_IPC_CHANNELS.commandPalette.open);
              },
              label: 'Command Palette…',
            },
            { type: 'separator' },
            {
              accelerator: process.platform === 'darwin' ? 'Cmd+R' : 'Ctrl+R',
              click: (_menuItem, browserWindow) => {
                const targetWindow =
                  browserWindow instanceof BrowserWindow
                    ? browserWindow
                    : BrowserWindow.getFocusedWindow();
                if (!targetWindow || targetWindow.isDestroyed()) {
                  logger.warn('Skipped menu reload because no target window was focused');
                  return;
                }
                reloadVisibleDocument(targetWindow, 'menu-reload', 'main');
              },
              label: 'Reload',
            },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            // The role's accelerator is ⌘/Ctrl+Plus, which needs Shift on most
            // layouts; this hidden twin takes the unshifted ⌘/Ctrl+= as well.
            { accelerator: 'CommandOrControl+=', role: 'zoomIn', visible: false },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
      ];
      // Only unpackaged builds show this menu, so a shipped app has no
      // Developer Tools item or shortcut.
      const developerMenus: Electron.MenuItemConstructorOptions[] = [
        {
          label: 'Developer',
          submenu: [
            { role: 'toggleDevTools' },
            { type: 'separator' },
            {
              accelerator:
                process.platform === 'darwin' ? 'Cmd+Shift+Backspace' : 'Ctrl+Shift+Backspace',
              click: async () => {
                const res = await dialog.showMessageBox({
                  buttons: ['Reset', 'Cancel'],
                  cancelId: 1,
                  defaultId: 1,
                  message:
                    'This will delete the local database files and reinitialize on next access. This action cannot be undone.',
                  title: 'Reset Local Database',
                  type: 'warning',
                });
                if (res.response !== 0) {
                  return;
                }
                // A second invocation (repeat accelerator press, or an
                // overlapping factory reset) would hit the reset barrier's
                // 'already active' throw — surface a readable message instead.
                if (developerDatabaseResetInFlight) {
                  await dialog.showMessageBox({
                    buttons: ['OK'],
                    message: 'A database reset is already in progress.',
                    title: 'Database Reset',
                    type: 'info',
                  });
                  return;
                }
                developerDatabaseResetInFlight = true;
                // The visible documents flush into the profile BEFORE it is cleared, and are
                // replaced afterwards whatever the reset's outcome: a flushed document is fenced.
                const documents = visibleDocumentWindows();
                await Promise.all(
                  documents.map((window) => flushDocumentBeforeUnload(window, lifecycleDelaySeam()))
                );
                let replaced: readonly BrowserWindow[] = documents;
                try {
                  // BST-1330: same drains as shutdown/factory reset — a bare
                  // resetLocalDatabase() could race in-flight live refreshes.
                  // Retire the host's writer before resetting this profile.
                  const lease = await profileReset.prepare();
                  try {
                    await profileReset.clear(lease);
                  } finally {
                    lease.release();
                  }
                  await hostProfile.resume();
                  replaced = BrowserWindow.getAllWindows();
                  await dialog.showMessageBox({
                    buttons: ['OK'],
                    message: 'Local database has been reset. The app will reload.',
                    title: 'Database Reset',
                    type: 'info',
                  });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  dialog.showErrorBox(
                    'Reset Failed',
                    `The local database was not reset: ${message}\n\nRetry, or use Factory Reset in Settings, which stops background work first.`
                  );
                } finally {
                  developerDatabaseResetInFlight = false;
                }
                if (isDesktopShuttingDown()) {
                  return;
                }
                for (const win of replaced) {
                  if (win.isDestroyed()) {
                    continue;
                  }
                  noteNextWindowReload(win, {
                    reason: 'developer-reset-local-database',
                    source: 'main',
                  });
                  win.webContents.reloadIgnoringCache();
                }
              },
              id: 'dev-reset-db',
              label: 'Reset Local Database…',
            },
          ],
        },
      ];
      const pushToMenuTargetWindow = (
        channel: string,
        payload?: unknown,
        explicitWindow?: Electron.BaseWindow
      ): void => {
        // Same `browserWindow instanceof BrowserWindow ? browserWindow :
        // BrowserWindow.getFocusedWindow()` routing as the Cmd+K / Cmd+P View
        // items above: application-file-menu.ts now passes Electron's
        // click-handler window through, because `getFocusedWindow()` alone is
        // null whenever this app is not the OS-active application — which is
        // exactly the state a programmatic `getMenuItemById(...).click(...)`
        // (the desktop e2e's only way to drive the File menu) runs in.
        const targetWindow =
          explicitWindow instanceof BrowserWindow
            ? explicitWindow
            : BrowserWindow.getFocusedWindow();
        if (!targetWindow || targetWindow.isDestroyed()) {
          return;
        }
        pushToRenderer(targetWindow.webContents, channel, payload);
      };

      const openSettingsFromMenu = (targetWindow?: Electron.BaseWindow): void => {
        pushToMenuTargetWindow(DESKTOP_IPC_CHANNELS.appMenu.openSettings, undefined, targetWindow);
      };
      const openPathFromMenu = (label: string, targetPath: string): void => {
        shell
          .openPath(targetPath)
          .then((failure) => {
            if (failure !== '') {
              logger.warn(`Failed to open the ${label}`, { failure, targetPath });
            }
          })
          .catch((error: unknown) => {
            logger.warn(`Failed to open the ${label}`, { error, targetPath });
          });
      };
      const checkForUpdatesOverWindow = (targetWindow?: Electron.BaseWindow): void => {
        checkForUpdatesFromMenu(appUpdates, targetWindow).catch((error: unknown) => {
          logger.error('Check for Updates… failed', { error });
        });
      };
      const helpMenu = buildHelpMenuTemplate({
        includeAbout: !isMac,
        onCheckForUpdates: checkForUpdatesOverWindow,
        onOpenReleaseNotes: () => {
          const url = releaseNotesUrl(app.getVersion());
          shell.openExternal(url).catch((error: unknown) => {
            logger.warn('Failed to open the release notes', { error, url });
          });
        },
        onOpenSourceLicenses: () => {
          openPathFromMenu(
            'third-party notices',
            resolveThirdPartyNoticesPath(app.isPackaged, process.resourcesPath)
          );
        },
        onOpenWebPage: (url) => {
          shell.openExternal(url).catch((error: unknown) => {
            logger.warn('Failed to open a page of the site', { error, url });
          });
        },
        onShowCrashReports: () => {
          openPathFromMenu('crash reports folder', app.getPath('crashDumps'));
        },
        onShowLogs: () => {
          openPathFromMenu('logs folder', app.getPath('logs'));
        },
      });

      let applicationMenuRebuildScheduled = false;
      const rebuildApplicationMenu = async (): Promise<void> => {
        const recents = workspaceRecentRootPaths;
        const template: Electron.MenuItemConstructorOptions[] = [
          ...(isMac
            ? [
                buildMacAppMenuTemplate({
                  appName: app.name,
                  onCheckForUpdates: checkForUpdatesOverWindow,
                  onOpenSettings: openSettingsFromMenu,
                }),
              ]
            : []),
          buildFileMenuTemplate({
            closingItems: isMac ? [] : buildFileMenuClosingItems(openSettingsFromMenu),
            onOpenFolder: (targetWindow) => {
              pushToMenuTargetWindow(
                DESKTOP_IPC_CHANNELS.workspace.openFolderPicker,
                undefined,
                targetWindow
              );
            },
            onOpenRecentPath: (recentPath, targetWindow) => {
              pushToMenuTargetWindow(
                DESKTOP_IPC_CHANNELS.workspace.openPath,
                {
                  origin: 'menu-recent',
                  path: recentPath,
                },
                targetWindow
              );
            },
            recentPaths: recents,
          }),
          ...editAndViewMenus,
          ...(isMac ? [buildMacWindowMenuTemplate()] : []),
          ...(app.isPackaged ? [] : developerMenus),
          helpMenu,
        ];
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
      };

      const scheduleApplicationMenuRebuild = (): void => {
        // Coalesced: a restore mounts many roots in a burst, and rebuilding
        // the whole application menu per root would thrash the menu bar.
        if (applicationMenuRebuildScheduled) {
          return;
        }
        applicationMenuRebuildScheduled = true;
        setTimeout(() => {
          applicationMenuRebuildScheduled = false;
          rebuildApplicationMenu().catch((error: unknown) => {
            logger.warn('Failed to rebuild the application menu', { error });
          });
        }, 250);
      };

      workspaceRootsMenuSubscriber = ({ grantedPath, recentChanged }) => {
        if (grantedPath) {
          // Spec §7's explicit ask. This feeds the macOS Dock menu and the
          // Windows jump list, whose clicks arrive back as `open-file` / argv —
          // the entry points Layer 3 handles.
          app.addRecentDocument(grantedPath);
        }
        if (recentChanged) {
          scheduleApplicationMenuRebuild();
        }
      };

      await rebuildApplicationMenu();

      ipcDisposers.add(
        'main-platform',
        registerMainPlatformIpcHandlers({
          noteNextWindowReload,
          requestReload: (window, reason) => reloadVisibleDocument(window, reason, 'renderer'),
        })
      );

      // Embedded browser pane (BST-1174): each window owns its OWN pane host
      // + IPC registration, so a macOS close→dock-reopen cycle (which calls
      // createMainWindow again without quitting) rebinds the pane to the new
      // window instead of leaving `window.browser` calls hitting a disposed
      // host. The manager attaches views to THIS window's contentView. Bound
      // before the document loads: the workspace reads main's page list as
      // it mounts, which can be before the load finishes.
      const bindBrowserPane = (win: BrowserWindow): void => {
        const browserPaneHost = createBrowserPaneHost(win);
        // Register for the assistant server's browser tools (BST-1176):
        // executors resolve the ACTIVE host per call through this registry.
        setActiveBrowserPaneHost(browserPaneHost);
        // A dock-reopen recreates the window; if the previous window's `closed`
        // handler has not yet unwound its pane registration, retire it first —
        // the stack refuses a second live 'browser' entry (no silent overwrite).
        browserIpcDisposer?.dispose();
        const thisWindowBrowserIpc = ipcDisposers.add(
          'browser',
          registerBrowserIpcHandlers(createBrowserIpcHandlers(browserPaneHost.manager))
        );
        browserIpcDisposer = thisWindowBrowserIpc;
        win.once('closed', () => {
          clearActiveBrowserPaneHost(browserPaneHost);
          browserPaneHost.dispose();
          thisWindowBrowserIpc.dispose();
        });
      };

      const createMainWindow = async () => {
        // Store is guaranteed to exist after app.whenReady()
        const store = getSettingsStore();
        if (!store) {
          throw new Error('Settings store unavailable after app.ready - this should never happen');
        }
        const storedWindowState = readStoredWindowState(store);
        const win = await createWindow({
          onBeforeLoad: (window) => {
            installDocumentUnload(window, documentUnloadOwner());
            bindWorkspaceOpenWindow(window);
            bindBrowserPane(window);
          },
          windowState: storedWindowState,
        });
        // app.on('activate') recreates this window; dispose the persistence
        // listeners + debounce timer on close so they don't accumulate per window.
        const disposeWindowStatePersistence = registerWindowStatePersistence(win, store);
        win.once('closed', disposeWindowStatePersistence);
        win.once('closed', () => {
          if (
            !isDesktopShuttingDown() &&
            visibleDocumentWindows().every((other) => other === win)
          ) {
            requireAppLifetime().lastWindowClosed();
          }
        });
        return win;
      };

      // One window at a time: a tray click during the first window's creation shows that window.
      let windowOpening: Promise<void> | undefined;
      const showOrOpenWindow = (): void => {
        if (isDesktopShuttingDown()) {
          return;
        }
        const show = (window: BrowserWindow): void => {
          if (window.isMinimized()) {
            window.restore();
          }
          window.show();
          window.focus();
        };
        const existing = visibleDocumentWindows()[0];
        if (existing) {
          show(existing);
          return;
        }
        windowOpening ??= (async () => {
          await initialWindowCreation;
          if (isDesktopShuttingDown()) {
            return;
          }
          const opened = visibleDocumentWindows()[0];
          if (opened) {
            show(opened);
          } else {
            await createMainWindow();
          }
        })().finally(() => {
          windowOpening = undefined;
        });
        windowOpening.catch((error: unknown) => {
          logger.error('Could not open a Brainstrike window', { error });
        });
      };

      const lifetimeStore = requireSettingsStore();
      appLifetime = createAppLifetime({
        loginItems: resolveLoginItems(),
        notify,
        openWindow: () => openMainWindow?.(),
        presence: resolveBackgroundPresence(),
        quit: () => app.quit(),
        store: {
          get: (key) => lifetimeStore.get(key),
          set: (key, value) => lifetimeStore.set(key, value),
        },
      });

      // ---------------------------------------------------------------
      // Event loop health diagnostics — logs CPU and loop lag every 30s.
      // Logs UNCONDITIONALLY so the absence of entries = freeze detected.
      // ---------------------------------------------------------------
      {
        const { monitorEventLoopDelay } = await import('node:perf_hooks');
        const histogram = monitorEventLoopDelay({ resolution: 50 });
        histogram.enable();
        let prevCpu = process.cpuUsage();
        let prevTime = process.hrtime.bigint();

        setInterval(() => {
          const cpu = process.cpuUsage(prevCpu);
          const now = process.hrtime.bigint();
          const elapsedMs = Number(now - prevTime) / 1_000_000;
          const cpuPercent = elapsedMs > 0 ? (cpu.user + cpu.system) / 1000 / elapsedMs : 0;
          prevCpu = process.cpuUsage();
          prevTime = process.hrtime.bigint();

          const p50 = histogram.percentile(50) / 1_000_000;
          const p99 = histogram.percentile(99) / 1_000_000;
          const max = histogram.max / 1_000_000;
          histogram.reset();

          const mem = process.memoryUsage();
          const handles =
            (
              process as NodeJS.Process & { _getActiveHandles?: () => unknown[] }
            )._getActiveHandles?.()?.length ?? -1;
          const requests =
            (
              process as NodeJS.Process & { _getActiveRequests?: () => unknown[] }
            )._getActiveRequests?.()?.length ?? -1;

          void processCounterSampler.sample(mem);
          const payload = {
            backgroundTasks: processCounterRing.list().at(-1)?.backgroundTasks ?? null,
            cpuPercent: (cpuPercent * 100).toFixed(1),
            handles,
            heapUsedKb: (mem.heapUsed / 1024).toFixed(0),
            loopLagMaxMs: max.toFixed(1),
            loopLagP50Ms: p50.toFixed(1),
            loopLagP99Ms: p99.toFixed(1),
            requests,
            rssKb: (mem.rss / 1024).toFixed(0),
            wasm: mainWebAssemblyCounter.snapshot().counts,
          };

          // Always log — if entries stop appearing, the event loop is stuck.
          // NOTE: pino API requires (obj, msg) order to merge fields into the entry.
          if (isMainProcessHealthDegraded({ loopLagMaxMs: max, loopLagP99Ms: p99 })) {
            logger.warn(payload, 'main-process-health');
          } else {
            logger.debug(payload, 'main-process-health');
          }
        }, 30_000).unref();
        // Deliberately never stopped: it and the watchdog below keep reporting
        // THROUGH graceful shutdown, whose hangs they exist to diagnose. Both
        // are unref'd, and after the database close the stopped
        // processCounterSampler turns each tick's sample into a no-op.
      }

      // ---------------------------------------------------------------
      // Worker thread watchdog — detects main-thread freezes that block
      // the event loop (and therefore all setInterval timers above).
      // The worker has its own event loop unaffected by signal storms.
      // If the main thread stops sending heartbeats, the worker writes
      // diagnostics directly to stderr and the log file.
      // ---------------------------------------------------------------
      initialWindowCreation = startMainWatchdogBeforeWindow(
        () => {
          const workerPath = resolveMainWatchdogWorkerPath(app.getAppPath(), app.isPackaged);
          const watchdog = new Worker(workerPath);
          let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

          watchdog.on('error', (error) => {
            logger.error(
              { error: serializeDesktopError(error), workerPath },
              'main-thread watchdog worker failed'
            );
          });
          watchdog.on('messageerror', (error) => {
            logger.error(
              { error: serializeDesktopError(error), workerPath },
              'main-thread watchdog worker message failed to deserialize'
            );
          });
          watchdog.once('exit', (code) => {
            if (heartbeatTimer !== null) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
            mainWatchdogAttachment.detachIfAttached();
            logger.error({ code, workerPath }, 'main-thread watchdog worker exited unexpectedly');
          });
          try {
            mainWatchdogAttachment.attach((message) => {
              watchdog.postMessage(message);
            }, loggingPreferences.current.file);
          } catch (error) {
            void watchdog.terminate().catch((terminationError: unknown) => {
              logger.error(
                { error: serializeDesktopError(terminationError), workerPath },
                'failed to terminate main-thread watchdog after startup failure'
              );
            });
            throw error;
          }
          heartbeatTimer = setInterval(() => {
            mainWatchdogRuntime.heartbeat();
          }, MAIN_WATCHDOG_CHECK_INTERVAL_MS);
          watchdog.unref();
          heartbeatTimer.unref();

          logger.debug({ workerPath }, 'main-thread watchdog started');
        },
        (error) => {
          logger.error(
            { error: serializeDesktopError(error) },
            'main-thread watchdog failed to start; continuing application startup'
          );
        },
        async () => {
          if (isDesktopShuttingDown()) {
            return;
          }
          // ADR-0033: a login launch starts in the Dock or tray, where the app stays reachable.
          if (await requireAppLifetime().startsHidden(wasLaunchedAtLogin())) {
            logger.info('Launched at login: starting without a window');
            return;
          }
          logger.debug('Creating main window...');
          // Owner decision 7.3(i): the first window does not wait for the host;
          // the renderer shows it as state while it starts.
          return await createMainWindow();
        }
      );
      // From here a tray click or a second launch joins the first window's creation.
      openMainWindow = showOrOpenWindow;
      const mainWindow = await initialWindowCreation;
      if (isDesktopShuttingDown()) {
        return;
      }
      logger.debug('Main window created successfully', { hidden: mainWindow === undefined });
      // One line per launch, once the host and the first paint have settled.
      void Promise.allSettled([
        agentHostProfile,
        mainWindow
          ? markRendererFirstPaint(mainWindow.webContents).catch((error: unknown) =>
              logger.warn('Could not read the renderer first paint for the startup timeline', {
                error,
              })
            )
          : undefined,
      ]).then(() => logger.info('Startup timeline', readStartupTimeline()));
      appUpdates.start({
        publish: (status) => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
              pushToRenderer(
                window.webContents,
                DESKTOP_IPC_CHANNELS.appUpdates.statusChanged,
                status
              );
            }
          }
        },
        settings: requireSettingsStore(),
      });
      if (mainWindow) {
        offerMoveToApplicationsFolder(requireSettingsStore(), mainWindow).catch(
          (error: unknown) => {
            logger.warn('The offer to move the app to Applications failed', { error });
          }
        );
      }

      // Launch argv is a ONE-TIME, launch-scoped producer — enqueued once here,
      // never re-enqueued by `app.on('activate')`'s later `createMainWindow()`
      // calls (which only need the attach wiring above, not a re-read of argv).
      enqueueFolderCandidates(
        workspaceOpenQueue,
        filterDirectoryOpenCandidates(
          resolveFolderCandidatesFromArgv({
            appEntryPath: MAIN_ENTRY_PATH,
            appPath: app.getAppPath(),
            argv: process.argv,
            isPackaged: app.isPackaged,
            workingDirectory: process.cwd(),
          }),
          'argv'
        ),
        'argv'
      );

      // The watchdog stands down across sleep, so a suspended Main is not reported frozen.
      powerMonitor.on('suspend', () => {
        runMainWatchdogPowerTransition(mainWatchdogRuntime, 'suspend', () => {
          logger.info('power:suspend');
        });
      });
      powerMonitor.on('resume', () => {
        runMainWatchdogPowerTransition(mainWatchdogRuntime, 'resume', () => {
          logger.info('power:resume');
        });
      });

      // Window focus/blur: throttle IPC traffic when backgrounded
      mainWindow?.on('blur', () => {
        logger.info('window:blur');
      });
      mainWindow?.on('focus', () => {
        logger.info('window:focus');
      });

      app.on('activate', async () => {
        if (isDesktopShuttingDown()) {
          return;
        }
        if (BrowserWindow.getAllWindows().length === 0) {
          await createMainWindow();
        }
      });
    } catch (error) {
      logger.error('Failed to initialize application:', error);
      const message = error instanceof Error ? error.message : String(error);
      tryShowStartupErrorDialog(message);
      app.quit();
    }
  });
} else {
  logger.warn('Another BrainStrike desktop process is already running. Exiting this process.');
  app.quit();
}

// Quit on the last visible window's close is decided where that close is intercepted, so the
// quit prepares the window first (`installDocumentUnload`); where the Dock or tray keeps the app
// running it stays (ADR-0033). Subscribing still matters: without a listener Electron itself
// quits whenever every window has closed.
app.on('window-all-closed', () => undefined);

// Crashpad leaves a minidump for a crashed child process; this record names the
// process beside the dump's time (BST-2351). App windows log their own renderer
// in create-window; any other exit is the owning manager's to report.
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'crashed' && details.reason !== 'oom') {
    return;
  }
  logger.error('Child process gone', {
    exitCode: details.exitCode,
    name: details.name,
    reason: details.reason,
    serviceName: details.serviceName,
    type: details.type,
  });
});

// Clean shutdown
app.on('before-quit', (event) => {
  logger.debug('before-quit triggered');
  if (allowImmediateQuit) {
    return;
  }

  event.preventDefault();
  if (gracefulShutdownInFlight) {
    logger.debug('before-quit ignored because graceful shutdown is already in flight');
    return;
  }
  gracefulShutdownInFlight = true;
  void (async () => {
    try {
      await gracefulShutdown.run('before-quit');
    } catch (error) {
      logger.error('Graceful shutdown failed in before-quit handler', { error });
    }
    allowImmediateQuit = true;
    app.quit();
  })();
});

app.on('will-quit', () => {
  logger.debug('will-quit triggered');
  // AFTER the graceful shutdown (before-quit re-enters quit only once it has
  // settled): every IPC domain's disposer unwinds here, LIFO, each throw
  // isolated so a failing pty/watcher reap never leaves a later domain's
  // handlers registered. Native watcher retirement belongs to the awaited
  // graceful steps above; this synchronous ledger must not retry it.
  for (const failure of ipcDisposers.disposeAll()) {
    logger.error('IPC domain disposer failed during will-quit', {
      error: failure.error,
      label: failure.label,
    });
  }
  removeLogBufferListener();
});

desktopBootstrap.bindPlatform((platformPort, nativeChildren) => {
  return bindDesktopPlatformPort(platformPort, {
    ...productionDesktopCapabilities({
      modelCatalog,
      workspaceRoots: workspaceRootCatalog,
    }),
    // ADR-0029: the host's sealed credential file borrows Main's safeStorage.
    credentialCipher: createSafeStorageCredentialCipher(),
    lifecycleDelays: lifecycleDelaySeam(),
    // BST-1930 c1: the forked host owns the one MCP runtime; Main serves its stores.
    mcp: createDesktopMcpPlatformCapabilities(getMainMcpHostControl()),
    // ADR-0017: the host reports its native processes; Main ends them if it dies.
    nativeChildren,
    // ADR-0029 stage 4: the host owns the open folders; Main keeps the picker and the windows.
    pickWorkspaceFolder: () => pickWorkspaceFolder(fileSystem),
    // A worktree the host opened for an agent: the window shows it, as for any folder Main opens.
    showWorkspaceFolder: (path) => {
      desktopBootstrap.workspaceOpenQueue.enqueue({ origin: 'agent-worktree', path });
    },
    // ADR-0034: a deleted thread's scratch folder goes to the system Trash, from userData only.
    trashScratchFolder: (folder) =>
      trashScratchFolder(app.getPath('userData'), folder, (trashed) => shell.trashItem(trashed)),
    workspaceRootsChanged: onWorkspaceRootsChanged,
  });
});

export { createWindow, registerIpcHandlers, setupSecurity };

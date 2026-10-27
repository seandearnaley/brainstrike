// Side-effect import, deliberately FIRST: wraps WebAssembly before any other
// import (PGlite, tokenizers, xxhash-wasm) can instantiate a module.
import './diagnostics/install-webassembly-counter';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { detectDeprecatedProviderEnvVars } from '@brainstrike/assistant-contract/provider-metadata';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { clearReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import {
  addLogListener,
  createLogger,
  type FileTransportConfig,
  initializeLogging,
  LogBuffer,
} from '@brainstrike/logging';
import { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { app, BrowserWindow, dialog, Menu, powerMonitor, shell } from 'electron';
import ElectronStore from 'electron-store';
import { registerAgentHostClientIpc } from './agent-host-client-ipc';
import { createAgentHostMainClient } from './agent-host-main-client';
import { bindDesktopPlatformPort } from './agent-host-platform/desktop-platform-port';
import { DesktopWorkspaceBindingAuthority } from './agent-host-platform/desktop-workspace-binding';
import { productionDesktopCapabilities } from './agent-host-platform/production-desktop-capabilities';
import { createDesktopWorkspaceRootCatalog } from './agent-host-platform/workspace-root-client';
import { restartLaunchedAgentHost } from './agent-host-restart';
import { isAppWindowSender } from './app-windows';
import { buildFileMenuTemplate } from './application-file-menu';
import { registerAssetProtocol } from './asset-protocol';
import { createCatalogRetrievalStore } from './assistant-server/retrieval-store-catalog';
import { loadWorkspaceRootsFromCatalog } from './assistant-server/workspace-roots';
import { hasHostRunInWorktree } from './assistant-server/worktree-host-activity';
import { createWorktreeLedger } from './assistant-server/worktree-ledger';
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
import { createDesktopFactoryResetHandler } from './desktop-reset-platform';
import { createDesktopResetResume } from './desktop-reset-resume';
import {
  isDesktopShuttingDown,
  isExpectedShutdownRefusal,
  markDesktopShuttingDown,
} from './desktop-shutdown-state';
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
import { createWorkspaceRootResolver } from './git-ipc-handlers';
import { assertRegisteredEmbeddingModel, createDesktopIndexConfig } from './index-config';
import { registerAgentHostRecoveryIpcHandlers } from './ipc-agent-host-recovery';
import { registerBrowserIpcHandlers } from './ipc-browser';
import { registerClipboardIpcHandlers } from './ipc-clipboard';
import { registerContextFilesIpcHandlers } from './ipc-context-files';
import { registerDesktopDiagnosticsIpcHandlers } from './ipc-desktop-diagnostics';
import { listRecentRootEntries } from './ipc-domains/workspace-recent-roots';
import { registerFileExportsIpcHandlers } from './ipc-file-exports';
import { createApplicationIpcDomain, registerIpcHandlers } from './ipc-handlers';
import { registerHooksIpcHandlers } from './ipc-hooks';
import { registerIndexSearchIpcHandlers } from './ipc-index-search';
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
import { registerUserPersonasIpcHandlers } from './ipc-user-personas';
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
import { prepareMainCatalogClose } from './main/main-catalog-close';
import { installShutdownSignalHandlers } from './main/shutdown-signals';
import { registerMainPlatformIpcHandlers } from './main-platform-ipc';
import { isMainProcessHealthDegraded } from './main-process-health-log-level';
import { getMcpAppShellRegistry, registerMcpAppShellProtocol } from './mcp/apps-shell-protocol';
import { createDesktopMcpPlatformCapabilities } from './mcp/desktop-host-platform';
import { getMainMcpHostControl } from './mcp/main-host-control';
import { createDesktopModelCatalog } from './model-catalog';
import { createNativeIndexActivation } from './native-index-activation';
import {
  reportAgentHostStartupFailure as reportHostStartupFailure,
  reportNativeIndexActivationError as reportNativeIndexFailure,
} from './native-index-activation-error';
import { observeNativeIndex } from './native-index-observations';
import {
  createNativeStartupFailureReporter,
  observeNativeReaderStartup,
} from './native-index-startup-window';
import { createNativeRootDataDeletion } from './native-root-data-deletion';
import { createNativeRootRegistration } from './native-root-registration';
import { createNativeScopedSearchCapability } from './native-scoped-search';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { pushToRenderer } from './platform/desktop-ipc-push';
import { prepareDocumentUnload } from './prepare-document-unload';
import { registerRendererProtocol } from './renderer-protocol';
import { createDesktopSettingsSecrets } from './secrets';
import { setupSecurity } from './setup-security';
import { openIndexQuery } from './sqlite-query-host-manager';
import type { DesktopSettingsStoreSchema } from './store-schema';
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
      dialog.showErrorBox('BrainStrike Desktop failed to start', message);
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

const logger = createLogger('DesktopMain');
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
// NOT a replay buffer, despite the name's "pending" framing: a grant recorded
// before this is assigned (inside app.whenReady()'s menu block) is a silent
// no-op for THIS subscriber specifically — it never queues and never fires
// late. That's safe because the grant itself is durable regardless (the
// ledger write in workspace-recent-roots.ts happens unconditionally, and the
// next application-menu rebuild reads the ledger fresh), so the only thing a
// pre-assignment grant misses is that one mount's app.addRecentDocument call
// — relevant only to a renderer-less/background window mounting before the
// visible-UI menu block runs, which does not happen in the normal boot path.
let pendingRootGrantSubscriber: ((grantedPath: string) => void) | null = null;
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

/** Every unload of a visible document flushes it first (ADR-0026 R1, `document-unload.ts`). */
function documentUnloadOwner(): DocumentUnloadOwner<BrowserWindow> {
  return {
    // Resolved when a document unloads, not when its window is created.
    delays: { delay: (point) => lifecycleDelaySeam().delay(point) },
    isQuitting: isDesktopShuttingDown,
    lastWindowQuits: process.platform !== 'darwin',
    quit: () => app.quit(),
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

let completeFactoryResetRendererReplacement: ((signal: AbortSignal) => Promise<void>) | null = null;

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
    closeDatabase: () => nativeIndexActivation.close(),
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
      'main-catalog': () =>
        prepareMainCatalogClose(applicationIpcDomain.roots, workspaceRootCatalog),
      // Wrapped: the cleanup's optional parameter is the runtime, not a signal.
      'mcp-runtime': () => cleanupMcpRuntimeForShutdown(),
      'native-index': async () => {
        await agentHostMainClient.close();
        // Fence profile admission before joining the renderer's in-flight host connect:
        // a host start that fails during shutdown is then never retried as a second host.
        await nativeIndexActivation.close();
        await agentHostClientIpc.close();
      },
      // before-quit postpones Electron's own window close. Join the renderer
      // producers first, while their DB/chunking/assistant dependencies still
      // live. Every window is joined to `closed`: a renderer that cannot
      // answer is destroyed by its own ladder, never abandoned (ADR-0026).
      renderers: async () => {
        // The admitted reset has joined. Fence new profile work while an
        // initial load finishes, before closing the window it is creating.
        nativeIndexActivation.fenceTerminal();
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
  // Fence the current native/profile owner before any renderer can request more work.
  retireBackgroundAdmission: () => nativeIndexActivation.fenceTerminal(),
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
const storage = new ElectronStorageAdapter();

const listWorkspaceRecentRootPaths = async (): Promise<readonly string[]> => {
  try {
    return (await listRecentRootEntries(storage)).map((entry) => entry.path);
  } catch (error) {
    // A menu that cannot list recents still opens folders; a boot that dies
    // on a storage read does not. Logged, never silent.
    logger.warn('Could not read the recent workspace folders for the File menu', { error });
    return [];
  }
};

const profileReset = createDesktopProfileResetOwner({
  profilePath: () => {
    const location = resolveDesktopDatabaseLocation();
    return joinProfileDirectory(location.rootPath, location.profile);
  },
  retireProfile: () => nativeIndexActivation.destroyAndRetireProfile(),
});

const handleResetLocal = createDesktopFactoryResetHandler({
  clearRetainedContent: async () => {
    await nativeIndexActivation.destroyNativeOwner();
    await applicationIpcDomain.roots.clearForContent();
    const result = await desktopBootstrap.profile.clearAndRetireContent();
    for (const filePath of listErrorLogFilePaths(
      path.join(app.getPath('logs'), ERROR_LOG_FILE_NAME)
    )) {
      await rm(filePath, { force: true });
    }
    return result;
  },
  completeSuccessfulReset: async (signal) => {
    const completeRendererReplacement = completeFactoryResetRendererReplacement;
    if (completeRendererReplacement === null) {
      throw new Error('Factory reset renderer replacement coordinator is unavailable');
    }
    await completeRendererReplacement(signal);
  },
  // The durable NDJSON backstop (Flight Recorder P2a) is a plaintext mirror
  // of `brainstrike_diagnostic_events`, which factory reset already wipes —
  // without this, the mirror would survive inside the preserved `logs`
  // folder while the DB rows it mirrors do not (see desktop-factory-reset.ts).
  errorLogFilePaths: listErrorLogFilePaths(path.join(app.getPath('logs'), ERROR_LOG_FILE_NAME)),
  logger,
  prepareDatabaseProfileReset: () => profileReset.prepare(),
  resetLocalDatabase: (lease) => profileReset.clear(lease),
  resetPersistentStorageAfterDataDeletion: () => storage.clear(),
  resumeAfterReset: createDesktopResetResume({
    publishIndexConfig: () => indexConfig.publishSaved(),
    resumeIndex: (signal) => nativeIndexActivation.resume(signal),
    resumeMcp: (outcome) => resumeMcpRuntimeAfterFactoryReset(getMainMcpHostControl(), outcome),
  }),
  runTransition: (work) => nativeRootDataDeletion.transition(work),
  runtimes: [
    { name: 'native-index-sources', stop: () => nativeIndexActivation.stopSources() },
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

// Register IPC handlers early to avoid renderer calls racing registration during startup.
const workspaceRootCatalog = createDesktopWorkspaceRootCatalog(() =>
  nativeIndexActivation.acquireProfile()
);
const modelCatalog = createDesktopModelCatalog(workspaceRootCatalog);
const applicationIpcDomain = createApplicationIpcDomain(fileSystem, storage, getSettingsStore, {
  getRootsCatalog: async () => workspaceRootCatalog,
  getUserDataPath: () => app.getPath('userData'),
  // The host owns the worktree ledger and settings: it says whether a folder is a managed worktree.
  managedWorktreeAuthorizer: async (candidate) =>
    (await agentHostMainClient.request('worktrees/classify-path', { path: candidate }))
      .classification,
  onClearContent: async () => {
    const result = await handleResetLocal.clearContent();
    if (
      !result.success ||
      result.deletedFiles === undefined ||
      result.deletedChunks === undefined
    ) {
      throw new Error(result.message ?? 'Content clearing did not return its completion receipt.');
    }
    return { deletedChunks: result.deletedChunks, deletedFiles: result.deletedFiles };
  },
  onDeleteRootData: (rootId) => nativeRootDataDeletion.deleteRootData(rootId),
  onResetLocal: () => handleResetLocal.reset(),
  onWorkspaceRootGranted: (grantedPath: string) => {
    pendingRootGrantSubscriber?.(grantedPath);
  },
  onWorkspaceRootsChanged: () => {
    // Not awaited, as a renderer's registration is not: the index status owns the outcome,
    // and the registration reports its own failure.
    nativeRootRegistration.rootsRegistered().catch(() => undefined);
  },
});
function activateSavedNativeIndexSettings(): Promise<void> {
  if (isDesktopShuttingDown()) {
    return Promise.resolve();
  }
  const resetting = handleResetLocal.inFlight();
  if (resetting) {
    return resetting.then((result) => {
      // The reset owner retains its original failed outcome; this notification
      // must not start activation after an unsuccessful reset.
      return result.success ? activateSavedNativeIndexSettings() : undefined;
    });
  }
  return nativeRootDataDeletion.prepareTransition(
    () => nativeIndexActivation.prepareSavedPause(),
    (prepared) => (prepared ? prepared.complete() : nativeIndexActivation.reconfigure())
  );
}

export function reportAgentHostStartupFailure(error: unknown): void {
  reportHostStartupFailure(error, isDesktopShuttingDown(), logger);
}
function reportNativeIndexActivationError(message: string, error: unknown): void {
  reportNativeIndexFailure(message, error, isDesktopShuttingDown(), logger);
}
const agentHostPrivateClients = desktopBootstrap.privateClients;
const nativeIndexActivation = createNativeIndexActivation({
  application: applicationIpcDomain,
  catalog: workspaceRootCatalog,
  lifecycleDelays: lifecycleDelaySeam,
  onError: (operation, error) =>
    reportNativeIndexActivationError(`Native indexing ${operation} failed`, error),
  onReceipt: (receipt) =>
    logger.info('Canonical native scan settled', { receipt, settledAt: new Date().toISOString() }),
  profile: desktopBootstrap.profile,
  settings: () => indexConfig.nativeSettings(),
});
const indexConfig = createDesktopIndexConfig({
  assertModel: assertRegisteredEmbeddingModel,
  catalog: workspaceRootCatalog,
  publish: (config) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        pushToRenderer(window.webContents, DESKTOP_IPC_CHANNELS.indexSearch.configChanged, config);
      }
    }
  },
  // A saved change joins the native owner's FIFO and `update` returns: the scan runs in the
  // background, so a Pause saved meanwhile fences admission at once. During a factory reset a
  // reconfigure waits for the reset while a rebuild or vector-space replacement joins the FIFO
  // directly, so applies can run out of save order; each re-reads the saved config when it runs,
  // so the index ends on the last save. Failures stay visible in the lifecycle observation and
  // these reports.
  rebuild: async () => {
    nativeIndexSearch
      .rebuild()
      .catch((error: unknown) =>
        reportNativeIndexActivationError('Search index rebuild for the new chunking failed', error)
      );
  },
  reconfigure: async () => {
    activateSavedNativeIndexSettings().catch((error: unknown) =>
      reportNativeIndexActivationError('Saved native index configuration could not activate', error)
    );
  },
  replaceVectorSpace: (id) =>
    nativeRootDataDeletion.transition(async () => {
      await nativeIndexActivation.cleanupCollection(id);
      await workspaceRootCatalog.collections({ id, operation: 'delete' });
      await nativeIndexActivation.resume();
    }),
});
// Main's own desktop-origin client: Settings credential writes reach the host,
// their single owner, through it.
const agentHostMainClient = createAgentHostMainClient(
  nativeIndexActivation.acquireProfile,
  agentHostPrivateClients.open
);
// The host owns hook trust.
const desktopHookTrust = createDesktopHookTrust((method, params) =>
  agentHostMainClient.request(method, params)
);
const agentHostClientIpc = registerAgentHostClientIpc(async () => {
  // A factory reset retires the profile until it reopens it, after its replacement
  // renderer is ready: that renderer's clients connect once it has, not into the fence.
  await handleResetLocal.idle();
  return await nativeIndexActivation.acquireProfile();
}, agentHostPrivateClients.open);
ipcDisposers.add('agent-host-client', agentHostClientIpc.unregister);
// BST-1880: the damaged-store notice's actions. A restart stops the host this
// app launched, which relaunches for the next client as after a crash, so its
// state store reopens and checks itself again.
ipcDisposers.add(
  'agent-host-recovery',
  registerAgentHostRecoveryIpcHandlers({
    restartHost: () =>
      restartLaunchedAgentHost({
        acquireProfile: () => nativeIndexActivation.acquireProfile(),
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
const nativeRootDataDeletion = createNativeRootDataDeletion({
  acquire: () => nativeIndexActivation.acquire(),
  captureOwner: async () => {
    await nativeIndexActivation.getSearchAuthority();
    return nativeIndexActivation.captureAcknowledgedAuthority();
  },
  closeOwner: () => nativeIndexActivation.closeNativeOwner(),
  deleteCanonicalRoot: async (mounted) => {
    await workspaceRootCatalog.workspaceRoots({
      operation: 'delete',
      paths: [mounted.canonicalPath, mounted.presentationPath],
      rootId: mounted.rootId,
    });
  },
  reserveRoot: (rootId) => applicationIpcDomain.roots.reserveRootDataDeletion(rootId),
  resume: () => nativeIndexActivation.resume(),
  stopSources: () => nativeIndexActivation.stopSources(),
});

const nativeIndexSearch = createNativeScopedSearchCapability({
  openQuery: openIndexQuery,
  rebuild: () => nativeRootDataDeletion.transition(() => nativeIndexActivation.rebuild()),
  withRead: nativeIndexActivation.withRead,
});
const nativeRootRegistration = createNativeRootRegistration({
  isShuttingDown: isDesktopShuttingDown,
  reconfigureRoots: () => nativeIndexActivation.reconfigureRoots(),
  reportError: reportNativeIndexActivationError,
  transition: (operation) => nativeRootDataDeletion.transition(operation),
});
const nativeLifecycleObserver = new AbortController();
// Windows follow this push for the index's lifecycle, status and coverage; none of them polls.
observeNativeIndex({
  coverageBatch: nativeIndexSearch.coverageBatch,
  observeChanges: nativeIndexActivation.observeChanges,
  observeLifecycle: nativeIndexActivation.observeLifecycle,
  publish: (observation) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        pushToRenderer(
          window.webContents,
          DESKTOP_IPC_CHANNELS.indexSearch.lifecycleChanged,
          observation
        );
      }
    }
  },
  signal: nativeLifecycleObserver.signal,
  status: nativeIndexSearch.status,
}).catch((error: unknown) => {
  if (error !== nativeLifecycleObserver.signal.reason) {
    reportNativeIndexActivationError('Native lifecycle observer failed', error);
  }
});
ipcDisposers.add('native-index-lifecycle', () =>
  nativeLifecycleObserver.abort(new Error('Native lifecycle observer disposed.'))
);
ipcDisposers.add(
  'index-search',
  registerIndexSearchIpcHandlers(nativeIndexSearch, nativeRootRegistration, indexConfig)
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
ipcDisposers.add('context-files', registerContextFilesIpcHandlers(workspaceRootCatalog));
ipcDisposers.add('thread-groups', registerThreadGroupsIpc(workspaceRootCatalog));
ipcDisposers.add('view-filter-presets', registerViewFilterPresetsIpc(workspaceRootCatalog));
ipcDisposers.add('model-catalog', registerModelCatalogIpc(modelCatalog));
ipcDisposers.add(
  'user-personas',
  registerUserPersonasIpcHandlers(workspaceRootCatalog, modelCatalog)
);

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

  completeFactoryResetRendererReplacement = async (signal) => {
    await factoryResetRendererReplacement.replace(BrowserWindow.getAllWindows(), signal);
  };

  desktopBootstrap.bindSecondInstanceFocus(() => {
    const existingWindow = BrowserWindow.getAllWindows()[0] ?? null;
    if (!existingWindow) {
      return;
    }

    if (typeof existingWindow.show === 'function') {
      existingWindow.show();
    }
    if (typeof existingWindow.focus === 'function') {
      existingWindow.focus();
    }
  });

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
      const reportInitialNativeFailure = createNativeStartupFailureReporter((error) =>
        reportNativeIndexActivationError('Native index activation unavailable', error)
      );
      // Threads use the profile even when search has no selected catalog. Start
      // its existing owner before catalog discovery and renderer hydration.
      void nativeIndexActivation
        .acquireProfile()
        .catch((error: unknown) =>
          reportNativeIndexActivationError('Agent host profile unavailable', error)
        );
      void nativeIndexActivation.acquire().catch(reportInitialNativeFailure);
      void observeNativeReaderStartup(
        nativeIndexActivation.acquireRead(),
        reportInitialNativeFailure
      ).then((outcome) =>
        logger.info('Initial native reader startup settled', { kind: outcome.kind })
      );
      logger.debug('Configured desktop renderer target', { rendererTarget });

      // Register the root-validated `brainstrike-asset://` protocol now that the
      // app is ready (protocol.handle requires ready). The resolver validates
      // renderer-supplied paths against the DB `roots` table — the SAME source
      // the git/read/search tools use — resolving the DB lazily per request.
      registerAssetProtocol(createWorkspaceRootResolver(workspaceRootCatalog));

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

      // Re-initialize file logging now that app.getPath() is available.
      const enabledLogFile = loggingPreferences.enableFileLoggingAfterReady();
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
      // backstop and the PGlite-backed DB sink are independent failure
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
      // the single credential writer. Its `auth/clear` also drops the host's MCP
      // OAuth records with their live providers.
      const secretsService = createDesktopSettingsSecrets({
        clear: async () => (await agentHostMainClient.request('auth/clear', {})).cleared,
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

      // Application menu with developer utilities
      const menuTemplate: Electron.MenuItemConstructorOptions[] = [
        {
          label: 'Application',
          submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
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
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Developer',
          submenu: [
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
                  // Join native producers, readers, and writer before resetting this profile.
                  await nativeRootDataDeletion.transition(async () => {
                    await nativeIndexActivation.stopSources();
                    const lease = await profileReset.prepare();
                    try {
                      await profileReset.clear(lease);
                    } finally {
                      lease.release();
                    }
                    await nativeIndexActivation.resume();
                  });
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
                    `The local database was not reset: ${message}\n\nIf background indexing kept the database busy, retry after it settles (or use Factory Reset in Settings, which stops background work first).`
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

      let applicationMenuRebuildScheduled = false;
      const rebuildApplicationMenu = async (): Promise<void> => {
        const recents = await listWorkspaceRecentRootPaths();
        const template = [...menuTemplate];
        template.splice(
          1,
          template[1]?.label === 'File' ? 1 : 0,
          buildFileMenuTemplate({
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
          })
        );
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

      pendingRootGrantSubscriber = (grantedPath: string) => {
        // Spec §7's explicit ask. This feeds the macOS Dock menu and the
        // Windows jump list, whose clicks arrive back as `open-file` / argv —
        // the entry points Layer 3 handles.
        app.addRecentDocument(grantedPath);
        scheduleApplicationMenuRebuild();
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
        return win;
      };

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
          logger.debug('Creating main window...');
          // Owner decision 7.3(i): the first window waits for neither the host nor
          // the index; the renderer shows both as state while they start.
          return isDesktopShuttingDown() ? undefined : await createMainWindow();
        }
      );
      const mainWindow = await initialWindowCreation;
      if (!mainWindow || isDesktopShuttingDown()) {
        return;
      }
      logger.debug('Main window created successfully');

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
      mainWindow.on('blur', () => {
        logger.info('window:blur');
      });
      mainWindow.on('focus', () => {
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
// quit prepares the window first (`installDocumentUnload`). Subscribing still matters: without a
// listener Electron itself quits whenever every window has closed.
app.on('window-all-closed', () => undefined);

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
  const ledger = createWorktreeLedger(
    async () => workspaceRootCatalog,
    (id) =>
      hasHostRunInWorktree(
        {
          readLedger: () => agentHostMainClient.request('ledger/read', {}),
          readThread: async (threadId) =>
            (await agentHostMainClient.request('thread/read', { fromSeq: 0, threadId })).rows,
        },
        id
      )
  );
  const workspace = new DesktopWorkspaceBindingAuthority({
    borrowRoot: (root) =>
      applicationIpcDomain.roots.borrowSourceRootForPath(
        root.path,
        applicationIpcDomain.watches.subscribe.bind(applicationIpcDomain.watches)
      ),
    // BST-1990: names a removed folder in the refusal, whatever its status now.
    readRootNames: async (ids) => {
      const { roots } = await workspaceRootCatalog.workspaceRoots({ operation: 'list' });
      return new Map(
        roots.filter((root) => ids.includes(root.id)).map((root) => [root.id, root.displayName])
      );
    },
    readRoots: async () => loadWorkspaceRootsFromCatalog(workspaceRootCatalog),
    readWorktree: (id) => ledger.get(id),
  });
  return bindDesktopPlatformPort(platformPort, {
    ...productionDesktopCapabilities(
      {
        modelCatalog,
        nativeIndexSearch,
        retrievalStore: createCatalogRetrievalStore(workspaceRootCatalog),
        workspaceRoots: workspaceRootCatalog,
      },
      undefined,
      workspace
    ),
    // BST-1977: app-owned host/stop released Root with the native writer live.
    // Retiring the profile here would wait on this same Core close request.
    closeRootCapabilities: async (host) => {
      const results = await Promise.allSettled([
        workspace.close(),
        nativeIndexActivation.closeRootCapabilities(host),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Desktop workspace and native Root retirement failed');
      }
    },
    lifecycleDelays: lifecycleDelaySeam(),
    // BST-1930 c1: the forked host owns the one MCP runtime; Main serves its stores.
    mcp: createDesktopMcpPlatformCapabilities(getMainMcpHostControl()),
    // ADR-0017: the host reports its native processes; Main ends them if it dies.
    nativeChildren,
    // The ledger authorizes a managed worktree's mount; no picker grant is needed.
    // The window is then asked to show it, as for any folder Main opens.
    openWorktreeFolder: async (path) => {
      const root = await applicationIpcDomain.roots.addRootByPath(path);
      desktopBootstrap.workspaceOpenQueue.enqueue({
        origin: 'agent-worktree',
        path: root.handle.path,
      });
      return { displayName: root.displayName, path: root.handle.path, rootId: root.rootId };
    },
    refreshWorkspaceIndex: (rootId) => nativeIndexActivation.requestWorkspaceScan(rootId),
  });
});

export { createWindow, registerIpcHandlers, setupSecurity };

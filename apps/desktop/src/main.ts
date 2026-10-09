// Side-effect import, deliberately FIRST: wraps WebAssembly before any other
// import (PGlite, tokenizers, xxhash-wasm) can instantiate a module.
import './diagnostics/install-webassembly-counter';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { detectDeprecatedProviderEnvVars } from '@brainstrike/assistant-contract/provider-metadata';
import { createMainLlmHostClient } from '@brainstrike/assistant-service/ports';
import { recoverInterruptedDimensionIndexMaintenanceAtStartup } from '@brainstrike/db';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { clearReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import { createProviderVerificationService } from '@brainstrike/host-capabilities/provider-verification';
import type { ProfileResetLease } from '@brainstrike/host-lease';
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
import { z } from 'zod';
import { configureAgentDevtoolsCommandLine } from './agent-devtools-config';
import { registerAgentHostClientIpc } from './agent-host-client-ipc';
import { createAgentHostMainClient } from './agent-host-main-client';
import { createDesktopPlatformPort } from './agent-host-platform/desktop-platform-port';
import { DesktopWorkspaceBindingAuthority } from './agent-host-platform/desktop-workspace-binding';
import { readMainLegacyMemory } from './agent-host-platform/legacy-memory-main';
import { readEmbeddingHostDevice } from './agent-host-platform/memory-vector-selection';
import {
  PlatformPolicySchema,
  platformPermissionPolicy,
} from './agent-host-platform/platform-wire';
import { productionDesktopCapabilities } from './agent-host-platform/production-desktop-capabilities';
import { createAgentHostPrivateClients } from './agent-host-private-clients';
import { buildFileMenuTemplate } from './application-file-menu';
import { registerAssetProtocol } from './asset-protocol';
import { startAssistantServer } from './assistant-server';
import { createHostThreadTurns } from './assistant-server/changeset-host-turns';
import {
  configureDesktopCommandSessionManager,
  disposeDesktopCommandSessions,
} from './assistant-server/command-session-manager';
import { disposeLiveChildProcesses } from './assistant-server/execute-command-tool';
import type { ForgeService } from './assistant-server/forge-service';
import type { GitInventoryService } from './assistant-server/git-inventory-service';
import { installDesktopHookApprovalReader } from './assistant-server/hooks/server-integration';
import { disposeLspServers } from './assistant-server/lsp-diagnostics';
import { readMainVerificationCredential } from './assistant-server/provider-credentials';
import { execFileSnapshotGitRunner } from './assistant-server/snapshot-git';
import { createSnapshotRepository } from './assistant-server/snapshot-repository';
import { createSnapshotService, type SnapshotService } from './assistant-server/snapshot-service';
import { loadWorkspaceRootsFromDatabase } from './assistant-server/workspace-roots';
import { createWorktreeLedger } from './assistant-server/worktree-ledger';
import { isPathWithin } from './assistant-server/worktree-paths';
import type { createWorktreeService } from './assistant-server/worktree-service';
import { readWorktreeSettings, writeWorktreeSettings } from './assistant-server/worktree-settings';
import { collectBackgroundRuntimeMetrics } from './background-runtime-metrics';
import { emitBootMeasurementMark, shouldQuitAfterBootMeasurement } from './boot-measurement';
import { createBrowserPaneHost } from './browser/browser-pane-host';
import {
  clearActiveBrowserPaneHost,
  setActiveBrowserPaneHost,
} from './browser/browser-pane-registry';
import { createBrowserIpcHandlers } from './browser-ipc-handlers';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { registerCanvasProtocol } from './canvas-protocol';
import { createChangesIpcHandlers } from './changes-ipc-handlers';
import { ChunkingHostManager } from './chunking-host-manager';
import { closeDesktopRenderers } from './close-desktop-renderers';
import { createWindow, noteNextWindowReload } from './create-window';
import { startDatabaseIntegrityContainment } from './database-integrity-containment';
import { getDesktopDatabaseIntegrity } from './database-integrity-state';
import { createDesktopDatabaseMaintenanceScheduler } from './database-maintenance-scheduler';
import { getDbHostManager } from './db-host-manager';
import {
  closeDatabase,
  getDatabase,
  prepareDatabaseProfileReset,
  resetLocalDatabase,
} from './db-main';
import { getDesktopCrashRecoverySnapshot } from './desktop-crash-recovery';
import { getDesktopEnvironmentBootstrapResult } from './desktop-env';
import { buildDesktopEnvBootstrapReport } from './desktop-env-report';
import { serializeDesktopError } from './desktop-error-serialization';
import { createDesktopHookTrust, loadDesktopRootPaths } from './desktop-hook-trust';
import { resolveDesktopRendererLaunchMode } from './desktop-launch-mode';
import {
  createDesktopMaintenanceTriggerGraph,
  type DesktopMaintenanceTriggerGraph,
} from './desktop-maintenance-trigger-graph';
import {
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
} from './desktop-renderer-target';
import { DESKTOP_DEV_RENDERER_URL } from './desktop-renderer-url';
import { getDesktopResetDiagnosticsSnapshot } from './desktop-reset-diagnostics';
import {
  createDesktopFactoryResetHandler,
  resetDesktopDatabaseProfile,
} from './desktop-reset-platform';
import { isDesktopShuttingDown, markDesktopShuttingDown } from './desktop-shutdown-state';
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
import {
  type DimensionIndexBuildStrategy,
  probeDimensionIndexRuntimeCapabilities,
} from './dimension-index-maintenance-capabilities';
import { createDesktopDimensionIndexMaintenanceScheduler } from './dimension-index-maintenance-scheduler';
import { resolveBuiltRendererPath } from './dist-root';
import { installE2eForegroundLatencyProbes } from './e2e-foreground-latency-probes';
import { createE2eScriptedLlmHost } from './e2e-scripted-llm-host';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';
import { EmbeddingHostManager } from './embedding-host-manager';
import { createFactoryResetRendererReplacementCoordinator } from './factory-reset-renderer-replacement';
import { resolveFolderCandidatesFromArgv } from './folder-argv';
import { createDatabaseRootResolver } from './git-ipc-handlers';
import { DISABLED_CHROMIUM_FEATURES } from './gpu-flags';
import { registerAgentIpcHandlers } from './ipc-agent';
import { registerBrowserIpcHandlers } from './ipc-browser';
import { registerChangesIpcHandlers } from './ipc-changes';
import { registerChunkingHostIpcHandlers } from './ipc-chunking-host';
import { registerClipboardIpcHandlers } from './ipc-clipboard';
import { registerContextFilesIpcHandlers } from './ipc-context-files';
import { registerDesktopDiagnosticsIpcHandlers } from './ipc-desktop-diagnostics';
import { registerAssistantCheckpointIpcHandlers } from './ipc-domains/assistant-checkpoint-ipc';
import { registerDatabaseIntegrityIpcHandlers } from './ipc-domains/database-integrity-ipc';
import { registerProviderAuthIpcHandlers } from './ipc-domains/provider-auth';
import { listRecentRootEntries } from './ipc-domains/workspace-recent-roots';
import { cancelAllDesktopEmbeddingBackfills } from './ipc-embedding-backfill';
import { registerEmbeddingHostIpcHandlers } from './ipc-embedding-host';
import { registerFileExportsIpcHandlers } from './ipc-file-exports';
import { registerGitIpcHandlers } from './ipc-git';
import {
  cleanupDesktopLiveSubscriptionsForShutdown,
  createApplicationIpcDomain,
  getDesktopDatabaseWorkScheduler,
  getDesktopDatabaseWorkSchedulerSnapshot,
  registerIpcHandlers,
  runDesktopScheduledDatabaseWork,
  runWithDesktopDatabaseResetBarrier,
  setBackgrounded,
  waitForDesktopDatabaseWorkSchedulerIdle,
} from './ipc-handlers';
import { registerHooksIpcHandlers } from './ipc-hooks';
import { registerIndexSearchIpcHandlers } from './ipc-index-search';
import { registerLlmHostIpcHandlers } from './ipc-llm-host';
import {
  cleanupMcpRuntimeForShutdown,
  registerMcpIpcHandlers,
  resetMcpRuntimeForFactoryReset,
  resumeMcpRuntimeAfterFactoryReset,
} from './ipc-mcp';
import { registerNotesVaultIpc } from './ipc-notes-vault';
import { registerParserHostIpcHandlers } from './ipc-parser-host';
import { registerRuntimeIpcHandlers } from './ipc-runtime';
import { registerSecretsIpcHandlers } from './ipc-secrets';
import { registerShellIpcHandlers } from './ipc-shell';
import { createShellIpcHandlers } from './ipc-shell-handlers';
import { registerSkillsIpcHandlers } from './ipc-skills';
import { registerTerminalIpc } from './ipc-terminal';
import { registerUserCommandsIpcHandlers } from './ipc-user-commands';
import { registerUserPersonasIpcHandlers } from './ipc-user-personas';
import { registerWorktreesIpcHandlers } from './ipc-worktrees';
import { LlmHostManager } from './llm-host-manager';
import { registerLoggingIpcHandlers } from './logging-ipc';
import {
  createDesktopGracefulShutdown,
  type DesktopShutdownRunPlan,
} from './main/desktop-graceful-shutdown';
import { createDisposerStack, type DisposerHandle } from './main/disposer-stack';
import { startGitAwarenessLifecycle } from './main/git-awareness-lifecycle';
import { createDesktopLoggingPreferencesController } from './main/logging-preferences';
import { installShutdownSignalHandlers } from './main/shutdown-signals';
import { startSnapshotStartupMaintenance } from './main/snapshot-lifecycle';
import { registerMainPlatformIpcHandlers } from './main-platform-ipc';
import { isMainProcessHealthDegraded } from './main-process-health-log-level';
import { getMcpAppShellRegistry, registerMcpAppShellProtocol } from './mcp/apps-shell-protocol';
import { createDesktopMcpPlatformCapabilities } from './mcp/desktop-host-platform';
import { getDesktopMcpHostRuntime } from './mcp/host-runtime';
import { createNativeCallerRead } from './native-caller-query';
import { createNativeIndexActivation } from './native-index-activation';
import { reportNativeIndexActivationError as reportNativeIndexFailure } from './native-index-activation-error';
import { NATIVE_INDEX_SETTINGS_KEY } from './native-index-settings';
import {
  createInitialWindowAfterNativeReader,
  createNativeStartupFailureReporter,
  observeNativeReaderStartup,
} from './native-index-startup-window';
import { createNativeRootDataDeletion } from './native-root-data-deletion';
import { createNativeScopedSearchCapability } from './native-scoped-search';
import { ParserHostManager } from './parser-host-manager';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { readDesktopPowerSnapshot } from './platform/desktop-power-snapshot';
import { VECTOR_PREFERENCES_STORAGE_KEY } from './platform/vector-preferences-storage-key';
import { registerPrivilegedSchemes } from './privileged-schemes';
import {
  createDesktopSettingsSecrets,
  desktopCredentialStoreSelection,
  desktopLegacySecretsPending,
  importDesktopLegacySecrets,
  installDesktopLegacyImporter,
} from './secrets';
import { setupSecurity } from './setup-security';
import { installIndexCallerRead, openIndexQuery } from './sqlite-query-host-manager';
import type { DesktopSettingsStoreSchema } from './store-schema';
import { disposeAllTerminals } from './terminal-ipc-handlers';
import { registerWindowFocusIpcHandlers } from './window-focus-ipc';
import { resolveSourceWindowRole } from './window-role';
import { readStoredWindowState, registerWindowStatePersistence } from './window-state';
import {
  createWorkspaceOpenQueue,
  enqueueFolderCandidates,
  filterDirectoryOpenCandidates,
} from './workspace-open-queue';
import { registerWorkspaceOpenReadyIpcHandlers } from './workspace-open-ready-ipc';
import { createWorktreesIpcHandlers } from './worktrees-ipc-handlers';

// The running bundled entry's own on-disk path (dist/main.js in every real
// launch), threaded to `resolveFolderCandidatesFromArgv` so the FILE-entry
// launch spelling (`electron <path>/dist/main.js`, BST-1459) is recognized
// as the implicit app argument.
// biome-ignore lint/correctness/noGlobalDirnameFilename: esbuild's cjs output leaves import.meta EMPTY and Vitest's shim has no module.filename — __filename is the only identifier populated in both; see bundled-sibling-path.ts's docblock (BST-1459).
const MAIN_ENTRY_PATH = __filename;

const desktopEnvLoadResult = getDesktopEnvironmentBootstrapResult();
const disableFileLogs = process.env['BRAINSTRIKE_DISABLE_FILE_LOGS'] === '1';
const E2E_USER_DATA_DIR_ENV = 'BRAINSTRIKE_E2E_USER_DATA_DIR';

const agentDevtoolsConfig = configureAgentDevtoolsCommandLine(
  app.commandLine,
  process.env,
  process.argv
);

// MUST run before app.whenReady(), and exactly once for ALL privileged
// schemes: Electron honors a single registerSchemesAsPrivileged call per
// launch (see privileged-schemes.ts).
registerPrivilegedSchemes();

function readExplicitE2eUserDataDir(): string | null {
  const candidate = process.env[E2E_USER_DATA_DIR_ENV]?.trim();
  if (!candidate || candidate.toLowerCase() === 'undefined') {
    return null;
  }
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${E2E_USER_DATA_DIR_ENV} must be an absolute path.`);
  }
  return candidate;
}

function applyExplicitPathIsolation(): void {
  const electronE2ETestMode = isElectronE2ETestMode();
  if (!(electronE2ETestMode || agentDevtoolsConfig.enabled)) {
    return;
  }

  const userDataDir = readExplicitE2eUserDataDir();
  if (!userDataDir) {
    if (agentDevtoolsConfig.enabled) {
      throw new Error(`${E2E_USER_DATA_DIR_ENV} is required when Agent DevTools is enabled.`);
    }
    return;
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);

  const sessionDataDir = path.join(userDataDir, 'session-data');
  fs.mkdirSync(sessionDataDir, { recursive: true });
  app.setPath('sessionData', sessionDataDir);

  const logsDir = path.join(userDataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  app.setPath('logs', logsDir);
}

applyExplicitPathIsolation();

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

// Note: Embedding worker configuration stays renderer-only via the hidden embedding host window.
// Main process owns host lifecycle/IPC, but it must not execute local WASM/WebGPU embeddings.

const logger = createLogger('DesktopMain');
// Preference STATE lives in main/logging-preferences.ts (BST-1648 step 4);
// the boot ORDER below is unchanged: controller (initial set) → watchdog →
// log buffer → initializeLogging → applyInitial. The watchdog hook is a
// closure over `mainWatchdogRuntime`, which is constructed a few lines down
// and only ever reached from a later IPC-driven update.
const loggingPreferences = createDesktopLoggingPreferencesController({
  app,
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
const mainProcessStartedAt = new Date();
configureDesktopCommandSessionManager({ resolver: createDatabaseRootResolver(getDatabase) });
logger.debug('Main process started');
const mainLogBuffer = new LogBuffer({ size: 3000 });
// Same counter the first-import side-effect module installed (idempotent).
const mainWebAssemblyCounter = installWebAssemblyCounter();
const processCounterRing = new ProcessCounterRing(PROCESS_COUNTER_RING_CAPACITY);

const processCounterSampler = createProcessCounterSampler({
  counter: mainWebAssemblyCounter,
  getDatabase,
  ring: processCounterRing,
  runScheduledWork: runDesktopScheduledDatabaseWork,
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

async function initializeDesktopDimensionIndexStrategy(): Promise<void> {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let recovered: number;
  try {
    db = await getDatabase();
    if (isDesktopShuttingDown()) {
      return;
    }
    // This process owns the single-instance lock and maintenance triggers have
    // not started. Only here can a persisted `running` build be proven orphaned.
    recovered = await recoverInterruptedDimensionIndexMaintenanceAtStartup(db, {
      now: () => mainProcessStartedAt,
    });
  } catch (error) {
    if (!isDesktopShuttingDown()) {
      throw error;
    }
    logger.info('Dimension index maintenance initialization aborted by shutdown', {
      error: serializeDesktopError(error),
    });
    return;
  }
  if (recovered > 0) {
    logger.info('Recovered interrupted dimension index maintenance at startup', {
      recovered,
    });
  }
  if (isDesktopShuttingDown()) {
    return;
  }
  try {
    const capabilities = await probeDimensionIndexRuntimeCapabilities({
      db,
      initialMemoryBytes: null,
      now: () => new Date(),
      scratchTableName: `brainstrike_hnsw_probe_${randomUUID().replaceAll('-', '_')}`,
    });
    desktopDimensionIndexStrategy = 'regular';
    logger.info('Dimension index maintenance capability probe completed', {
      hnswIndexBuild: capabilities.hnswIndexBuild,
      maintenanceSettings: capabilities.maintenanceSettings,
      progressReporting: capabilities.progressReporting,
      strategy: desktopDimensionIndexStrategy,
    });
  } catch (error) {
    desktopDimensionIndexStrategy = null;
    // The probe runs concurrently with the app lifecycle (it no longer gates
    // window creation), so a short-lived session can tear the DB down while
    // the probe is mid-flight. That rejection is an EXPECTED teardown (see
    // desktop-shutdown-state), not a capability failure — log it quietly.
    if (isDesktopShuttingDown()) {
      logger.info('Dimension index maintenance capability probe aborted by shutdown', { error });
    } else {
      logger.error('Dimension index maintenance capability probe failed', { error });
    }
  }
}

let stopAssistantServer: null | (() => Promise<void>) = null;
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
// `unregisterForgeIpc` below is the deliberate exception: it is torn down
// inside the graceful shutdown's 'forge' step, BEFORE 'database-drain'.
const ipcDisposers = createDisposerStack();
// Per-window: the embedded browser pane's IPC is bound to the CURRENT visible
// window (rebound on a macOS dock-reopen), so its handle is kept to retire the
// previous binding before the next one is added.
let browserIpcDisposer: DisposerHandle | null = null;
// Flight Recorder P2a Task 3: the durable NDJSON backstop for warn+ records
// from main AND from renderers/hidden hosts over IPC (see
// registerLoggingIpcHandlers' recordDurableLog below). Constructed at
// app-ready when file logging isn't disabled; closed as the last graceful-
// shutdown step so it captures failures from every earlier step.
let errorLogSink: ErrorLogSinkHandle | null = null;
let forgeService: ForgeService | undefined;
let unregisterForgeIpc: (() => void) | undefined;
// BST-1112: cross-workspace git worktree inventory. Constructed and started
// inside `app.whenReady()` (NOT at module scope): its `start()` call performs
// an eager build whose first step reads the database, which in turn spawns a
// `utilityProcess` — an operation Electron rejects before the app is ready.
// Stopped as a graceful-shutdown step, before the `database` step, since its
// `loadRoots` dependency reads from the DB.
let gitInventoryService: GitInventoryService | null = null;
let worktreeService: ReturnType<typeof createWorktreeService> | null = null;
// BST-1164 (W7 T1): the ONE app-lifetime shadow-git SnapshotService.
// Constructed inside `app.whenReady()` (never at module scope — the
// gitInventoryService incident class: a module-scope construction would also
// sit above the single-instance lock). Consumers resolve it LAZILY through
// `() => snapshotService` because the changes IPC handlers register at module
// load, before construction. There is exactly one instance; T2/T3 consume it
// through the injected seams, never by constructing a second service.
let snapshotService: SnapshotService | null = null;
let desktopMaintenanceTriggerGraph: DesktopMaintenanceTriggerGraph | null = null;
let desktopDimensionIndexStrategy: DimensionIndexBuildStrategy | null = null;
let allowImmediateQuit = false;
let gracefulShutdownInFlight = false;
const SIGNAL_SHUTDOWN_TIMEOUT_MS = 5000 as const;
const FACTORY_RESET_RENDERER_READY_TIMEOUT_MS = 30_000 as const;
let completeFactoryResetRendererReplacement: (() => Promise<void>) | null = null;

// One shutdown run's step BODIES, built when the run starts so they capture
// its state. They live here beside the module state they read and clear. The
// keys are sorted, not ordered: the run ORDER, failure isolation, forced-exit
// budget and logs are `main/desktop-graceful-shutdown.ts`'s
// `DESKTOP_SHUTDOWN_STEP_ORDER`, which is where a new step is ordered.
function planDesktopShutdownRun(): DesktopShutdownRunPlan {
  const stopServer = stopAssistantServer;
  let assistantServerDrained = stopServer === null;
  return {
    // The reserved slice: `desktop-graceful-shutdown.ts` runs it after the ordered
    // steps even when the deadline aborted one. `database-drain` has already
    // stopped what issues database work, so this is the host close alone.
    closeDatabase: () => closeDatabase(),
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
    isAssistantServerDrained: () => assistantServerDrained,
    steps: {
      'assistant-server': async () => {
        // Start every process reaper in the same settlement batch as the server
        // drain. A hung or rejected drain must never prevent shell, terminal,
        // command-session, or LSP cleanup from being attempted.
        const [stopResult, ...cleanupResults] = await Promise.allSettled([
          Promise.resolve().then(() => stopServer?.()),
          Promise.resolve().then(disposeLiveChildProcesses),
          Promise.resolve().then(disposeAllTerminals),
          Promise.resolve().then(disposeDesktopCommandSessions),
          Promise.resolve().then(disposeLspServers),
        ]);
        if (stopResult?.status === 'fulfilled') {
          stopAssistantServer = null;
          assistantServerDrained = true;
        }
        const causes = [stopResult, ...cleanupResults].flatMap((result) =>
          result?.status === 'rejected' ? [result.reason] : []
        );
        if (causes.length > 0) {
          throw new AggregateError(causes, 'Assistant server shutdown cleanup failed');
        }
      },
      'chunking-host': async () => {
        await chunkingHostManager.dispose();
      },
      // Stops everything that issues database work. It does NOT close the
      // database: that is `closeDatabase` below, a slice that always runs.
      'database-drain': async () => {
        const maintenance = desktopMaintenanceTriggerGraph;
        maintenance?.stop();
        desktopMaintenanceTriggerGraph = null;
        // Before the idle join: a submitted sample drains; later ticks are no-ops.
        processCounterSampler.stop();
        const triggerClosures = await Promise.allSettled([maintenance?.close()]);
        const triggerErrors: unknown[] = triggerClosures.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        // A failed trigger finalizer cannot skip the independent DB idle join.
        // Admitted SQL remains owned by the work scheduler.
        let databaseDrainFailed = false;
        let databaseDrainError: unknown;
        try {
          await cleanupDesktopLiveSubscriptionsForShutdown();
          await waitForDesktopDatabaseWorkSchedulerIdle();
          await cleanupDesktopLiveSubscriptionsForShutdown();
        } catch (error) {
          databaseDrainFailed = true;
          databaseDrainError = error;
        }
        if (triggerErrors.length > 0) {
          throw new AggregateError(
            databaseDrainFailed ? [...triggerErrors, databaseDrainError] : triggerErrors,
            'Desktop database shutdown cleanup failed'
          );
        }
        if (databaseDrainFailed) {
          throw databaseDrainError;
        }
      },
      'embedding-host': async () => {
        await embeddingHostManager.dispose();
      },
      'file-system': () => applicationIpcDomain.close(),
      // Its own step, deliberately NOT nested inside 'git-inventory':
      // `gitInventoryService.stop()`'s final `await toDispose.disposeAll()` is
      // unguarded, and the shutdown sequence catches a rejection at the step
      // boundary — nesting forge teardown after it would silently skip these
      // three lines on a throwing watcher disposer, leaving `ipcMain` handlers
      // registered and a live `forgeService` heading into 'database-drain'.
      // forge has the same DB dependency as git-inventory (`getDatabase` ->
      // `readForgePrCacheEntry`/`writeForgePrCacheEntry`) but is otherwise
      // unrelated to git-inventory's success, so it gets its own
      // failure-isolated step, BEFORE 'database-drain' for the same reason.
      forge: async () => {
        const service = forgeService;
        // Retire both authorities before any await: watcher invalidations and
        // IPC can no longer enqueue work while stop aborts and drains the
        // operations that were already in flight.
        forgeService = undefined;
        const drain = service?.stop();
        try {
          unregisterForgeIpc?.();
        } finally {
          unregisterForgeIpc = undefined;
          await drain;
        }
      },
      'git-inventory': async () => {
        // Runs BEFORE 'database-drain': this service's `loadRoots` dependency
        // reads the DB `roots` table, so its watchers/in-flight build must
        // be torn down while the database is still available to it.
        if (gitInventoryService) {
          await gitInventoryService.stop();
          gitInventoryService = null;
        }
      },
      'llm-host': async () => {
        await llmHostManager.dispose();
      },
      // Wrapped: the cleanup's optional parameter is the runtime, not a signal.
      'mcp-runtime': () => cleanupMcpRuntimeForShutdown(),
      'native-index': async () => {
        await agentHostMainClient.close();
        await agentHostClientIpc.close();
        await nativeIndexActivation.close();
      },
      'parser-host': async () => {
        await parserHostManager.stop();
      },
      // before-quit postpones Electron's own window close. Join the renderer
      // producers first, while their DB/chunking/assistant dependencies still
      // live. Hidden renderer hosts must retain command listeners until their
      // own stop.
      renderers: () =>
        closeDesktopRenderers(
          BrowserWindow.getAllWindows(),
          (window) =>
            chunkingHostManager.isHostWindow(window) ||
            embeddingHostManager.isHostWindow(window) ||
            llmHostManager.isHostWindow(window)
        ),
    },
  };
}

const gracefulShutdown = createDesktopGracefulShutdown({
  deadlineMs: SIGNAL_SHUTDOWN_TIMEOUT_MS,
  exitProcess: (code) => process.exit(code),
  logger,
  markShuttingDown: markDesktopShuttingDown,
  planRun: planDesktopShutdownRun,
  // Background indexing keeps requesting embedding backfills until its
  // renderer dies, and each request would restart the embedding host that the
  // ordered steps are about to stop. Retire the admission first so host
  // teardown owns its window; the job rows stay durable and resume next launch.
  retireBackgroundAdmission: cancelAllDesktopEmbeddingBackfills,
});

async function handleShutdownSignal(signal: NodeJS.Signals): Promise<void> {
  logger.warn('Received shutdown signal, attempting graceful desktop shutdown', { signal });

  // The graceful run logs and resolves even when cleanup fails, so we always
  // continue to quit the process rather than hanging on a partial shutdown.
  await gracefulShutdown.run('signal', signal);

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

const chunkingHostManager = new ChunkingHostManager();
const parserHostManager = new ParserHostManager();
const embeddingHostManager = new EmbeddingHostManager({ storage });
const llmHostManager = new LlmHostManager();

// Integrity state clears only when a user-confirmed reset completed: a failed
// reset must never mark the database healthy, so the wrapper marks after the
// reset resolves and lets a rejection propagate untouched.
const databaseIntegrity = getDesktopDatabaseIntegrity();

function createDatabaseResetMarkingReplaced(
  reason: 'factory-reset' | 'developer-reset'
): (lease?: ProfileResetLease) => Promise<void> {
  return async (lease) => {
    await resetLocalDatabase(lease);
    databaseIntegrity.markDatabaseReplaced(reason);
  };
}

const handleResetLocal = createDesktopFactoryResetHandler({
  cleanupLiveSubscriptionsForShutdown: cleanupDesktopLiveSubscriptionsForShutdown,
  completeSuccessfulReset: async () => {
    const completeRendererReplacement = completeFactoryResetRendererReplacement;
    if (completeRendererReplacement === null) {
      throw new Error('Factory reset renderer replacement coordinator is unavailable');
    }
    await completeRendererReplacement();
  },
  // The durable NDJSON backstop (Flight Recorder P2a) is a plaintext mirror
  // of `brainstrike_diagnostic_events`, which factory reset already wipes —
  // without this, the mirror would survive inside the preserved `logs`
  // folder while the DB rows it mirrors do not (see desktop-factory-reset.ts).
  errorLogFilePaths: listErrorLogFilePaths(path.join(app.getPath('logs'), ERROR_LOG_FILE_NAME)),
  logger,
  prepareDatabaseProfileReset: () =>
    prepareDatabaseProfileReset({
      retireProfileOwner: () => nativeIndexActivation.destroyAndRetireProfile(),
    }),
  resetLocalDatabase: createDatabaseResetMarkingReplaced('factory-reset'),
  resetPersistentStorageAfterDataDeletion: () => storage.clear(),
  resumeAfterReset: async (outcome) => {
    if (outcome === 'succeeded') {
      await nativeIndexActivation.resume();
    }
    await resumeMcpRuntimeAfterFactoryReset(getDesktopMcpHostRuntime(), outcome);
  },
  runtimes: [
    { name: 'native-index-sources', stop: () => nativeIndexActivation.stopSources() },
    {
      name: 'mcp-runtime',
      stop: async () => {
        const runtime = getDesktopMcpHostRuntime();
        await resetMcpRuntimeForFactoryReset(runtime);
        logger.info('MCP runtime reset cleanup completed', {
          hostCloseReport: runtime.retiredCleanupReport(),
          legacyClientsClosed: true,
          snapshot: runtime.host.snapshot(),
        });
      },
    },
    { name: 'embedding-host', stop: () => embeddingHostManager.stop() },
    { name: 'chunking-host', stop: () => chunkingHostManager.stop() },
    // In-memory diagnostics ring: a factory reset must not carry the previous
    // profile's process samples into the next one.
    {
      name: 'process-counter-ring',
      stop: () => {
        processCounterRing.clear();
        return Promise.resolve();
      },
    },
    { name: 'llm-host', stop: () => llmHostManager.stop() },
    // Reap any shell command the assistant left running so a factory reset is a
    // true fresh start with no orphaned subprocess surviving the wipe.
    {
      name: 'shell-children',
      stop: () => {
        disposeLiveChildProcesses();
        return Promise.resolve();
      },
    },
    // Reap any live terminal pty so a factory reset is a true fresh start with
    // no orphaned interactive shell surviving the wipe.
    {
      name: 'terminals',
      stop: async () => {
        await disposeAllTerminals();
      },
    },
    // Reap persistent assistant command sessions and clear retained output so
    // reset leaves no process or in-memory session inventory behind.
    {
      name: 'command-sessions',
      stop: disposeDesktopCommandSessions,
    },
    // Reap any pooled LSP language-server child processes (report R2) so a
    // factory reset is a true fresh start with no orphaned server surviving.
    {
      name: 'lsp-servers',
      stop: () => disposeLspServers(),
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
  runWithDatabaseResetBarrier: runWithDesktopDatabaseResetBarrier,
  userDataPath: app.getPath('userData'),
  waitForDatabaseWorkSchedulerIdle: waitForDesktopDatabaseWorkSchedulerIdle,
});

// An integrity error cancels running backfills; every other background writer is
// paused by the scheduler gate and the owner-level skips (BST-1870).
ipcDisposers.add(
  'database-integrity-containment',
  startDatabaseIntegrityContainment({
    cancelAllDesktopEmbeddingBackfills,
    integrity: databaseIntegrity,
  })
);
// The visible UI and the embedding host read the state and receive every change;
// the host's claim permit parks on it (BST-1870).
ipcDisposers.add(
  'database-integrity',
  registerDatabaseIntegrityIpcHandlers({ integrity: databaseIntegrity })
);
const desktopDatabaseMaintenanceScheduler = createDesktopDatabaseMaintenanceScheduler({
  getDatabase,
  getSchedulerSnapshot: getDesktopDatabaseWorkSchedulerSnapshot,
  integrity: databaseIntegrity,
  logger,
  runScheduledWork: runDesktopScheduledDatabaseWork,
  // BST-1333: lets the scheduler require SUSTAINED idle before starting an
  // unpreemptable maintenance statement, instead of trusting a single sample.
  subscribeToSchedulerSnapshots: (listener) =>
    getDesktopDatabaseWorkScheduler().subscribe(listener),
});
const desktopDimensionIndexMaintenanceScheduler = createDesktopDimensionIndexMaintenanceScheduler({
  getDatabase,
  getDimensionIndexStrategy: () => desktopDimensionIndexStrategy,
  getPowerSnapshot: () => readDesktopPowerSnapshot(powerMonitor),
  getSchedulerSnapshot: getDesktopDatabaseWorkSchedulerSnapshot,
  integrity: databaseIntegrity,
  logger,
  runScheduledWork: runDesktopScheduledDatabaseWork,
  // The HNSW build cannot be preempted: it starts only after sustained
  // scheduler quiet with no assistant work in flight (database.md).
  subscribeToSchedulerSnapshots: (listener) =>
    getDesktopDatabaseWorkScheduler().subscribe(listener),
});
desktopMaintenanceTriggerGraph = createDesktopMaintenanceTriggerGraph(
  desktopDatabaseMaintenanceScheduler,
  desktopDimensionIndexMaintenanceScheduler
);

ipcDisposers.add(
  'logging',
  registerLoggingIpcHandlers({
    getBufferedLogs: () => mainLogBuffer.getRecords(),
    getState: loggingPreferences.getSettingsPayload,
    ingestBufferedLog: (senderId, record) => {
      mainLogBuffer.push({
        ...record,
        bindings: {
          ...record.bindings,
          forwardedFrom: 'renderer',
          sourceWebContentsId: senderId,
          sourceWindowRole: resolveSourceWindowRole(senderId),
        },
      });
    },
    openDestination: loggingPreferences.openDestination,
    recordDurableLog: (record) => errorLogSink?.recordLogRecord(record),
    selectDestination: loggingPreferences.selectDestination,
    setPreferences: loggingPreferences.applyAndPersist,
  })
);

// Register IPC handlers early to avoid renderer calls racing registration during startup.
const applicationIpcDomain = createApplicationIpcDomain(fileSystem, storage, getSettingsStore, {
  chunkingHostManager,
  embeddingHostManager,
  getDimensionIndexMaintenanceStrategy: () => desktopDimensionIndexStrategy,
  managedWorktreeAuthorizer: async (candidate) => {
    if (worktreeService && (await worktreeService.isManagedWorktreePath(candidate))) {
      return 'authorized';
    }
    const settings = await readWorktreeSettings(storage, app.getPath('home'));
    return isPathWithin(candidate, settings.managedDirectory)
      ? 'managed-but-unauthorized'
      : 'unmanaged';
  },
  onDeleteRootData: (rootId) => nativeRootDataDeletion.deleteRootData(rootId),
  onResetLocal: () => nativeRootDataDeletion.transition(() => handleResetLocal()),
  onStorageChanged: (key) => {
    if (!app.isReady() || isDesktopShuttingDown()) {
      return;
    }
    if (key === VECTOR_PREFERENCES_STORAGE_KEY) {
      // Recall's unpinned device follows the preference; the worker keeps its own until restart.
      embeddingHostManager.resolveDevice();
      return;
    }
    if (key !== NATIVE_INDEX_SETTINGS_KEY) {
      return;
    }
    nativeRootDataDeletion
      .transition(() => nativeIndexActivation.reconfigure())
      .catch((error: unknown) =>
        reportNativeIndexActivationError(
          'Saved native index configuration could not activate',
          error
        )
      );
  },
  onWorkspaceRootGranted: (grantedPath: string) => {
    pendingRootGrantSubscriber?.(grantedPath);
    if (app.isReady() && !isDesktopShuttingDown()) {
      nativeRootDataDeletion
        .transition(() => nativeIndexActivation.reconfigure())
        .catch((error: unknown) =>
          reportNativeIndexActivationError(
            'Mounted native source configuration could not activate',
            error
          )
        );
    }
  },
});
function reportDesktopLegacyImport(attempt: ReturnType<typeof importDesktopLegacySecrets>): void {
  attempt.then(
    (imported) => {
      if (imported.migrated > 0 || imported.alreadyPresent > 0) {
        logger.info('Imported legacy provider secrets into the credential store', imported);
      }
    },
    (error: unknown) => {
      logger.error('Legacy provider secrets could not be imported; the legacy store is kept', {
        error: serializeDesktopError(error),
      });
    }
  );
}
function reportNativeIndexActivationError(message: string, error: unknown): void {
  reportNativeIndexFailure(message, error, isDesktopShuttingDown(), logger);
}
const agentHostPrivateClients = createAgentHostPrivateClients();
const nativeIndexActivation = createNativeIndexActivation({
  agentHostPlatform: {
    onChildReady: (child) => {
      agentHostPrivateClients.attach(child);
      // A host launched while retired entries remained waits to hear about them.
      reportDesktopLegacyImport(importDesktopLegacySecrets({ afterHostLaunch: true }));
    },
    platform: (nativeChildren) => {
      const ledger = createWorktreeLedger(getDatabase);
      const workspace = new DesktopWorkspaceBindingAuthority({
        borrowRoot: (root) =>
          applicationIpcDomain.roots.borrowSourceRootForPath(
            root.path,
            applicationIpcDomain.watches.subscribe.bind(applicationIpcDomain.watches)
          ),
        readRoots: async () => loadWorkspaceRootsFromDatabase(await getDatabase()),
        readWorktree: (id) => ledger.get(id),
      });
      return createDesktopPlatformPort({
        ...productionDesktopCapabilities(
          {
            embeddingHostManager,
            nativeIndexSearch,
            resolveForgeService: () => forgeService ?? null,
            resolveWorktreeService: () => worktreeService,
          },
          async () => {
            const stored = await storage.getItem('permission-policy.v1');
            if (!stored) {
              return;
            }
            const envelope = z
              .object({ state: PlatformPolicySchema.extend({ enforce: z.boolean() }) })
              .parse(JSON.parse(stored));
            const { enforce, ...input } = envelope.state;
            const policy = platformPermissionPolicy(input);
            return { ...policy, yolo: policy.yolo || !enforce };
          },
          undefined,
          workspace,
          // Local recall loads as the embedding host's unpinned query did (BST-1929).
          (signal) => readEmbeddingHostDevice(embeddingHostManager, signal)
        ),
        // BST-1977: app-owned host/stop released Root with the native writer live.
        // Retiring the profile here would wait on this same Core close request.
        closeRootCapabilities: async () => {
          const results = await Promise.allSettled([
            workspace.close(),
            nativeIndexActivation.closeRootCapabilities(),
          ]);
          const failures = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          );
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              'Desktop workspace and native Root retirement failed'
            );
          }
        },
        // ADR-0007: a host thread's admitted local chat model or observer borrows the hidden
        // llm-host (an isolated E2E launch may script it instead of downloading the model).
        localLlm: createMainLlmHostClient(createE2eScriptedLlmHost() ?? llmHostManager),
        // BST-1930 c1: the forked host owns the one MCP runtime; Main serves its stores.
        mcp: createDesktopMcpPlatformCapabilities(getDesktopMcpHostRuntime()),
        // ADR-0017: the host reports its native processes; Main ends them if it dies.
        nativeChildren,
        // Gap 17: the host imports the profile's legacy workspace memory once.
        readLegacyMemory: readMainLegacyMemory,
        // BST-1977: host runs' turns snapshot through legacy turns' one shadow-git owner.
        workspaceSnapshots: () => snapshotService,
      });
    },
    platformModule: resolveBundledSiblingPath(
      'Agent host platform',
      'agent-host-platform-entry.js'
    ),
    // The host owns the profile store Main reads. While the retired safeStorage
    // store still holds entries, the host holds credential use until Main's
    // import over the private client settles.
    platformOptions: async () => {
      const legacyImportPending = await desktopLegacySecretsPending();
      // An isolated E2E launch's egress boundary may stand in for the Codex
      // sign-in issuer on loopback; the host refuses any other origin.
      const e2eCodexIssuer = isElectronE2ETestMode()
        ? process.env['BRAINSTRIKE_E2E_OPENAI_CODEX_ISSUER']
        : undefined;
      return {
        appPaths: {
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          userDataPath: app.getPath('userData'),
        },
        credentialStore: desktopCredentialStoreSelection(),
        // Main loaded the env files; the host gates provider status on rejections.
        ...(desktopEnvLoadResult.failures.length > 0
          ? { envFileFailures: [...desktopEnvLoadResult.failures] }
          : {}),
        ...(legacyImportPending ? { legacyImportPending: true as const } : {}),
        ...(e2eCodexIssuer ? { openAiCodexIssuer: e2eCodexIssuer } : {}),
      };
    },
  },
  application: applicationIpcDomain,
  embedding: embeddingHostManager,
  onError: (operation, error) =>
    reportNativeIndexActivationError(`Native indexing ${operation} failed`, error),
  onReceipt: (receipt) =>
    logger.info('Canonical native scan settled', { receipt, settledAt: new Date().toISOString() }),
  storage,
});
installIndexCallerRead(createNativeCallerRead(nativeIndexActivation.withRead));
// Main's own desktop-origin client: Settings credential writes, provider sign-in
// and subscription verification reach the host, their single owner, through it.
// The host's sign-in pages open through the same validated shell path as the
// shell IPC domain (allow-listed protocols, never an embedded webview).
const agentHostShellOpener = createShellIpcHandlers({ shell });
const agentHostMainClient = createAgentHostMainClient(
  nativeIndexActivation.acquireProfile,
  agentHostPrivateClients.open,
  async (url) => {
    const result = await agentHostShellOpener.openExternal(url);
    if (!result.ok) {
      throw new Error(result.error ?? 'shell.openExternal failed');
    }
  }
);
// Only Main can decrypt the retired safeStorage store; the host writes it.
installDesktopLegacyImporter((input) => agentHostMainClient.request('auth/import-legacy', input));
// The host owns hook trust. Main imports the retired renderer approvals once,
// and no visible client attaches, so no host run is admitted, before it settles.
const desktopHookTrust = createDesktopHookTrust({
  loadRootPaths: async () => loadDesktopRootPaths(await getDatabase()),
  request: (method, params) => agentHostMainClient.request(method, params),
  storage,
});
// Legacy threads run project hooks at the same host-owned trust.
installDesktopHookApprovalReader((root) => desktopHookTrust.approval(root));
// Host threads record their turn snapshots in the host's log, not the ledger;
// the startup snapshot GC keeps their refs while the host lists the thread.
const readHostThreadIds = async (): Promise<ReadonlySet<string>> =>
  new Set(
    (await agentHostMainClient.request('thread/list', {})).threads.map(({ threadId }) => threadId)
  );
const agentHostClientIpc = registerAgentHostClientIpc(async () => {
  const attachment = await nativeIndexActivation.acquireProfile();
  await desktopHookTrust.imported();
  return attachment;
}, agentHostPrivateClients.open);
ipcDisposers.add('agent-host-client', agentHostClientIpc.unregister);
const nativeRootDataDeletion = createNativeRootDataDeletion({
  acquire: () => nativeIndexActivation.acquire(),
  captureOwner: async () => {
    await nativeIndexActivation.getSearchAuthority();
    return nativeIndexActivation.captureAcknowledgedAuthority();
  },
  closeOwner: () => nativeIndexActivation.close(),
  deleteCanonicalRoot: async (mounted) => {
    const { deleteManagedRootData } = await import('@brainstrike/db');
    await deleteManagedRootData(await getDbHostManager().getDatabase(), {
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
ipcDisposers.add('index-search', registerIndexSearchIpcHandlers(nativeIndexSearch));
ipcDisposers.add('main', () => {
  // The graceful filesystem step joins physical retirement. This late ledger
  // entry repeats idempotent bookkeeping and reports any retained cleanup error.
  applicationIpcDomain.close().catch((error: unknown) => {
    logger.error('Application IPC domain cleanup failed during will-quit', { error });
  });
});
ipcDisposers.add('chunking-host', registerChunkingHostIpcHandlers(chunkingHostManager));
ipcDisposers.add('parser-host', registerParserHostIpcHandlers(parserHostManager));
ipcDisposers.add('embedding-host', registerEmbeddingHostIpcHandlers(embeddingHostManager));
ipcDisposers.add('llm-host', registerLlmHostIpcHandlers(llmHostManager));
ipcDisposers.add(
  'desktop-diagnostics',
  registerDesktopDiagnosticsIpcHandlers({
    crashRecovery: {
      getSnapshot: getDesktopCrashRecoverySnapshot,
    },
    database: {
      getDiagnostics: async () => await getDbHostManager().getDiagnostics(),
    },
    databaseIntegrity: {
      getSnapshot: () => databaseIntegrity.getSnapshot(),
    },
    databaseScheduler: {
      getSnapshot: getDesktopDatabaseWorkSchedulerSnapshot,
    },
    embeddingHost: embeddingHostManager,
    indexing: {
      getBackfillsInFlight: async () => {
        const { getDesktopEmbeddingBackfillsInFlight } = await import('./ipc-embedding-backfill');
        return getDesktopEmbeddingBackfillsInFlight();
      },
      getDimensionIndexMaintenanceSnapshot: async () => {
        const { listDimensionIndexMaintenance, listDimensionIndexSuspensions } = await import(
          '@brainstrike/db'
        );
        const db = await getDbHostManager().getDatabase();
        const [maintenance, suspensions] = await Promise.all([
          listDimensionIndexMaintenance(db),
          listDimensionIndexSuspensions(db),
        ]);
        return { maintenance, suspensions };
      },
    },
    llmHost: llmHostManager,
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
    telemetry: {
      getRuntimeMetrics: collectBackgroundRuntimeMetrics,
    },
  })
);
ipcDisposers.add('shell', registerShellIpcHandlers());
ipcDisposers.add('clipboard', registerClipboardIpcHandlers());
ipcDisposers.add('window-focus', registerWindowFocusIpcHandlers());
ipcDisposers.add('file-exports', registerFileExportsIpcHandlers());
// Lazy resolver for the same reason as `resolveSnapshotService` below: this
// registration runs at module load, the ONE snapshot service is constructed
// at app-ready. The checkpoint-undo engine restores from turn-start
// snapshots (BST-1164 T4), so the handlers need the same seams as changes.
ipcDisposers.add(
  'assistant-checkpoint',
  registerAssistantCheckpointIpcHandlers({
    resolveSnapshotService: () => snapshotService,
  })
);
ipcDisposers.add('git', registerGitIpcHandlers());
// `resolveInventoryService` is a LAZY getter on purpose: this registration
// runs at module load, while `gitInventoryService` is only constructed once
// the app is ready (see `createGitInventoryService` below). Capturing the
// value here would pin `null` forever.
ipcDisposers.add(
  'changes',
  registerChangesIpcHandlers(
    createChangesIpcHandlers({
      // T1 injection points (BST-1164): the snapshot-repository factory and the
      // lazy service resolver are THREADED but not yet consumed — T2/T3 consume
      // them here so neither has to edit main.ts. Lazy for the same reason as
      // `resolveInventoryService` below.
      createSnapshotRepository,
      // BST-1977: host threads' agent-run changesets resolve from the host's log.
      hostThreadTurns: createHostThreadTurns({
        listThreads: readHostThreadIds,
        readRows: async (threadId, fromSeq) =>
          (await agentHostMainClient.request('thread/read', { fromSeq, threadId })).rows,
      }),
      resolveInventoryService: () => gitInventoryService,
      resolveSnapshotService: () => snapshotService,
    })
  )
);
ipcDisposers.add(
  'worktrees',
  registerWorktreesIpcHandlers(
    createWorktreesIpcHandlers({
      readSettings: () => readWorktreeSettings(storage, app.getPath('home')),
      resolveService: () => worktreeService,
      // Apply BST-1342 containment at save time so the user learns immediately,
      // rather than only when a worktree create later targets the saved path.
      writeSettings: (next) =>
        writeWorktreeSettings(storage, app.getPath('home'), next, async () => {
          const roots = await loadWorkspaceRootsFromDatabase(await getDatabase());
          return roots.map((root) => root.path);
        }),
    })
  )
);
ipcDisposers.add('hooks', registerHooksIpcHandlers(desktopHookTrust));
ipcDisposers.add('context-files', registerContextFilesIpcHandlers());
ipcDisposers.add('skills', registerSkillsIpcHandlers());
ipcDisposers.add('user-commands', registerUserCommandsIpcHandlers());
ipcDisposers.add('user-personas', registerUserPersonasIpcHandlers());
ipcDisposers.add('terminal', registerTerminalIpc());
ipcDisposers.add('notes-vault', registerNotesVaultIpc(storage));

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

const singleInstanceLockAcquired = isElectronE2ETestMode()
  ? true
  : typeof app.requestSingleInstanceLock === 'function'
    ? app.requestSingleInstanceLock()
    : true;

if (singleInstanceLockAcquired) {
  const e2eTestMode = isElectronE2ETestMode();
  if (e2eTestMode) {
    // The loaded foreground-latency benchmark times main-process operations (BST-1925).
    installE2eForegroundLatencyProbes();
  }

  const workspaceOpenQueue = createWorkspaceOpenQueue(DESKTOP_IPC_CHANNELS.workspace.openPath);

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

  completeFactoryResetRendererReplacement = async () => {
    const visibleWindows = BrowserWindow.getAllWindows().filter(
      (window) =>
        !(
          chunkingHostManager.isHostWindow(window) ||
          embeddingHostManager.isHostWindow(window) ||
          llmHostManager.isHostWindow(window)
        )
    );
    await factoryResetRendererReplacement.replace(visibleWindows);
  };

  // macOS delivers this before `whenReady` (Dock drop, "Open With", a click in
  // the Dock's recent-documents list that `app.addRecentDocument` populates),
  // so the listener is registered at module scope and the queue holds the
  // request until a renderer is listening. Registered in E2E mode too — the
  // desktop e2e drives it with `app.emit('open-file', …)`, which is the only
  // way this entry point is observable end to end.
  app.on('open-file', (event, openedPath) => {
    event.preventDefault();
    if (isDesktopShuttingDown()) {
      return;
    }
    enqueueFolderCandidates(
      workspaceOpenQueue,
      filterDirectoryOpenCandidates([openedPath], 'open-file'),
      'open-file'
    );
  });

  // REMOVED: enable-gpu-rasterization + enable-zero-copy
  // These push rasterization onto the same GPU command queue that ONNX/Dawn
  // uses for WebGPU inference. Under sustained background embedding load,
  // the Metal command queue race causes a Dawn CHECK() → SIGTRAP at ~4 min.

  // Prevent macOS from deprioritizing the renderer's GPU context when the
  // window is occluded (behind another window). Without this, the GPU process
  // may starve WebGPU command submissions after ~4 minutes.
  app.commandLine.appendSwitch('disable-features', DISABLED_CHROMIUM_FEATURES.join(','));

  if (!e2eTestMode) {
    // Honest coverage note (BST-1393 ruling L3): this listener is registered
    // only in non-e2e mode, and E2E cannot launch a second process against
    // the harness's app. Its argv parse is covered by folder-argv.test.ts and
    // its delivery path is the SAME queue + channel the open-file e2e
    // exercises end to end. No e2e is invented for it.
    app.on('second-instance', (_event, secondInstanceArgv, workingDirectory) => {
      if (isDesktopShuttingDown()) {
        return;
      }
      enqueueFolderCandidates(
        workspaceOpenQueue,
        filterDirectoryOpenCandidates(
          resolveFolderCandidatesFromArgv({
            appEntryPath: MAIN_ENTRY_PATH,
            appPath: app.getAppPath(),
            argv: secondInstanceArgv,
            isPackaged: app.isPackaged,
            workingDirectory,
          }),
          'second-instance'
        ),
        'second-instance'
      );

      const existingWindow =
        BrowserWindow.getAllWindows().find(
          (window) =>
            !(
              embeddingHostManager.isHostWindow(window) ||
              chunkingHostManager.isHostWindow(window) ||
              llmHostManager.isHostWindow(window)
            )
        ) ?? null;
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
  }

  // Push one payload to every live renderer window (ipc-mcp precedent): the
  // git-awareness pushes can land in any window.
  const broadcastToRenderers = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue;
      }
      window.webContents.send(channel, payload);
    }
  };

  app.whenReady().then(async () => {
    registerShutdownSignalHandlers();
    try {
      emitBootMeasurementMark('app-ready', app.isPackaged);
      // One-time import of the retired safeStorage entries, decrypted here and
      // written by the host once it is ready. Credential use in Main and the
      // host waits for it; a failure keeps the legacy copy and reports itself.
      reportDesktopLegacyImport(importDesktopLegacySecrets());
      // Validated up front (before assistant-server startup) so a malformed
      // value fails loudly and clearly here, instead of being caught by the
      // assistant-server try/catch below and mislabeled as an assistant
      // startup failure.
      const quitAfterBootMeasurement = shouldQuitAfterBootMeasurement(app.isPackaged);
      logger.debug('App ready, starting initialization...');

      const launchMode = resolveDesktopRendererLaunchMode({
        argv: process.argv,
        isPackaged: app.isPackaged,
        isTestMode: e2eTestMode,
      });
      logger.debug('Resolved desktop launch mode', { launchMode });

      // The ONE renderer target for this process (BST-1641). The visible
      // window (`create-window.ts`) and the hidden hosts
      // (`renderer-host-lifecycle.ts`) load the document it names, and the
      // IPC sender-frame allowlist that every `registerAuthorizedInvoke`
      // channel checks `event.senderFrame.url` against is derived from this
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
      const reportInitialNativeFailure = createNativeStartupFailureReporter((error) =>
        reportNativeIndexActivationError('Native index activation unavailable', error)
      );
      void nativeIndexActivation.acquire().catch(reportInitialNativeFailure);
      const nativeReaderStartup = observeNativeReaderStartup(
        nativeIndexActivation.acquireRead(),
        reportInitialNativeFailure
      );
      logger.debug('Configured desktop renderer target', { rendererTarget });

      // Register the root-validated `brainstrike-asset://` protocol now that the
      // app is ready (protocol.handle requires ready). The resolver validates
      // renderer-supplied paths against the DB `roots` table — the SAME source
      // the git/read/search tools use — resolving the DB lazily per request.
      registerAssetProtocol(createDatabaseRootResolver(getDatabase));

      // Static Canvas sandbox shell (BST-1173); no DB dependency, serves one
      // reviewed document with its own CSP header (see canvas-protocol.ts).
      registerCanvasProtocol();

      // Per-mount MCP App sandbox shells (BST-1572): the renderer registers
      // each shell over the visible-UI `mcp:apps:prepareShell` IPC and this
      // handler serves it on its own origin with header-delivered policies.
      registerMcpAppShellProtocol(getMcpAppShellRegistry());

      // BST-1112 / BST-1391 / BST-1161: the ONE git inventory, forge, and
      // worktree services (+ their renderer pushes) — constructed HERE, inside
      // app.whenReady(), never at module scope (main/git-awareness-lifecycle.ts
      // carries the full rationale). The module-scope slots below are what
      // graceful shutdown's 'git-inventory' and 'forge' steps tear down.
      const gitAwareness = startGitAwarenessLifecycle({
        broadcast: broadcastToRenderers,
        getDatabase,
        homePath: app.getPath('home'),
        logger,
        storage,
      });
      forgeService = gitAwareness.forgeService;
      unregisterForgeIpc = gitAwareness.unregisterForgeIpc;
      gitInventoryService = gitAwareness.gitInventoryService;
      worktreeService = gitAwareness.worktreeService;

      // BST-1164 (W7 T1): shadow-git snapshot backbone. Constructed HERE,
      // inside app.whenReady() — `app.getPath('userData')` is the storage
      // contract (`userData/snapshots/<rootId>/git`), and the factory-reset
      // wholesale userData wipe is what covers it (pinned by
      // desktop-factory-reset.test.ts). Same wiring posture as
      // GitInventoryService above: ONE instance, never at module scope.
      const snapshotsBaseDir = path.join(app.getPath('userData'), 'snapshots');
      const constructedSnapshotService = createSnapshotService({
        runner: execFileSnapshotGitRunner,
        snapshotsBaseDir,
      });
      snapshotService = constructedSnapshotService;
      startSnapshotStartupMaintenance({
        getDatabase,
        logger,
        mainProcessStartedAt,
        readHostThreadIds,
        snapshotService: constructedSnapshotService,
        snapshotsBaseDir,
      });

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
      // the single credential writer. Its `auth/clear` also drops the sign-in
      // engine's in-memory rotated-token overlay (BST-1356) and the host's MCP
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
              result: desktopEnvLoadResult,
              userDataPath: app.getPath('userData'),
            }),
        })
      );
      // Provider sign-in (BST-1355/1356) runs in the host's one OAuth engine,
      // the only refresher; a second engine would replay a rotating refresh
      // token. Main forwards the visible window's calls over its private client.
      ipcDisposers.add(
        'provider-auth',
        registerProviderAuthIpcHandlers({
          auth: {
            cancel: (provider) => agentHostMainClient.request('auth/cancel', { provider }),
            connect: (provider, method) =>
              agentHostMainClient.request('auth/connect', {
                provider,
                ...(method === undefined ? {} : { method }),
              }),
            disconnect: (provider) => agentHostMainClient.request('auth/disconnect', { provider }),
            status: (provider) => agentHostMainClient.request('auth/status', { provider }),
          },
        })
      );
      ipcDisposers.add('agent', registerAgentIpcHandlers());
      ipcDisposers.add(
        'mcp',
        registerMcpIpcHandlers({
          runtime: getDesktopMcpHostRuntime(),
          settingsStore: getSettingsStore,
        })
      );
      ipcDisposers.add('runtime', registerRuntimeIpcHandlers());
      logger.debug('Ready-dependent IPC handlers registered successfully');
      // Kick off DB initialization (utilityProcess spawn + migrations) and the
      // dimension-index capability probe WITHOUT blocking window creation: the
      // visible window needs none of it to paint, and renderer DB calls
      // coalesce on the same getDatabase() promise. Only the maintenance
      // schedulers wait for the probe (they consume the selected strategy).
      // The capability probe catches its own failures. The outer catch keeps
      // startup recovery and scheduler start failures visible and handled.
      void initializeDesktopDimensionIndexStrategy()
        .then(async () => {
          if (isDesktopShuttingDown()) {
            return;
          }
          const maintenance = desktopMaintenanceTriggerGraph;
          if (maintenance) {
            await maintenance.start();
            logger.debug('Scheduled desktop maintenance triggers started');
          }
        })
        .catch((error) => {
          logger.error('Failed to start desktop maintenance schedulers', {
            error: serializeDesktopError(error),
          });
        });

      // Setup security before creating windows
      setupSecurity();
      logger.debug('Security setup complete');

      // NOTE: Embedding worker is started in renderer process, not here in main process.
      // Main process cannot run transformers.js with Web Workers (they don't exist in Node.js).
      // See apps/desktop/src/renderer/main.tsx for renderer-side worker initialization.

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
                // the user is looking. Hidden host windows are never focused and
                // never register the renderer listener, so this is a no-op there.
                const targetWindow =
                  browserWindow instanceof BrowserWindow
                    ? browserWindow
                    : BrowserWindow.getFocusedWindow();
                if (!targetWindow || targetWindow.isDestroyed()) {
                  return;
                }
                targetWindow.webContents.send(DESKTOP_IPC_CHANNELS.commandPalette.open);
              },
              label: 'Command Palette…',
            },
            {
              accelerator: process.platform === 'darwin' ? 'Cmd+P' : 'Ctrl+P',
              click: (_menuItem, browserWindow) => {
                // Same focused-window routing as the command palette; a no-op on
                // hidden host windows (never focused, never register the listener).
                const targetWindow =
                  browserWindow instanceof BrowserWindow
                    ? browserWindow
                    : BrowserWindow.getFocusedWindow();
                if (!targetWindow || targetWindow.isDestroyed()) {
                  return;
                }
                targetWindow.webContents.send(DESKTOP_IPC_CHANNELS.quickOpen.open);
              },
              label: 'Quick Open…',
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
                noteNextWindowReload(targetWindow, {
                  reason: 'menu-reload',
                  source: 'main',
                });
                targetWindow.webContents.reload();
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
                try {
                  // BST-1330: same drains as shutdown/factory reset — a bare
                  // resetLocalDatabase() could race in-flight live refreshes.
                  // Join native producers, readers, and writer before resetting this profile.
                  await nativeRootDataDeletion.transition(async () => {
                    await nativeIndexActivation.stopSources();
                    const developerProfileResetLease = await prepareDatabaseProfileReset({
                      retireProfileOwner: () => nativeIndexActivation.destroyAndRetireProfile(),
                    });
                    try {
                      await resetDesktopDatabaseProfile({
                        cleanupLiveSubscriptionsForShutdown:
                          cleanupDesktopLiveSubscriptionsForShutdown,
                        resetLocalDatabase: () =>
                          createDatabaseResetMarkingReplaced('developer-reset')(
                            developerProfileResetLease
                          ),
                        runWithDatabaseResetBarrier: runWithDesktopDatabaseResetBarrier,
                        waitForDatabaseWorkSchedulerIdle: waitForDesktopDatabaseWorkSchedulerIdle,
                      });
                    } finally {
                      await developerProfileResetLease.release();
                    }
                    await nativeIndexActivation.resume();
                  });
                  await dialog.showMessageBox({
                    buttons: ['OK'],
                    message: 'Local database has been reset. The app will reload.',
                    title: 'Database Reset',
                    type: 'info',
                  });
                  for (const win of BrowserWindow.getAllWindows()) {
                    noteNextWindowReload(win, {
                      reason: 'developer-reset-local-database',
                      source: 'main',
                    });
                    win.webContents.reloadIgnoringCache();
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  dialog.showErrorBox(
                    'Reset Failed',
                    `The local database was not reset: ${message}\n\nIf background indexing kept the database busy, retry after it settles (or use Factory Reset in Settings, which stops background work first).`
                  );
                } finally {
                  developerDatabaseResetInFlight = false;
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
        targetWindow.webContents.send(channel, payload);
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

      // Start local data stream server for desktop assistant-ui
      let assistantUrl = '';
      let assistantAuthToken: string | undefined;
      let assistantStartupError: string | undefined;
      try {
        const { url, stop, authToken } = await startAssistantServer(undefined, {
          deprecatedEnvVars: deprecatedEnvVarReports,
          embeddingHostManager,
          envFileFailures: desktopEnvLoadResult.failures,
          llmHostManager,
          nativeIndexSearch,
          // Subscription freshness through the host's one refresher; no token returns.
          providerVerificationService: createProviderVerificationService({
            readCredential: readMainVerificationCredential,
            verifySubscriptionSession: (provider) =>
              agentHostMainClient.request('auth/verify', { provider }),
          }),
          resolveForgeService: () => forgeService ?? null,
          resolveWorktreeService: () => worktreeService,
          // T1 injection point (BST-1164): the run-persistence seam's snapshot
          // deps — threaded, not yet consumed (T2's turn-boundary triggers
          // consume them without editing main.ts).
          snapshots: {
            createRepository: createSnapshotRepository,
            service: constructedSnapshotService,
          },
        });
        assistantUrl = url;
        assistantAuthToken = authToken;
        stopAssistantServer = stop;
        // Emitted here (one microtask after the server's listen callback
        // resolves) rather than inside startAssistantServer's listen callback:
        // that promise has no reject path, so anything throwable inside the
        // callback would wedge the await above instead of failing loudly.
        emitBootMeasurementMark('assistant-listening', app.isPackaged);
        logger.debug(`Assistant server started at ${assistantUrl}`);
        if (quitAfterBootMeasurement) {
          app.quit();
          return;
        }
      } catch (err) {
        // Captured and surfaced to the renderer via assistant:get-auth — the
        // availability probe presents it as an error state instead of the app
        // silently booting with a dead assistant (BST-574).
        assistantStartupError = `Assistant server failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`;
        logger.error('Failed to start assistant server:', err);
      }

      ipcDisposers.add(
        'main-platform',
        registerMainPlatformIpcHandlers({
          getAssistantAuth: () => {
            if (assistantUrl && assistantAuthToken) {
              return { token: assistantAuthToken, url: assistantUrl };
            }
            if (assistantStartupError) {
              return { startupError: assistantStartupError };
            }
            return null;
          },
          getAssistantUrl: () => assistantUrl,
          getPowerSnapshot: () => readDesktopPowerSnapshot(powerMonitor),
          noteNextWindowReload,
        })
      );

      const createMainWindow = async () => {
        // Store is guaranteed to exist after app.whenReady()
        const store = getSettingsStore();
        if (!store) {
          throw new Error('Settings store unavailable after app.ready - this should never happen');
        }
        const storedWindowState = readStoredWindowState(store);
        const win = await createWindow({ windowState: storedWindowState });
        // app.on('activate') recreates this window; dispose the persistence
        // listeners + debounce timer on close so they don't accumulate per window.
        const disposeWindowStatePersistence = registerWindowStatePersistence(win, store);
        win.once('closed', disposeWindowStatePersistence);
        // Between `win.close()` being initiated and the webContents actually being
        // destroyed, `isDestroyed()` still reports `false` — so without this, a
        // request enqueued in that same tick would be spliced out of `pending` and
        // `send` into a dying webContents (lost, or an uncaught "Object has been
        // destroyed" escaping through `enqueue`). Detaching explicitly on `closed`
        // removes that gap instead of leaving it an emergent property of
        // `isDestroyed()` timing; `activate`'s later `createMainWindow()` call
        // re-attaches to the new window through the same wiring above.
        win.once('closed', () => {
          workspaceOpenQueue.detach();
        });

        // `createWindow`'s `loadFile`/`loadURL` call RESOLVES at `did-finish-load`
        // (Electron's own contract), so by the time `win` exists here the initial
        // load's main-frame document has already finished — a listener registered
        // only AFTER this point would never see THAT particular event. Attach is
        // gated on TWO independent conditions below (`loadFinished` AND
        // `rendererReady`), each with its own catch-up path, so neither being
        // already-true by the time this code runs is a problem.
        // Wired HERE, inside `createMainWindow`, rather than at each call site, so
        // the SAME attach point serves the initial launch and every
        // `app.on('activate')` recreation — macOS's Dock-drop path with no window
        // open is the primary way `open-file` arrives, and a window built without
        // this wiring would strand the queue's target forever (BST-1393 L3 review).
        let loadFinished = false;
        // `did-finish-load` alone is NOT proof the renderer can receive a
        // delivery: it fires when the DOCUMENT finishes loading, before React
        // has mounted `WorkspaceConnectHost` and that component's passive
        // `useEffect` has subscribed via `onOpenPath`. A flush in that gap
        // sends into a renderer with no `ipcRenderer.on` listener, and
        // Electron does not retain or replay the event — silent loss, the
        // exact failure class this queue exists to prevent. `rendererReady`
        // is the renderer's own explicit ack (`notifyOpenPathReady`, sent the
        // instant `WorkspaceConnectHost` subscribes) — attach requires BOTH.
        let rendererReady = false;
        const attachWorkspaceOpenQueue = () => {
          workspaceOpenQueue.attach({
            isDestroyed: () => win.webContents.isDestroyed(),
            send: (channel, payload) => {
              win.webContents.send(channel, payload);
            },
          });
        };
        const maybeAttachWorkspaceOpenQueue = () => {
          if (loadFinished && rendererReady) {
            attachWorkspaceOpenQueue();
          }
        };
        // A reload/navigation destroys the renderer's `WorkspaceConnectHost`
        // subscription before the new document re-mounts it; detaching on
        // `did-start-loading` stops mid-reload requests from being sent into a
        // page with no listener (they buffer instead, and the matching
        // re-attach below delivers them once loading settles again).
        // `loadFinished` resets here UNCONDITIONALLY (any frame, including a
        // subframe) — fail-safe: a request enqueued mid-load would be lost
        // into a possibly-reloading page anyway, and the paired
        // `did-stop-loading` below self-heals it regardless of which frame
        // navigated.
        //
        // `rendererReady` is deliberately NOT reset here — see
        // `did-start-navigation` below for why resetting it on EVERY
        // `did-start-loading` is a second Critical bug, not a fix (PR #2682
        // re-review).
        win.webContents.on('did-start-loading', () => {
          loadFinished = false;
          workspaceOpenQueue.detach();
        });
        // `rendererReady` resets ONLY on a real MAIN-FRAME navigation that
        // replaces the current document (`isMainFrame && !isSameDocument` — the
        // same guard `browser-pane-host.ts`'s `onHostNavigation` already uses
        // for an identical "did the top-level document just get replaced?"
        // question). This is deliberately a DIFFERENT, narrower event than
        // `did-start-loading` above: that one is WebContents-level and fires
        // for ANY frame, including the canvas surface's `<iframe>`
        // (`canvas-frame.tsx`) whose `src` changes with the nonce every time
        // an artifact opens or re-keys. `WorkspaceConnectHost`'s ready-ping
        // effect depends only on `[connectPath]`, so it NEVER re-fires for a
        // subframe navigation — resetting `rendererReady` on
        // `did-start-loading` (as an earlier version of this fix did) would
        // clear it on a canvas-artifact open and nothing would ever set it
        // back: `did-stop-loading` would restore `loadFinished`, but with no
        // second ready ping ever coming, the queue would stay permanently
        // detached — the ORIGINAL Critical 2 bug, reproduced through the new
        // flag instead of the old attach listener. A subframe navigation
        // (`isMainFrame === false`) and a same-document one (`isSameDocument`,
        // e.g. a hash change or `pushState`) both leave the existing
        // `WorkspaceConnectHost` subscription — and its already-sent ready
        // ping — intact, so neither should reset readiness.
        win.webContents.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) {
            rendererReady = false;
          }
        });
        // `did-stop-loading`, NOT `did-finish-load`: the latter is main-frame
        // ONLY (Electron guards `WebContents::DidFinishLoad` on
        // `!render_frame_host->GetParent()`; a subframe's completion fires
        // `did-frame-finish-load` instead), while `did-start-loading` above is
        // WebContents-level and fires for ANY frame, including `<iframe>`
        // navigations (e.g. the canvas surface's artifact frame). Pairing
        // `did-start-loading` with `did-finish-load` is asymmetric: a
        // subframe-only load would detach with nothing ever re-attaching for
        // the lifetime of the window. `did-stop-loading` is documented as the
        // WebContents-level counterpart of `did-start-loading` — it always
        // fires, for main-frame and subframe loads alike, keeping the pair
        // symmetric (BST-1393 PR #2682 review).
        win.webContents.on('did-stop-loading', () => {
          loadFinished = true;
          maybeAttachWorkspaceOpenQueue();
        });
        // Renderer→main ready ping (`WorkspaceConnectHost`, immediately after
        // it subscribes via `onOpenPath`). The channel itself is registered
        // ONCE, globally, by `workspace-open-ready-ipc.ts` (see the module
        // comment above `workspaceOpenReadyCallbacksByWebContentsId`) — this
        // just plugs THIS window's callback into that shared dispatch map,
        // keyed by `webContents.id` so a ping from a different window (or a
        // stale one from a previous, now-destroyed window, after `activate`
        // recreates it) never attaches this one prematurely. Removed on
        // `closed` so the map doesn't accumulate entries across recreations.
        // Captured NOW, not read inside the `closed` handler: by the time
        // `closed` fires the WebContents is destroyed and `win.webContents`
        // GETTER ACCESS throws "Object has been destroyed" — an uncaught
        // main-process exception on every window close (caught live by the
        // BST-1393 L5 e2e run, where it surfaced during every teardown).
        const workspaceOpenReadyWebContentsId = win.webContents.id;
        workspaceOpenReadyCallbacksByWebContentsId.set(workspaceOpenReadyWebContentsId, () => {
          rendererReady = true;
          maybeAttachWorkspaceOpenQueue();
        });
        win.once('closed', () => {
          workspaceOpenReadyCallbacksByWebContentsId.delete(workspaceOpenReadyWebContentsId);
        });
        // LOAD-BEARING: this whole block, from the `did-start-loading`
        // registration above through the `isLoading()` check below, MUST stay
        // one synchronous run with NO `await` between any of the statements.
        // Node/Electron main is single-threaded, so as written nothing can
        // interleave; an inserted `await` would let a real `did-stop-loading`
        // (or ready ping) land between a registration and this check, silently
        // re-opening Critical 1 (the initial attach never fires again) in a
        // way no test can express — this is a property of the CALLER's code
        // shape, not something a mock can pin.
        if (!win.webContents.isLoading()) {
          loadFinished = true;
          // `rendererReady` is still false here — WorkspaceConnectHost's
          // effect has not run yet. This just catches up `loadFinished`;
          // `maybeAttachWorkspaceOpenQueue` stays a no-op until the ready
          // ping arrives, which is the correct order for a fresh window.
          maybeAttachWorkspaceOpenQueue();
        }

        // Embedded browser pane (BST-1174): each window owns its OWN pane host
        // + IPC registration, so a macOS close→dock-reopen cycle (which calls
        // createMainWindow again without quitting) rebinds the pane to the new
        // window instead of leaving `window.browser` calls hitting a disposed
        // host. The manager attaches views to THIS window's contentView.
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
        return win;
      };

      const broadcastPowerState = (state: 'resume' | 'suspend') => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed()) {
            continue;
          }
          window.webContents.send(DESKTOP_IPC_CHANNELS.runtime.powerState, state);
        }
      };
      let pendingPowerResumeTimer: ReturnType<typeof setTimeout> | null = null;
      const clearPendingPowerResume = () => {
        if (pendingPowerResumeTimer === null) {
          return;
        }
        clearTimeout(pendingPowerResumeTimer);
        pendingPowerResumeTimer = null;
      };
      const schedulePowerResume = () => {
        clearPendingPowerResume();
        pendingPowerResumeTimer = setTimeout(() => {
          pendingPowerResumeTimer = null;
          broadcastPowerState('resume');
        }, 2000);
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
            backgroundRuntimeMetrics: collectBackgroundRuntimeMetrics(),
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
      const mainWindow = await startMainWatchdogBeforeWindow(
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
        () => {
          logger.debug('Creating main window...');
          return createInitialWindowAfterNativeReader(
            nativeReaderStartup,
            createMainWindow,
            (outcome) =>
              logger.info('Initial native reader startup settled before visible renderer load', {
                kind: outcome.kind,
              }),
            isDesktopShuttingDown
          );
        }
      );
      if (!mainWindow) {
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

      // Power state monitoring: gracefully pause/resume heavy subsystems on sleep/wake
      powerMonitor.on('suspend', () => {
        runMainWatchdogPowerTransition(mainWatchdogRuntime, 'suspend', () => {
          logger.info('power:suspend');
          clearPendingPowerResume();
          broadcastPowerState('suspend');
        });
      });

      powerMonitor.on('resume', () => {
        runMainWatchdogPowerTransition(mainWatchdogRuntime, 'resume', () => {
          logger.info('power:resume');
          // Delay to let OS settle (GPU re-init, network reconnect)
          schedulePowerResume();
        });
      });

      // Lock-screen invalidates GPU contexts on macOS (WindowServer reclaims
      // Metal contexts for the login window). Broadcast the same power state
      // events as suspend/resume so renderers can pause GPU keep-alive timers
      // and avoid submitting commands to stale devices.
      powerMonitor.on('lock-screen', () => {
        logger.info('power:lock-screen');
        clearPendingPowerResume();
        broadcastPowerState('suspend');
      });
      powerMonitor.on('unlock-screen', () => {
        logger.info('power:unlock-screen');
        // Delay to let GPU contexts re-initialize after WindowServer hands
        // back the display, matching the resume delay.
        schedulePowerResume();
      });

      // Window focus/blur: throttle IPC traffic when backgrounded
      mainWindow.on('blur', () => {
        logger.info('window:blur');
        setBackgrounded(true);
      });
      mainWindow.on('focus', () => {
        logger.info('window:focus');
        setBackgrounded(false);
      });

      app.on('activate', async () => {
        if (isDesktopShuttingDown()) {
          return;
        }
        const hasVisibleWindow = BrowserWindow.getAllWindows().some(
          (window) =>
            !(
              embeddingHostManager.isHostWindow(window) ||
              chunkingHostManager.isHostWindow(window) ||
              llmHostManager.isHostWindow(window)
            )
        );
        if (!hasVisibleWindow) {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
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
      await gracefulShutdown.run('before-quit', 'before-quit');
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
  // handlers registered. Terminal's disposer also reaps every live pty and
  // notes-vault's stops every live watcher.
  for (const failure of ipcDisposers.disposeAll()) {
    logger.error('IPC domain disposer failed during will-quit', {
      error: failure.error,
      label: failure.label,
    });
  }
  worktreeService = null;
  removeLogBufferListener();
});

export { createWindow, registerIpcHandlers, setupSecurity };

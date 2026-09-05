import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { detectDeprecatedProviderEnvVars } from '@brainstrike/assistant-contract/provider-metadata';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import {
  addLogListener,
  applyLoggingPreferences,
  createDefaultLoggingPreferences,
  createLogger,
  type FileTransportConfig,
  type InitializeLoggingOptions,
  initializeLogging,
  LogBuffer,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/logging';
import { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { ChangesInvalidationEvent, ForgePrUpdatedEvent } from '@brainstrike/types';
import { app, BrowserWindow, dialog, Menu, powerMonitor, shell } from 'electron';
import ElectronStore from 'electron-store';
import { configureAgentDevtoolsCommandLine } from './agent-devtools-config';
import { buildFileMenuTemplate } from './application-file-menu';
import { registerAssetProtocol } from './asset-protocol';
import { startAssistantServer } from './assistant-server';
import {
  configureDesktopCommandSessionManager,
  disposeDesktopCommandSessions,
} from './assistant-server/command-session-manager';
import type { EditCheckpointDatabase } from './assistant-server/edit-checkpoint-journal';
import { disposeLiveChildProcesses } from './assistant-server/execute-command-tool';
import { execFileGhRunner } from './assistant-server/forge-gh-client';
import { createForgeService, type ForgeService } from './assistant-server/forge-service';
import {
  createGitInventoryService,
  type GitInventoryService,
} from './assistant-server/git-inventory-service';
import { disposeLspServers } from './assistant-server/lsp-diagnostics';
import { clearReadWorkspaceFileCursorRegistry } from './assistant-server/read-workspace-file-cursor-registry';
import { recordDesktopAssistantRunEvent } from './assistant-server/run-persistence';
import { execFileSnapshotGitRunner } from './assistant-server/snapshot-git';
import { createSnapshotRepository } from './assistant-server/snapshot-repository';
import { createSnapshotService, type SnapshotService } from './assistant-server/snapshot-service';
import { runSnapshotStartupGc } from './assistant-server/snapshot-startup-gc';
import { reapOrphanedThreadRuns } from './assistant-server/thread-run-startup-reaper';
import { loadWorkspaceRootsFromDatabase } from './assistant-server/workspace-roots';
import { isPathWithin } from './assistant-server/worktree-paths';
import { createWorktreeService } from './assistant-server/worktree-service';
import { readWorktreeSettings, writeWorktreeSettings } from './assistant-server/worktree-settings';
import { runWorktreeSetup } from './assistant-server/worktree-setup';
import { collectBackgroundRuntimeMetrics } from './background-runtime-metrics';
import { emitBootMeasurementMark, shouldQuitAfterBootMeasurement } from './boot-measurement';
import { createBrowserPaneHost } from './browser/browser-pane-host';
import {
  clearActiveBrowserPaneHost,
  setActiveBrowserPaneHost,
} from './browser/browser-pane-registry';
import { createBrowserIpcHandlers } from './browser-ipc-handlers';
import { registerCanvasProtocol } from './canvas-protocol';
import { createChangesIpcHandlers } from './changes-ipc-handlers';
import { ChunkingHostManager } from './chunking-host-manager';
import { createWindow, noteNextWindowReload } from './create-window';
import {
  createDesktopDatabaseMaintenanceScheduler,
  type DesktopDatabaseMaintenanceScheduler,
} from './database-maintenance-scheduler';
import { getDbHostManager } from './db-host-manager';
import {
  closeDatabase,
  getDatabase,
  handleRuntimeCorruption as replaceCorruptedDatabase,
  resetLocalDatabase,
} from './db-main';
import { getDesktopCrashRecoverySnapshot } from './desktop-crash-recovery';
import { getDesktopEnvironmentBootstrapResult } from './desktop-env';
import { buildDesktopEnvBootstrapReport } from './desktop-env-report';
import { type SerializedDesktopError, serializeDesktopError } from './desktop-error-serialization';
import { resolveDesktopRendererLaunchMode } from './desktop-launch-mode';
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
import { MAIN_WATCHDOG_CHECK_INTERVAL_MS } from './diagnostics/main-watchdog-core';
import { resolveMainWatchdogWorkerPath } from './diagnostics/main-watchdog-path';
import {
  attemptMainWatchdogBootstrap,
  createMainWatchdogAttachmentLifecycle,
  createMainWatchdogRuntime,
  runMainWatchdogPowerTransition,
} from './diagnostics/main-watchdog-runtime';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from './diagnostics/rotating-file-sink';
import {
  type DimensionIndexBuildStrategy,
  probeDimensionIndexRuntimeCapabilities,
} from './dimension-index-maintenance-capabilities';
import {
  createDesktopDimensionIndexMaintenanceScheduler,
  type DesktopDimensionIndexMaintenanceScheduler,
} from './dimension-index-maintenance-scheduler';
import { resolveBuiltRendererPath } from './dist-root';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';
import { EmbeddingHostManager } from './embedding-host-manager';
import { createFactoryResetRendererReplacementCoordinator } from './factory-reset-renderer-replacement';
import { resolveFolderCandidatesFromArgv } from './folder-argv';
import { createForgeIpcHandlers, createForgeRepositoryResolver } from './forge-ipc-handlers';
import { createDatabaseRootResolver, execFileGitRunner } from './git-ipc-handlers';
import { DISABLED_CHROMIUM_FEATURES } from './gpu-flags';
import { registerAgentIpcHandlers } from './ipc-agent';
import { registerBrowserIpcHandlers } from './ipc-browser';
import { registerChangesIpcHandlers } from './ipc-changes';
import { registerChunkingHostIpcHandlers } from './ipc-chunking-host';
import { registerClipboardIpcHandlers } from './ipc-clipboard';
import { registerContextFilesIpcHandlers } from './ipc-context-files';
import { registerDesktopDiagnosticsIpcHandlers } from './ipc-desktop-diagnostics';
import { registerAssistantCheckpointIpcHandlers } from './ipc-domains/assistant-checkpoint-ipc';
import { registerProviderAuthIpcHandlers } from './ipc-domains/provider-auth';
import { listRecentRootEntries } from './ipc-domains/workspace-recent-roots';
import { cancelAllDesktopEmbeddingBackfills } from './ipc-embedding-backfill';
import { registerEmbeddingHostIpcHandlers } from './ipc-embedding-host';
import { registerFileExportsIpcHandlers } from './ipc-file-exports';
import { registerForgeIpcHandlers } from './ipc-forge';
import { registerGitIpcHandlers } from './ipc-git';
import {
  cleanupDesktopLiveSubscriptionsForShutdown,
  getDesktopDatabaseWorkScheduler,
  getDesktopDatabaseWorkSchedulerSnapshot,
  quiesceDesktopDatabaseWorkForRecovery,
  registerIpcHandlers,
  resumeDesktopDatabaseWorkAfterRecoveryReload,
  runDesktopScheduledDatabaseWork,
  runWithDesktopDatabaseResetBarrier,
  setBackgrounded,
  waitForDesktopDatabaseWorkSchedulerIdle,
} from './ipc-handlers';
import { registerHooksIpcHandlers } from './ipc-hooks';
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
import {
  cloneLoggingPreferences,
  cloneLoggingSettingsPayload,
  registerLoggingIpcHandlers,
} from './logging-ipc';
import type { LoggingSettingsPayload } from './logging-shared';
import { registerMainPlatformIpcHandlers } from './main-platform-ipc';
import { isMainProcessHealthDegraded } from './main-process-health-log-level';
import { getMcpAppShellRegistry, registerMcpAppShellProtocol } from './mcp/apps-shell-protocol';
import { getDesktopMcpHostRuntime } from './mcp/host-runtime';
import { purgeMcpOAuthRuntimeState } from './mcp/oauth-client-provider';
import { ParserHostManager } from './parser-host-manager';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { readDesktopPowerSnapshot } from './platform/desktop-power-snapshot';
import { registerPrivilegedSchemes } from './privileged-schemes';
import {
  initializeProviderAuthRuntime,
  purgeProviderAuthRuntimeState,
} from './provider-auth/provider-auth-runtime';
import { getSecretsService } from './secrets';
import { setupSecurity } from './setup-security';
import type { DesktopSettingsStoreSchema } from './store-schema';
import { disposeAllTerminals } from './terminal-ipc-handlers';
import { resolveSourceWindowRole } from './window-role';
import { readStoredWindowState, registerWindowStatePersistence } from './window-state';
import {
  createWorkspaceOpenQueue,
  enqueueFolderCandidates,
  filterDirectoryOpenCandidates,
} from './workspace-open-queue';
import { registerWorkspaceOpenReadyIpcHandlers } from './workspace-open-ready-ipc';
import { resolveRootCwd } from './workspace-root-cwd';
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
const LOG_FILE_VERIFICATION_POLL_INTERVAL_MS = 250;
const LOG_FILE_VERIFICATION_TIMEOUT_MS = 5000;

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

function createDesktopDefaultPreferences(): LoggingPreferences {
  const logPath = getLogFilePath();
  return createDefaultLoggingPreferences({
    consoleLevel: LogLevel.WARN,
    file: {
      append: true,
      destination: logPath ?? null,
      enabled: !disableFileLogs && Boolean(logPath),
      level: LogLevel.INFO,
      mkdir: true,
    },
    includeTimestamp: true,
    level: LogLevel.INFO,
  });
}

function createLegacyDesktopDefaultPreferences(): LoggingPreferences {
  const logPath = getLogFilePath();
  return createDefaultLoggingPreferences({
    consoleLevel: LogLevel.INFO,
    file: {
      append: true,
      destination: logPath ?? null,
      enabled: !disableFileLogs && Boolean(logPath),
      level: LogLevel.DEBUG,
      mkdir: true,
    },
    includeTimestamp: true,
    level: LogLevel.DEBUG,
  });
}

function areLoggingPreferencesEqual(left: LoggingPreferences, right: LoggingPreferences): boolean {
  return (
    left.level === right.level &&
    left.consoleEnabled === right.consoleEnabled &&
    left.consoleLevel === right.consoleLevel &&
    left.includeTimestamp === right.includeTimestamp &&
    left.file.enabled === right.file.enabled &&
    left.file.destination === right.file.destination &&
    left.file.level === right.file.level &&
    left.file.append === right.file.append &&
    left.file.mkdir === right.file.mkdir &&
    left.redactPaths.length === right.redactPaths.length &&
    left.redactPaths.every((path, index) => path === right.redactPaths[index])
  );
}

function migrateStoredLoggingPreferences(stored: LoggingPreferences): LoggingPreferences {
  const sanitizedStored = sanitizeDesktopPreferences(stored);
  const legacyDefaults = sanitizeDesktopPreferences(createLegacyDesktopDefaultPreferences());
  const currentDefaults = createDesktopDefaultPreferences();
  const debugFileDefaults = sanitizeDesktopPreferences({
    ...currentDefaults,
    file: {
      ...currentDefaults.file,
      level: LogLevel.DEBUG,
    },
    level: LogLevel.DEBUG,
  });
  if (
    areLoggingPreferencesEqual(sanitizedStored, legacyDefaults) ||
    areLoggingPreferencesEqual(sanitizedStored, debugFileDefaults)
  ) {
    return sanitizeDesktopPreferences(createDesktopDefaultPreferences());
  }
  return sanitizedStored;
}

function mergeStoredPreferences(
  base: LoggingPreferences,
  stored: LoggingPreferences | undefined
): LoggingPreferences {
  if (!stored) {
    return base;
  }

  return {
    ...base,
    ...stored,
    file: {
      ...base.file,
      ...(stored.file ?? {}),
    },
    redactPaths: stored.redactPaths ?? base.redactPaths,
  };
}

function sanitizeDesktopPreferences(preferences: LoggingPreferences): LoggingPreferences {
  const normalized: LoggingPreferences = {
    ...preferences,
    file: { ...preferences.file },
    redactPaths: preferences.redactPaths
      .map((value) => value.trim())
      .filter((value) => value.length),
  };

  const trimmedDestination = normalized.file.destination?.trim() ?? null;

  if (disableFileLogs) {
    normalized.file.enabled = false;
    normalized.file.destination = null;
  } else if (normalized.file.enabled) {
    normalized.file.destination = trimmedDestination ?? getLogFilePath() ?? null;
    if (!normalized.file.destination) {
      normalized.file.enabled = false;
    } else if (!isWritableLogDestination(normalized.file.destination)) {
      normalized.file.enabled = false;
    }
  } else {
    normalized.file.destination = trimmedDestination;
  }

  return normalized;
}

function readStoredLoggingPreferences(): LoggingPreferences | undefined {
  try {
    const store = getSettingsStore();
    if (!store) {
      return;
    }
    const record = (
      store as ElectronStore<DesktopSettingsStoreSchema> & {
        get: (key: string) => unknown;
      }
    ).get('loggingPreferences') as DesktopSettingsStoreSchema['loggingPreferences'] | undefined;
    if (!record?.v1) {
      return;
    }
    return migrateStoredLoggingPreferences(record.v1);
  } catch {
    return;
  }
}

function isWritableLogDestination(destination: string): boolean {
  try {
    const resolved = path.resolve(destination);
    const directory = path.dirname(resolved);
    const stats = fs.statSync(directory);
    if (!stats.isDirectory()) {
      return false;
    }
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface FileStatSnapshot {
  mtimeMs: number;
  size: number;
}

async function readFileStatSnapshot(filePath: string): Promise<FileStatSnapshot | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

async function isWritableLogDestinationAsync(destination: string): Promise<boolean> {
  try {
    const resolved = path.resolve(destination);
    const directory = path.dirname(resolved);
    const stats = await fs.promises.stat(directory);
    if (!stats.isDirectory()) {
      return false;
    }
    await fs.promises.access(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function sanitizeDesktopPreferencesAsync(
  preferences: LoggingPreferences
): Promise<LoggingPreferences> {
  const normalized: LoggingPreferences = {
    ...preferences,
    file: { ...preferences.file },
    redactPaths: preferences.redactPaths
      .map((value) => value.trim())
      .filter((value) => value.length),
  };

  const trimmedDestination = normalized.file.destination?.trim() ?? null;

  if (disableFileLogs) {
    normalized.file.enabled = false;
    normalized.file.destination = null;
  } else if (normalized.file.enabled) {
    normalized.file.destination = trimmedDestination ?? getLogFilePath() ?? null;
    if (!normalized.file.destination) {
      normalized.file.enabled = false;
    } else if (!(await isWritableLogDestinationAsync(normalized.file.destination))) {
      normalized.file.enabled = false;
    }
  } else {
    normalized.file.destination = trimmedDestination;
  }

  return normalized;
}

function persistLoggingPreferences(preferences: LoggingPreferences): boolean {
  try {
    const store = getSettingsStore();
    if (!store) {
      return false;
    }
    (
      store as ElectronStore<DesktopSettingsStoreSchema> & {
        set: (key: string, value: unknown) => void;
      }
    ).set('loggingPreferences', { v1: cloneLoggingPreferences(preferences) });
    return true;
  } catch {
    // Persistence failures should not crash the app; preferences can be reapplied during runtime.
    return false;
  }
}

const defaultPreferences = createDesktopDefaultPreferences();
const storedPreferences = readStoredLoggingPreferences();
const initialLoggingPreferences = sanitizeDesktopPreferences(
  mergeStoredPreferences(defaultPreferences, storedPreferences)
);

const loggingOptions: InitializeLoggingOptions = {
  appName: 'brainstrike-desktop',
  appVersion: app.getVersion(),
  baseBindings: {
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    ...(initialLoggingPreferences.file.enabled && initialLoggingPreferences.file.destination
      ? { logFile: initialLoggingPreferences.file.destination }
      : {}),
  },
  consoleLevel: initialLoggingPreferences.consoleLevel,
  includeTimestamp: initialLoggingPreferences.includeTimestamp,
  level: initialLoggingPreferences.level,
  runtime: 'electron-main',
};

const logger = createLogger('DesktopMain');
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
const removeLogBufferListener = addLogListener((record) => {
  mainLogBuffer.push(record);
});

if (initialLoggingPreferences.file.enabled && initialLoggingPreferences.file.destination) {
  loggingOptions.file = {
    append: initialLoggingPreferences.file.append,
    destination: initialLoggingPreferences.file.destination,
    level: initialLoggingPreferences.file.level,
    mkdir: initialLoggingPreferences.file.mkdir,
    ...createMainLogTransportConfig(),
  };
}

try {
  initializeLogging(loggingOptions);
} catch (error) {
  logger.error('Failed to initialize structured logging; continuing with console-only logs.', {
    error,
  });
}

let currentLoggingPreferences = initialLoggingPreferences;
applyLoggingPreferences(currentLoggingPreferences, 'electron-main', {
  baseBindings: {
    logFile:
      currentLoggingPreferences.file.enabled && currentLoggingPreferences.file.destination
        ? currentLoggingPreferences.file.destination
        : null,
  },
  fileTransport: createMainLogTransportConfig(),
});
persistLoggingPreferences(currentLoggingPreferences);

function getLoggingCapabilities() {
  return {
    canSelectDestination: !disableFileLogs,
    defaultDestination: getLogFilePath() ?? null,
    fileLoggingSupported: !disableFileLogs,
    reason: disableFileLogs ? 'File logging disabled by BRAINSTRIKE_DISABLE_FILE_LOGS=1' : null,
    runtime: 'electron' as const,
  };
}

function getLoggingSettingsPayload(): LoggingSettingsPayload {
  return cloneLoggingSettingsPayload({
    capabilities: getLoggingCapabilities(),
    preferences: currentLoggingPreferences,
  });
}

async function verifyActiveLogFile(reason: string): Promise<void> {
  const { enabled, destination } = currentLoggingPreferences.file;
  const defaultDestination = getLoggingCapabilities().defaultDestination;

  logger.info('Desktop file logging configuration resolved', {
    appReady: app.isReady(),
    configuredDestination: destination,
    defaultDestination,
    fileLoggingEnabled: enabled,
    reason,
  });

  if (!(enabled && destination)) {
    logger.warn('Desktop file logging is not active', {
      configuredDestination: destination,
      defaultDestination,
      fileLoggingEnabled: enabled,
      reason,
    });
    return;
  }

  const before = await readFileStatSnapshot(destination);
  logger.info('Desktop file logging verification marker', {
    logFile: destination,
    previousMtimeMs: before?.mtimeMs ?? null,
    previousSizeBytes: before?.size ?? null,
    reason,
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < LOG_FILE_VERIFICATION_TIMEOUT_MS) {
    await sleep(LOG_FILE_VERIFICATION_POLL_INTERVAL_MS);
    const after = await readFileStatSnapshot(destination);
    if (!after) {
      continue;
    }
    if (!before || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      logger.info('Desktop file logging verified on disk', {
        logFile: destination,
        mtimeMs: after.mtimeMs,
        previousMtimeMs: before?.mtimeMs ?? null,
        previousSizeBytes: before?.size ?? null,
        reason,
        sizeBytes: after.size,
      });
      return;
    }
  }

  const finalStats = await readFileStatSnapshot(destination);
  logger.error('Desktop file logging did not advance on disk after verification marker', {
    defaultDestination,
    existsOnDisk: finalStats !== null,
    logFile: destination,
    mtimeMs: finalStats?.mtimeMs ?? null,
    previousMtimeMs: before?.mtimeMs ?? null,
    previousSizeBytes: before?.size ?? null,
    reason,
    sizeBytes: finalStats?.size ?? null,
  });
}

async function selectLogDestination(): Promise<string | null> {
  if (!getLoggingCapabilities().canSelectDestination) {
    return null;
  }

  const defaultPath =
    currentLoggingPreferences.file.destination ?? getLogFilePath() ?? app.getPath('logs');

  const result = await dialog.showSaveDialog({
    buttonLabel: 'Use Log File',
    defaultPath,
    title: 'Choose log file location',
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
}

async function applyAndPersistLoggingPreferences(
  preferences: LoggingPreferences
): Promise<LoggingSettingsPayload> {
  const normalized = await sanitizeDesktopPreferencesAsync(preferences);
  if (!persistLoggingPreferences(normalized)) {
    return getLoggingSettingsPayload();
  }
  currentLoggingPreferences = normalized;
  applyLoggingPreferences(currentLoggingPreferences, 'electron-main', {
    baseBindings: {
      logFile:
        currentLoggingPreferences.file.enabled && currentLoggingPreferences.file.destination
          ? currentLoggingPreferences.file.destination
          : null,
    },
    fileTransport: createMainLogTransportConfig(),
  });
  mainWatchdogRuntime.configureLogging(normalized.file);
  void verifyActiveLogFile('logging-preferences-updated');
  return getLoggingSettingsPayload();
}

async function openLogDestination(target: string | null): Promise<boolean> {
  const destination =
    target ??
    currentLoggingPreferences.file.destination ??
    getLoggingCapabilities().defaultDestination;
  if (!destination) {
    return false;
  }
  try {
    shell.showItemInFolder(destination);
    return true;
  } catch {
    return false;
  }
}

async function initializeDesktopDimensionIndexStrategy(): Promise<void> {
  try {
    const capabilities = await probeDimensionIndexRuntimeCapabilities({
      db: await getDatabase(),
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
let unregisterMainIpcHandlers: null | (() => void) = null;
let unregisterChunkingHostIpcHandlers: null | (() => void) = null;
let unregisterParserHostIpcHandlers: null | (() => void) = null;
let unregisterEmbeddingHostIpcHandlers: null | (() => void) = null;
let unregisterLlmHostIpcHandlers: null | (() => void) = null;
let unregisterLoggingIpcHandlers: null | (() => void) = null;
// Flight Recorder P2a Task 3: the durable NDJSON backstop for warn+ records
// from main AND from renderers/hidden hosts over IPC (see
// registerLoggingIpcHandlers' recordDurableLog below). Constructed at
// app-ready when file logging isn't disabled; closed as the last graceful-
// shutdown step so it captures failures from every earlier step.
let errorLogSink: ErrorLogSinkHandle | null = null;
let unregisterMainPlatformIpcHandlers: null | (() => void) = null;
let unregisterDesktopDiagnosticsIpcHandlers: null | (() => void) = null;
let unregisterMcpIpcHandlers: null | (() => void) = null;
let unregisterShellIpcHandlers: null | (() => void) = null;
let unregisterClipboardIpcHandlers: null | (() => void) = null;
let unregisterFileExportsIpcHandlers: null | (() => void) = null;
let unregisterAssistantCheckpointIpcHandlers: null | (() => void) = null;
let unregisterGitIpcHandlers: null | (() => void) = null;
let unregisterChangesIpcHandlers: null | (() => void) = null;
let unregisterWorktreesIpcHandlers: null | (() => void) = null;
let unregisterBrowserIpcHandlers: null | (() => void) = null;
let unregisterHooksIpcHandlers: null | (() => void) = null;
let unregisterContextFilesIpcHandlers: null | (() => void) = null;
let unregisterSkillsIpcHandlers: null | (() => void) = null;
let unregisterUserCommandsIpcHandlers: null | (() => void) = null;
let unregisterUserPersonasIpcHandlers: null | (() => void) = null;
let unregisterTerminalIpcHandlers: null | (() => void) = null;
let unregisterNotesVaultIpcHandlers: null | (() => void) = null;
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
let desktopDatabaseMaintenanceScheduler: DesktopDatabaseMaintenanceScheduler | null = null;
let desktopDimensionIndexMaintenanceScheduler: DesktopDimensionIndexMaintenanceScheduler | null =
  null;
let desktopDimensionIndexStrategy: DimensionIndexBuildStrategy | null = null;
let signalShutdownInFlight = false;
let allowImmediateQuit = false;
let gracefulShutdownPromise: Promise<void> | null = null;
let gracefulShutdownInFlight = false;
let forcedProcessExitTimeout: NodeJS.Timeout | null = null;
const SIGNAL_SHUTDOWN_TIMEOUT_MS = 5000 as const;
const FACTORY_RESET_RENDERER_READY_TIMEOUT_MS = 30_000 as const;
let completeFactoryResetRendererReplacement: (() => Promise<void>) | null = null;

async function runShutdownStep(
  step: string,
  fn: () => Promise<void>
): Promise<SerializedDesktopError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return {
      step,
      ...serializeDesktopError(error),
    };
  }
}

function scheduleForcedProcessExit(trigger: NodeJS.Signals | 'before-quit'): void {
  if (forcedProcessExitTimeout) {
    return;
  }

  forcedProcessExitTimeout = setTimeout(() => {
    logger.error('Timed out waiting for graceful shutdown; forcing exit', {
      trigger,
    });
    process.exit(1);
  }, SIGNAL_SHUTDOWN_TIMEOUT_MS);
  forcedProcessExitTimeout.unref();
}

function clearForcedProcessExitTimer(): void {
  if (!forcedProcessExitTimeout) {
    return;
  }
  clearTimeout(forcedProcessExitTimeout);
  forcedProcessExitTimeout = null;
}

async function runGracefulShutdown(trigger: 'before-quit' | 'signal'): Promise<void> {
  // Mark shutdown before any host/DB teardown so background work torn down
  // mid-flight (e.g. an in-flight embedding backfill) is logged as a benign
  // stop, not a failure.
  markDesktopShuttingDown();
  if (gracefulShutdownPromise) {
    await gracefulShutdownPromise;
    return;
  }

  gracefulShutdownPromise = (async () => {
    const failures: SerializedDesktopError[] = [];
    // Adding a new step? Call `runShutdownStep` and pass its result through
    // `recordFailure` like every step below, rather than a bespoke
    // `const x = ...; if (x) { failures.push(x); }` — that pattern, repeated
    // once per step, is what pushed this closure over the cognitive-
    // complexity lint budget when the error-log-sink step (Flight Recorder
    // P2a Task 3) was added.
    const recordFailure = (failure: SerializedDesktopError | null): void => {
      if (failure) {
        failures.push(failure);
      }
    };

    const stopServer = stopAssistantServer;
    let assistantServerDrained = stopServer === null;
    recordFailure(
      await runShutdownStep('assistant-server', async () => {
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
      })
    );

    recordFailure(await runShutdownStep('mcp-runtime', cleanupMcpRuntimeForShutdown));
    if (!assistantServerDrained) {
      failures.push({
        message: 'Closed MCP host before assistant-server drain completed',
        name: 'McpShutdownOrderingError',
        step: 'mcp-runtime',
      });
    }

    recordFailure(
      await runShutdownStep('chunking-host', async () => {
        await chunkingHostManager.dispose();
      })
    );

    recordFailure(
      await runShutdownStep('parser-host', async () => {
        await parserHostManager.stop();
      })
    );

    recordFailure(
      await runShutdownStep('embedding-host', async () => {
        await embeddingHostManager.dispose();
      })
    );

    recordFailure(
      await runShutdownStep('llm-host', async () => {
        await llmHostManager.dispose();
      })
    );

    recordFailure(
      await runShutdownStep('git-inventory', async () => {
        // BEFORE 'database' below: this service's `loadRoots` dependency
        // reads the DB `roots` table, so its watchers/in-flight build must
        // be torn down while the database is still available to it.
        if (gitInventoryService) {
          await gitInventoryService.stop();
          gitInventoryService = null;
        }
      })
    );

    // Its own step, deliberately NOT nested inside 'git-inventory' above:
    // `gitInventoryService.stop()`'s final `await toDispose.disposeAll()` is
    // unguarded, and `runShutdownStep` catches a rejection at the step
    // boundary — nesting forge teardown after it would silently skip these
    // three lines on a throwing watcher disposer, leaving `ipcMain` handlers
    // registered and a live `forgeService` heading into 'database' below.
    // forge has the same DB dependency as git-inventory (`getDatabase` ->
    // `readForgePrCacheEntry`/`writeForgePrCacheEntry`) but is otherwise
    // unrelated to git-inventory's success, so it gets its own
    // failure-isolated step, BEFORE 'database' for the same reason.
    //
    recordFailure(
      await runShutdownStep('forge', async () => {
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
      })
    );

    recordFailure(
      await runShutdownStep('database', async () => {
        desktopDimensionIndexMaintenanceScheduler?.stop();
        desktopDimensionIndexMaintenanceScheduler = null;
        desktopDatabaseMaintenanceScheduler?.stop();
        desktopDatabaseMaintenanceScheduler = null;
        await cleanupDesktopLiveSubscriptionsForShutdown();
        await waitForDesktopDatabaseWorkSchedulerIdle();
        await cleanupDesktopLiveSubscriptionsForShutdown();
        await closeDatabase();
      })
    );

    if (failures.length > 0) {
      // The ONLY place any of the failures collected above gets logged — and
      // therefore the only warn+ record that could describe them. It MUST
      // run before the error-log-sink step below: closing the sink first
      // would make `recordDurableLog` a no-op for this very call, so the
      // NDJSON backstop would contain no trace of a shutdown-step failure
      // (e.g. `closeDatabase()` throwing) despite being "the last writer
      // standing".
      logger.warn('Graceful shutdown completed with cleanup failures', {
        failures,
        trigger,
      });
    }

    // Last shutdown step, deliberately, and AFTER the warn above (not just
    // after 'database'): the durable NDJSON file is the last writer
    // standing, so it must stay open through every earlier step — including
    // the aggregate failure log immediately above — in order to capture
    // their failures too.
    //
    // Deliberately NOT routed through `recordFailure`/`failures`: the
    // aggregate `if (failures.length > 0) logger.warn(...)` above is the
    // ONLY consumer of that array and has already run, so a failure pushed
    // into it now would never be read by anything — logging it here is the
    // only way this failure reaches console/`brainstrike.log` at all (the
    // NDJSON sink itself is exactly what just failed to close). The handle
    // is nulled from a `finally` so a throwing `close()` still leaves
    // `errorLogSink` cleared rather than a stale handle that later
    // `recordDurableLog` calls would treat as still open.
    const sinkToClose = errorLogSink;
    const sinkCloseFailure = await runShutdownStep('error-log-sink', async () => {
      try {
        sinkToClose?.close();
      } finally {
        errorLogSink = null;
      }
    });
    if (sinkCloseFailure) {
      logger.error('Failed to close the durable NDJSON error log', {
        failure: sinkCloseFailure,
        trigger,
      });
    }
  })().finally(() => {
    clearForcedProcessExitTimer();
  });
  await gracefulShutdownPromise;
}

async function handleShutdownSignal(signal: NodeJS.Signals): Promise<void> {
  if (signalShutdownInFlight) {
    return;
  }
  signalShutdownInFlight = true;

  logger.warn('Received shutdown signal, attempting graceful desktop shutdown', { signal });
  scheduleForcedProcessExit(signal);

  // runGracefulShutdown logs and resolves even when cleanup fails, so we always continue
  // to quit the process rather than hanging on a partial shutdown.
  await runGracefulShutdown('signal');

  allowImmediateQuit = true;
  if (app.isReady()) {
    app.quit();
  } else {
    process.exit(0);
  }
}

function registerShutdownSignalHandlers(): void {
  if (process.env['NODE_ENV'] === 'test') {
    return;
  }

  const shutdownSignals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of shutdownSignals) {
    process.once(signal, () => {
      void handleShutdownSignal(signal);
    });
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
const embeddingHostManager = new EmbeddingHostManager();
const llmHostManager = new LlmHostManager();
let runtimeDatabaseRecoveryPromise: Promise<void> | null = null;

async function recoverRuntimeDatabaseAndReload(context: string): Promise<void> {
  if (runtimeDatabaseRecoveryPromise) {
    await runtimeDatabaseRecoveryPromise;
    return;
  }

  const recovery = (async (): Promise<void> => {
    logger.warn('Runtime database recovery started; active indexing work is being canceled', {
      context,
    });
    quiesceDesktopDatabaseWorkForRecovery();
    let reloadScheduled = false;
    try {
      cancelAllDesktopEmbeddingBackfills();
      // Recovery runs inside the scheduler operation whose database call just
      // failed, so waiting for scheduler idle here would deadlock on itself.
      // Backfills receive the recovery-aware scheduler; queued work cannot run
      // until this operation unwinds and then rejects against the old epoch.
      await cleanupDesktopLiveSubscriptionsForShutdown();
      await replaceCorruptedDatabase(context);

      const visibleWindows = BrowserWindow.getAllWindows().filter(
        (window) =>
          !(
            chunkingHostManager.isHostWindow(window) ||
            embeddingHostManager.isHostWindow(window) ||
            llmHostManager.isHostWindow(window)
          )
      );
      if (visibleWindows.length === 0) {
        logger.warn('Runtime database recovery completed without a visible window to reload', {
          context,
        });
        resumeDesktopDatabaseWorkAfterRecoveryReload();
        return;
      }

      for (const window of visibleWindows) {
        noteNextWindowReload(window, {
          reason: 'runtime-database-corruption-recovery',
          source: 'main',
        });
      }
      logger.info('Runtime database recovery completed; visible windows will reload', {
        context,
        visibleWindowCount: visibleWindows.length,
      });

      // Let the failed IPC invocation unwind first. Until this timer runs,
      // scheduler quiescence rejects both old queued closures and new work from
      // the stale renderer. The replacement database cannot receive either.
      reloadScheduled = true;
      setTimeout(() => {
        try {
          for (const window of visibleWindows) {
            if (!window.isDestroyed()) {
              window.webContents.reloadIgnoringCache();
            }
          }
        } finally {
          resumeDesktopDatabaseWorkAfterRecoveryReload();
        }
      }, 0);
    } catch (error) {
      if (!reloadScheduled) {
        resumeDesktopDatabaseWorkAfterRecoveryReload();
      }
      throw error;
    }
  })();

  runtimeDatabaseRecoveryPromise = recovery;
  try {
    await recovery;
  } finally {
    if (runtimeDatabaseRecoveryPromise === recovery) {
      runtimeDatabaseRecoveryPromise = null;
    }
  }
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
  resetLocalDatabase,
  resetPersistentStorageAfterDataDeletion: () => storage.clear(),
  resumeAfterReset: (outcome) =>
    resumeMcpRuntimeAfterFactoryReset(getDesktopMcpHostRuntime(), outcome),
  runtimes: [
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
      stop: () => {
        disposeAllTerminals();
        return Promise.resolve();
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

desktopDatabaseMaintenanceScheduler = createDesktopDatabaseMaintenanceScheduler({
  getDatabase,
  getSchedulerSnapshot: getDesktopDatabaseWorkSchedulerSnapshot,
  logger,
  runScheduledWork: runDesktopScheduledDatabaseWork,
  // BST-1333: lets the scheduler require SUSTAINED idle before starting an
  // unpreemptable maintenance statement, instead of trusting a single sample.
  subscribeToSchedulerSnapshots: (listener) =>
    getDesktopDatabaseWorkScheduler().subscribe(listener),
});
desktopDimensionIndexMaintenanceScheduler = createDesktopDimensionIndexMaintenanceScheduler({
  getDatabase,
  getDimensionIndexStrategy: () => desktopDimensionIndexStrategy,
  getPowerSnapshot: () => readDesktopPowerSnapshot(powerMonitor),
  getSchedulerSnapshot: getDesktopDatabaseWorkSchedulerSnapshot,
  logger,
  runScheduledWork: runDesktopScheduledDatabaseWork,
});

unregisterLoggingIpcHandlers = registerLoggingIpcHandlers({
  getBufferedLogs: () => mainLogBuffer.getRecords(),
  getState: getLoggingSettingsPayload,
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
  openDestination: openLogDestination,
  recordDurableLog: (record) => errorLogSink?.recordLogRecord(record),
  selectDestination: selectLogDestination,
  setPreferences: applyAndPersistLoggingPreferences,
});

// Register IPC handlers early to avoid renderer calls racing registration during startup.
unregisterMainIpcHandlers = registerIpcHandlers(fileSystem, storage, getSettingsStore, {
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
  onResetLocal: handleResetLocal,
  onRuntimeCorruption: recoverRuntimeDatabaseAndReload,
  onWorkspaceRootGranted: (grantedPath: string) => {
    pendingRootGrantSubscriber?.(grantedPath);
  },
});
unregisterChunkingHostIpcHandlers = registerChunkingHostIpcHandlers(chunkingHostManager);
unregisterParserHostIpcHandlers = registerParserHostIpcHandlers(parserHostManager);
unregisterEmbeddingHostIpcHandlers = registerEmbeddingHostIpcHandlers(embeddingHostManager);
unregisterLlmHostIpcHandlers = registerLlmHostIpcHandlers(llmHostManager);
unregisterDesktopDiagnosticsIpcHandlers = registerDesktopDiagnosticsIpcHandlers({
  crashRecovery: {
    getSnapshot: getDesktopCrashRecoverySnapshot,
  },
  database: {
    getDiagnostics: async () => await getDbHostManager().getDiagnostics(),
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
    getState: getLoggingSettingsPayload,
  },
  reset: {
    getSnapshot: () => getDesktopResetDiagnosticsSnapshot(app.getPath('userData')),
  },
  telemetry: {
    getRuntimeMetrics: collectBackgroundRuntimeMetrics,
  },
});
unregisterShellIpcHandlers = registerShellIpcHandlers();
unregisterClipboardIpcHandlers = registerClipboardIpcHandlers();
unregisterFileExportsIpcHandlers = registerFileExportsIpcHandlers();
// Lazy resolver for the same reason as `resolveSnapshotService` below: this
// registration runs at module load, the ONE snapshot service is constructed
// at app-ready. The checkpoint-undo engine restores from turn-start
// snapshots (BST-1164 T4), so the handlers need the same seams as changes.
unregisterAssistantCheckpointIpcHandlers = registerAssistantCheckpointIpcHandlers({
  resolveSnapshotService: () => snapshotService,
});
unregisterGitIpcHandlers = registerGitIpcHandlers();
// `resolveInventoryService` is a LAZY getter on purpose: this registration
// runs at module load, while `gitInventoryService` is only constructed once
// the app is ready (see `createGitInventoryService` below). Capturing the
// value here would pin `null` forever.
unregisterChangesIpcHandlers = registerChangesIpcHandlers(
  createChangesIpcHandlers({
    // T1 injection points (BST-1164): the snapshot-repository factory and the
    // lazy service resolver are THREADED but not yet consumed — T2/T3 consume
    // them here so neither has to edit main.ts. Lazy for the same reason as
    // `resolveInventoryService` below.
    createSnapshotRepository,
    resolveInventoryService: () => gitInventoryService,
    resolveSnapshotService: () => snapshotService,
  })
);
unregisterWorktreesIpcHandlers = registerWorktreesIpcHandlers(
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
);
unregisterHooksIpcHandlers = registerHooksIpcHandlers();
unregisterContextFilesIpcHandlers = registerContextFilesIpcHandlers();
unregisterSkillsIpcHandlers = registerSkillsIpcHandlers();
unregisterUserCommandsIpcHandlers = registerUserCommandsIpcHandlers();
unregisterUserPersonasIpcHandlers = registerUserPersonasIpcHandlers();
unregisterTerminalIpcHandlers = registerTerminalIpc();
unregisterNotesVaultIpcHandlers = registerNotesVaultIpc(storage);

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
registerShutdownSignalHandlers();

const singleInstanceLockAcquired = isElectronE2ETestMode()
  ? true
  : typeof app.requestSingleInstanceLock === 'function'
    ? app.requestSingleInstanceLock()
    : true;

if (singleInstanceLockAcquired) {
  const e2eTestMode = isElectronE2ETestMode();

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
  });

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

  app.whenReady().then(async () => {
    try {
      emitBootMeasurementMark('app-ready', app.isPackaged);
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

      // BST-1112: cross-workspace git worktree inventory service. Constructed
      // and started HERE, inside app.whenReady() — never at module scope.
      // `start()` kicks off an eager build whose very first step
      // (`loadRoots`) reaches `getDatabase()` → `getRemoteDbHostManager()` →
      // `utilityProcess.fork`, and Electron throws
      // "utilityProcess cannot be created before app is ready." if that spawn
      // is attempted pre-ready. A module-scope `start()` call sits above
      // `app.whenReady()` entirely, so every production boot would hit this
      // rejection silently (caught by `rebuild()`'s try/catch, logged
      // nowhere, cached as a false "no repositories" snapshot for the full
      // TTL — see BST-1112 review). It also sat ABOVE the single-instance
      // lock guard, so a duplicate launch would walk every workspace root and
      // spawn git without ever calling `stop()`. Uses a PRIVATE
      // `ElectronFileSystemAdapter` instance — never the shared `fileSystem`
      // above and never the renderer-owned `fs:watch` IPC pipeline
      // (`ipc-domains/file-system-watch-ipc.ts` dedupes native subscriptions
      // on `(ownerId, resolvedPath)` ONLY; the ignore-pattern set is not part
      // of that key, so routing this module's fixed `ignorePatterns: []`
      // through the shared pipeline could let an unrelated registration for
      // the same resolved path silently share this filter set). See
      // `ipc-notes-vault.ts:66-105` for the same private-adapter + inline
      // `DirectoryHandle` pattern.
      const gitInventoryWatcherAdapter = new ElectronFileSystemAdapter();
      // BST-1161 (spec §6): each watcher invalidation is pushed to every live
      // renderer as `changes:invalidated` so git-scope changeset views and the
      // inventory refetch without polling. The monotonic generation lets the
      // renderer drop stale/duplicate deliveries. Broadcast (ipc-mcp
      // precedent): the Changes surface and git panel can live in any window.
      let changesInvalidationGeneration = 0;
      const broadcastChangesInvalidation = (event: {
        gitCommonDir: string;
        repositoryRoot: string | null;
      }): void => {
        changesInvalidationGeneration += 1;
        const payload: ChangesInvalidationEvent = {
          generation: changesInvalidationGeneration,
          gitCommonDir: event.gitCommonDir,
          repositoryRoot: event.repositoryRoot,
        };
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed()) {
            continue;
          }
          window.webContents.send(DESKTOP_IPC_CHANNELS.changes.invalidated, payload);
        }
      };
      // BST-1391 (W4): forge PR awareness. ONE instance, never at module
      // scope, same posture as GitInventoryService above. It reads the DB
      // through db-main's provider and spawns `gh` only inside a resolved,
      // containment-checked workspace root.
      let forgePrUpdatedGeneration = 0;
      // Kept as its own binding (not inlined into `resolveRepository` below)
      // so the git-metadata watcher's `onInvalidate` callback below can also
      // clear this resolver's per-rootId cache on the SAME commonDir signal
      // that already drives `forgeService.onRepositoryInvalidated`.
      const forgeRepositoryResolver = createForgeRepositoryResolver(
        createDatabaseRootResolver(getDatabase)
      );
      forgeService = createForgeService({
        getDatabase,
        onPrUpdated: (event) => {
          forgePrUpdatedGeneration += 1;
          const payload: ForgePrUpdatedEvent = {
            ...event,
            generation: forgePrUpdatedGeneration,
          };
          for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) {
              continue;
            }
            window.webContents.send(DESKTOP_IPC_CHANNELS.forge.prUpdated, payload);
          }
        },
        resolveRepository: forgeRepositoryResolver,
        run: execFileGhRunner,
      });
      unregisterForgeIpc = registerForgeIpcHandlers(
        createForgeIpcHandlers({ service: forgeService })
      );
      gitInventoryService = createGitInventoryService({
        loadRoots: async () => {
          const roots = await loadWorkspaceRootsFromDatabase(await getDatabase());
          return roots.map((root) => ({ id: root.rootId, path: root.path }));
        },
        // The refs watcher moving `refs/remotes/<remote>/<branch>` is the
        // "a push happened" signal §8 asks for: broadcast to renderers AND
        // let the forge service refresh the repositories it already tracks.
        onInvalidate: (event) => {
          broadcastChangesInvalidation(event);
          forgeService?.onRepositoryInvalidated(event.gitCommonDir);
          forgeRepositoryResolver.invalidateResolverCache(event.gitCommonDir);
        },
        run: execFileGitRunner,
        // `ElectronFileSystemAdapter.watchDirectory` returns its disposer
        // SYNCHRONOUSLY; `WatchGitCommonDir`'s DI shape is `Promise<() => void>` —
        // adapting with `Promise.resolve(...)` is the documented intent in that
        // type's own doc comment in `git-inventory-watcher.ts` (no health-
        // transition gate needed here, unlike `ipc-notes-vault.ts`'s `startWatch`,
        // because the returned disposer is already safe to use immediately).
        watchDirectory: (commonDir, callback, onSignal, options) =>
          Promise.resolve(
            gitInventoryWatcherAdapter.watchDirectory(
              {
                kind: 'directory',
                name: path.basename(commonDir),
                path: commonDir,
                platform: 'electron',
              },
              callback,
              onSignal,
              options
            )
          ),
      });
      gitInventoryService.start();
      worktreeService = createWorktreeService({
        getDatabase,
        readSettings: () => readWorktreeSettings(storage, app.getPath('home')),
        recordRunEvent: (runId, event) => recordDesktopAssistantRunEvent(runId, event, getDatabase),
        resolveInventory: async (options) => {
          if (!gitInventoryService) {
            throw new Error('worktrees: gitInventoryService is not running');
          }
          // `maxAgeMs: 0` is FORCED (git-inventory-service.ts's own doc
          // comment): it guarantees a build that started after this call, not
          // merely a cache-bust — what reconcileWorktreesFromShell's
          // post-command read needs to reliably see a worktree the agent's
          // shell command just created.
          const snapshot = await gitInventoryService.getSnapshot(
            options?.forceFresh ? { maxAgeMs: 0 } : undefined
          );
          return { errors: snapshot.errors, repositories: snapshot.repositories };
        },
        resolveRootCwd: (rootId) =>
          resolveRootCwd(createDatabaseRootResolver(getDatabase), rootId, 'worktrees', logger),
        resolveRootPaths: async () => {
          const roots = await loadWorkspaceRootsFromDatabase(await getDatabase());
          return roots.map((root) => ({ id: root.rootId, path: root.path }));
        },
        run: execFileGitRunner,
        runSetup: (setupInput) => runWorktreeSetup(setupInput),
      });

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
      // Startup orphan sweep: remove shadow repos whose workspace root row no
      // longer EXISTS at all. Deliberately keyed on every `roots` row (any
      // status), NOT on `status = 'live'`: disconnect ≠ delete (the row is
      // kept and the root can reconnect), and sweeping a disconnected root
      // here would irreversibly destroy its snapshot history. Fire-and-forget
      // so startup never blocks on it; failures are logged visibly, never
      // swallowed.
      void (async () => {
        try {
          const database = await getDatabase();
          // BST-1162: unstick rewind's in-flight gate. Rows a previous
          // process left in 'running' are provably dead (see the reaper's
          // evidence rule); marking them failed here is what re-enables
          // Conversation Rewind on their threads. Runs before the snapshot
          // GC on purpose (its retention floor walks run ranges), but in its
          // OWN try/catch: a reap failure must neither skip the orphan sweep
          // and GC below nor report itself under their step name.
          try {
            const reapReport = await reapOrphanedThreadRuns(
              database as unknown as EditCheckpointDatabase,
              mainProcessStartedAt
            );
            if (reapReport.runsTableMissing || reapReport.reaped.length > 0) {
              logger.info('Startup thread-run reap completed', {
                reapedRunIds: reapReport.reaped.map((row) => row.id),
                runsTableMissing: reapReport.runsTableMissing,
              });
            }
          } catch (reapError) {
            logger.error('Startup thread-run reap failed', { error: reapError });
          }
          const rootRows = await database.query<{ id: string; path: string }>(
            'SELECT id, path FROM roots'
          );
          const result = await constructedSnapshotService.sweepOrphans(
            snapshotsBaseDir,
            rootRows.rows.map((row) => row.id)
          );
          logger.info('Workspace snapshot orphan sweep completed', {
            kept: result.kept.length,
            removed: result.removed,
            snapshotsBaseDir,
          });
          // T4 startup GC (after the orphan sweep so vanished-root repos are
          // already gone): dead-thread rows + refs, ref-only residue, the
          // 50-turn retention ring, and shallow-cut history reclamation.
          // Same fire-and-forget block — logged, non-blocking, failures
          // visible per item.
          const gcDatabase = database as unknown as EditCheckpointDatabase;
          const gcReport = await runSnapshotStartupGc({
            db: gcDatabase,
            liveRoots: rootRows.rows.map((row) => ({ path: row.path, rootId: row.id })),
            snapshotRepository: createSnapshotRepository(gcDatabase),
            snapshotService: constructedSnapshotService,
          });
          for (const failure of gcReport.failures) {
            logger.error('Workspace snapshot GC item failed', { failure });
          }
          if (gcReport.skippedInaccessibleRoots.length > 0) {
            // Expected condition (deleted directory / unmounted volume), so a
            // single warn — not one error per boot forever.
            logger.warn('Workspace snapshot GC skipped inaccessible roots', {
              roots: gcReport.skippedInaccessibleRoots,
            });
          }
          logger.info('Workspace snapshot startup GC completed', {
            deadThreadsPruned: gcReport.deadThreadsPruned.length,
            failures: gcReport.failures.length,
            historyPrunedRoots: gcReport.historyPrunedRoots,
            refOnlyPruned: gcReport.refOnlyPruned.length,
            ringTrimmed: gcReport.ringTrimmed,
            skippedInaccessibleRoots: gcReport.skippedInaccessibleRoots.length,
            threadsTableMissing: gcReport.threadsTableMissing,
          });
        } catch (error) {
          logger.error('Workspace snapshot orphan sweep failed', { error, snapshotsBaseDir });
        }
      })();

      // Keep macOS desktop E2E runs invisible while Playwright drives the hidden window.
      if (e2eTestMode && process.platform === 'darwin') {
        app.setActivationPolicy?.('accessory');
        app.dock?.hide();
      }

      // Re-initialize file logging now that app.getPath() is available.
      // At module load time, app.isReady() is false so getLogFilePath()
      // returns null and file logging defaults to disabled.
      if (!(disableFileLogs || currentLoggingPreferences.file.enabled)) {
        const resolvedLogPath = getLogFilePath();
        if (resolvedLogPath) {
          currentLoggingPreferences = {
            ...currentLoggingPreferences,
            file: {
              ...currentLoggingPreferences.file,
              destination: resolvedLogPath,
              enabled: true,
            },
          };
          applyLoggingPreferences(currentLoggingPreferences, 'electron-main', {
            baseBindings: {
              arch: process.arch,
              electron: process.versions.electron,
              logFile: resolvedLogPath,
              node: process.versions.node,
              platform: process.platform,
            },
            fileTransport: createMainLogTransportConfig(),
          });
          logger.debug('File logging enabled after app.ready', { logFile: resolvedLogPath });
        }
      }
      void verifyActiveLogFile('app-ready');

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
      // ONE SecretsService instance is shared by the secrets IPC domain, the
      // provider-auth engine, and MCP external bearer resolution — multiple
      // ElectronStore instances over the same file would serve stale reads to
      // each other.
      const secretsService = getSecretsService();
      registerSecretsIpcHandlers(secretsService, {
        envFileFailures: desktopEnvLoadResult.failures,
        // Factory reset must also drop the provider-auth engine's IN-MEMORY
        // rotated-token overlay (BST-1356); wiping the secrets file alone
        // would leave it the active credential for the process lifetime.
        onClearAll: async () => {
          await purgeProviderAuthRuntimeState();
          await purgeMcpOAuthRuntimeState();
        },
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
      });
      // Provider OAuth engine (BST-1355) + the OpenAI Codex descriptor
      // (BST-1356). The browser opener is the SAME validated
      // shell.openExternal path the shell IPC domain uses (allow-listed
      // protocols; never an embedded webview), and a failed open surfaces as
      // a typed visible error.
      //
      // ONE engine instance is shared with the assistant server's credential
      // resolution (see provider-auth-runtime): a second engine would carry
      // its own single-flight map and replay a rotating refresh token.
      const shellOpenHandlers = createShellIpcHandlers({ shell });
      registerProviderAuthIpcHandlers({
        engine: initializeProviderAuthRuntime({
          appVersion: app.getVersion(),
          openExternal: async (url) => {
            const result = await shellOpenHandlers.openExternal(url);
            if (!result.ok) {
              throw new Error(result.error ?? 'shell.openExternal failed');
            }
          },
          secrets: secretsService,
        }),
      });
      registerAgentIpcHandlers();
      unregisterMcpIpcHandlers = registerMcpIpcHandlers({
        runtime: getDesktopMcpHostRuntime(),
        settingsStore: getSettingsStore,
      });
      registerRuntimeIpcHandlers();
      logger.debug('Ready-dependent IPC handlers registered successfully');
      // Kick off DB initialization (utilityProcess spawn + migrations) and the
      // dimension-index capability probe WITHOUT blocking window creation: the
      // visible window needs none of it to paint, and renderer DB calls
      // coalesce on the same getDatabase() promise. Only the maintenance
      // schedulers wait for the probe (they consume the selected strategy).
      // initializeDesktopDimensionIndexStrategy never rejects (it catches and
      // degrades internally); the .catch guards the scheduler start() calls so
      // a future throw there can never become an unhandled rejection.
      void initializeDesktopDimensionIndexStrategy()
        .then(() => {
          desktopDatabaseMaintenanceScheduler?.start();
          logger.debug('Scheduled desktop database maintenance started');
          desktopDimensionIndexMaintenanceScheduler?.start();
          logger.debug('Scheduled desktop dimension index maintenance started');
        })
        .catch((error) => {
          logger.error('Failed to start desktop maintenance schedulers', { error });
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
                  // Unlike factory reset this does NOT stop the background
                  // runtimes first: the reload below restarts them anyway, and
                  // if their submissions keep the scheduler busy past the idle
                  // timeout the reset FAILS LOUDLY in the dialog rather than
                  // closing over in-flight work.
                  await resetDesktopDatabaseProfile({
                    cleanupLiveSubscriptionsForShutdown: cleanupDesktopLiveSubscriptionsForShutdown,
                    resetLocalDatabase,
                    runWithDatabaseResetBarrier: runWithDesktopDatabaseResetBarrier,
                    waitForDatabaseWorkSchedulerIdle: waitForDesktopDatabaseWorkSchedulerIdle,
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

      unregisterMainPlatformIpcHandlers = registerMainPlatformIpcHandlers({
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
      });

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
        unregisterBrowserIpcHandlers = registerBrowserIpcHandlers(
          createBrowserIpcHandlers(browserPaneHost.manager)
        );
        win.once('closed', () => {
          clearActiveBrowserPaneHost(browserPaneHost);
          browserPaneHost.dispose();
          unregisterBrowserIpcHandlers?.();
          unregisterBrowserIpcHandlers = null;
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

          const payload = {
            backgroundRuntimeMetrics: collectBackgroundRuntimeMetrics(),
            cpuPercent: (cpuPercent * 100).toFixed(1),
            handles,
            heapUsedKb: (mem.heapUsed / 1024).toFixed(0),
            loopLagMaxMs: max.toFixed(1),
            loopLagP50Ms: p50.toFixed(1),
            loopLagP99Ms: p99.toFixed(1),
            requests,
            rssKb: (mem.rss / 1024).toFixed(0),
          };

          // Always log — if entries stop appearing, the event loop is stuck.
          // NOTE: pino API requires (obj, msg) order to merge fields into the entry.
          if (isMainProcessHealthDegraded({ loopLagMaxMs: max, loopLagP99Ms: p99 })) {
            logger.warn(payload, 'main-process-health');
          } else {
            logger.debug(payload, 'main-process-health');
          }
        }, 30_000).unref();
      }

      // ---------------------------------------------------------------
      // Worker thread watchdog — detects main-thread freezes that block
      // the event loop (and therefore all setInterval timers above).
      // The worker has its own event loop unaffected by signal storms.
      // If the main thread stops sending heartbeats, the worker writes
      // diagnostics directly to stderr and the log file.
      // ---------------------------------------------------------------
      attemptMainWatchdogBootstrap(
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
            }, currentLoggingPreferences.file);
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
        }
      );

      logger.debug('Creating main window...');
      const mainWindow = await createMainWindow();
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
  scheduleForcedProcessExit('before-quit');
  void (async () => {
    try {
      await runGracefulShutdown('before-quit');
    } catch (error) {
      logger.error('Graceful shutdown failed in before-quit handler', { error });
    }
    allowImmediateQuit = true;
    app.quit();
  })();
});

app.on('will-quit', () => {
  logger.debug('will-quit triggered');
  clearForcedProcessExitTimer();
  if (unregisterEmbeddingHostIpcHandlers) {
    unregisterEmbeddingHostIpcHandlers();
    unregisterEmbeddingHostIpcHandlers = null;
  }
  if (unregisterLlmHostIpcHandlers) {
    unregisterLlmHostIpcHandlers();
    unregisterLlmHostIpcHandlers = null;
  }
  if (unregisterChunkingHostIpcHandlers) {
    unregisterChunkingHostIpcHandlers();
    unregisterChunkingHostIpcHandlers = null;
  }
  if (unregisterParserHostIpcHandlers) {
    unregisterParserHostIpcHandlers();
    unregisterParserHostIpcHandlers = null;
  }
  if (unregisterMainIpcHandlers) {
    unregisterMainIpcHandlers();
    unregisterMainIpcHandlers = null;
  }
  if (unregisterDesktopDiagnosticsIpcHandlers) {
    unregisterDesktopDiagnosticsIpcHandlers();
    unregisterDesktopDiagnosticsIpcHandlers = null;
  }
  if (unregisterLoggingIpcHandlers) {
    unregisterLoggingIpcHandlers();
    unregisterLoggingIpcHandlers = null;
  }
  if (unregisterMainPlatformIpcHandlers) {
    unregisterMainPlatformIpcHandlers();
    unregisterMainPlatformIpcHandlers = null;
  }
  if (unregisterMcpIpcHandlers) {
    unregisterMcpIpcHandlers();
    unregisterMcpIpcHandlers = null;
  }
  if (unregisterShellIpcHandlers) {
    unregisterShellIpcHandlers();
    unregisterShellIpcHandlers = null;
  }
  if (unregisterClipboardIpcHandlers) {
    unregisterClipboardIpcHandlers();
    unregisterClipboardIpcHandlers = null;
  }
  unregisterFileExportsIpcHandlers?.();
  unregisterFileExportsIpcHandlers = null;
  if (unregisterAssistantCheckpointIpcHandlers) {
    unregisterAssistantCheckpointIpcHandlers();
    unregisterAssistantCheckpointIpcHandlers = null;
  }
  if (unregisterGitIpcHandlers) {
    unregisterGitIpcHandlers();
    unregisterGitIpcHandlers = null;
  }
  unregisterChangesIpcHandlers?.();
  unregisterChangesIpcHandlers = null;
  unregisterWorktreesIpcHandlers?.();
  unregisterWorktreesIpcHandlers = null;
  worktreeService = null;
  unregisterBrowserIpcHandlers?.();
  unregisterBrowserIpcHandlers = null;
  if (unregisterHooksIpcHandlers) {
    unregisterHooksIpcHandlers();
    unregisterHooksIpcHandlers = null;
  }
  if (unregisterContextFilesIpcHandlers) {
    unregisterContextFilesIpcHandlers();
    unregisterContextFilesIpcHandlers = null;
  }
  if (unregisterSkillsIpcHandlers) {
    unregisterSkillsIpcHandlers();
    unregisterSkillsIpcHandlers = null;
  }
  if (unregisterUserCommandsIpcHandlers) {
    unregisterUserCommandsIpcHandlers();
    unregisterUserCommandsIpcHandlers = null;
  }
  if (unregisterUserPersonasIpcHandlers) {
    unregisterUserPersonasIpcHandlers();
    unregisterUserPersonasIpcHandlers = null;
  }
  if (unregisterTerminalIpcHandlers) {
    // Disposer also reaps every live pty (no orphaned shell survives quit).
    unregisterTerminalIpcHandlers();
    unregisterTerminalIpcHandlers = null;
  }
  if (unregisterNotesVaultIpcHandlers) {
    // Disposer also stops every live notes vault watcher.
    unregisterNotesVaultIpcHandlers();
    unregisterNotesVaultIpcHandlers = null;
  }
  removeLogBufferListener();
});

export { createWindow, registerIpcHandlers, setupSecurity };

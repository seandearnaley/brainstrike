import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { LogBuffer } from '@brainstrike/utils/log-buffer';
import { addLogListener, createLogger, LogLevel } from '@brainstrike/utils/logger';
import {
  type InitializeLoggingOptions,
  initializeLogging,
} from '@brainstrike/utils/logging-initializer';
import {
  applyLoggingPreferences,
  createDefaultLoggingPreferences,
  type LoggingPreferences,
} from '@brainstrike/utils/logging-preferences';
import { app, BrowserWindow, dialog, Menu, powerMonitor, shell } from 'electron';
import ElectronStore from 'electron-store';
import { configureAgentDevtoolsCommandLine } from './agent-devtools-config';
import { registerAssetProtocol, registerAssetProtocolPrivileges } from './asset-protocol';
import { startAssistantServer } from './assistant-server';
import { disposeLiveChildProcesses } from './assistant-server/execute-command-tool';
import { collectBackgroundRuntimeMetrics } from './background-runtime-metrics';
import { ChunkingHostManager } from './chunking-host-manager';
import { createWindow, noteNextWindowReload } from './create-window';
import {
  createDesktopDatabaseMaintenanceScheduler,
  type DesktopDatabaseMaintenanceScheduler,
} from './database-maintenance-scheduler';
import { getDbHostManager } from './db-host-manager';
import { closeDatabase, getDatabase, resetLocalDatabase } from './db-main';
import { getDesktopCrashRecoverySnapshot } from './desktop-crash-recovery';
import { resolveDesktopRendererLaunchMode } from './desktop-launch-mode';
import { getDesktopResetDiagnosticsSnapshot } from './desktop-reset-diagnostics';
import { createDesktopFactoryResetHandler } from './desktop-reset-platform';
import { isDesktopShuttingDown, markDesktopShuttingDown } from './desktop-shutdown-state';
import {
  type DimensionIndexStrategySelection,
  probeDimensionIndexRuntimeCapabilities,
  selectDimensionIndexStrategy,
} from './dimension-index-maintenance-capabilities';
import {
  createDesktopDimensionIndexMaintenanceScheduler,
  type DesktopDimensionIndexMaintenanceScheduler,
} from './dimension-index-maintenance-scheduler';
import { EmbeddingHostManager } from './embedding-host-manager';
import { createDatabaseRootResolver } from './git-ipc-handlers';
import { DISABLED_CHROMIUM_FEATURES } from './gpu-flags';
import { registerAgentIpcHandlers } from './ipc-agent';
import { registerChunkingHostIpcHandlers } from './ipc-chunking-host';
import { registerClipboardIpcHandlers } from './ipc-clipboard';
import { registerContextFilesIpcHandlers } from './ipc-context-files';
import { registerDesktopDiagnosticsIpcHandlers } from './ipc-desktop-diagnostics';
import { registerAssistantCheckpointIpcHandlers } from './ipc-domains/assistant-checkpoint-ipc';
import { registerEmbeddingHostIpcHandlers } from './ipc-embedding-host';
import { registerGitIpcHandlers } from './ipc-git';
import {
  cleanupDesktopLiveSubscriptionsForShutdown,
  getDesktopDatabaseWorkSchedulerSnapshot,
  registerIpcHandlers,
  runDesktopScheduledDatabaseWork,
  runWithDesktopDatabaseResetBarrier,
  setBackgrounded,
  waitForDesktopDatabaseWorkSchedulerIdle,
} from './ipc-handlers';
import { registerHooksIpcHandlers } from './ipc-hooks';
import { registerLlmHostIpcHandlers } from './ipc-llm-host';
import { cleanupMcpRuntimeForShutdown, registerMcpIpcHandlers } from './ipc-mcp';
import { registerNotesVaultIpc } from './ipc-notes-vault';
import { registerParserHostIpcHandlers } from './ipc-parser-host';
import { registerRuntimeIpcHandlers } from './ipc-runtime';
import { registerSecretsIpcHandlers } from './ipc-secrets';
import { registerShellIpcHandlers } from './ipc-shell';
import { registerTerminalIpc } from './ipc-terminal';
import { registerToolsIpcHandlers } from './ipc-tools';
import { registerUserCommandsIpcHandlers } from './ipc-user-commands';
import { registerUserPersonasIpcHandlers } from './ipc-user-personas';
import { LlmHostManager } from './llm-host-manager';
import {
  cloneLoggingPreferences,
  cloneLoggingSettingsPayload,
  registerLoggingIpcHandlers,
} from './logging-ipc';
import type { LoggingSettingsPayload } from './logging-shared';
import { registerMainPlatformIpcHandlers } from './main-platform-ipc';
import { isMainProcessHealthDegraded } from './main-process-health-log-level';
import { ParserHostManager } from './parser-host-manager';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { readDesktopPowerSnapshot } from './platform/desktop-power-snapshot';
import { createSecretsService } from './secrets';
import { setupSecurity } from './setup-security';
import type { DesktopSettingsStoreSchema } from './store-schema';
import { disposeAllTerminals } from './terminal-ipc-handlers';
import { getWindowRoleByWebContentsId } from './window-role';
import { readStoredWindowState, registerWindowStatePersistence } from './window-state';

const disableFileLogs = process.env['BRAINSTRIKE_DISABLE_FILE_LOGS'] === '1';
const E2E_USER_DATA_DIR_ENV = 'BRAINSTRIKE_E2E_USER_DATA_DIR';
const LOG_FILE_VERIFICATION_POLL_INTERVAL_MS = 250;
const LOG_FILE_VERIFICATION_TIMEOUT_MS = 5000;

configureAgentDevtoolsCommandLine(app.commandLine, process.env, process.argv);

// MUST run before app.whenReady(): privileged scheme registration is only
// honored if it happens before the app is ready.
registerAssetProtocolPrivileges();

function isElectronE2ETestMode(): boolean {
  return process.argv.includes('--test-mode') || process.env['ELECTRON_IS_E2E_TEST'] === 'true';
}

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

function applyE2EPathIsolation(): void {
  if (!isElectronE2ETestMode()) {
    return;
  }

  const userDataDir = readExplicitE2eUserDataDir();
  if (!userDataDir) {
    return;
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);

  const sessionDataDir = path.join(userDataDir, 'session-data');
  fs.mkdirSync(sessionDataDir, { recursive: true });
  app.setPath('sessionData', sessionDataDir);
}

applyE2EPathIsolation();

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
  enableDebugInProduction: true,
  includeTimestamp: initialLoggingPreferences.includeTimestamp,
  level: initialLoggingPreferences.level,
  runtime: 'electron-main',
};

const logger = createLogger('DesktopMain');
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
  });
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
      foregroundHealthProbe: async () => {
        throw new Error('Startup capability probe must not run foreground health measurement.');
      },
      initialMemoryBytes: null,
      now: () => new Date(),
      scratchTableName: `brainstrike_hnsw_probe_${randomUUID().replaceAll('-', '_')}`,
    });
    desktopDimensionIndexStrategySelection = selectDimensionIndexStrategy({
      concurrentIndexBuild: capabilities.concurrentIndexBuild,
      foregroundHealthThresholdMs: 5000,
    });
    logger.info('Dimension index maintenance capability probe completed', {
      concurrentIndexBuild: capabilities.concurrentIndexBuild,
      hnswIndexBuild: capabilities.hnswIndexBuild,
      maintenanceSettings: capabilities.maintenanceSettings,
      progressReporting: capabilities.progressReporting,
      strategy: desktopDimensionIndexStrategySelection.strategy,
      strategyReason: desktopDimensionIndexStrategySelection.reason,
    });
  } catch (error) {
    desktopDimensionIndexStrategySelection = null;
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
let unregisterMainIpcHandlers: null | (() => void) = null;
let unregisterChunkingHostIpcHandlers: null | (() => void) = null;
let unregisterParserHostIpcHandlers: null | (() => void) = null;
let unregisterEmbeddingHostIpcHandlers: null | (() => void) = null;
let unregisterLlmHostIpcHandlers: null | (() => void) = null;
let unregisterLoggingIpcHandlers: null | (() => void) = null;
let unregisterMainPlatformIpcHandlers: null | (() => void) = null;
let unregisterDesktopDiagnosticsIpcHandlers: null | (() => void) = null;
let unregisterMcpIpcHandlers: null | (() => void) = null;
let unregisterShellIpcHandlers: null | (() => void) = null;
let unregisterClipboardIpcHandlers: null | (() => void) = null;
let unregisterAssistantCheckpointIpcHandlers: null | (() => void) = null;
let unregisterGitIpcHandlers: null | (() => void) = null;
let unregisterHooksIpcHandlers: null | (() => void) = null;
let unregisterContextFilesIpcHandlers: null | (() => void) = null;
let unregisterUserCommandsIpcHandlers: null | (() => void) = null;
let unregisterUserPersonasIpcHandlers: null | (() => void) = null;
let unregisterTerminalIpcHandlers: null | (() => void) = null;
let unregisterNotesVaultIpcHandlers: null | (() => void) = null;
let desktopDatabaseMaintenanceScheduler: DesktopDatabaseMaintenanceScheduler | null = null;
let desktopDimensionIndexMaintenanceScheduler: DesktopDimensionIndexMaintenanceScheduler | null =
  null;
let desktopDimensionIndexStrategySelection: DimensionIndexStrategySelection | null = null;
let signalShutdownInFlight = false;
let allowImmediateQuit = false;
let gracefulShutdownPromise: Promise<void> | null = null;
let gracefulShutdownInFlight = false;
let forcedProcessExitTimeout: NodeJS.Timeout | null = null;
const SIGNAL_SHUTDOWN_TIMEOUT_MS = 5000 as const;

function serializeDesktopError(error: unknown): Record<string, string | undefined> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

async function runShutdownStep(
  step: string,
  fn: () => Promise<void>
): Promise<Record<string, string | undefined> | null> {
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
    const failures: Record<string, string | undefined>[] = [];

    if (stopAssistantServer) {
      const failure = await runShutdownStep('assistant-server', async () => {
        // Reap any shell command the assistant left running FIRST so no orphaned
        // subprocess (vitest/build) keeps eating CPU/battery after the app exits.
        disposeLiveChildProcesses();
        // Reap any live terminal pty so no interactive shell survives the app.
        disposeAllTerminals();
        if (stopAssistantServer) {
          await stopAssistantServer();
          stopAssistantServer = null;
        }
      });
      if (failure) {
        failures.push(failure);
      }
    }

    const mcpFailure = await runShutdownStep('mcp-runtime', cleanupMcpRuntimeForShutdown);
    if (mcpFailure) {
      failures.push(mcpFailure);
    }

    const chunkingFailure = await runShutdownStep('chunking-host', async () => {
      await chunkingHostManager.dispose();
    });
    if (chunkingFailure) {
      failures.push(chunkingFailure);
    }

    const parserFailure = await runShutdownStep('parser-host', async () => {
      await parserHostManager.stop();
    });
    if (parserFailure) {
      failures.push(parserFailure);
    }

    const embeddingFailure = await runShutdownStep('embedding-host', async () => {
      await embeddingHostManager.dispose();
    });
    if (embeddingFailure) {
      failures.push(embeddingFailure);
    }

    const llmFailure = await runShutdownStep('llm-host', async () => {
      await llmHostManager.dispose();
    });
    if (llmFailure) {
      failures.push(llmFailure);
    }

    const databaseFailure = await runShutdownStep('database', async () => {
      desktopDimensionIndexMaintenanceScheduler?.stop();
      desktopDimensionIndexMaintenanceScheduler = null;
      desktopDatabaseMaintenanceScheduler?.stop();
      desktopDatabaseMaintenanceScheduler = null;
      await cleanupDesktopLiveSubscriptionsForShutdown();
      await waitForDesktopDatabaseWorkSchedulerIdle();
      await cleanupDesktopLiveSubscriptionsForShutdown();
      await closeDatabase();
    });
    if (databaseFailure) {
      failures.push(databaseFailure);
    }

    if (failures.length > 0) {
      logger.warn('Graceful shutdown completed with cleanup failures', {
        failures,
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
const chunkingHostManager = new ChunkingHostManager();
const parserHostManager = new ParserHostManager();
const embeddingHostManager = new EmbeddingHostManager();
const llmHostManager = new LlmHostManager();
const handleResetLocal = createDesktopFactoryResetHandler({
  cleanupLiveSubscriptionsForShutdown: cleanupDesktopLiveSubscriptionsForShutdown,
  logger,
  resetLocalDatabase,
  runtimes: [
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
});
desktopDimensionIndexMaintenanceScheduler = createDesktopDimensionIndexMaintenanceScheduler({
  getDatabase,
  getDimensionIndexStrategy: () => desktopDimensionIndexStrategySelection,
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
        sourceWindowRole: getWindowRoleByWebContentsId(senderId) ?? 'visible-ui',
      },
    });
  },
  openDestination: openLogDestination,
  selectDestination: selectLogDestination,
  setPreferences: applyAndPersistLoggingPreferences,
});

// Register IPC handlers early to avoid renderer calls racing registration during startup.
unregisterMainIpcHandlers = registerIpcHandlers(fileSystem, storage, getSettingsStore, {
  chunkingHostManager,
  embeddingHostManager,
  getDimensionIndexMaintenanceStrategy: () =>
    desktopDimensionIndexStrategySelection?.strategy ?? null,
  onResetLocal: handleResetLocal,
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
unregisterAssistantCheckpointIpcHandlers = registerAssistantCheckpointIpcHandlers();
unregisterGitIpcHandlers = registerGitIpcHandlers();
unregisterHooksIpcHandlers = registerHooksIpcHandlers();
unregisterContextFilesIpcHandlers = registerContextFilesIpcHandlers();
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

  // REMOVED: enable-gpu-rasterization + enable-zero-copy
  // These push rasterization onto the same GPU command queue that ONNX/Dawn
  // uses for WebGPU inference. Under sustained background embedding load,
  // the Metal command queue race causes a Dawn CHECK() → SIGTRAP at ~4 min.

  // Prevent macOS from deprioritizing the renderer's GPU context when the
  // window is occluded (behind another window). Without this, the GPU process
  // may starve WebGPU command submissions after ~4 minutes.
  app.commandLine.appendSwitch('disable-features', DISABLED_CHROMIUM_FEATURES.join(','));

  if (!e2eTestMode) {
    app.on('second-instance', () => {
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
      logger.debug('App ready, starting initialization...');

      const launchMode = resolveDesktopRendererLaunchMode({
        argv: process.argv,
        isPackaged: app.isPackaged,
        isTestMode: e2eTestMode,
      });
      logger.debug('Resolved desktop launch mode', { launchMode });

      // Register the root-validated `brainstrike-asset://` protocol now that the
      // app is ready (protocol.handle requires ready). The resolver validates
      // renderer-supplied paths against the DB `roots` table — the SAME source
      // the git/read/search tools use — resolving the DB lazily per request.
      registerAssetProtocol(createDatabaseRootResolver(getDatabase));

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
          });
          logger.debug('File logging enabled after app.ready', { logFile: resolvedLogPath });
        }
      }
      void verifyActiveLogFile('app-ready');

      logger.debug('Setting up IPC handlers that require app readiness...');
      registerSecretsIpcHandlers(createSecretsService());
      registerAgentIpcHandlers();
      unregisterMcpIpcHandlers = registerMcpIpcHandlers();
      registerToolsIpcHandlers({ embeddingHostManager });
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
                try {
                  await resetLocalDatabase();
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
                  dialog.showErrorBox('Reset Failed', message);
                }
              },
              id: 'dev-reset-db',
              label: 'Reset Local Database…',
            },
          ],
        },
      ];
      Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

      // Start local data stream server for desktop assistant-ui
      let assistantUrl = '';
      try {
        const { url, stop } = await startAssistantServer(undefined, {
          embeddingHostManager,
          llmHostManager,
        });
        assistantUrl = url;
        stopAssistantServer = stop;
        logger.debug(`Assistant server started at ${assistantUrl}`);
      } catch (err) {
        logger.error('Failed to start assistant server:', err);
      }

      unregisterMainPlatformIpcHandlers = registerMainPlatformIpcHandlers({
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

      logger.debug('Creating main window...');
      const mainWindow = await createMainWindow();
      logger.debug('Main window created successfully');

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
      {
        const { Worker } = await import('node:worker_threads');
        const watchdogSource = [
          'const { parentPort } = require("node:worker_threads");',
          'const fs = require("node:fs");',
          'let lastHb = Date.now();',
          'let logPath = null;',
          'const CHECK_MS = 5000;',
          'const FROZEN_MS = 20000;',
          'parentPort.on("message", (m) => {',
          '  if (m.type === "heartbeat") lastHb = Date.now();',
          '  else if (m.type === "config") logPath = m.logPath;',
          '});',
          'setInterval(() => {',
          '  const age = Date.now() - lastHb;',
          '  if (age > FROZEN_MS) {',
          '    const d = JSON.stringify({',
          '      level: 50,',
          '      time: new Date().toISOString(),',
          '      scope: "MainWatchdog",',
          '      msg: "MAIN_THREAD_UNRESPONSIVE",',
          '      heartbeatAgeMs: age,',
          '      cpuUser: process.cpuUsage().user,',
          '      cpuSystem: process.cpuUsage().system,',
          '      rssKb: Math.round(process.memoryUsage().rss / 1024),',
          '      heapUsedKb: Math.round(process.memoryUsage().heapUsed / 1024),',
          '    });',
          '    process.stderr.write(d + "\\n");',
          '    if (logPath) {',
          '      try { fs.appendFileSync(logPath, d + "\\n"); } catch (_) {}',
          '    }',
          '  }',
          '}, CHECK_MS);',
        ].join('\n');

        const watchdog = new Worker(watchdogSource, { eval: true });
        watchdog.unref();
        watchdog.postMessage({ logPath: getLogFilePath(), type: 'config' });

        setInterval(() => {
          watchdog.postMessage({ type: 'heartbeat' });
        }, 5000).unref();

        logger.debug('main-thread watchdog started');
      }

      // Power state monitoring: gracefully pause/resume heavy subsystems on sleep/wake
      powerMonitor.on('suspend', () => {
        logger.info('power:suspend');
        clearPendingPowerResume();
        broadcastPowerState('suspend');
      });

      powerMonitor.on('resume', () => {
        logger.info('power:resume');
        // Delay to let OS settle (GPU re-init, network reconnect)
        schedulePowerResume();
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
  if (unregisterAssistantCheckpointIpcHandlers) {
    unregisterAssistantCheckpointIpcHandlers();
    unregisterAssistantCheckpointIpcHandlers = null;
  }
  if (unregisterGitIpcHandlers) {
    unregisterGitIpcHandlers();
    unregisterGitIpcHandlers = null;
  }
  if (unregisterHooksIpcHandlers) {
    unregisterHooksIpcHandlers();
    unregisterHooksIpcHandlers = null;
  }
  if (unregisterContextFilesIpcHandlers) {
    unregisterContextFilesIpcHandlers();
    unregisterContextFilesIpcHandlers = null;
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

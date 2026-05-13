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
import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, shell } from 'electron';
import ElectronStore from 'electron-store';
import { startAssistantServer } from './assistant-server';
import { setAssistantEmbeddingHostManager } from './assistant-server/retrieval-tool';
import { collectBackgroundRuntimeMetrics } from './background-runtime-metrics';
import { ChunkingHostManager } from './chunking-host-manager';
import { createWindow, noteNextWindowReload } from './create-window';
import {
  createDesktopDatabaseMaintenanceScheduler,
  type DesktopDatabaseMaintenanceScheduler,
} from './database-maintenance-scheduler';
import { closeDatabase, getDatabase, resetLocalDatabase } from './db-main';
import { resetDesktopApplicationData } from './desktop-factory-reset';
import { resolveDesktopRendererLaunchMode } from './desktop-launch-mode';
import { EmbeddingHostManager } from './embedding-host-manager';
import { DISABLED_CHROMIUM_FEATURES } from './gpu-flags';
import { registerAgentIpcHandlers } from './ipc-agent';
import { registerChunkingHostIpcHandlers } from './ipc-chunking-host';
import { registerEmbeddingHostIpcHandlers } from './ipc-embedding-host';
import {
  cleanupDesktopLiveSubscriptionsForShutdown,
  getDesktopDatabaseWorkSchedulerSnapshot,
  registerIpcHandlers,
  runDesktopScheduledDatabaseWork,
  runWithDesktopDatabaseResetBarrier,
  setBackgrounded,
  waitForDesktopDatabaseWorkSchedulerIdle,
} from './ipc-handlers';
import { registerLlmHostIpcHandlers } from './ipc-llm-host';
import { registerMcpIpcHandlers } from './ipc-mcp';
import { registerRuntimeIpcHandlers } from './ipc-runtime';
import { registerSecretsIpcHandlers } from './ipc-secrets';
import { registerToolsIpcHandlers } from './ipc-tools';
import { LlmHostManager } from './llm-host-manager';
import {
  cloneLoggingPreferences,
  cloneLoggingSettingsPayload,
  registerLoggingIpcHandlers,
} from './logging-ipc';
import type { LoggingSettingsPayload } from './logging-shared';
import { createSecretsService } from './secrets';
import { setupSecurity } from './setup-security';
import type { DesktopSettingsStoreSchema } from './store-schema';
import { getWindowRoleByWebContentsId } from './window-role';
import { readStoredWindowState, registerWindowStatePersistence } from './window-state';

const disableFileLogs = process.env['BRAINSTRIKE_DISABLE_FILE_LOGS'] === '1';
const E2E_USER_DATA_DIR_ENV = 'BRAINSTRIKE_E2E_USER_DATA_DIR';
const LOG_FILE_VERIFICATION_POLL_INTERVAL_MS = 250;
const LOG_FILE_VERIFICATION_TIMEOUT_MS = 5000;

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
    level: LogLevel.INFO,
    consoleLevel: LogLevel.WARN,
    includeTimestamp: true,
    file: {
      enabled: !disableFileLogs && Boolean(logPath),
      destination: logPath ?? null,
      level: LogLevel.INFO,
      append: true,
      mkdir: true,
    },
  });
}

function createLegacyDesktopDefaultPreferences(): LoggingPreferences {
  const logPath = getLogFilePath();
  return createDefaultLoggingPreferences({
    level: LogLevel.DEBUG,
    consoleLevel: LogLevel.INFO,
    includeTimestamp: true,
    file: {
      enabled: !disableFileLogs && Boolean(logPath),
      destination: logPath ?? null,
      level: LogLevel.DEBUG,
      append: true,
      mkdir: true,
    },
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
    level: LogLevel.DEBUG,
    file: {
      ...currentDefaults.file,
      level: LogLevel.DEBUG,
    },
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
    redactPaths: stored.redactPaths ?? base.redactPaths,
    file: {
      ...base.file,
      ...(stored.file ?? {}),
    },
  };
}

function sanitizeDesktopPreferences(preferences: LoggingPreferences): LoggingPreferences {
  const normalized: LoggingPreferences = {
    ...preferences,
    redactPaths: preferences.redactPaths
      .map((value) => value.trim())
      .filter((value) => value.length),
    file: { ...preferences.file },
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
      size: stats.size,
      mtimeMs: stats.mtimeMs,
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
    redactPaths: preferences.redactPaths
      .map((value) => value.trim())
      .filter((value) => value.length),
    file: { ...preferences.file },
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
  runtime: 'electron-main',
  level: initialLoggingPreferences.level,
  consoleLevel: initialLoggingPreferences.consoleLevel,
  includeTimestamp: initialLoggingPreferences.includeTimestamp,
  appName: 'brainstrike-desktop',
  appVersion: app.getVersion(),
  baseBindings: {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    ...(initialLoggingPreferences.file.enabled && initialLoggingPreferences.file.destination
      ? { logFile: initialLoggingPreferences.file.destination }
      : {}),
  },
  enableDebugInProduction: true,
};

const logger = createLogger('DesktopMain');
logger.debug('Main process started');
const mainLogBuffer = new LogBuffer({ size: 3000 });
const removeLogBufferListener = addLogListener((record) => {
  mainLogBuffer.push(record);
});

if (initialLoggingPreferences.file.enabled && initialLoggingPreferences.file.destination) {
  loggingOptions.file = {
    destination: initialLoggingPreferences.file.destination,
    level: initialLoggingPreferences.file.level,
    mkdir: initialLoggingPreferences.file.mkdir,
    append: initialLoggingPreferences.file.append,
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
    runtime: 'electron' as const,
    fileLoggingSupported: !disableFileLogs,
    canSelectDestination: !disableFileLogs,
    defaultDestination: getLogFilePath() ?? null,
    reason: disableFileLogs ? 'File logging disabled by BRAINSTRIKE_DISABLE_FILE_LOGS=1' : null,
  };
}

function getLoggingSettingsPayload(): LoggingSettingsPayload {
  return cloneLoggingSettingsPayload({
    preferences: currentLoggingPreferences,
    capabilities: getLoggingCapabilities(),
  });
}

async function verifyActiveLogFile(reason: string): Promise<void> {
  const { enabled, destination } = currentLoggingPreferences.file;
  const defaultDestination = getLoggingCapabilities().defaultDestination;

  logger.info('Desktop file logging configuration resolved', {
    reason,
    fileLoggingEnabled: enabled,
    configuredDestination: destination,
    defaultDestination,
    appReady: app.isReady(),
  });

  if (!(enabled && destination)) {
    logger.warn('Desktop file logging is not active', {
      reason,
      fileLoggingEnabled: enabled,
      configuredDestination: destination,
      defaultDestination,
    });
    return;
  }

  const before = await readFileStatSnapshot(destination);
  logger.info('Desktop file logging verification marker', {
    reason,
    logFile: destination,
    previousSizeBytes: before?.size ?? null,
    previousMtimeMs: before?.mtimeMs ?? null,
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
        reason,
        logFile: destination,
        sizeBytes: after.size,
        mtimeMs: after.mtimeMs,
        previousSizeBytes: before?.size ?? null,
        previousMtimeMs: before?.mtimeMs ?? null,
      });
      return;
    }
  }

  const finalStats = await readFileStatSnapshot(destination);
  logger.error('Desktop file logging did not advance on disk after verification marker', {
    reason,
    logFile: destination,
    existsOnDisk: finalStats !== null,
    sizeBytes: finalStats?.size ?? null,
    mtimeMs: finalStats?.mtimeMs ?? null,
    previousSizeBytes: before?.size ?? null,
    previousMtimeMs: before?.mtimeMs ?? null,
    defaultDestination,
  });
}

async function selectLogDestination(): Promise<string | null> {
  if (!getLoggingCapabilities().canSelectDestination) {
    return null;
  }

  const defaultPath =
    currentLoggingPreferences.file.destination ?? getLogFilePath() ?? app.getPath('logs');

  const result = await dialog.showSaveDialog({
    title: 'Choose log file location',
    buttonLabel: 'Use Log File',
    defaultPath,
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

let stopAssistantServer: null | (() => Promise<void>) = null;
let unregisterMainIpcHandlers: null | (() => void) = null;
let unregisterChunkingHostIpcHandlers: null | (() => void) = null;
let unregisterEmbeddingHostIpcHandlers: null | (() => void) = null;
let unregisterLlmHostIpcHandlers: null | (() => void) = null;
let unregisterLoggingIpcHandlers: null | (() => void) = null;
let desktopDatabaseMaintenanceScheduler: DesktopDatabaseMaintenanceScheduler | null = null;
let signalShutdownInFlight = false;
let allowImmediateQuit = false;
let gracefulShutdownPromise: Promise<void> | null = null;
let gracefulShutdownInFlight = false;
let forcedProcessExitTimeout: NodeJS.Timeout | null = null;
const SIGNAL_SHUTDOWN_TIMEOUT_MS = 5000 as const;

function serializeDesktopError(error: unknown): Record<string, string | undefined> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
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

async function handleResetLocal(): Promise<{ success: boolean; message?: string }> {
  try {
    await resetDesktopApplicationData({
      resetDatabaseProfile: async () => {
        await runWithDesktopDatabaseResetBarrier(async () => {
          await cleanupDesktopLiveSubscriptionsForShutdown();
          await waitForDesktopDatabaseWorkSchedulerIdle();
          await cleanupDesktopLiveSubscriptionsForShutdown();
          await resetLocalDatabase();
        });
      },
      stopBackgroundRuntimes: async () => {
        await Promise.all([
          embeddingHostManager.stop(),
          chunkingHostManager.stop(),
          llmHostManager.stop(),
        ]);
      },
      userDataPath: app.getPath('userData'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to reset desktop application data:', error);
    return { success: false, message };
  }

  return { success: true };
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
  if (gracefulShutdownPromise) {
    await gracefulShutdownPromise;
    return;
  }

  gracefulShutdownPromise = (async () => {
    const failures: Record<string, string | undefined>[] = [];

    if (stopAssistantServer) {
      const failure = await runShutdownStep('assistant-server', async () => {
        if (stopAssistantServer) {
          await stopAssistantServer();
          stopAssistantServer = null;
        }
      });
      if (failure) {
        failures.push(failure);
      }
    }

    const chunkingFailure = await runShutdownStep('chunking-host', async () => {
      await chunkingHostManager.dispose();
    });
    if (chunkingFailure) {
      failures.push(chunkingFailure);
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
        trigger,
        failures,
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
const embeddingHostManager = new EmbeddingHostManager();
const llmHostManager = new LlmHostManager();
setAssistantEmbeddingHostManager(embeddingHostManager);

desktopDatabaseMaintenanceScheduler = createDesktopDatabaseMaintenanceScheduler({
  getDatabase,
  getSchedulerSnapshot: getDesktopDatabaseWorkSchedulerSnapshot,
  logger,
  runScheduledWork: runDesktopScheduledDatabaseWork,
});

unregisterLoggingIpcHandlers = registerLoggingIpcHandlers({
  getState: getLoggingSettingsPayload,
  setPreferences: applyAndPersistLoggingPreferences,
  selectDestination: selectLogDestination,
  openDestination: openLogDestination,
  getBufferedLogs: () => mainLogBuffer.getRecords(),
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
});

// Register IPC handlers early to avoid renderer calls racing registration during startup.
unregisterMainIpcHandlers = registerIpcHandlers(fileSystem, storage, getSettingsStore, {
  chunkingHostManager,
  embeddingHostManager,
  onResetLocal: handleResetLocal,
});
unregisterChunkingHostIpcHandlers = registerChunkingHostIpcHandlers(chunkingHostManager);
unregisterEmbeddingHostIpcHandlers = registerEmbeddingHostIpcHandlers(embeddingHostManager);
unregisterLlmHostIpcHandlers = registerLlmHostIpcHandlers(llmHostManager);

// Add global error handlers to catch silent crashes
process.on('uncaughtException', (error) => {
  const serializedError =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
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
          name: reason.name,
          message: reason.message,
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
              enabled: true,
              destination: resolvedLogPath,
            },
          };
          applyLoggingPreferences(currentLoggingPreferences, 'electron-main', {
            baseBindings: {
              logFile: resolvedLogPath,
              platform: process.platform,
              arch: process.arch,
              electron: process.versions.electron,
              node: process.versions.node,
            },
          });
          logger.debug('File logging enabled after app.ready', { logFile: resolvedLogPath });
        }
      }
      void verifyActiveLogFile('app-ready');

      logger.debug('Setting up IPC handlers that require app readiness...');
      registerSecretsIpcHandlers(createSecretsService());
      registerAgentIpcHandlers();
      registerMcpIpcHandlers();
      registerToolsIpcHandlers();
      registerRuntimeIpcHandlers();
      logger.debug('Ready-dependent IPC handlers registered successfully');
      desktopDatabaseMaintenanceScheduler?.start();
      logger.debug('Scheduled desktop database maintenance started');

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
              label: 'Reload',
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
              id: 'dev-reset-db',
              label: 'Reset Local Database…',
              accelerator:
                process.platform === 'darwin' ? 'Cmd+Shift+Backspace' : 'Ctrl+Shift+Backspace',
              click: async () => {
                const res = await dialog.showMessageBox({
                  type: 'warning',
                  buttons: ['Reset', 'Cancel'],
                  defaultId: 1,
                  cancelId: 1,
                  title: 'Reset Local Database',
                  message:
                    'This will delete the local database files and reinitialize on next access. This action cannot be undone.',
                });
                if (res.response !== 0) {
                  return;
                }
                try {
                  await resetLocalDatabase();
                  await dialog.showMessageBox({
                    type: 'info',
                    buttons: ['OK'],
                    title: 'Database Reset',
                    message: 'Local database has been reset. The app will reload.',
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
            },
          ],
        },
      ];
      Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

      // Start local data stream server for desktop assistant-ui
      let assistantUrl = '';
      try {
        const { url, stop } = await startAssistantServer();
        assistantUrl = url;
        stopAssistantServer = stop;
        logger.debug(`Assistant server started at ${assistantUrl}`);
      } catch (err) {
        logger.error('Failed to start assistant server:', err);
      }

      // IPC to provide assistant URL to renderer
      ipcMain.handle('assistant:get-url', () => assistantUrl);
      ipcMain.handle('app:lifecycle:note-reload-intent', async (event, reason: unknown) => {
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          throw new Error('Renderer reload intent reason must be a non-empty string.');
        }
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || window.isDestroyed()) {
          throw new Error('Renderer reload intent must originate from a live BrowserWindow.');
        }
        noteNextWindowReload(window, {
          reason: reason.trim(),
          source: 'renderer',
        });
      });

      const createMainWindow = async () => {
        // Store is guaranteed to exist after app.whenReady()
        const store = getSettingsStore();
        if (!store) {
          throw new Error('Settings store unavailable after app.ready - this should never happen');
        }
        const storedWindowState = readStoredWindowState(store);
        const win = await createWindow({ windowState: storedWindowState });
        registerWindowStatePersistence(win, store);
        return win;
      };

      const broadcastPowerState = (state: 'resume' | 'suspend') => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed()) {
            continue;
          }
          window.webContents.send('app:power-state', state);
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
            cpuPercent: (cpuPercent * 100).toFixed(1),
            loopLagP50Ms: p50.toFixed(1),
            loopLagP99Ms: p99.toFixed(1),
            loopLagMaxMs: max.toFixed(1),
            rssKb: (mem.rss / 1024).toFixed(0),
            heapUsedKb: (mem.heapUsed / 1024).toFixed(0),
            handles,
            requests,
            backgroundRuntimeMetrics: collectBackgroundRuntimeMetrics(),
          };

          // Always log — if entries stop appearing, the event loop is stuck.
          // NOTE: pino API requires (obj, msg) order to merge fields into the entry.
          if (cpuPercent > 0.1 || p99 > 100 || max > 500) {
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
        watchdog.postMessage({ type: 'config', logPath: getLogFilePath() });

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
  setAssistantEmbeddingHostManager(null);
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
  if (unregisterMainIpcHandlers) {
    unregisterMainIpcHandlers();
    unregisterMainIpcHandlers = null;
  }
  if (unregisterLoggingIpcHandlers) {
    unregisterLoggingIpcHandlers();
    unregisterLoggingIpcHandlers = null;
  }
  removeLogBufferListener();
});

export { createWindow, registerIpcHandlers, setupSecurity };

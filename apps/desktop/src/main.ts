import fs from 'node:fs';
import path from 'node:path';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import { ElectronStorageAdapter } from '@brainstrike/storage';

// Raw debug log to verify main process startup
// biome-ignore lint/suspicious/noConsole: Critical startup debugging
console.log('--- RAW CONSOLE LOG: MAIN PROCESS EXECUTING ---');

import {
  addLogListener,
  applyLoggingPreferences,
  createDefaultLoggingPreferences,
  createLogger,
  type InitializeLoggingOptions,
  initializeLogging,
  LogBuffer,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/utils';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  powerSaveBlocker,
  shell,
} from 'electron';
import ElectronStore from 'electron-store';
import { startAssistantServer } from './assistant-server';
import { createWindow } from './create-window';
import { closeDatabase, resetLocalDatabase } from './db-main';
import { registerAgentIpcHandlers } from './ipc-agent';
import { registerIpcHandlers, setBackgrounded } from './ipc-handlers';
import { registerMcpIpcHandlers } from './ipc-mcp';
import { registerSecretsIpcHandlers } from './ipc-secrets';
import { registerToolsIpcHandlers } from './ipc-tools';
import {
  cloneLoggingPreferences,
  cloneLoggingSettingsPayload,
  registerLoggingIpcHandlers,
} from './logging-ipc';
import type { LoggingSettingsPayload } from './logging-shared';
import { createSecretsService } from './secrets';
import { setupSecurity } from './setup-security';
import type { DesktopSettingsStoreSchema } from './store-schema';
import { readStoredWindowState, registerWindowStatePersistence } from './window-state';

const disableFileLogs = process.env['BRAINSTRIKE_DISABLE_FILE_LOGS'] === '1';
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

// Note: Embedding worker configuration moved to renderer process (see renderer/components/embedding-worker-provider.tsx)
// Main process cannot run Web Workers - WASM/WebGPU require browser context

function createDesktopDefaultPreferences(): LoggingPreferences {
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
    return record?.v1;
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
logger.info('Main process started');
const mainLogBuffer = new LogBuffer({ size: 1000 });
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
let signalShutdownInFlight = false;
let allowImmediateQuit = false;
let gracefulShutdownPromise: Promise<void> | null = null;
let forcedProcessExitTimeout: NodeJS.Timeout | null = null;
const SIGNAL_SHUTDOWN_TIMEOUT_MS = 5000 as const;

async function handleResetLocal(): Promise<{ success: boolean; message?: string }> {
  // Note: Embedding worker runs in renderer, not main process, so no need to stop it here

  try {
    await resetLocalDatabase();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to reset local database:', error);
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
    try {
      await gracefulShutdownPromise;
    } catch (error) {
      logger.error('Failed during graceful shutdown', { trigger, error });
    }
    return;
  }

  gracefulShutdownPromise = (async () => {
    if (stopAssistantServer) {
      await stopAssistantServer();
      stopAssistantServer = null;
    }
    await closeDatabase();
    clearForcedProcessExitTimer();
  })();

  try {
    await gracefulShutdownPromise;
  } catch (error) {
    logger.error('Failed during graceful shutdown', { trigger, error });
  }
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

registerLoggingIpcHandlers({
  getState: getLoggingSettingsPayload,
  setPreferences: applyAndPersistLoggingPreferences,
  selectDestination: selectLogDestination,
  openDestination: openLogDestination,
  getBufferedLogs: () => mainLogBuffer.getRecords(),
});

// Register IPC handlers early to avoid renderer calls racing registration during startup.
unregisterMainIpcHandlers = registerIpcHandlers(fileSystem, storage, getSettingsStore, {
  onResetLocal: handleResetLocal,
});

// Add global error handlers to catch silent crashes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', { reason, promise });
});
registerShutdownSignalHandlers();

const singleInstanceLockAcquired =
  typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true;

if (singleInstanceLockAcquired) {
  // REMOVED: enable-gpu-rasterization + enable-zero-copy
  // These push rasterization onto the same GPU command queue that ONNX/Dawn
  // uses for WebGPU inference. Under sustained background embedding load,
  // the Metal command queue race causes a Dawn CHECK() → SIGTRAP at ~4 min.

  // Prevent macOS from deprioritizing the renderer's GPU context when the
  // window is occluded (behind another window). Without this, the GPU process
  // may starve WebGPU command submissions after ~4 minutes.
  app.commandLine.appendSwitch(
    'disable-features',
    'MacWebContentsOcclusion,SpareRendererForSitePerProcess'
  );

  app.on('second-instance', () => {
    const existingWindow = BrowserWindow.getAllWindows()[0];
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
    try {
      logger.info('App ready, starting initialization...');

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
          logger.info('File logging enabled after app.ready', { logFile: resolvedLogPath });
        }
      }

      logger.info('Setting up IPC handlers that require app readiness...');
      registerSecretsIpcHandlers(createSecretsService());
      registerAgentIpcHandlers();
      registerMcpIpcHandlers();
      registerToolsIpcHandlers();
      logger.info('Ready-dependent IPC handlers registered successfully');

      // Setup security before creating windows
      setupSecurity();
      logger.info('Security setup complete');

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
            { role: 'reload' },
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
        logger.info(`Assistant server started at ${assistantUrl}`);
      } catch (err) {
        logger.error('Failed to start assistant server:', err);
      }

      // IPC to provide assistant URL to renderer
      ipcMain.handle('assistant:get-url', () => assistantUrl);

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

      logger.info('Creating main window...');
      const mainWindow = await createMainWindow();
      logger.info('Main window created successfully');

      // Prevent macOS App Nap from throttling the main process.
      // App Nap kicks in after ~5 min of being unfocused and modifies timer
      // coalescing, which can break libuv's event loop and cause 100% CPU spin.
      const powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
      logger.info('powerSaveBlocker started', { id: powerSaveId });

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
          };

          // Always log — if entries stop appearing, the event loop is stuck.
          // NOTE: pino API requires (obj, msg) order to merge fields into the entry.
          if (cpuPercent > 0.1 || p99 > 100 || max > 500) {
            logger.warn(payload, 'main-process-health');
          } else {
            logger.info(payload, 'main-process-health');
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

        logger.info('main-thread watchdog started');
      }

      // Power state monitoring: gracefully pause/resume heavy subsystems on sleep/wake
      powerMonitor.on('suspend', () => {
        logger.info('power:suspend');
        mainWindow.webContents.send('app:power-state', 'suspend');
      });

      powerMonitor.on('resume', () => {
        logger.info('power:resume');
        // Delay to let OS settle (GPU re-init, network reconnect)
        setTimeout(() => {
          mainWindow.webContents.send('app:power-state', 'resume');
        }, 2000);
      });

      powerMonitor.on('lock-screen', () => logger.info('power:lock-screen'));
      powerMonitor.on('unlock-screen', () => logger.info('power:unlock-screen'));

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
        if (BrowserWindow.getAllWindows().length === 0) {
          await createMainWindow();
        }
      });
    } catch (error) {
      logger.error('Failed to initialize application:', error);
      // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
      console.error('❌ FATAL: Failed to initialize application:', error);
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
  // biome-ignore lint/suspicious/noConsole: Critical shutdown debugging
  console.log('--- RAW CONSOLE LOG: BEFORE-QUIT TRIGGERED ---');
  if (allowImmediateQuit) {
    return;
  }

  event.preventDefault();
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
  // biome-ignore lint/suspicious/noConsole: Critical shutdown debugging
  console.log('--- RAW CONSOLE LOG: WILL-QUIT TRIGGERED ---');
  clearForcedProcessExitTimer();
  if (unregisterMainIpcHandlers) {
    unregisterMainIpcHandlers();
    unregisterMainIpcHandlers = null;
  }
  removeLogBufferListener();
});

export { createWindow, setupSecurity, registerIpcHandlers };

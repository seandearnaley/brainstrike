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
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import ElectronStore from 'electron-store';
import { startAssistantServer } from './assistant-server';
import { createWindow } from './create-window';
import { closeDatabase, resetLocalDatabase } from './db-main';
import { registerAgentIpcHandlers } from './ipc-agent';
import { registerIpcHandlers } from './ipc-handlers';
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
let logFilePath: string | undefined;
function getLogFilePath(): string | undefined {
  if (disableFileLogs) {
    return undefined;
  }
  // CRITICAL: app.getPath() throws before app.ready - return undefined and configure later
  if (!app.isReady()) {
    return undefined;
  }
  if (logFilePath === undefined) {
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

function applyAndPersistLoggingPreferences(
  preferences: LoggingPreferences
): LoggingSettingsPayload {
  const normalized = sanitizeDesktopPreferences(preferences);
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

app.whenReady().then(async () => {
  try {
    logger.info('App ready, starting initialization...');

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
    await createMainWindow();
    logger.info('Main window created successfully');

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean shutdown
app.on('before-quit', async () => {
  // biome-ignore lint/suspicious/noConsole: Critical shutdown debugging
  console.log('--- RAW CONSOLE LOG: BEFORE-QUIT TRIGGERED ---');
  try {
    if (stopAssistantServer) {
      await stopAssistantServer();
      stopAssistantServer = null;
    }
    await closeDatabase();
  } catch (error) {
    logger.error('Error closing database:', error);
  }
});

app.on('will-quit', () => {
  // biome-ignore lint/suspicious/noConsole: Critical shutdown debugging
  console.log('--- RAW CONSOLE LOG: WILL-QUIT TRIGGERED ---');
  if (unregisterMainIpcHandlers) {
    unregisterMainIpcHandlers();
    unregisterMainIpcHandlers = null;
  }
  removeLogBufferListener();
});

export { createWindow, setupSecurity, registerIpcHandlers };

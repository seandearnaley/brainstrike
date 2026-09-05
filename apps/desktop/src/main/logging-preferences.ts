/**
 * Desktop logging-preferences lifecycle, moved out of `main.ts` (BST-1648
 * step 4 — bookkeeping only, behaviour preserved line for line): the
 * desktop/legacy defaults, stored-preference migration + sanitization,
 * persistence into the settings store, the Settings payload, destination
 * selection/open, on-disk verification, and the app-ready file-logging
 * re-enable. `main.ts` still owns the ORDER of the module-scope boot
 * sequence (createLogger → watchdog → log buffer → `initializeLogging` →
 * `applyInitial`) and passes the Electron surfaces in; this module owns the
 * preference STATE (`current`) and every transition of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  applyLoggingPreferences,
  createDefaultLoggingPreferences,
  type createLogger,
  type FileTransportConfig,
  type InitializeLoggingOptions,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/logging';
import type { App, Dialog, Shell } from 'electron';
import type ElectronStore from 'electron-store';
import { cloneLoggingPreferences, cloneLoggingSettingsPayload } from '../logging-ipc';
import type { LoggingSettingsPayload } from '../logging-shared';
import type { DesktopSettingsStoreSchema } from '../store-schema';

const LOG_FILE_VERIFICATION_POLL_INTERVAL_MS = 250;
const LOG_FILE_VERIFICATION_TIMEOUT_MS = 5000;

type DesktopMainLogger = Pick<ReturnType<typeof createLogger>, 'debug' | 'error' | 'info' | 'warn'>;

/**
 * Electron surfaces are taken as LAZY functions (not the `dialog`/`shell`
 * objects): the controller is constructed at module scope, and the main-
 * process test harnesses mock `electron` strictly — touching an export the
 * mock does not define throws at import time.
 */
export interface DesktopLoggingPreferencesDeps {
  readonly app: Pick<App, 'getPath' | 'getVersion' | 'isReady'>;
  readonly createMainLogTransportConfig: () => Pick<FileTransportConfig, 'options' | 'target'>;
  readonly disableFileLogs: boolean;
  readonly getLogFilePath: () => string | null;
  readonly getSettingsStore: () => ElectronStore<DesktopSettingsStoreSchema> | null;
  readonly logger: DesktopMainLogger;
  /** Runs after every applied+persisted update (main.ts feeds the watchdog). */
  readonly onFilePreferencesApplied: (file: LoggingPreferences['file']) => void;
  readonly showItemInFolder: Shell['showItemInFolder'];
  readonly showSaveDialog: Dialog['showSaveDialog'];
}

export interface DesktopLoggingPreferencesController {
  readonly applyAndPersist: (preferences: LoggingPreferences) => Promise<LoggingSettingsPayload>;
  /** Apply + persist the initial set (the module-scope boot step). */
  readonly applyInitial: () => void;
  /** `initializeLogging` options for the initial set (file transport when enabled). */
  readonly createInitializeLoggingOptions: () => InitializeLoggingOptions;
  readonly current: LoggingPreferences;
  /**
   * After `app.ready`, when file logging was off ONLY because no log path was
   * known at module load: enables it and returns the resolved path, else null.
   */
  readonly enableFileLoggingAfterReady: () => string | null;
  readonly getSettingsPayload: () => LoggingSettingsPayload;
  readonly initial: LoggingPreferences;
  readonly openDestination: (target: string | null) => Promise<boolean>;
  readonly selectDestination: () => Promise<string | null>;
  readonly verifyActiveLogFile: (reason: string) => Promise<void>;
}

interface FileStatSnapshot {
  mtimeMs: number;
  size: number;
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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
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

export function createDesktopLoggingPreferencesController(
  deps: DesktopLoggingPreferencesDeps
): DesktopLoggingPreferencesController {
  const {
    app,
    createMainLogTransportConfig,
    disableFileLogs,
    getLogFilePath,
    getSettingsStore,
    logger,
    onFilePreferencesApplied,
    showItemInFolder,
    showSaveDialog,
  } = deps;

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
  let currentLoggingPreferences = initialLoggingPreferences;

  function createInitializeLoggingOptions(): InitializeLoggingOptions {
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
    if (initialLoggingPreferences.file.enabled && initialLoggingPreferences.file.destination) {
      loggingOptions.file = {
        append: initialLoggingPreferences.file.append,
        destination: initialLoggingPreferences.file.destination,
        level: initialLoggingPreferences.file.level,
        mkdir: initialLoggingPreferences.file.mkdir,
        ...createMainLogTransportConfig(),
      };
    }
    return loggingOptions;
  }

  function applyCurrentLoggingPreferences(): void {
    applyLoggingPreferences(currentLoggingPreferences, 'electron-main', {
      baseBindings: {
        logFile:
          currentLoggingPreferences.file.enabled && currentLoggingPreferences.file.destination
            ? currentLoggingPreferences.file.destination
            : null,
      },
      fileTransport: createMainLogTransportConfig(),
    });
  }

  function applyInitial(): void {
    applyCurrentLoggingPreferences();
    persistLoggingPreferences(currentLoggingPreferences);
  }

  function getLoggingCapabilities() {
    return {
      canSelectDestination: !disableFileLogs,
      defaultDestination: getLogFilePath() ?? null,
      fileLoggingSupported: !disableFileLogs,
      reason: disableFileLogs ? 'File logging disabled by BRAINSTRIKE_DISABLE_FILE_LOGS=1' : null,
      runtime: 'electron' as const,
    };
  }

  function getSettingsPayload(): LoggingSettingsPayload {
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

  async function selectDestination(): Promise<string | null> {
    if (!getLoggingCapabilities().canSelectDestination) {
      return null;
    }

    const defaultPath =
      currentLoggingPreferences.file.destination ?? getLogFilePath() ?? app.getPath('logs');

    const result = await showSaveDialog({
      buttonLabel: 'Use Log File',
      defaultPath,
      title: 'Choose log file location',
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    return result.filePath;
  }

  async function applyAndPersist(preferences: LoggingPreferences): Promise<LoggingSettingsPayload> {
    const normalized = await sanitizeDesktopPreferencesAsync(preferences);
    if (!persistLoggingPreferences(normalized)) {
      return getSettingsPayload();
    }
    currentLoggingPreferences = normalized;
    applyCurrentLoggingPreferences();
    onFilePreferencesApplied(normalized.file);
    void verifyActiveLogFile('logging-preferences-updated');
    return getSettingsPayload();
  }

  async function openDestination(target: string | null): Promise<boolean> {
    const destination =
      target ??
      currentLoggingPreferences.file.destination ??
      getLoggingCapabilities().defaultDestination;
    if (!destination) {
      return false;
    }
    try {
      showItemInFolder(destination);
      return true;
    } catch {
      return false;
    }
  }

  function enableFileLoggingAfterReady(): string | null {
    // At module load time, app.isReady() is false so getLogFilePath()
    // returns null and file logging defaults to disabled.
    if (disableFileLogs || currentLoggingPreferences.file.enabled) {
      return null;
    }
    const resolvedLogPath = getLogFilePath();
    if (!resolvedLogPath) {
      return null;
    }
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
    return resolvedLogPath;
  }

  return {
    applyAndPersist,
    applyInitial,
    createInitializeLoggingOptions,
    get current() {
      return currentLoggingPreferences;
    },
    enableFileLoggingAfterReady,
    getSettingsPayload,
    initial: initialLoggingPreferences,
    openDestination,
    selectDestination,
    verifyActiveLogFile,
  };
}

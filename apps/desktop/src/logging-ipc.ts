import type { LoggingPreferences } from '@brainstrike/logging';
import { addLogListener, createLogger, LogLevel, type LogRecord } from '@brainstrike/logging';
import { ipcMain, webContents } from 'electron';
import type { LoggingSettingsPayload } from './logging-shared';
import { createDesktopIpcRegistry, settleIpcResult } from './platform/desktop-ipc-registry';
import {
  assertBufferedLogRecord,
  assertLoggingOpenDestinationTarget,
  assertLoggingPreferences,
  LOGGING_API_CHANNELS,
} from './platform/logging-api-contract';
import { getWindowRoleByWebContentsId, resolveSourceWindowRole } from './window-role';

const ALL_HOSTS_SENDER_POLICY = {
  reason:
    'Invoked by the visible UI and the chunking, embedding, and llm hidden hosts (dist/hidden-preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;
const VISIBLE_ONLY_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

const logger = createLogger('LoggingIPC');

/** Levels that qualify a record for the durable-record push to the visible
 * renderer (Task 6: desktop main → renderer durable-record push). */
const DURABLE_PUSH_LEVELS = new Set<LogLevel>([LogLevel.WARN, LogLevel.ERROR, LogLevel.FATAL]);

export interface LoggingIpcHandlers {
  getBufferedLogs: () => readonly LogRecord[];
  getState: () => LoggingSettingsPayload;
  ingestBufferedLog: (senderId: number, record: LogRecord) => void;
  openDestination: (target: string | null) => Promise<boolean>;
  /** Flight Recorder P2a Task 3: forwards the SAME warn+ records already
   * gated by `DURABLE_PUSH_LEVELS` (no second level filter) into the
   * rotating NDJSON backstop sink. Optional so callers that predate the
   * backstop (or tests exercising only the renderer push) need not stub it. */
  recordDurableLog?: (record: LogRecord) => void;
  selectDestination: () => Promise<string | null>;
  setPreferences: (
    preferences: LoggingPreferences
  ) => LoggingSettingsPayload | Promise<LoggingSettingsPayload>;
}

/** Pushes a warn+ record to the visible-ui window(s) only (never to hidden
 * hosts), reusing the same webContents-enumeration + isDestroyed/getType
 * targeting `broadcastLoggingPreferences` uses below, narrowed by window
 * role. */
function pushDurableRecordToVisibleWindow(record: LogRecord): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) {
      continue;
    }
    const targetType = contents.getType?.();
    if (targetType !== 'window' && targetType !== 'webview') {
      continue;
    }
    if (getWindowRoleByWebContentsId(contents.id) !== 'visible-ui') {
      continue;
    }
    try {
      contents.send(LOGGING_API_CHANNELS.durableRecord, record);
    } catch {
      // A WebContents can disappear between enumeration and send during shutdown churn.
    }
  }
}

/** No silent fallbacks: a record that fails the same validation the ingest
 * channel applies is dropped with a loud main-process warning, never
 * coerced or pushed as-is. */
function validateRecordForDurablePush(candidate: LogRecord): LogRecord | null {
  try {
    return assertBufferedLogRecord(candidate);
  } catch (error) {
    logger.warn('Dropping malformed durable log record before push to renderer', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function registerLoggingIpcHandlers(handlers: LoggingIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  // Main's own warn+ log records are tapped here (in addition to whatever
  // else is listening, e.g. the main-log ring buffer) and pushed straight to
  // the visible renderer's durable diagnostic sink.
  const removeDurableRecordTap = addLogListener((record) => {
    if (!DURABLE_PUSH_LEVELS.has(record.level)) {
      return;
    }
    const validated = validateRecordForDurablePush(record);
    if (!validated) {
      return;
    }
    pushDurableRecordToVisibleWindow(validated);
    handlers.recordDurableLog?.(validated);
  });

  registry.registerUnauthenticatedInvoke(
    'logging',
    LOGGING_API_CHANNELS.getPreferences,
    ALL_HOSTS_SENDER_POLICY,
    () =>
      settleIpcResult({ category: 'logging', code: 'logging.read-failed' }, () =>
        handlers.getState()
      )
  );

  let preferencesUpdateQueue: Promise<void> = Promise.resolve();

  registry.registerUnauthenticatedInvoke(
    'logging',
    LOGGING_API_CHANNELS.setPreferences,
    VISIBLE_ONLY_SENDER_POLICY,
    (_event, preferences: unknown) =>
      settleIpcResult({ category: 'logging', code: 'logging.write-failed' }, async () => {
        const parsedPreferences = assertLoggingPreferences(preferences);
        const runUpdate = async (): Promise<LoggingSettingsPayload> => {
          const payload = await handlers.setPreferences(parsedPreferences);
          broadcastLoggingPreferences(payload.preferences);
          return payload;
        };

        const queuedUpdate = preferencesUpdateQueue.then(runUpdate, runUpdate);
        preferencesUpdateQueue = queuedUpdate.then(
          () => undefined,
          () => undefined
        );

        return queuedUpdate;
      })
  );

  registry.registerUnauthenticatedInvoke(
    'logging',
    LOGGING_API_CHANNELS.selectDestination,
    VISIBLE_ONLY_SENDER_POLICY,
    () =>
      settleIpcResult({ category: 'logging', code: 'logging.select-destination-failed' }, () =>
        handlers.selectDestination()
      )
  );

  registry.registerUnauthenticatedInvoke(
    'logging',
    LOGGING_API_CHANNELS.openDestination,
    VISIBLE_ONLY_SENDER_POLICY,
    (_event, target: unknown) =>
      settleIpcResult({ category: 'logging', code: 'logging.open-destination-failed' }, () =>
        handlers.openDestination(assertLoggingOpenDestinationTarget(target))
      )
  );

  registry.registerUnauthenticatedInvoke(
    'logging',
    LOGGING_API_CHANNELS.getBufferedLogs,
    VISIBLE_ONLY_SENDER_POLICY,
    () =>
      settleIpcResult({ category: 'logging', code: 'logging.records-failed' }, () =>
        handlers.getBufferedLogs()
      )
  );
  registry.registerEvent('logging', LOGGING_API_CHANNELS.ingestBufferedRecord, (event, payload) => {
    const record = assertBufferedLogRecord(payload);
    handlers.ingestBufferedLog(event.sender.id, record);

    if (DURABLE_PUSH_LEVELS.has(record.level)) {
      const enrichedRecord: LogRecord = {
        ...record,
        bindings: {
          ...record.bindings,
          sourceWindowRole: resolveSourceWindowRole(event.sender.id),
        },
      };
      pushDurableRecordToVisibleWindow(enrichedRecord);
      handlers.recordDurableLog?.(enrichedRecord);
    }
  });

  return () => {
    registry.unregisterAll();
    removeDurableRecordTap();
  };
}

function broadcastLoggingPreferences(preferences: LoggingPreferences): void {
  const cloned = cloneLoggingPreferences(preferences);
  for (const contents of webContents.getAllWebContents()) {
    const targetType = contents.getType?.();
    if (contents.isDestroyed()) {
      continue;
    }
    if (targetType === 'window' || targetType === 'webview') {
      try {
        contents.send(LOGGING_API_CHANNELS.preferencesUpdated, cloned);
      } catch {
        // A WebContents can disappear between enumeration and send during shutdown churn.
      }
      continue;
    }
    logger.debug('Skipping logging preference broadcast for unsupported WebContents type', {
      targetType: typeof targetType === 'string' ? targetType : 'unknown',
      webContentsId: contents.id,
    });
  }
}

export function cloneLoggingSettingsPayload(
  payload: LoggingSettingsPayload
): LoggingSettingsPayload {
  return {
    capabilities: { ...payload.capabilities },
    preferences: {
      ...payload.preferences,
      file: { ...payload.preferences.file },
      redactPaths: [...payload.preferences.redactPaths],
    },
  };
}

export function cloneLoggingPreferences(preferences: LoggingPreferences): LoggingPreferences {
  return {
    ...preferences,
    file: { ...preferences.file },
    redactPaths: [...preferences.redactPaths],
  };
}

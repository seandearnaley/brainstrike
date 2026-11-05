import type { LoggingPreferences, LoggingPreferencesPatch } from '@brainstrike/logging';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { Schema } from 'effect';
import { DESKTOP_IPC_CHANNELS } from './desktop-ipc-channels';

export const LOGGING_API_CHANNELS = DESKTOP_IPC_CHANNELS.logging;

const VALID_LOG_LEVELS = new Set<unknown>([
  LogLevel.TRACE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
  LogLevel.SILENT,
]);
const MAX_LOGGING_DESTINATION_LENGTH = 1024;
const MAX_REDACT_PATHS = 256;
const MAX_REDACT_PATH_LENGTH = 512;

function assertLogLevel(value: unknown, message: string): LogLevel {
  if (!VALID_LOG_LEVELS.has(value)) {
    throw new Error(message);
  }
  return value as LogLevel;
}

export function assertBufferedLogRecord(payload: unknown): LogRecord {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Buffered log record must be an object.');
  }

  const candidate = payload as Record<string, unknown>;
  const level = assertLogLevel(candidate['level'], 'Buffered log record has invalid level.');
  if (typeof candidate['timestamp'] !== 'number' || !Number.isFinite(candidate['timestamp'])) {
    throw new Error('Buffered log record must include a finite numeric timestamp.');
  }
  if (!Array.isArray(candidate['args'])) {
    throw new Error('Buffered log record must include args array.');
  }
  if (
    !candidate['bindings'] ||
    typeof candidate['bindings'] !== 'object' ||
    Array.isArray(candidate['bindings'])
  ) {
    throw new Error('Buffered log record must include bindings object.');
  }
  if (candidate['message'] !== undefined && typeof candidate['message'] !== 'string') {
    throw new Error('Buffered log record message must be a string when present.');
  }
  if (candidate['scope'] !== undefined && typeof candidate['scope'] !== 'string') {
    throw new Error('Buffered log record scope must be a string when present.');
  }

  return {
    args: [...candidate['args']],
    bindings: { ...(candidate['bindings'] as Record<string, unknown>) },
    level,
    timestamp: candidate['timestamp'],
    ...(typeof candidate['message'] === 'string' ? { message: candidate['message'] } : {}),
    ...(typeof candidate['scope'] === 'string' ? { scope: candidate['scope'] } : {}),
  } satisfies LogRecord;
}

const LogLevelSchema = Schema.Literals([
  LogLevel.TRACE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
  LogLevel.SILENT,
]);
const DestinationSchema = Schema.NullOr(
  Schema.String.check(
    Schema.isMaxLength(MAX_LOGGING_DESTINATION_LENGTH),
    Schema.makeFilter((value) => !value.includes('\0'), { expected: 'no null bytes' })
  )
);

/** A renderer's change to some logging preferences; Main merges it into the record it holds. */
export const LoggingPreferencesPatchSchema = Schema.Struct({
  consoleEnabled: Schema.optionalKey(Schema.Boolean),
  consoleLevel: Schema.optionalKey(LogLevelSchema),
  file: Schema.optionalKey(
    Schema.Struct({
      append: Schema.optionalKey(Schema.Boolean),
      destination: Schema.optionalKey(DestinationSchema),
      enabled: Schema.optionalKey(Schema.Boolean),
      level: Schema.optionalKey(LogLevelSchema),
      mkdir: Schema.optionalKey(Schema.Boolean),
    })
  ),
  includeTimestamp: Schema.optionalKey(Schema.Boolean),
  level: Schema.optionalKey(LogLevelSchema),
  redactPaths: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(MAX_REDACT_PATH_LENGTH))).check(
      Schema.isMaxLength(MAX_REDACT_PATHS)
    )
  ),
});

export const OpenDestinationArgs = Schema.Tuple([DestinationSchema]);

/** Merges a decoded patch into the preferences Main holds. */
export function mergeLoggingPreferencesPatch(
  current: LoggingPreferences,
  patch: LoggingPreferencesPatch
): LoggingPreferences {
  return { ...current, ...patch, file: { ...current.file, ...patch.file } };
}

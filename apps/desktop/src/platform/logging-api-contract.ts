import { LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import type { LoggingPreferences } from '@brainstrike/utils/logging-preferences';

export const LOGGING_API_CHANNELS = {
  getBufferedLogs: 'logging:get-buffered-logs',
  getPreferences: 'logging:get-preferences',
  ingestBufferedRecord: 'logging:ingest-buffered-record',
  openDestination: 'logging:open-destination',
  preferencesUpdated: 'logging:preferences-updated',
  selectDestination: 'logging:select-destination',
  setPreferences: 'logging:set-preferences',
} as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertLogLevel(value: unknown, message: string): LogLevel {
  if (!VALID_LOG_LEVELS.has(value)) {
    throw new Error(message);
  }
  return value as LogLevel;
}

function assertBoolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(message);
  }
  return value;
}

function assertStringArray(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  if (value.length > MAX_REDACT_PATHS) {
    throw new Error(`Logging preferences redactPaths cannot exceed ${MAX_REDACT_PATHS} entries.`);
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(message);
    }

    const entry = value[index];
    if (typeof entry !== 'string') {
      throw new Error(message);
    }
    if (entry.length > MAX_REDACT_PATH_LENGTH) {
      throw new Error(
        `Logging preferences redactPaths entries cannot exceed ${MAX_REDACT_PATH_LENGTH} characters.`
      );
    }
  }

  return [...value];
}

function assertNullableDestinationString(
  value: unknown,
  invalidTypeMessage: string,
  label: string
): string | null {
  if (value === null) {
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error(invalidTypeMessage);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} cannot contain null bytes.`);
  }
  if (value.length > MAX_LOGGING_DESTINATION_LENGTH) {
    throw new Error(`${label} cannot exceed ${MAX_LOGGING_DESTINATION_LENGTH} characters.`);
  }
  return value;
}

export function assertLoggingOpenDestinationTarget(value: unknown): string | null {
  return assertNullableDestinationString(
    value,
    'Logging open-destination target must be a string or null.',
    'Logging open-destination target'
  );
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
    level,
    timestamp: candidate['timestamp'],
    args: [...candidate['args']],
    bindings: { ...(candidate['bindings'] as Record<string, unknown>) },
    ...(typeof candidate['message'] === 'string' ? { message: candidate['message'] } : {}),
    ...(typeof candidate['scope'] === 'string' ? { scope: candidate['scope'] } : {}),
  } satisfies LogRecord;
}

export function assertLoggingPreferences(value: unknown): LoggingPreferences {
  if (!isRecord(value)) {
    throw new Error('Logging preferences must be an object.');
  }
  if (!isRecord(value['file'])) {
    throw new Error('Logging file preferences must be an object.');
  }

  const file = value['file'];

  return {
    consoleEnabled: assertBoolean(
      value['consoleEnabled'],
      'Logging preferences consoleEnabled must be a boolean.'
    ),
    consoleLevel: assertLogLevel(
      value['consoleLevel'],
      'Logging preferences consoleLevel must be a valid log level.'
    ),
    file: {
      append: assertBoolean(file['append'], 'Logging file preferences append must be a boolean.'),
      destination: assertNullableDestinationString(
        file['destination'],
        'Logging file preferences destination must be a string or null.',
        'Logging file preferences destination'
      ),
      enabled: assertBoolean(
        file['enabled'],
        'Logging file preferences enabled must be a boolean.'
      ),
      level: assertLogLevel(
        file['level'],
        'Logging file preferences level must be a valid log level.'
      ),
      mkdir: assertBoolean(file['mkdir'], 'Logging file preferences mkdir must be a boolean.'),
    },
    includeTimestamp: assertBoolean(
      value['includeTimestamp'],
      'Logging preferences includeTimestamp must be a boolean.'
    ),
    level: assertLogLevel(value['level'], 'Logging preferences level must be a valid log level.'),
    redactPaths: assertStringArray(
      value['redactPaths'],
      'Logging preferences redactPaths must be a string array.'
    ),
  };
}

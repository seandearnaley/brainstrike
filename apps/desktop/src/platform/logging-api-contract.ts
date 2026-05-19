import { LogLevel } from '@brainstrike/utils/logger';
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
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(message);
  }
  return [...value];
}

function assertNullableString(value: unknown, message: string): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(message);
}

export function assertLoggingOpenDestinationTarget(value: unknown): string | null {
  return assertNullableString(value, 'Logging open-destination target must be a string or null.');
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
      destination: assertNullableString(
        file['destination'],
        'Logging file preferences destination must be a string or null.'
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

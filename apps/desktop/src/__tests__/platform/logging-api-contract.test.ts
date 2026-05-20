import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { createDefaultLoggingPreferences } from '@brainstrike/utils/logging-preferences';
import { describe, expect, it } from 'vitest';
import {
  assertBufferedLogRecord,
  assertLoggingOpenDestinationTarget,
  assertLoggingPreferences,
  LOGGING_API_CHANNELS,
} from '../../platform/logging-api-contract';

function readDesktopSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8');
}

describe('logging API contract', () => {
  it('defines the canonical logging IPC channel names in one main-process contract', () => {
    expect(LOGGING_API_CHANNELS).toEqual({
      getBufferedLogs: 'logging:get-buffered-logs',
      getPreferences: 'logging:get-preferences',
      ingestBufferedRecord: 'logging:ingest-buffered-record',
      openDestination: 'logging:open-destination',
      preferencesUpdated: 'logging:preferences-updated',
      selectDestination: 'logging:select-destination',
      setPreferences: 'logging:set-preferences',
    });
  });

  it('accepts and clones well-formed logging preferences from the renderer', () => {
    const preferences = createDefaultLoggingPreferences({
      file: {
        append: false,
        destination: '/tmp/brainstrike.log',
        enabled: true,
        level: LogLevel.DEBUG,
        mkdir: false,
      },
      redactPaths: ['/secret'],
    });

    const parsed = assertLoggingPreferences(preferences);

    expect(parsed).toEqual(preferences);
    expect(parsed).not.toBe(preferences);
    expect(parsed.file).not.toBe(preferences.file);
    expect(parsed.redactPaths).not.toBe(preferences.redactPaths);
  });

  it('rejects malformed logging preferences before they reach mutable main-process state', () => {
    const sparseRedactPaths = new Array<string>(2);
    sparseRedactPaths[1] = 'token';

    expect(() => assertLoggingPreferences(null)).toThrow('Logging preferences must be an object.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        consoleEnabled: 'yes',
      })
    ).toThrow('Logging preferences consoleEnabled must be a boolean.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        file: null,
      })
    ).toThrow('Logging file preferences must be an object.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        level: 'verbose',
      })
    ).toThrow('Logging preferences level must be a valid log level.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        file: {
          ...createDefaultLoggingPreferences().file,
          level: 'verbose',
        },
      })
    ).toThrow('Logging file preferences level must be a valid log level.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        redactPaths: 'token',
      })
    ).toThrow('Logging preferences redactPaths must be a string array.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        redactPaths: sparseRedactPaths,
      })
    ).toThrow('Logging preferences redactPaths must be a string array.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        redactPaths: Array.from({ length: 257 }, (_, index) => `secret-${index}`),
      })
    ).toThrow('Logging preferences redactPaths cannot exceed 256 entries.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        redactPaths: ['x'.repeat(513)],
      })
    ).toThrow('Logging preferences redactPaths entries cannot exceed 512 characters.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        file: {
          ...createDefaultLoggingPreferences().file,
          destination: '/tmp/brainstrike\0.log',
        },
      })
    ).toThrow('Logging file preferences destination cannot contain null bytes.');
    expect(() =>
      assertLoggingPreferences({
        ...createDefaultLoggingPreferences(),
        file: {
          ...createDefaultLoggingPreferences().file,
          destination: '/tmp/'.concat('x'.repeat(1025)),
        },
      })
    ).toThrow('Logging file preferences destination cannot exceed 1024 characters.');
  });

  it('normalizes only supported open-destination targets', () => {
    expect(assertLoggingOpenDestinationTarget(null)).toBeNull();
    expect(assertLoggingOpenDestinationTarget('/tmp/brainstrike.log')).toBe('/tmp/brainstrike.log');

    expect(() => assertLoggingOpenDestinationTarget(undefined)).toThrow(
      'Logging open-destination target must be a string or null.'
    );
    expect(() => assertLoggingOpenDestinationTarget({ path: '/tmp/brainstrike.log' })).toThrow(
      'Logging open-destination target must be a string or null.'
    );
    expect(() => assertLoggingOpenDestinationTarget('/tmp/brainstrike\0.log')).toThrow(
      'Logging open-destination target cannot contain null bytes.'
    );
    expect(() => assertLoggingOpenDestinationTarget('/tmp/'.concat('x'.repeat(1025)))).toThrow(
      'Logging open-destination target cannot exceed 1024 characters.'
    );
  });

  it('validates buffered renderer log records in the shared logging contract', () => {
    const record = {
      level: LogLevel.INFO,
      timestamp: Date.now(),
      args: ['renderer log'],
      bindings: { runtime: 'electron-renderer' },
      message: 'renderer log',
      scope: 'Renderer',
    } satisfies LogRecord;

    expect(assertBufferedLogRecord(record)).toEqual(record);
    expect(assertBufferedLogRecord(record)).not.toBe(record);

    expect(() => assertBufferedLogRecord(null)).toThrow('Buffered log record must be an object.');
    expect(() => assertBufferedLogRecord({ ...record, level: 'verbose' })).toThrow(
      'Buffered log record has invalid level.'
    );
    expect(() => assertBufferedLogRecord({ ...record, timestamp: Number.NaN })).toThrow(
      'Buffered log record must include a finite numeric timestamp.'
    );
    expect(() => assertBufferedLogRecord({ ...record, args: 'renderer log' })).toThrow(
      'Buffered log record must include args array.'
    );
    expect(() => assertBufferedLogRecord({ ...record, bindings: null })).toThrow(
      'Buffered log record must include bindings object.'
    );
  });

  it('requires logging-ipc to register handlers through the contract constants', () => {
    const source = readDesktopSource('logging-ipc.ts');

    expect(source).toContain('LOGGING_API_CHANNELS.getPreferences');
    expect(source).toContain('LOGGING_API_CHANNELS.setPreferences');
    expect(source).toContain('LOGGING_API_CHANNELS.preferencesUpdated');
    expect(source).not.toContain('function assertLogRecord');
    expect(source).not.toMatch(
      /(?:ipcMain\.(?:handle|on|removeHandler|removeListener)|contents\.send)\(\s*['"`]logging:/
    );
  });
});

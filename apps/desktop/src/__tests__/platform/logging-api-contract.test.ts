import { createDefaultLoggingPreferences, LogLevel, type LogRecord } from '@brainstrike/logging';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { ipcArgsDecoder } from '../../platform/ipc-args';
import {
  assertBufferedLogRecord,
  LoggingPreferencesPatchSchema,
  mergeLoggingPreferencesPatch,
  OpenDestinationArgs,
} from '../../platform/logging-api-contract';

const decodePatch = ipcArgsDecoder(
  'logging:update-preferences',
  Schema.Tuple([LoggingPreferencesPatchSchema])
);
const decodeTarget = ipcArgsDecoder('logging:open-destination', OpenDestinationArgs);

describe('logging API contract', () => {
  it('merges a renderer patch into the preferences Main holds', () => {
    const current = createDefaultLoggingPreferences();
    const [patch] = decodePatch([
      { file: { destination: '/tmp/brainstrike.log', enabled: true }, redactPaths: ['/secret'] },
    ]);

    const merged = mergeLoggingPreferencesPatch(current, patch);

    expect(merged).toEqual({
      ...current,
      file: { ...current.file, destination: '/tmp/brainstrike.log', enabled: true },
      redactPaths: ['/secret'],
    });
  });

  it.each([
    ['an unknown level', { level: 'verbose' }],
    ['an unknown file level', { file: { level: 'verbose' } }],
    ['a non-boolean switch', { consoleEnabled: 'yes' }],
    ['more than 256 redact paths', { redactPaths: Array.from({ length: 257 }, String) }],
    ['a redact path over 512 characters', { redactPaths: ['x'.repeat(513)] }],
    ['a destination with a null byte', { file: { destination: '/tmp/brainstrike\0.log' } }],
    ['a destination over 1024 characters', { file: { destination: 'x'.repeat(1025) } }],
    ['an undeclared field', { unexpected: true }],
  ])('rejects a patch with %s before it reaches main-process state', (_label, patch) => {
    expect(() => decodePatch([patch])).toThrow(TypeError);
  });

  it('accepts a destination path or null as the open-destination target', () => {
    expect(decodeTarget([null])).toEqual([null]);
    expect(decodeTarget(['/tmp/brainstrike.log'])).toEqual(['/tmp/brainstrike.log']);
    for (const target of [undefined, { path: '/tmp/a.log' }, '/tmp/a\0.log', 'x'.repeat(1025)]) {
      expect(() => decodeTarget([target])).toThrow(TypeError);
    }
  });

  it('validates buffered renderer log records in the shared logging contract', () => {
    const record = {
      args: ['renderer log'],
      bindings: { runtime: 'electron-renderer' },
      level: LogLevel.INFO,
      message: 'renderer log',
      scope: 'Renderer',
      timestamp: Date.now(),
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
});

/**
 * Unit coverage for `createErrorLogSink` (Flight Recorder P2a Task 3): the
 * conversion + serialization wrapper around `RotatingFileSink` that turns a
 * warn+ `LogRecord` into one durable NDJSON line. Real fs via a tmpdir — the
 * writes here are a handful of short lines, not the rotation/failure-mode
 * territory `rotating-file-sink.integration.test.ts` covers, so this stays
 * a plain unit test per the brief's file name.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { parseDiagnosticEventLine } from '@brainstrike/utils/diagnostics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createErrorLogSink } from '../../diagnostics/error-log-sink';

async function makeDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-error-log-sink-'));
  return await fsPromises.realpath(dir);
}

function createRecord(overrides?: Partial<LogRecord>): LogRecord {
  return {
    args: ['boom'],
    bindings: { runtime: 'electron-main' },
    level: LogLevel.ERROR,
    message: 'boom',
    scope: 'TestScope',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

async function readLines(filePath: string): Promise<string[]> {
  const raw = await fsPromises.readFile(filePath, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

describe('createErrorLogSink', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await makeDir();
    filePath = path.join(dir, 'brainstrike-errors.ndjson');
  });

  afterEach(async () => {
    await fsPromises.rm(dir, { force: true, recursive: true });
  });

  it('writes a main-process ERROR record as one parseable line sourced from electron-main', async () => {
    const sink = createErrorLogSink({
      appVersion: '1.2.3',
      filePath,
      platform: 'darwin-arm64',
      sessionId: 'session-abc',
    });

    sink.recordLogRecord(createRecord());
    sink.close();

    const lines = await readLines(filePath);
    expect(lines).toHaveLength(1);
    const event = parseDiagnosticEventLine(lines[0] ?? '');
    expect(event).not.toBeNull();
    expect(event?.source).toBe('electron-main');
    expect(event?.severity).toBe('error');
    expect(event?.sessionId).toBe('session-abc');
    expect(event?.appVersion).toBe('1.2.3');
    expect(event?.platform).toBe('darwin-arm64');
  });

  it('derives source from bindings.sourceWindowRole for a non-main record', async () => {
    const sink = createErrorLogSink({
      appVersion: '1.2.3',
      filePath,
      platform: 'darwin-arm64',
      sessionId: 'session-abc',
    });

    // A distinct role (not the `?? 'hidden-host'` fallback value itself) so
    // this assertion actually discriminates: an implementation that ignored
    // `sourceWindowRole` entirely would still produce 'hidden-host' via the
    // fallback and pass a same-value test undetected.
    sink.recordLogRecord(createRecord({ bindings: { sourceWindowRole: 'chunking-host' } }));
    sink.close();

    const lines = await readLines(filePath);
    expect(lines).toHaveLength(1);
    const event = parseDiagnosticEventLine(lines[0] ?? '');
    expect(event?.source).toBe('chunking-host');
  });

  it('writes nothing for a record below the warn+ severity floor', async () => {
    const sink = createErrorLogSink({
      appVersion: '1.2.3',
      filePath,
      platform: 'darwin-arm64',
      sessionId: 'session-abc',
    });

    sink.recordLogRecord(createRecord({ level: LogLevel.INFO }));
    sink.close();

    await expect(fsPromises.access(filePath)).rejects.toThrow();
  });

  it('does not throw when a record cannot be converted/serialized (e.g. a BigInt in args)', () => {
    const sink = createErrorLogSink({
      appVersion: '1.2.3',
      filePath,
      platform: 'darwin-arm64',
      sessionId: 'session-abc',
    });
    // `writeLine` never throws, but `logRecordToDiagnosticEvent` /
    // `serializeDiagnosticEventLine` are not contractually safe — a BigInt
    // anywhere in the record's context throws out of `JSON.stringify`. This
    // must be caught and reported via the same raw console.error path, never
    // escape into the caller (the addLogListener tap).
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => sink.recordLogRecord(createRecord({ args: [{ big: 10n }] }))).not.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
    sink.close();
  });

  it('exposes the configured filePath on the handle', () => {
    const sink = createErrorLogSink({
      appVersion: '1.2.3',
      filePath,
      platform: 'darwin-arm64',
      sessionId: 'session-abc',
    });

    expect(sink.filePath).toBe(filePath);
    sink.close();
  });
});

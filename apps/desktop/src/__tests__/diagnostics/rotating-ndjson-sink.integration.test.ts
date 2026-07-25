/**
 * Integration coverage for `RotatingNdjsonSink`: real fs, real rotation, real
 * failure injection. This is the durable BACKSTOP for the diagnostics system
 * (Flight Recorder P2a Task 2) — it must keep working even when the PGlite
 * diagnostic sink is broken, so these tests exercise a real filesystem
 * rather than a mocked one. Mirrors the mkdtemp + afterEach cleanup pattern
 * from `git-ipc-handlers.integration.test.ts`.
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DiagnosticEvent } from '@brainstrike/utils/diagnostics';
import {
  parseDiagnosticEventLine,
  serializeDiagnosticEventLine,
} from '@brainstrike/utils/diagnostics';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RotatingNdjsonSink } from '../../diagnostics/rotating-ndjson-sink';

const createdDirs: string[] = [];

async function makeDir(prefix = 'brainstrike-ndjson-sink-'): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(dir);
  createdDirs.push(real);
  return real;
}

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  }
});

let eventCounter = 0;

function makeEvent(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  eventCounter += 1;
  return {
    appVersion: '1.0.0',
    causeChain: null,
    code: null,
    context: null,
    fingerprint: `fp-${eventCounter}`,
    id: `evt-${eventCounter}`,
    message: `boom ${eventCounter}`,
    occurredAt: 1_700_000_000_000 + eventCounter,
    platform: 'darwin',
    resourceId: null,
    rootId: null,
    runId: null,
    scope: null,
    sessionId: 'session-1',
    severity: 'error',
    source: 'electron-main',
    stack: null,
    threadId: null,
    ...overrides,
  };
}

describe('RotatingNdjsonSink', () => {
  it('writes newline-delimited lines that parseDiagnosticEventLine reads back', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    const sink = new RotatingNdjsonSink({ filePath });
    const events = [makeEvent(), makeEvent(), makeEvent()];

    for (const event of events) {
      sink.writeLine(serializeDiagnosticEventLine(event));
    }
    sink.close();

    const raw = await fsPromises.readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => parseDiagnosticEventLine(line))).toEqual(events);
    expect(sink.disabled).toBe(false);
  });

  it('derives the incoming byte count from the encoded line without a separate UTF-8 scan', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    const sink = new RotatingNdjsonSink({ filePath });
    const byteLengthSpy = vi.spyOn(Buffer, 'byteLength');
    let byteLengthCalls = -1;

    try {
      sink.writeLine('unicode-\u00e9');
      sink.close();
      byteLengthCalls = byteLengthSpy.mock.calls.length;
    } finally {
      byteLengthSpy.mockRestore();
    }

    expect(byteLengthCalls).toBe(0);
    expect(await fsPromises.readFile(filePath, 'utf8')).toBe('unicode-\u00e9\n');
  });

  it('rotates once a write would exceed maxBytes, and the live file restarts small', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    // Each line is exactly 10 ASCII bytes + trailing '\n' = 11 bytes on disk.
    const line = 'A'.repeat(10);
    // Room for 2 lines (22 bytes) but not a 3rd (33 bytes).
    const sink = new RotatingNdjsonSink({ filePath, maxBytes: 25, maxFiles: 5 });

    sink.writeLine(line);
    sink.writeLine(line);
    sink.writeLine(line);
    sink.close();

    expect(await fsPromises.readFile(filePath, 'utf8')).toBe(`${line}\n`);
    expect(await fsPromises.readFile(`${filePath}.1`, 'utf8')).toBe(`${line}\n${line}\n`);
  });

  it('keeps at most maxFiles files after repeated rotations, dropping the oldest', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    const maxFiles = 3;
    // Each 3-char label + '\n' is exactly 4 bytes, so every write after the
    // first is guaranteed to trigger exactly one rotation.
    const sink = new RotatingNdjsonSink({ filePath, maxBytes: 4, maxFiles });

    for (let i = 1; i <= 6; i += 1) {
      sink.writeLine(String(i).padStart(3, '0'));
    }
    sink.close();

    const entries = (await fsPromises.readdir(dir)).sort();
    expect(entries).toEqual(['errors.ndjson', 'errors.ndjson.1', 'errors.ndjson.2']);
    // Rotation would have run 5 times (writes 2-6): "001".."003" must be gone.
    expect(await fsPromises.readFile(filePath, 'utf8')).toBe('006\n');
    expect(await fsPromises.readFile(`${filePath}.1`, 'utf8')).toBe('005\n');
    expect(await fsPromises.readFile(`${filePath}.2`, 'utf8')).toBe('004\n');
  });

  it('still writes a single line larger than maxBytes to its own freshly-rotated file', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    const oversized = 'X'.repeat(50);
    const sink = new RotatingNdjsonSink({ filePath, maxBytes: 20, maxFiles: 5 });

    sink.writeLine('small');
    sink.writeLine(oversized);

    expect(await fsPromises.readFile(filePath, 'utf8')).toBe(`${oversized}\n`);
    expect(await fsPromises.readFile(`${filePath}.1`, 'utf8')).toBe('small\n');

    // The oversized line alone (51 bytes) already exceeds maxBytes, so the
    // very next write must rotate again rather than silently accumulating.
    sink.writeLine('next');
    sink.close();

    expect(await fsPromises.readFile(filePath, 'utf8')).toBe('next\n');
    expect(await fsPromises.readFile(`${filePath}.1`, 'utf8')).toBe(`${oversized}\n`);
  });

  it('seeds live-file size from disk on reopen, rotating without rewriting prior history', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    const maxBytes = 20;

    const first = new RotatingNdjsonSink({ filePath, maxBytes, maxFiles: 5 });
    first.writeLine('A'.repeat(10)); // 11 bytes
    first.writeLine('B'.repeat(5)); // 6 bytes; currentSize now 17, under budget
    first.close();

    const second = new RotatingNdjsonSink({ filePath, maxBytes, maxFiles: 5 });
    // 17 (seeded from disk) + 6 ('C'.repeat(5) + '\n') = 23 > 20: must rotate
    // BEFORE writing, carrying the two prior lines into `.1` untouched.
    second.writeLine('C'.repeat(5));
    second.close();

    expect(await fsPromises.readFile(`${filePath}.1`, 'utf8')).toBe(
      `${'A'.repeat(10)}\n${'B'.repeat(5)}\n`
    );
    expect(await fsPromises.readFile(filePath, 'utf8')).toBe(`${'C'.repeat(5)}\n`);
  });

  it('disables itself, reports onFailure exactly once, and never throws once broken', async () => {
    const dir = await makeDir();
    const blockingFile = path.join(dir, 'not-a-directory');
    await fsPromises.writeFile(blockingFile, 'blocking');
    // The parent of `filePath` is a FILE, not a directory, so `mkdirSync`
    // inside the sink's open path throws (ENOTDIR).
    const filePath = path.join(blockingFile, 'nested', 'errors.ndjson');
    const failures: unknown[] = [];
    const sink = new RotatingNdjsonSink({
      filePath,
      onFailure: (error: unknown) => failures.push(error),
    });

    expect(() => sink.writeLine('first')).not.toThrow();
    expect(sink.disabled).toBe(true);
    expect(failures).toHaveLength(1);

    expect(() => sink.writeLine('second')).not.toThrow();
    expect(sink.disabled).toBe(true);
    expect(failures).toHaveLength(1);
  });

  it('throws from the constructor when maxFiles < 2 (no room for a rotated sibling)', () => {
    expect(
      () => new RotatingNdjsonSink({ filePath: '/irrelevant/errors.ndjson', maxFiles: 1 })
    ).toThrow(/maxFiles/);
  });

  it('throws from the constructor when maxBytes < 1 (no line could ever fit)', () => {
    expect(
      () => new RotatingNdjsonSink({ filePath: '/irrelevant/errors.ndjson', maxBytes: 0 })
    ).toThrow(/maxBytes/);
  });

  it('disables the sink and reports onFailure when a write returns fewer bytes than requested', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    const failures: unknown[] = [];
    const sink = new RotatingNdjsonSink({
      filePath,
      onFailure: (error: unknown) => failures.push(error),
    });

    // A genuine short write (signal interruption, RLIMIT_FSIZE, an ENOSPC
    // boundary) is not reliably forceable from a portable test. Simulated
    // instead: intercept fs.writeSync and report fewer bytes than requested
    // for exactly one call. The sink calls `fs.writeSync` via property
    // access on the imported `fs` namespace (not a reference captured at
    // import time), so a spy on that same shared `node:fs` module object is
    // observed by the sink.
    const writeSyncSpy = vi.spyOn(fs, 'writeSync').mockReturnValueOnce(1);

    expect(() => sink.writeLine('hello')).not.toThrow();
    writeSyncSpy.mockRestore();

    expect(sink.disabled).toBe(true);
    expect(failures).toHaveLength(1);
    expect(String((failures[0] as Error).message)).toMatch(/short write/);

    // Same no-throw / no-re-report contract as the open-failure path.
    expect(() => sink.writeLine('after')).not.toThrow();
    expect(failures).toHaveLength(1);
  });

  it('close() untracks the fd before calling closeSync, so a throwing close stays idempotent', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    const sink = new RotatingNdjsonSink({ filePath });
    sink.writeLine('first');

    const closeSyncSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => {
      throw new Error('simulated EBADF');
    });

    expect(() => sink.close()).toThrow('simulated EBADF');
    // The fix untracks `fd` BEFORE the (throwing) syscall, so a second
    // close() sees no fd to close and is a true no-op: it must NOT attempt
    // to re-close the same descriptor (the pre-fix code only nulled `fd`
    // AFTER a successful closeSync, so a throw left it re-closable).
    expect(() => sink.close()).not.toThrow();
    expect(closeSyncSpy).toHaveBeenCalledTimes(1);

    closeSyncSpy.mockRestore();

    // A later writeLine must reopen a fresh fd rather than believing it
    // still owns the untracked one.
    sink.writeLine('second');
    sink.close();

    expect(await fsPromises.readFile(filePath, 'utf8')).toBe('first\nsecond\n');
  });

  it('reopens transparently on a writeLine after close() — close() does not disable', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'errors.ndjson');
    const sink = new RotatingNdjsonSink({ filePath });

    sink.writeLine('before-close');
    sink.close();
    // A late write after close() is deliberately NOT treated as writing to
    // a disabled sink — only an actual open/write/rotate failure disables.
    expect(sink.disabled).toBe(false);

    sink.writeLine('after-close');
    sink.close();

    expect(await fsPromises.readFile(filePath, 'utf8')).toBe('before-close\nafter-close\n');
  });
});

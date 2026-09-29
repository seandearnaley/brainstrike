import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseInitAttemptRecord, DatabaseInitPhaseReport } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerErrorMock = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: loggerErrorMock,
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

import {
  DB_HOST_INIT_FIRST_REPORT_TIMEOUT_MS,
  DB_HOST_INIT_MAX_BUDGET_MS,
  resolveInitPhaseBudgetMs,
} from '../db-host-init-budget';
import {
  DB_INIT_STOP_AFTER_TIMEOUTS,
  initPhaseKey,
  isInitStopped,
  nextInitTimeoutRecord,
  readDbInitAttemptRecord,
  removeDbInitAttemptRecord,
  writeDbInitAttemptRecord,
} from '../db-init-attempt-record';

const MIB = 1024 * 1024;

const REBUILD: DatabaseInitPhaseReport = {
  index: {
    accessMethod: 'bm25',
    heapBytes: 137_363_456,
    index: 'idx_file_chunks_content_bm25',
    indexBytes: 33_685_504,
    schema: 'public',
    table: 'file_chunks',
    toastBytes: 221_249_536,
  },
  phase: 'index-rebuild',
};

const RECORD: DatabaseInitAttemptRecord = {
  budgetMs: 372_000,
  consecutiveTimeouts: 1,
  hostPid: 4242,
  lastTimeoutAt: '2026-09-29T18:00:00.000Z',
  phaseKey: 'index-rebuild:public.idx_file_chunks_content_bm25',
  report: REBUILD,
  version: 1,
};

describe('db init attempt record', () => {
  let profileDir: string;
  const recordPath = (): string => path.join(profileDir, '.db-init-attempt.json');

  beforeEach(() => {
    profileDir = mkdtempSync(path.join(tmpdir(), 'brainstrike-init-attempt-'));
    loggerErrorMock.mockReset();
  });

  afterEach(() => {
    rmSync(profileDir, { force: true, recursive: true });
  });

  describe('persistence', () => {
    it('writes atomically and reads back', () => {
      writeDbInitAttemptRecord(profileDir, RECORD);

      expect(readDbInitAttemptRecord(profileDir)).toEqual(RECORD);
      // The temp file was renamed over the record: nothing else is left in the profile.
      expect(readdirSync(profileDir)).toEqual(['.db-init-attempt.json']);
    });

    it('creates the profile directory when a timeout came before the host made it', () => {
      // A first-report timeout can expire before the host has created anything in a new profile.
      const newProfile = path.join(profileDir, 'profiles', 'new');

      writeDbInitAttemptRecord(newProfile, RECORD);

      expect(readDbInitAttemptRecord(newProfile)).toEqual(RECORD);
    });

    it('rebuilds the record from its known fields: an extra key never surfaces', () => {
      // A hand-edited or tampered file must not carry extra keys into diagnostics, logs or the stop error.
      const tampered = {
        ...RECORD,
        injected: 'do-not-surface-top',
        report: {
          ...REBUILD,
          index: { ...REBUILD.index, injected: 'do-not-surface-index' },
          injected: 'do-not-surface-report',
        },
      };
      writeFileSync(recordPath(), JSON.stringify(tampered));

      const record = readDbInitAttemptRecord(profileDir);

      expect(record).toEqual(RECORD);
      expect(JSON.stringify(record)).not.toContain('do-not-surface');
      expect(loggerErrorMock).not.toHaveBeenCalled();
    });

    it('reads a first-report timeout, which has no phase report', () => {
      const firstReport: DatabaseInitAttemptRecord = {
        ...RECORD,
        budgetMs: 90_000,
        phaseKey: 'init:first-report',
        report: null,
      };
      writeDbInitAttemptRecord(profileDir, firstReport);

      expect(readDbInitAttemptRecord(profileDir)).toEqual(firstReport);
    });

    it('reads a missing record as absent, without logging', () => {
      expect(readDbInitAttemptRecord(profileDir)).toBeNull();
      expect(loggerErrorMock).not.toHaveBeenCalled();
    });

    it.each([
      ['not JSON', '{"version":'],
      ['not an object', '[]'],
      ['a JSON null', 'null'],
      ['a JSON number', '42'],
      ['a JSON string', '"text"'],
      ['a foreign version', JSON.stringify({ ...RECORD, version: 2 })],
      ['no version', JSON.stringify({ ...RECORD, version: undefined })],
      ['a missing phaseKey', JSON.stringify({ ...RECORD, phaseKey: undefined })],
      ['a zero count', JSON.stringify({ ...RECORD, consecutiveTimeouts: 0 })],
      ['a fractional count', JSON.stringify({ ...RECORD, consecutiveTimeouts: 1.5 })],
      ['a non-numeric budget', JSON.stringify({ ...RECORD, budgetMs: 'long' })],
      ['a malformed report', JSON.stringify({ ...RECORD, report: { phase: 'index-rebuild' } })],
      ['a non-string timestamp', JSON.stringify({ ...RECORD, lastTimeoutAt: 5 })],
      ['a timestamp that is not ISO', JSON.stringify({ ...RECORD, lastTimeoutAt: 'yesterday' })],
      ["a phaseKey that is not the report's", JSON.stringify({ ...RECORD, phaseKey: 'migration' })],
      ['a phaseKey with a report of none', JSON.stringify({ ...RECORD, report: null })],
    ])('reads a file with %s as absent and logs it at error', (_label, contents) => {
      writeFileSync(recordPath(), contents);

      expect(readDbInitAttemptRecord(profileDir)).toBeNull();
      expect(loggerErrorMock).toHaveBeenCalledTimes(1);
      // It never deletes the file it could not use: only a user action or a successful init does.
      expect(readFileSync(recordPath(), 'utf8')).toBe(contents);
    });

    it.each([
      ['a foreign-version file', '{"version":2,"phaseKey":"do-not-log-this-value"}'],
      ['a file that is not JSON', '{"phaseKey":"do-not-log-this-value'],
    ])('logs the shape of %s, never its content', (_label, contents) => {
      writeFileSync(recordPath(), contents);

      readDbInitAttemptRecord(profileDir);

      expect(loggerErrorMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('do-not-log-this-value');
    });

    it('surfaces a read failure other than an absent file instead of treating it as absent', () => {
      // A directory where the record belongs cannot be read as a file.
      mkdirSync(recordPath());

      expect(() => readDbInitAttemptRecord(profileDir)).toThrow();
    });

    it('removes the record, and tolerates only its absence', () => {
      writeDbInitAttemptRecord(profileDir, RECORD);

      removeDbInitAttemptRecord(profileDir);
      expect(readdirSync(profileDir)).toEqual([]);
      expect(() => removeDbInitAttemptRecord(profileDir)).not.toThrow();

      mkdirSync(recordPath());
      expect(() => removeDbInitAttemptRecord(profileDir)).toThrow();
    });
  });

  describe('counting consecutive timeouts', () => {
    const NOW = new Date('2026-09-29T18:05:00.000Z');
    const timeout = (
      previous: DatabaseInitAttemptRecord | null,
      report: DatabaseInitPhaseReport | null,
      budgetMs = 372_000
    ) => nextInitTimeoutRecord(previous, { budgetMs, hostPid: 77, now: NOW, report });

    it('names the phases the way the report does', () => {
      expect(initPhaseKey(null)).toBe('init:first-report');
      expect(initPhaseKey({ pgWalBytes: 0, phase: 'open-database' })).toBe('open-database');
      expect(initPhaseKey({ phase: 'migration' })).toBe('migration');
      expect(initPhaseKey(REBUILD)).toBe('index-rebuild:public.idx_file_chunks_content_bm25');
    });

    it('starts at one, and records the phase, budget, host and time', () => {
      expect(timeout(null, REBUILD)).toEqual({
        budgetMs: 372_000,
        consecutiveTimeouts: 1,
        hostPid: 77,
        lastTimeoutAt: NOW.toISOString(),
        phaseKey: 'index-rebuild:public.idx_file_chunks_content_bm25',
        report: REBUILD,
        version: 1,
      });
    });

    it('counts a second timeout in the same phase', () => {
      expect(timeout(RECORD, REBUILD).consecutiveTimeouts).toBe(2);
    });

    it('resets to one when the timeout is in a different phase', () => {
      expect(timeout(RECORD, { phase: 'migration' })).toMatchObject({
        consecutiveTimeouts: 1,
        phaseKey: 'migration',
      });
      expect(timeout(RECORD, null)).toMatchObject({
        consecutiveTimeouts: 1,
        phaseKey: 'init:first-report',
        report: null,
      });
    });

    it('never writes a budget the reader rejects: every real budget round-trips', () => {
      // The writer takes whatever window expired; the reader accepts only a positive safe integer.
      // If they ever disagree the record reads as absent and the count never reaches two, so the
      // breaker would silently never trip. Use the real budgets, not hand-picked integers.
      const budgets = [
        resolveInitPhaseBudgetMs({ pgWalBytes: 0, phase: 'open-database' }),
        resolveInitPhaseBudgetMs({ pgWalBytes: 912 * MIB, phase: 'open-database' }),
        resolveInitPhaseBudgetMs(REBUILD),
        resolveInitPhaseBudgetMs({ phase: 'migration' }),
        DB_HOST_INIT_FIRST_REPORT_TIMEOUT_MS,
        // `retryInit({ noDeadline })` arms this; a timeout at it must still be recordable.
        DB_HOST_INIT_MAX_BUDGET_MS,
      ];
      for (const budgetMs of budgets) {
        const record = timeout(null, REBUILD, budgetMs);
        writeDbInitAttemptRecord(profileDir, record);
        expect(readDbInitAttemptRecord(profileDir)).toEqual(record);
      }
      expect(loggerErrorMock).not.toHaveBeenCalled();
    });

    it('rounds a fractional window up to a whole millisecond rather than write one the reader rejects', () => {
      const record = timeout(null, REBUILD, 372_000.4);
      expect(record.budgetMs).toBe(372_001);

      writeDbInitAttemptRecord(profileDir, record);
      expect(readDbInitAttemptRecord(profileDir)).toEqual(record);
    });

    it.each([Number.NaN, 0, -5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
      'refuses to record a window of %s: nothing armed a timer that could have expired',
      (budgetMs) => {
        expect(() => timeout(null, REBUILD, budgetMs)).toThrow(RangeError);
      }
    );

    it('stops at two consecutive timeouts, not at one', () => {
      expect(DB_INIT_STOP_AFTER_TIMEOUTS).toBe(2);
      expect(isInitStopped(null)).toBe(false);
      expect(isInitStopped({ ...RECORD, consecutiveTimeouts: 1 })).toBe(false);
      expect(isInitStopped({ ...RECORD, consecutiveTimeouts: 2 })).toBe(true);
    });
  });
});

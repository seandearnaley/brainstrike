import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ profileDir: '', resolveFails: false }));
const loggerErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../desktop-database-location', () => ({
  resolveDesktopDatabaseLocation: () => ({ profile: 'test', rootPath: '/mock/root' }),
  resolveDesktopDatabaseProfileDirectory: () => {
    if (state.resolveFails) {
      throw new Error('the profile directory cannot be resolved');
    }
    return state.profileDir;
  },
}));
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

import { DbHostInitStoppedError } from '../db-host-lifecycle-errors';
import { DbHostRequestTimeoutError } from '../db-host-timeout-error';
import { InitAttemptGuard } from '../db-init-attempt-guard';

const MIGRATION: DatabaseInitPhaseReport = { phase: 'migration' };

function timeout(): DbHostRequestTimeoutError {
  return new DbHostRequestTimeoutError({
    pendingCount: 1,
    phase: MIGRATION,
    requestKind: 'init',
    timeoutMs: 90_000,
    willTerminateHost: true,
  });
}

describe('InitAttemptGuard record failures', () => {
  const recordPath = (): string => path.join(state.profileDir, '.db-init-attempt.json');

  beforeEach(() => {
    state.profileDir = mkdtempSync(path.join(tmpdir(), 'brainstrike-init-guard-'));
    state.resolveFails = false;
    loggerErrorMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(state.profileDir, { force: true, recursive: true });
  });

  it('counts an unreadable record from this session only, and still trips the breaker', () => {
    // A directory where the record belongs: it cannot be read as a file, and nothing can replace it.
    mkdirSync(recordPath());
    const guard = new InitAttemptGuard();

    guard.recordTimeout(timeout(), 4242);
    expect(guard.readStop()).toBeNull();
    guard.recordTimeout(timeout(), 4243);

    expect(guard.readStop()).toMatchObject({ consecutiveTimeouts: 2, phaseKey: 'migration' });
    expect(() => guard.assertNotStopped()).toThrow(DbHostInitStoppedError);
    // The first timeout could neither read nor write the record; the second counts from the
    // in-memory record, so it never re-reads the file and only fails to write.
    expect(loggerErrorMock.mock.calls.map(([message]) => message)).toEqual([
      'Could not read the DB init attempt record; counting from this session only',
      'Could not persist the DB init attempt record; a stop after repeated timeouts is kept for this session only',
      'Could not persist the DB init attempt record; a stop after repeated timeouts is kept for this session only',
    ]);
  });

  it('counts a timeout whose profile directory cannot be resolved, and writes nothing', () => {
    state.resolveFails = true;
    const guard = new InitAttemptGuard();

    expect(() => guard.recordTimeout(timeout(), null)).not.toThrow();
    guard.recordTimeout(timeout(), null);

    // The stop answers from memory: it does not need the directory that could not be resolved.
    expect(guard.readStop()).toMatchObject({ consecutiveTimeouts: 2, hostPid: null });
    expect(existsSync(recordPath())).toBe(false);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Could not read the DB init attempt record; counting from this session only',
      expect.objectContaining({ error: expect.any(Error) })
    );
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Could not persist the DB init attempt record; a stop after repeated timeouts is kept for this session only',
      expect.objectContaining({
        error: expect.objectContaining({ message: 'The profile directory could not be resolved.' }),
      })
    );
  });

  it.each([
    ['production', 'production'],
    [undefined, null],
  ])('answers diagnostics for a stop with NODE_ENV %s as %s', (nodeEnv, expected) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    const guard = new InitAttemptGuard();
    guard.recordTimeout(timeout(), 4242);
    guard.recordTimeout(timeout(), 4243);
    const stop = guard.readStop();
    if (stop === null) {
      throw new Error('Expected two timeouts in one phase to stop the guard.');
    }

    expect(guard.stoppedDiagnostics(stop)).toMatchObject({
      hasDatabaseHandle: false,
      initStop: stop,
      nodeEnv: expected,
    });
  });

  it('logs at error, and does not throw, when a successful init cannot remove the record', () => {
    const guard = new InitAttemptGuard();
    guard.recordTimeout(timeout(), 4242);
    // A directory at the record path: `unlink` fails with something other than an absent file.
    rmSync(recordPath());
    mkdirSync(recordPath());
    loggerErrorMock.mockReset();

    expect(() => guard.recordSuccess()).not.toThrow();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Could not remove the DB init attempt record after a successful init',
      expect.objectContaining({ error: expect.any(Error) })
    );
    // What it could not remove is left alone.
    expect(existsSync(recordPath())).toBe(true);
  });
});

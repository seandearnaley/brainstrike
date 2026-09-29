import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseInitAttemptRecord, DatabaseInitPhaseReport } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHostRequestEnvelope } from '../../db-host-protocol';

const MIB = 1024 * 1024;
const OPEN: DatabaseInitPhaseReport = { pgWalBytes: 0, phase: 'open-database' };
// 131 + 211 MiB of heap and toast: a 372 s budget.
const REBUILD: DatabaseInitPhaseReport = {
  index: {
    accessMethod: 'bm25',
    heapBytes: 131 * MIB,
    index: 'idx_file_chunks_content_bm25',
    indexBytes: 32 * MIB,
    schema: 'public',
    table: 'file_chunks',
    toastBytes: 211 * MIB,
  },
  phase: 'index-rebuild',
};
const REBUILD_BUDGET_MS = 372_000;
const MIGRATION: DatabaseInitPhaseReport = { phase: 'migration' };
const MAX_TIMER_MS = 2_147_483_647;
const REBUILD_KEY = 'index-rebuild:public.idx_file_chunks_content_bm25';

class FakeUtilityProcess extends EventEmitter {
  readonly messages: DbHostRequestEnvelope[] = [];
  readonly kill = vi.fn(() => true);
  readonly pid: number;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  readonly postMessage = (message: DbHostRequestEnvelope): void => {
    this.messages.push(message);
  };

  get initRequest(): DbHostRequestEnvelope {
    const request = this.messages.find((message) => message.request.kind === 'init');
    if (!request) {
      throw new Error('Expected an init request to have been posted.');
    }
    return request;
  }

  progress(report: DatabaseInitPhaseReport): void {
    this.emit('message', { id: this.initRequest.id, kind: 'progress', report });
  }

  reply(result: unknown): void {
    this.emit('message', { id: this.initRequest.id, kind: 'response', ok: true, result });
  }

  reject(message: string): void {
    this.emit('message', {
      error: { message },
      id: this.initRequest.id,
      kind: 'response',
      ok: false,
    });
  }
}

const state = vi.hoisted(() => ({ profileDir: '' }));
const forkMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', isPackaged: false },
  utilityProcess: { fork: forkMock },
}));
vi.mock('../../desktop-database-location', () => ({
  resolveDesktopDatabaseLocation: () => ({ profile: 'test', rootPath: '/mock/root' }),
  resolveDesktopDatabaseProfileDirectory: () => state.profileDir,
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

let nextPid = 1000;
let killSpy: ReturnType<typeof vi.spyOn>;

function latestProcess(): FakeUtilityProcess {
  const host: unknown = forkMock.mock.results.at(-1)?.value;
  if (!(host instanceof FakeUtilityProcess)) {
    throw new Error('Expected a fake utility process.');
  }
  return host;
}

async function settled(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => null,
    (error: unknown) => error
  );
}

async function loadManager(initializationTimeoutMs = 15) {
  const module = await import('../../db-host-manager');
  const { DbHostInitStoppedError } = await import('../../db-host-lifecycle-errors');
  return {
    DbHostInitStoppedError,
    DbHostRequestTimeoutError: module.DbHostRequestTimeoutError,
    manager: module.createDbHostManager({
      entryPath: '/mock/db-host-entry.js',
      initializationTimeoutMs,
    }),
  };
}

const recordPath = (): string => path.join(state.profileDir, '.db-init-attempt.json');
const readRecord = (): DatabaseInitAttemptRecord =>
  JSON.parse(readFileSync(recordPath(), 'utf8')) as DatabaseInitAttemptRecord;

/** One init attempt that reports `phases` in order (as a real host does) and then goes silent. */
async function timedOutAttempt(
  manager: { getDatabase: () => Promise<unknown> },
  phases: readonly DatabaseInitPhaseReport[],
  lastBudgetMs: number
): Promise<{ readonly error: unknown; readonly host: FakeUtilityProcess }> {
  const failure = settled(manager.getDatabase());
  const host = latestProcess();
  for (const report of phases) {
    host.progress(report);
  }
  await vi.advanceTimersByTimeAsync(lastBudgetMs);
  const error = await failure;
  // The exit is what lets the next attempt fork a replacement.
  host.emit('exit', 137);
  await vi.advanceTimersByTimeAsync(0);
  return { error, host };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  state.profileDir = mkdtempSync(path.join(tmpdir(), 'brainstrike-init-loop-'));
  loggerErrorMock.mockReset();
  forkMock.mockReset().mockImplementation(() => new FakeUtilityProcess(nextPid++));
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  killSpy.mockRestore();
  vi.useRealTimers();
  rmSync(state.profileDir, { force: true, recursive: true });
});

describe('the init loop breaker', () => {
  it('persists the phase and a first timeout, then a second consecutive timeout in the same phase', async () => {
    const { manager } = await loadManager();

    // A real attempt passes through open-database before the rebuild: the count must survive that.
    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    expect(readRecord()).toMatchObject({
      budgetMs: REBUILD_BUDGET_MS,
      consecutiveTimeouts: 1,
      hostPid: 1000,
      phaseKey: REBUILD_KEY,
      report: REBUILD,
      version: 1,
    });

    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    expect(readRecord()).toMatchObject({
      consecutiveTimeouts: 2,
      hostPid: 1001,
      phaseKey: REBUILD_KEY,
    });
  });

  it('refuses a third fork after two consecutive timeouts in the same phase', async () => {
    const { DbHostInitStoppedError, manager } = await loadManager();
    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    expect(forkMock).toHaveBeenCalledTimes(2);

    const third = await settled(manager.getDatabase());

    expect(third).toBeInstanceOf(DbHostInitStoppedError);
    expect(third).toMatchObject({
      message:
        'BrainStrike stopped retrying the database start: rebuilding the search index timed out twice (last budget 372 s). Nothing was deleted or replaced.',
      record: { consecutiveTimeouts: 2, phaseKey: REBUILD_KEY },
    });
    expect(forkMock).toHaveBeenCalledTimes(2);

    // Diagnostics answer from main: the stop is the answer, and no host is forked to ask.
    await expect(manager.getDiagnostics()).resolves.toMatchObject({
      hasDatabaseHandle: false,
      hostPid: null,
      initStop: { consecutiveTimeouts: 2, phaseKey: REBUILD_KEY },
      lastInitializationFailure: null,
    });
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it('reports no stop in the diagnostics while the timeouts stop short of two', async () => {
    const { manager } = await loadManager();
    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);

    const diagnostics = manager.getDiagnostics();
    latestProcess().emit('message', {
      id: latestProcess().messages.at(-1)?.id,
      kind: 'response',
      ok: true,
      result: { activeLiveQueryCount: 0, hasDatabaseHandle: true },
    });

    await expect(diagnostics).resolves.toMatchObject({ initStop: null });
  });

  it('a timeout in a different phase resets the count to one', async () => {
    const { manager } = await loadManager();
    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);

    // The rebuild finished this time; the migration phase is what never returned.
    await timedOutAttempt(manager, [OPEN, REBUILD, MIGRATION], 90_000);

    expect(readRecord()).toMatchObject({
      budgetMs: 90_000,
      consecutiveTimeouts: 1,
      phaseKey: 'migration',
      report: MIGRATION,
    });
    // One timeout in one phase is not a stop: the next attempt forks.
    const next = manager.getDatabase();
    expect(forkMock).toHaveBeenCalledTimes(3);
    latestProcess().reject('stopped for this test');
    await settled(next);
  });

  it('a first-report timeout is counted under its own phase, even in a profile the host never created', async () => {
    rmSync(state.profileDir, { force: true, recursive: true });
    const { manager } = await loadManager();

    await timedOutAttempt(manager, [], 15);
    expect(readRecord()).toMatchObject({
      budgetMs: 15,
      consecutiveTimeouts: 1,
      phaseKey: 'init:first-report',
      report: null,
    });

    await timedOutAttempt(manager, [], 15);
    expect(readRecord()).toMatchObject({ consecutiveTimeouts: 2, phaseKey: 'init:first-report' });
    expect(await settled(manager.getDatabase())).toMatchObject({
      message: expect.stringContaining('starting the database process timed out twice'),
      name: 'DbHostInitStoppedError',
    });
  });

  it('a successful init removes the record', async () => {
    const { manager } = await loadManager();
    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    expect(existsSync(recordPath())).toBe(true);

    const database = manager.getDatabase();
    const host = latestProcess();
    host.progress(OPEN);
    host.reply({ initialized: true });
    await expect(database).resolves.toBeDefined();

    expect(existsSync(recordPath())).toBe(false);
  });

  it('a non-timeout init failure leaves the record untouched and forks nothing new', async () => {
    const { manager } = await loadManager();
    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    const before = readFileSync(recordPath(), 'utf8');

    const failure = settled(manager.getDatabase());
    latestProcess().progress(OPEN);
    latestProcess().reject('The desktop database could not rebuild its search index');
    expect(await failure).toMatchObject({
      message: 'The desktop database could not rebuild its search index',
    });

    expect(readFileSync(recordPath(), 'utf8')).toBe(before);
    expect(forkMock).toHaveBeenCalledTimes(2);
    // The host is alive and holds the real failure: the retry reuses it.
    void manager.getDatabase();
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a persisted stop across a relaunch: no fork, and diagnostics answer from the record', async () => {
    writeFileSync(
      recordPath(),
      JSON.stringify({
        budgetMs: REBUILD_BUDGET_MS,
        consecutiveTimeouts: 2,
        hostPid: 4242,
        lastTimeoutAt: '2026-09-29T18:00:00.000Z',
        phaseKey: REBUILD_KEY,
        report: { ...REBUILD, secret: 'do-not-surface' },
        secret: 'do-not-surface',
        version: 1,
      })
    );
    const { DbHostInitStoppedError, manager } = await loadManager();

    // Diagnostics first, as a platform-diagnostics read after launch would: still no fork.
    const diagnostics = await manager.getDiagnostics();
    expect(diagnostics).toMatchObject({ initStop: { consecutiveTimeouts: 2 } });
    const stopped = await settled(manager.getDatabase());
    expect(stopped).toBeInstanceOf(DbHostInitStoppedError);
    expect(forkMock).not.toHaveBeenCalled();
    // A tampered file's extra keys reach neither the diagnostics nor the error.
    expect(JSON.stringify([diagnostics, stopped, (stopped as Error).message])).not.toContain(
      'do-not-surface'
    );
  });

  it('logs at error and still kills the host when the record cannot be written', async () => {
    // A directory where the write's temp file belongs: reading the record is fine (it is absent),
    // writing it is not.
    mkdirSync(`${recordPath()}.tmp`);
    const { DbHostRequestTimeoutError, manager } = await loadManager();

    const { error, host } = await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);

    // The timeout is still what the caller sees, and the wedged host is still killed.
    expect(error).toBeInstanceOf(DbHostRequestTimeoutError);
    expect(killSpy).toHaveBeenCalledWith(host.pid, 'SIGKILL');
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Could not persist the DB init attempt record; a stop after repeated timeouts is kept for this session only',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});

describe('a stopped manager forks nothing, on any path', () => {
  const seedStop = (): void => {
    writeFileSync(
      recordPath(),
      JSON.stringify({
        budgetMs: REBUILD_BUDGET_MS,
        consecutiveTimeouts: 2,
        hostPid: 4242,
        lastTimeoutAt: '2026-09-29T18:00:00.000Z',
        phaseKey: REBUILD_KEY,
        report: REBUILD,
        version: 1,
      })
    );
  };

  it('rejects every request that would fork a host, and forks none', async () => {
    seedStop();
    const { DbHostInitStoppedError, manager } = await loadManager();

    // Data requests, and a reset (which needs a host to run in): none may start one.
    for (const request of [
      manager.applyManagedCacheBatch({}),
      manager.insertChunksAndEnqueueEmbeddingJobs({}),
      manager.invalidateManagedCacheEntriesByIdentity({}),
      manager.reset(),
    ]) {
      expect(await settled(request)).toBeInstanceOf(DbHostInitStoppedError);
    }
    expect(forkMock).not.toHaveBeenCalled();
    // Closing a manager with no host is still a no-op, so a reset can retire it.
    await expect(manager.close()).resolves.toBeUndefined();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('follows the record: once a reset has removed it, the same manager forks again', async () => {
    seedStop();
    const { DbHostInitStoppedError, manager } = await loadManager();
    expect(await settled(manager.getDatabase())).toBeInstanceOf(DbHostInitStoppedError);

    // A reset deletes the profile, and the record with it.
    rmSync(recordPath());
    void manager.getDatabase();

    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('a completed reset cancels a pending no-deadline for the init after it', async () => {
    const { DbHostRequestTimeoutError, manager } = await loadManager();
    manager.retryInit({ noDeadline: true });
    const reset = manager.reset();
    const host = latestProcess();
    host.emit('message', {
      id: host.messages.at(-1)?.id,
      kind: 'response',
      ok: true,
      result: null,
    });
    await reset;

    const attempt = settled(manager.getDatabase());
    await vi.advanceTimersByTimeAsync(15);

    expect(await attempt).toBeInstanceOf(DbHostRequestTimeoutError);
  });

  it('keeps counting in memory when the record cannot be written, so the breaker still trips', async () => {
    // A directory where the write's temp file belongs: every write fails.
    mkdirSync(`${recordPath()}.tmp`);
    const { DbHostInitStoppedError, manager } = await loadManager();

    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    await timedOutAttempt(manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    const third = await settled(manager.getDatabase());

    expect(existsSync(recordPath())).toBe(false);
    expect(third).toBeInstanceOf(DbHostInitStoppedError);
    expect(forkMock).toHaveBeenCalledTimes(2);
    // ...and retryInit still clears it, so the person is never stuck on a record that never existed.
    manager.retryInit({ noDeadline: false });
    void manager.getDatabase();
    expect(forkMock).toHaveBeenCalledTimes(3);
  });

  it.each([0, -1, Number.NaN, 1.5, 2_147_483_648])(
    'refuses an initialization window of %s: it could not be armed, or recorded',
    async (window) => {
      await expect(loadManager(window)).rejects.toThrow(RangeError);
    }
  );
});

describe('retryInit', () => {
  async function stoppedManager() {
    const loaded = await loadManager();
    await timedOutAttempt(loaded.manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    await timedOutAttempt(loaded.manager, [OPEN, REBUILD], REBUILD_BUDGET_MS);
    expect(await settled(loaded.manager.getDatabase())).toBeInstanceOf(
      loaded.DbHostInitStoppedError
    );
    return loaded;
  }

  it('clears the stop and the record, and the next init forks', async () => {
    const { manager } = await stoppedManager();
    expect(forkMock).toHaveBeenCalledTimes(2);

    manager.retryInit({ noDeadline: false });
    expect(existsSync(recordPath())).toBe(false);

    const database = manager.getDatabase();
    expect(forkMock).toHaveBeenCalledTimes(3);
    latestProcess().reply({ initialized: true });
    await expect(database).resolves.toBeDefined();

    // The stop is gone, so diagnostics ask the live host again instead of answering from main.
    const diagnostics = manager.getDiagnostics();
    const asked = latestProcess().messages.at(-1);
    expect(asked?.request.kind).toBe('diagnostics');
    latestProcess().emit('message', {
      id: asked?.id,
      kind: 'response',
      ok: true,
      result: { activeLiveQueryCount: 0, hasDatabaseHandle: true },
    });
    await expect(diagnostics).resolves.toMatchObject({ hasDatabaseHandle: true, initStop: null });
  });

  it('with noDeadline arms the init request with the longest timer', async () => {
    const { DbHostRequestTimeoutError, manager } = await stoppedManager();
    killSpy.mockClear(); // the two timed-out attempts that caused the stop killed their hosts

    manager.retryInit({ noDeadline: true });
    const attempt = settled(manager.getDatabase());
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS - 1);
    expect(killSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const error = await attempt;
    expect(error).toBeInstanceOf(DbHostRequestTimeoutError);
    expect(error).toMatchObject({ timeoutMs: MAX_TIMER_MS });
  });

  it('with noDeadline arms every phase with the longest timer', async () => {
    const { DbHostRequestTimeoutError, manager } = await stoppedManager();
    killSpy.mockClear();

    manager.retryInit({ noDeadline: true });
    const attempt = settled(manager.getDatabase());
    const host = latestProcess();
    host.progress(OPEN);
    host.progress(REBUILD);
    // The rebuild's own budget is 372 s; suspended, it is the longest timer instead.
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS - 1);
    expect(killSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const error = await attempt;
    expect(error).toBeInstanceOf(DbHostRequestTimeoutError);
    expect(error).toMatchObject({ phase: REBUILD, timeoutMs: MAX_TIMER_MS });
  });

  it('suspends the deadline for the next init only', async () => {
    const { DbHostRequestTimeoutError, manager } = await stoppedManager();
    manager.retryInit({ noDeadline: true });

    // The suspended attempt fails for a reason that is not a timeout...
    const first = settled(manager.getDatabase());
    latestProcess().reject('init failed');
    expect(await first).toMatchObject({ message: 'init failed' });

    // ...and the attempt after it is armed normally again.
    const second = settled(manager.getDatabase());
    await vi.advanceTimersByTimeAsync(15);
    expect(await second).toBeInstanceOf(DbHostRequestTimeoutError);
  });

  it('a retry without noDeadline cancels a pending suspension', async () => {
    const { DbHostRequestTimeoutError, manager } = await stoppedManager();
    manager.retryInit({ noDeadline: true });
    manager.retryInit({ noDeadline: false });

    const attempt = settled(manager.getDatabase());
    await vi.advanceTimersByTimeAsync(15);

    expect(await attempt).toBeInstanceOf(DbHostRequestTimeoutError);
  });
});

import type { RuntimeData } from '@brainstrike/agent';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDatabaseMock, reindexEditedFileMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
  reindexEditedFileMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({ getDatabase: getDatabaseMock }));
vi.mock('../../assistant-server/reindex-edited-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../assistant-server/reindex-edited-file')>()),
  reindexEditedFile: reindexEditedFileMock,
  statMtimeMs: vi.fn(async () => 1),
}));

import {
  triggerEditedFileReindex,
  triggerFileDeletionInvalidation,
} from '../../assistant-server/reindex-side-effects';
import {
  getDesktopDatabaseIntegrity,
  resetDesktopDatabaseIntegrityForTests,
} from '../../database-integrity-state';
import { resetDesktopDatabaseWorkSchedulerForTests } from '../../platform/desktop-database-work-scheduler';

const SKIP_MESSAGE =
  'Skipped re-index: database integrity containment is active; the Workspace Index may be stale';

const runtimeData = {
  workspaceIndexEmbeddingSetId: 'set-1',
  workspaceIndexingEnabled: true,
} as unknown as RuntimeData;

const editArgs = {
  absolutePath: '/workspace/src/a.ts',
  content: 'export {};',
  rootId: 'root-1',
  runtimeData,
  size: 10,
  workspacePath: '/src/a.ts',
};

/** What Postgres raises for a corrupt page; the classifier reads only this `code`. */
function createCorruptionError(): Error {
  return Object.assign(new Error('invalid page in block 9'), { code: 'XX001' });
}

/** The redacted `error` field each ERROR record carries: a re-index failure logs only its name and code. */
function loggedErrorFields(captured: LogRecord[]): unknown[] {
  return captured
    .filter((record) => record.level === LogLevel.ERROR)
    .flatMap((record) => record.args)
    .filter(
      (arg): arg is { error: unknown } => typeof arg === 'object' && arg !== null && 'error' in arg
    )
    .map((arg) => arg.error);
}

function containDatabase(): void {
  getDesktopDatabaseIntegrity().contain('db:query', {
    message: 'invalid page in block 3',
    sqlstate: 'XX001',
  });
}

describe('assistant re-index side effects under database integrity containment', () => {
  let captured: LogRecord[];
  let removeListener: () => void;

  beforeEach(() => {
    resetDesktopDatabaseIntegrityForTests();
    getDatabaseMock.mockReset();
    getDatabaseMock.mockResolvedValue({ query: vi.fn() });
    reindexEditedFileMock.mockReset();
    reindexEditedFileMock.mockResolvedValue(false);
    setLogLevel(LogLevel.INFO);
    captured = [];
    removeListener = addLogListener((record) => {
      if (record.scope === 'DesktopAssistantTools') {
        captured.push(record);
      }
    });
  });

  afterEach(() => {
    removeListener();
    resetDesktopDatabaseIntegrityForTests();
  });

  function skipWarnings(): LogRecord[] {
    return captured.filter(
      (record) => record.level === LogLevel.WARN && record.message === SKIP_MESSAGE
    );
  }

  it('re-indexes an edited file while the database is healthy', async () => {
    await triggerEditedFileReindex(editArgs);

    expect(getDatabaseMock).toHaveBeenCalledOnce();
    expect(reindexEditedFileMock).toHaveBeenCalledOnce();
    expect(skipWarnings()).toEqual([]);
  });

  it('skips the post-edit re-index while contained: warns, never opens the database', async () => {
    containDatabase();

    await expect(triggerEditedFileReindex(editArgs)).resolves.toBeUndefined();

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(reindexEditedFileMock).not.toHaveBeenCalled();
    expect(skipWarnings()).toHaveLength(1);
  });

  it('skips the delete/rename invalidation while contained and reports indexInvalidated: false', async () => {
    containDatabase();

    await expect(
      triggerFileDeletionInvalidation({
        rootId: 'root-1',
        runtimeData,
        workspacePath: '/src/a.ts',
      })
    ).resolves.toEqual({ invalidated: false });

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(skipWarnings()).toHaveLength(1);
  });

  it('opens the database for the delete/rename invalidation while healthy', async () => {
    await triggerFileDeletionInvalidation({
      rootId: 'root-1',
      runtimeData,
      workspacePath: '/src/a.ts',
    });

    expect(getDatabaseMock).toHaveBeenCalledOnce();
    expect(skipWarnings()).toEqual([]);
  });

  it('stays silent for a delete when no Workspace Index is configured, even while contained', async () => {
    containDatabase();

    await expect(
      triggerFileDeletionInvalidation({
        rootId: 'root-1',
        runtimeData: undefined,
        workspacePath: '/src/a.ts',
      })
    ).resolves.toEqual({ invalidated: false });

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(skipWarnings()).toEqual([]);
  });

  it('contains an integrity error raised by the post-edit re-index and still logs it', async () => {
    reindexEditedFileMock.mockRejectedValueOnce(createCorruptionError());

    await expect(triggerEditedFileReindex(editArgs)).resolves.toBeUndefined();

    expect(getDesktopDatabaseIntegrity().getSnapshot().state).toMatchObject({
      context: 'assistant:reindex',
      kind: 'contained',
      signal: { sqlstate: 'XX001' },
    });
    expect(
      captured.filter((record) => record.level === LogLevel.ERROR).map((record) => record.message)
    ).toEqual(['Failed to re-index edited file; RAG index may be stale until next sync']);
    // The typed error is what gets logged, not the raw one it wraps.
    expect(loggedErrorFields(captured)).toEqual([
      { name: 'DatabaseIntegrityError', redacted: true },
    ]);
  });

  it('leaves the state healthy when the re-index fails for another reason', async () => {
    reindexEditedFileMock.mockRejectedValueOnce(new Error('disk full'));

    await expect(triggerEditedFileReindex(editArgs)).resolves.toBeUndefined();

    expect(getDesktopDatabaseIntegrity().getSnapshot().state).toEqual({ kind: 'healthy' });
    expect(loggedErrorFields(captured)).toEqual([{ name: 'Error', redacted: true }]);
  });

  it('resumes re-indexing once the database has been replaced', async () => {
    containDatabase();
    getDesktopDatabaseIntegrity().markDatabaseReplaced('factory-reset');

    await triggerEditedFileReindex(editArgs);

    expect(reindexEditedFileMock).toHaveBeenCalledOnce();
  });
});

/**
 * The pre-check alone is a one-time read: containment can start while the
 * helper awaits `getDatabase()` or between its own statements. The writes go
 * through the desktop work scheduler as `background` (the same
 * `createScheduledDbHandle(db, getDesktopDatabaseWorkScheduler(), 'background')`
 * the embedding backfill uses), so the scheduler's start-time gate rejects them.
 */
describe('assistant re-index side effects close the containment window', () => {
  let captured: LogRecord[];
  let removeListener: () => void;

  beforeEach(async () => {
    resetDesktopDatabaseIntegrityForTests();
    resetDesktopDatabaseWorkSchedulerForTests();
    getDatabaseMock.mockReset();
    reindexEditedFileMock.mockReset();
    const actual = await vi.importActual<
      typeof import('../../assistant-server/reindex-edited-file')
    >('../../assistant-server/reindex-edited-file');
    reindexEditedFileMock.mockImplementation(actual.reindexEditedFile);
    setLogLevel(LogLevel.INFO);
    captured = [];
    removeListener = addLogListener((record) => {
      if (record.scope === 'DesktopAssistantTools') {
        captured.push(record);
      }
    });
  });

  afterEach(() => {
    removeListener();
    resetDesktopDatabaseIntegrityForTests();
  });

  function createRawDatabase(onQuery?: () => void) {
    return {
      query: vi.fn(async () => {
        onQuery?.();
        return { rows: [{ id: 'fr-1' }] };
      }),
      transaction: vi.fn(async () => undefined),
    };
  }

  function levelMessages(level: LogLevel): (string | undefined)[] {
    return captured.filter((record) => record.level === level).map((record) => record.message);
  }

  it('writes through the scheduler while the database is healthy', async () => {
    const db = createRawDatabase();
    getDatabaseMock.mockResolvedValue(db);

    await triggerEditedFileReindex(editArgs);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(levelMessages(LogLevel.WARN)).toEqual([]);
    expect(levelMessages(LogLevel.ERROR)).toEqual([]);
  });

  it('does not write an edit when containment begins while getDatabase is pending', async () => {
    const db = createRawDatabase();
    const pending = Promise.withResolvers<typeof db>();
    getDatabaseMock.mockReturnValue(pending.promise);

    const run = triggerEditedFileReindex(editArgs);
    containDatabase();
    pending.resolve(db);
    await run;

    expect(db.query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(levelMessages(LogLevel.WARN)).toEqual([SKIP_MESSAGE]);
    expect(levelMessages(LogLevel.ERROR)).toEqual([]);
  });

  it('does not write an edit when containment begins during the file-record lookup', async () => {
    const db = createRawDatabase(containDatabase);
    getDatabaseMock.mockResolvedValue(db);

    await triggerEditedFileReindex(editArgs);

    expect(db.query).toHaveBeenCalledOnce();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(levelMessages(LogLevel.WARN)).toEqual([SKIP_MESSAGE]);
    expect(levelMessages(LogLevel.ERROR)).toEqual([]);
  });

  it('contains an integrity error raised while invalidating index rows and still reports it', async () => {
    const corruption = createCorruptionError();
    getDatabaseMock.mockResolvedValue({
      query: vi.fn(async () => {
        throw corruption;
      }),
      transaction: vi.fn(async () => {
        throw corruption;
      }),
    });

    await expect(
      triggerFileDeletionInvalidation({
        rootId: 'root-1',
        runtimeData,
        workspacePath: '/src/a.ts',
      })
    ).resolves.toEqual({ invalidated: false });

    expect(getDesktopDatabaseIntegrity().getSnapshot().state).toMatchObject({
      context: 'assistant:reindex',
      kind: 'contained',
    });
    expect(levelMessages(LogLevel.ERROR)).toEqual([
      'Failed to invalidate index rows for a removed/renamed file; RAG index may be stale until next sync',
    ]);
    expect(loggedErrorFields(captured)).toEqual([
      { name: 'DatabaseIntegrityError', redacted: true },
    ]);
  });

  it('does not invalidate index rows when containment begins while getDatabase is pending', async () => {
    const db = createRawDatabase();
    const pending = Promise.withResolvers<typeof db>();
    getDatabaseMock.mockReturnValue(pending.promise);

    const run = triggerFileDeletionInvalidation({
      rootId: 'root-1',
      runtimeData,
      workspacePath: '/src/a.ts',
    });
    containDatabase();
    pending.resolve(db);

    await expect(run).resolves.toEqual({ invalidated: false });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(levelMessages(LogLevel.WARN)).toEqual([SKIP_MESSAGE]);
    expect(levelMessages(LogLevel.ERROR)).toEqual([]);
  });
});

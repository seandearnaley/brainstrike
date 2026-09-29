import type { RuntimeData } from '@brainstrike/agent';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDatabaseMock, readWorkspaceTextFileMock, reindexEditedFileMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
  readWorkspaceTextFileMock: vi.fn(),
  reindexEditedFileMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({ getDatabase: getDatabaseMock }));
vi.mock('../../assistant-server/reindex-edited-file', () => ({
  reindexEditedFile: reindexEditedFileMock,
  statMtimeMs: vi.fn(async () => 1),
}));
vi.mock('../../assistant-server/workspace-text-file-reader', () => ({
  readWorkspaceTextFile: readWorkspaceTextFileMock,
}));

import {
  triggerEditedFileReindex,
  triggerFileDeletionInvalidation,
  triggerRenamedDestinationReindex,
} from '../../assistant-server/reindex-side-effects';
import {
  getDesktopDatabaseIntegrity,
  resetDesktopDatabaseIntegrityForTests,
} from '../../database-integrity-state';

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
    readWorkspaceTextFileMock.mockReset();
    readWorkspaceTextFileMock.mockResolvedValue({ content: 'export {};', size: 10 });
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

  it('skips the rename-destination re-index while contained without reading the file, warning once', async () => {
    containDatabase();

    await expect(
      triggerRenamedDestinationReindex({
        absolutePath: '/workspace/src/b.ts',
        rootId: 'root-1',
        rootPath: '/workspace',
        runtimeData,
        workspacePath: '/src/b.ts',
      })
    ).resolves.toBeUndefined();

    expect(readWorkspaceTextFileMock).not.toHaveBeenCalled();
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(skipWarnings()).toHaveLength(1);
  });

  it('re-indexes the rename destination while the database is healthy', async () => {
    await triggerRenamedDestinationReindex({
      absolutePath: '/workspace/src/b.ts',
      rootId: 'root-1',
      rootPath: '/workspace',
      runtimeData,
      workspacePath: '/src/b.ts',
    });

    expect(readWorkspaceTextFileMock).toHaveBeenCalledOnce();
    expect(reindexEditedFileMock).toHaveBeenCalledOnce();
  });

  it('resumes re-indexing once the database has been replaced', async () => {
    containDatabase();
    getDesktopDatabaseIntegrity().markDatabaseReplaced('factory-reset');

    await triggerEditedFileReindex(editArgs);

    expect(reindexEditedFileMock).toHaveBeenCalledOnce();
  });
});

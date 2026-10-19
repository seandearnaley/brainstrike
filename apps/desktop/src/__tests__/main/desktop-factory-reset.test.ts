import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn((_path?: string): string[] => []),
  rename: vi.fn(async (_oldPath: string, _newPath: string): Promise<void> => undefined),
  rm: vi.fn(async (_path: string, _options?: unknown): Promise<void> => undefined),
}));

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return {
    ...mod,
    ...fsMocks,
    default: { ...mod, ...fsMocks },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...mod,
    default: { ...mod, rename: fsMocks.rename, rm: fsMocks.rm },
    rename: fsMocks.rename,
    rm: fsMocks.rm,
  };
});

describe('resetDesktopApplicationData', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.rename.mockResolvedValue(undefined);
    fsMocks.rm.mockResolvedValue(undefined);
    fsMocks.readdirSync.mockReturnValue([
      'Cache',
      'IndexedDB',
      'Local Storage',
      'logs',
      'mcp',
      'pgdata',
    ]);
  });

  it('stops runtimes, resets the database profile, and deletes user data except logs', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');
    const { getDesktopResetDiagnosticsSnapshot } = await import('../../desktop-reset-diagnostics');

    const result = await resetDesktopApplicationData({
      resetDatabaseProfile,
      stopBackgroundRuntimes,
      userDataPath: '/mock/userData',
    });

    const stopOrder = stopBackgroundRuntimes.mock.invocationCallOrder[0];
    const resetOrder = resetDatabaseProfile.mock.invocationCallOrder[0];
    if (stopOrder === undefined || resetOrder === undefined) {
      throw new Error('expected runtime stop and database reset calls');
    }
    expect(stopOrder).toBeLessThan(resetOrder);
    expect(resetDatabaseProfile).toHaveBeenCalledTimes(1);
    expect(fsMocks.readdirSync).toHaveBeenCalledWith('/mock/userData');
    const trashPath = path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1');
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(trashPath, { recursive: true });
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'Cache'),
      path.join(trashPath, 'Cache')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'IndexedDB'),
      path.join(trashPath, 'IndexedDB')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'Local Storage'),
      path.join(trashPath, 'Local Storage')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'mcp'),
      path.join(trashPath, 'mcp')
    );
    expect(fsMocks.rm).toHaveBeenCalledWith(trashPath, {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rm).not.toHaveBeenCalledWith(path.join('/mock/userData', 'logs'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'pgdata'),
      path.join(trashPath, 'pgdata')
    );
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/mock/userData', { recursive: true });
    expect(result).toEqual({
      deletedPaths: [
        path.join('/mock/userData', 'Cache'),
        path.join('/mock/userData', 'IndexedDB'),
        path.join('/mock/userData', 'Local Storage'),
        path.join('/mock/userData', 'mcp'),
        path.join('/mock/userData', 'pgdata'),
      ],
      pendingDeletionPaths: [],
      preservedPaths: [path.join('/mock/userData', 'logs')],
    });
    expect(getDesktopResetDiagnosticsSnapshot('/mock/userData')).toMatchObject({
      lastDeletedPathCount: 5,
      lastError: null,
      lastPreservedPathCount: 1,
      status: 'completed',
      userDataPath: '/mock/userData',
    });
  });

  it('wipes the userData/snapshots shadow-git dir in the wholesale userData reset (BST-1164)', async () => {
    // The shadow-git snapshot store (SnapshotService's `snapshotsBaseDir`,
    // wired in main.ts as `path.join(app.getPath('userData'), 'snapshots')`)
    // deliberately has NO dedicated reset wiring: it lives under userData, so
    // the wholesale wipe must cover it — the FACTORY RESET CONTRACT's dir
    // half, paired with the `brainstrike_workspace_snapshots` table wipe in
    // the reset-table registry. This test pins that — if the dir ever moves
    // out of userData, or `snapshots` is added to the preserved-entry list,
    // captured workspace content would survive a factory reset.
    fsMocks.readdirSync.mockReturnValue(['logs', 'snapshots']);
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    const result = await resetDesktopApplicationData({
      resetDatabaseProfile: vi.fn(async () => undefined),
      stopBackgroundRuntimes: vi.fn(async () => undefined),
      userDataPath: '/mock/userData',
    });

    const trashPath = path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1');
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'snapshots'),
      path.join(trashPath, 'snapshots')
    );
    expect(result.deletedPaths).toContain(path.join('/mock/userData', 'snapshots'));
    expect(result.preservedPaths).toEqual([path.join('/mock/userData', 'logs')]);
  });

  it('does not delete app data when runtime shutdown fails', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => {
      throw new Error('embedding host refused to stop');
    });
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');
    const { getDesktopResetDiagnosticsSnapshot } = await import('../../desktop-reset-diagnostics');

    await expect(
      resetDesktopApplicationData({
        resetDatabaseProfile,
        stopBackgroundRuntimes,
        userDataPath: '/mock/userData',
      })
    ).rejects.toThrow('embedding host refused to stop');

    expect(resetDatabaseProfile).not.toHaveBeenCalled();
    expect(fsMocks.rm).not.toHaveBeenCalled();
    expect(getDesktopResetDiagnosticsSnapshot('/mock/userData')).toMatchObject({
      lastError: 'embedding host refused to stop',
      status: 'failed',
      userDataPath: '/mock/userData',
    });
  });

  it('does not delete app data when the database profile cannot be reset', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => {
      throw new Error('DB host failed to close the database');
    });
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');
    const { getDesktopResetDiagnosticsSnapshot } = await import('../../desktop-reset-diagnostics');

    await expect(
      resetDesktopApplicationData({
        resetDatabaseProfile,
        stopBackgroundRuntimes,
        userDataPath: '/mock/userData',
      })
    ).rejects.toThrow('DB host failed to close the database');

    expect(fsMocks.rename).not.toHaveBeenCalled();
    expect(fsMocks.rm).not.toHaveBeenCalled();
    expect(getDesktopResetDiagnosticsSnapshot('/mock/userData')).toMatchObject({
      lastError: 'DB host failed to close the database',
      status: 'failed',
    });
  });

  it('attempts every user data entry before failing when one entry cannot be staged', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const deleteError = new Error('IndexedDB is locked');
    fsMocks.rename.mockImplementation(async (targetPath: string) => {
      if (targetPath === path.join('/mock/userData', 'IndexedDB')) {
        throw deleteError;
      }
    });
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    await expect(
      resetDesktopApplicationData({
        resetDatabaseProfile,
        stopBackgroundRuntimes,
        userDataPath: '/mock/userData',
      })
    ).rejects.toThrow('Desktop factory reset failed to delete 1 userData entry');

    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'Cache'),
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1', 'Cache')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'IndexedDB'),
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1', 'IndexedDB')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'Local Storage'),
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1', 'Local Storage')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'mcp'),
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1', 'mcp')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'pgdata'),
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1', 'pgdata')
    );
    expect(fsMocks.rename).toHaveBeenCalledTimes(5);
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/mock/userData', { recursive: true });
  });

  it('treats entries that disappear during staging as already deleted', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const missingError = Object.assign(new Error('IndexedDB disappeared'), { code: 'ENOENT' });
    fsMocks.rename.mockImplementation(async (targetPath: string) => {
      if (targetPath === path.join('/mock/userData', 'IndexedDB')) {
        throw missingError;
      }
    });
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    const result = await resetDesktopApplicationData({
      resetDatabaseProfile,
      stopBackgroundRuntimes,
      userDataPath: '/mock/userData',
    });

    expect(result).toEqual({
      deletedPaths: [
        path.join('/mock/userData', 'Cache'),
        path.join('/mock/userData', 'IndexedDB'),
        path.join('/mock/userData', 'Local Storage'),
        path.join('/mock/userData', 'mcp'),
        path.join('/mock/userData', 'pgdata'),
      ],
      pendingDeletionPaths: [],
      preservedPaths: [path.join('/mock/userData', 'logs')],
    });
    expect(fsMocks.rm).toHaveBeenCalledWith(
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1'),
      {
        force: true,
        recursive: true,
      }
    );
  });

  it('fails when locked entries remain in active user data', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const lockedError = Object.assign(new Error('Cache is locked'), { code: 'EPERM' });
    fsMocks.rename.mockImplementation(async (targetPath: string) => {
      if (targetPath === path.join('/mock/userData', 'Cache')) {
        throw lockedError;
      }
    });
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    await expect(
      resetDesktopApplicationData({
        resetDatabaseProfile,
        stopBackgroundRuntimes,
        userDataPath: '/mock/userData',
      })
    ).rejects.toThrow('Desktop factory reset failed to delete 1 userData entry');

    expect(fsMocks.rm).not.toHaveBeenCalled();
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/mock/userData', { recursive: true });
  });

  it('completes once active profile data is staged even when trash cleanup fails', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    fsMocks.rm.mockRejectedValueOnce(new Error('trash still locked'));
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    const result = await resetDesktopApplicationData({
      resetDatabaseProfile,
      stopBackgroundRuntimes,
      userDataPath: '/mock/userData',
    });

    expect(result).toEqual({
      deletedPaths: [
        path.join('/mock/userData', 'Cache'),
        path.join('/mock/userData', 'IndexedDB'),
        path.join('/mock/userData', 'Local Storage'),
        path.join('/mock/userData', 'mcp'),
        path.join('/mock/userData', 'pgdata'),
      ],
      pendingDeletionPaths: [
        path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1'),
      ],
      preservedPaths: [path.join('/mock/userData', 'logs')],
    });
  });

  it('purges the durable NDJSON error-log files (live + rotated siblings) even though logs/ is preserved', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const errorLogFilePaths = [
      '/mock/userData/logs/brainstrike-errors.ndjson',
      '/mock/userData/logs/brainstrike-errors.ndjson.1',
      '/mock/userData/logs/brainstrike-errors.ndjson.2',
    ];
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    const result = await resetDesktopApplicationData({
      errorLogFilePaths,
      resetDatabaseProfile,
      stopBackgroundRuntimes,
      userDataPath: '/mock/userData',
    });

    for (const errorLogFilePath of errorLogFilePaths) {
      expect(fsMocks.rm).toHaveBeenCalledWith(errorLogFilePath, { force: true });
    }
    expect(result.deletedPaths).toEqual(
      expect.arrayContaining(errorLogFilePaths as unknown as string[])
    );
    // The preserved `logs` directory itself is untouched — only the NDJSON
    // files inside it are purged.
    expect(result.preservedPaths).toEqual([path.join('/mock/userData', 'logs')]);
  });

  it('reports (never swallows) a failure to purge a durable NDJSON error-log file, without failing the whole reset', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const errorLogFilePaths = ['/mock/userData/logs/brainstrike-errors.ndjson'];
    const purgeError = Object.assign(new Error('EBUSY: file is locked'), { code: 'EBUSY' });
    fsMocks.rm.mockImplementation(async (targetPath: string) => {
      if (targetPath === errorLogFilePaths[0]) {
        throw purgeError;
      }
    });
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    const result = await resetDesktopApplicationData({
      errorLogFilePaths,
      resetDatabaseProfile,
      stopBackgroundRuntimes,
      userDataPath: '/mock/userData',
    });

    // Not swallowed: surfaced in the result...
    expect(result.pendingDeletionPaths).toContain(errorLogFilePaths[0]);
    expect(result.deletedPaths).not.toContain(errorLogFilePaths[0]);
    // ...and the rest of the reset still completed successfully.
    expect(resetDatabaseProfile).toHaveBeenCalledTimes(1);
  });

  it('does not attempt to purge error-log files when errorLogFilePaths is omitted', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    await resetDesktopApplicationData({
      resetDatabaseProfile,
      stopBackgroundRuntimes,
      userDataPath: '/mock/userData',
    });

    expect(fsMocks.rm).not.toHaveBeenCalledWith(
      expect.stringContaining('brainstrike-errors.ndjson'),
      expect.anything()
    );
  });

  it('uses unique trash paths for same-millisecond reset calls', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    fsMocks.readdirSync.mockReturnValue(['logs']);
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    await resetDesktopApplicationData({
      resetDatabaseProfile,
      stopBackgroundRuntimes,
      userDataPath: '/mock/userData',
    });
    await resetDesktopApplicationData({
      resetDatabaseProfile,
      stopBackgroundRuntimes,
      userDataPath: '/mock/userData',
    });

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-1'),
      { recursive: true }
    );
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000-2'),
      { recursive: true }
    );
  });
});

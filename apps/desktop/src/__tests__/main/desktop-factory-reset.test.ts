import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  rename: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return {
    ...mod,
    ...fsMocks,
    default: { ...mod.default, ...fsMocks },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...mod,
    rename: fsMocks.rename,
    rm: fsMocks.rm,
    default: { ...mod.default, rename: fsMocks.rename, rm: fsMocks.rm },
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
    fsMocks.readdirSync.mockReturnValue(['Cache', 'IndexedDB', 'Local Storage', 'logs', 'mcp']);
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
    expect(stopOrder).toBeLessThan(resetOrder);
    expect(resetDatabaseProfile).toHaveBeenCalledTimes(1);
    expect(fsMocks.readdirSync).toHaveBeenCalledWith('/mock/userData');
    const trashPath = path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000');
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
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/mock/userData', { recursive: true });
    expect(result).toEqual({
      deletedPaths: [
        path.join('/mock/userData', 'Cache'),
        path.join('/mock/userData', 'IndexedDB'),
        path.join('/mock/userData', 'Local Storage'),
        path.join('/mock/userData', 'mcp'),
      ],
      pendingDeletionPaths: [],
      preservedPaths: [path.join('/mock/userData', 'logs')],
    });
    expect(getDesktopResetDiagnosticsSnapshot('/mock/userData')).toMatchObject({
      lastDeletedPathCount: 4,
      lastError: null,
      lastPreservedPathCount: 1,
      status: 'completed',
      userDataPath: '/mock/userData',
    });
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
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000', 'Cache')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'IndexedDB'),
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000', 'IndexedDB')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'Local Storage'),
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000', 'Local Storage')
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(
      path.join('/mock/userData', 'mcp'),
      path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000', 'mcp')
    );
    expect(fsMocks.rename).toHaveBeenCalledTimes(4);
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
      ],
      pendingDeletionPaths: [path.join('/mock/userData', '.brainstrike-reset-trash-1700000000000')],
      preservedPaths: [path.join('/mock/userData', 'logs')],
    });
  });
});

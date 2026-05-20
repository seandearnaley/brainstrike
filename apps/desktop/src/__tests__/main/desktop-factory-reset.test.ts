import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
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
    rm: fsMocks.rm,
    default: { ...mod.default, rm: fsMocks.rm },
  };
});

describe('resetDesktopApplicationData', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(true);
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
    expect(fsMocks.rm).toHaveBeenCalledWith(path.join('/mock/userData', 'Cache'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rm).toHaveBeenCalledWith(path.join('/mock/userData', 'IndexedDB'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rm).toHaveBeenCalledWith(path.join('/mock/userData', 'Local Storage'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rm).toHaveBeenCalledWith(path.join('/mock/userData', 'mcp'), {
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

  it('attempts every user data entry before failing when one delete fails', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => undefined);
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const deleteError = new Error('IndexedDB is locked');
    fsMocks.rm.mockImplementation(async (targetPath: string) => {
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

    expect(fsMocks.rm).toHaveBeenCalledWith(path.join('/mock/userData', 'Cache'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rm).toHaveBeenCalledWith(path.join('/mock/userData', 'IndexedDB'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rm).toHaveBeenCalledWith(path.join('/mock/userData', 'Local Storage'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rm).toHaveBeenCalledWith(path.join('/mock/userData', 'mcp'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rm).toHaveBeenCalledTimes(4);
    expect(fsMocks.mkdirSync).not.toHaveBeenCalled();
  });
});

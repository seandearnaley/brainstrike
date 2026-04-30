import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return {
    ...mod,
    ...fsMocks,
    default: { ...mod.default, ...fsMocks },
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
    expect(fsMocks.rmSync).toHaveBeenCalledWith(path.join('/mock/userData', 'Cache'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rmSync).toHaveBeenCalledWith(path.join('/mock/userData', 'IndexedDB'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rmSync).toHaveBeenCalledWith(path.join('/mock/userData', 'Local Storage'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rmSync).toHaveBeenCalledWith(path.join('/mock/userData', 'mcp'), {
      force: true,
      recursive: true,
    });
    expect(fsMocks.rmSync).not.toHaveBeenCalledWith(path.join('/mock/userData', 'logs'), {
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
  });

  it('does not delete app data when runtime shutdown fails', async () => {
    const stopBackgroundRuntimes = vi.fn(async () => {
      throw new Error('embedding host refused to stop');
    });
    const resetDatabaseProfile = vi.fn(async () => undefined);
    const { resetDesktopApplicationData } = await import('../../desktop-factory-reset');

    await expect(
      resetDesktopApplicationData({
        resetDatabaseProfile,
        stopBackgroundRuntimes,
        userDataPath: '/mock/userData',
      })
    ).rejects.toThrow('embedding host refused to stop');

    expect(resetDatabaseProfile).not.toHaveBeenCalled();
    expect(fsMocks.rmSync).not.toHaveBeenCalled();
  });
});

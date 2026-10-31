import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => ({
  autoDownload: true,
  autoInstallOnAppQuit: true,
  checkForUpdatesAndNotify: vi.fn(),
  getOrCreateDownloadHelper: vi.fn(),
  logger: null as unknown,
}));

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0-beta.3', isPackaged: true } }));
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }));
vi.mock('../../desktop-database-location', () => ({ isIsolatedDesktopTestRun: () => false }));

const { checkForAppUpdate, clearAppUpdateForReset } = await import('../../app-update');

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

it('a factory reset deletes the downloaded update and stops one still downloading', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'bs-updater-cache-'));
  tempDirs.push(cacheDir);
  await mkdir(path.join(cacheDir, 'pending'), { recursive: true });
  await writeFile(path.join(cacheDir, 'pending', 'update-info.json'), '{}');
  await writeFile(path.join(cacheDir, 'update.zip'), 'previous update');

  let stopDownload: (reason: Error) => void = () => undefined;
  const downloadPromise = new Promise<string[]>((_resolve, reject) => {
    stopDownload = reject;
  });
  const cancel = vi.fn(() => stopDownload(new Error('cancelled')));
  const check = Promise.resolve({ cancellationToken: { cancel }, downloadPromise });
  updater.checkForUpdatesAndNotify.mockReturnValue(check);
  updater.getOrCreateDownloadHelper.mockResolvedValue({ cacheDir });

  checkForAppUpdate({ get: () => undefined, set: () => undefined });
  await check;
  await clearAppUpdateForReset();

  expect(cancel).toHaveBeenCalledOnce();
  await expect(stat(cacheDir)).rejects.toMatchObject({ code: 'ENOENT' });
  // A check still in flight starts no download, and nothing installs on quit.
  expect(updater.autoDownload).toBe(false);
  expect(updater.autoInstallOnAppQuit).toBe(false);
});

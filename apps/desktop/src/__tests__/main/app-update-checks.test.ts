import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppUpdateStatus } from '../../ipc-domains/app-updates.contract';

/**
 * BST-2356: a running app keeps checking for updates, a check asked for while
 * one is under way waits for it, and a downloaded update offers a restart.
 * These drive the real updater over a fake electron-updater and fake clocks.
 */
const updater = vi.hoisted(() => ({
  allowPrerelease: false,
  autoDownload: true,
  autoInstallOnAppQuit: true,
  checkForUpdatesAndNotify: vi.fn(),
  getOrCreateDownloadHelper: vi.fn(),
  logger: null as unknown,
  quitAndInstall: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0', isPackaged: true } }));
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }));
vi.mock('../../desktop-database-location', () => ({ isIsolatedDesktopTestRun: () => false }));
vi.mock('../../electron-e2e-test-mode', () => ({ isElectronE2ETestMode: () => false }));

const { APP_UPDATE_CHECK_INTERVAL_MS, createAppUpdates } = await import('../../app-update');

const noUpdate = { isUpdateAvailable: false, updateInfo: { version: '1.0.0' } };

function updateAvailable(version: string, download: Promise<string[]>) {
  return { downloadPromise: download, isUpdateAvailable: true, updateInfo: { version } };
}

function startedUpdates() {
  const published: AppUpdateStatus[] = [];
  const updates = createAppUpdates();
  updates.start({
    publish: (status) => published.push(status),
    settings: { get: () => undefined, set: () => undefined },
  });
  return { published, updates };
}

beforeEach(() => {
  vi.useFakeTimers();
  updater.checkForUpdatesAndNotify.mockReset();
  updater.quitAndInstall.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

it('an app left open picks up a release published after it started', async () => {
  updater.checkForUpdatesAndNotify.mockResolvedValueOnce(noUpdate);
  const { published, updates } = startedUpdates();
  await vi.waitFor(() => expect(updates.status()).toEqual({ state: 'up-to-date' }));

  updater.checkForUpdatesAndNotify.mockResolvedValueOnce(
    updateAvailable('1.1.0', Promise.resolve(['update.zip']))
  );
  await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);

  await vi.waitFor(() => expect(updates.status()).toEqual({ state: 'ready', version: '1.1.0' }));
  expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);
  expect(published).toEqual([
    { state: 'checking' },
    { state: 'up-to-date' },
    { state: 'checking' },
    { state: 'downloading', version: '1.1.0' },
    { state: 'ready', version: '1.1.0' },
  ]);
});

it('Check now during a download answers with the download instead of starting another', async () => {
  const download = Promise.withResolvers<string[]>();
  updater.checkForUpdatesAndNotify.mockResolvedValueOnce(
    updateAvailable('1.1.0', download.promise)
  );
  const { updates } = startedUpdates();
  await vi.waitFor(() =>
    expect(updates.status()).toEqual({ state: 'downloading', version: '1.1.0' })
  );

  await expect(updates.check()).resolves.toEqual({ state: 'downloading', version: '1.1.0' });
  await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
  expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledOnce();

  download.resolve(['update.zip']);
  await vi.waitFor(() => expect(updates.status()).toEqual({ state: 'ready', version: '1.1.0' }));
  await expect(updates.check()).resolves.toEqual({ state: 'ready', version: '1.1.0' });
  expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledOnce();
});

it('Restart to update installs only a downloaded update', async () => {
  const download = Promise.withResolvers<string[]>();
  updater.checkForUpdatesAndNotify.mockResolvedValueOnce(
    updateAvailable('1.1.0', download.promise)
  );
  const { updates } = startedUpdates();
  await vi.waitFor(() => expect(updates.status().state).toBe('downloading'));

  expect(() => updates.restartToInstall()).toThrow('No downloaded update is waiting to install.');
  expect(updater.quitAndInstall).not.toHaveBeenCalled();

  download.resolve(['update.zip']);
  await vi.waitFor(() => expect(updates.status().state).toBe('ready'));
  updates.restartToInstall();
  expect(updater.quitAndInstall).toHaveBeenCalledOnce();
});

it('a failed check says why, and the next scheduled check tries again', async () => {
  updater.checkForUpdatesAndNotify.mockRejectedValueOnce(
    new Error('net::ERR_INTERNET_DISCONNECTED')
  );
  const { updates } = startedUpdates();
  await vi.waitFor(() =>
    expect(updates.status()).toEqual({
      message: 'net::ERR_INTERNET_DISCONNECTED',
      state: 'failed',
      step: 'check',
    })
  );

  updater.checkForUpdatesAndNotify.mockResolvedValueOnce(noUpdate);
  await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
  await vi.waitFor(() => expect(updates.status()).toEqual({ state: 'up-to-date' }));
});

it('a failed download says why instead of offering a restart', async () => {
  const download = Promise.withResolvers<string[]>();
  updater.checkForUpdatesAndNotify.mockResolvedValueOnce(
    updateAvailable('1.1.0', download.promise)
  );
  const { updates } = startedUpdates();
  await vi.waitFor(() => expect(updates.status().state).toBe('downloading'));
  download.reject(new Error('sha512 checksum mismatch'));

  await vi.waitFor(() =>
    expect(updates.status()).toEqual({
      message: 'sha512 checksum mismatch',
      state: 'failed',
      step: 'download',
    })
  );
  expect(() => updates.restartToInstall()).toThrow();
});

it('a factory reset stops the checks until the next launch', async () => {
  updater.checkForUpdatesAndNotify.mockResolvedValue(noUpdate);
  updater.getOrCreateDownloadHelper.mockResolvedValue({ cacheDir: '/nonexistent/updater-cache' });
  const { published, updates } = startedUpdates();
  await vi.waitFor(() => expect(updates.status()).toEqual({ state: 'up-to-date' }));

  await updates.clearForReset();
  await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS * 3);

  expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledOnce();
  await expect(updates.check()).resolves.toEqual({ reason: 'reset', state: 'off' });
  expect(published.at(-1)).toEqual({ reason: 'reset', state: 'off' });
});

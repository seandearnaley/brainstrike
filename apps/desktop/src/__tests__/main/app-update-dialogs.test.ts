import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppUpdates } from '../../app-update';
import type { MoveToApplicationsStore } from '../../app-update-dialogs';
import type { AppUpdateStatus } from '../../ipc-domains/app-updates.contract';

/**
 * BST-2356: Check for Updates… says what the check found and can restart into
 * a downloaded update; a macOS copy outside Applications offers the move once.
 */
const electron = vi.hoisted(() => ({
  inApplications: false,
  moveToApplicationsFolder: vi.fn(),
  showMessageBox: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    isInApplicationsFolder: () => electron.inApplications,
    isPackaged: true,
    moveToApplicationsFolder: electron.moveToApplicationsFolder,
    name: 'Brainstrike',
  },
  dialog: { showMessageBox: electron.showMessageBox },
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }));
vi.mock('../../desktop-database-location', () => ({ isIsolatedDesktopTestRun: () => false }));
vi.mock('../../electron-e2e-test-mode', () => ({ isElectronE2ETestMode: () => false }));

const { checkForUpdatesFromMenu, describeUpdateCheck, offerMoveToApplicationsFolder } =
  await import('../../app-update-dialogs');

/** Answers each check with the next status in `found`, then keeps the last one. */
function fakeUpdates(
  ...found: [AppUpdateStatus, ...AppUpdateStatus[]]
): AppUpdates & { checks: number; restarts: number } {
  const current = () => found[Math.min(updates.checks, found.length) - 1] ?? found[0];
  const updates = {
    check: () => {
      updates.checks += 1;
      return Promise.resolve(current());
    },
    checks: 0,
    clearForReset: () => Promise.resolve(),
    restarts: 0,
    restartToInstall: () => {
      updates.restarts += 1;
    },
    start: () => undefined,
    status: () => current(),
  };
  return updates;
}

function createStore(): MoveToApplicationsStore {
  const values = new Map<string, unknown>();
  return { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
}

/** The message and buttons of the one dialog shown since the last reset. */
function shownDialog(): { buttons: string[]; message: string } {
  expect(electron.showMessageBox).toHaveBeenCalledOnce();
  const [options] = electron.showMessageBox.mock.lastCall ?? [];
  return { buttons: options.buttons, message: options.message };
}

const originalPlatform = process.platform;

function runOn(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
  runOn(originalPlatform);
});

beforeEach(() => {
  electron.inApplications = false;
  electron.moveToApplicationsFolder.mockReset();
  electron.showMessageBox.mockReset();
});

it('Check for Updates… restarts into a downloaded update when the user picks Restart', async () => {
  const updates = fakeUpdates({ state: 'ready', version: '1.1.0' });
  electron.showMessageBox.mockResolvedValue({ response: 0 });

  await checkForUpdatesFromMenu(updates, undefined);

  expect(shownDialog()).toEqual({
    buttons: ['Restart to update', 'Later'],
    message: 'Brainstrike 1.1.0 is ready to install',
  });
  expect(updates.restarts).toBe(1);
});

it('Check for Updates… leaves a downloaded update for the quit when the user picks Later', async () => {
  const updates = fakeUpdates({ state: 'ready', version: '1.1.0' });
  electron.showMessageBox.mockResolvedValue({ response: 1 });

  await checkForUpdatesFromMenu(updates, undefined);

  expect(updates.restarts).toBe(0);
});

it('Check for Updates… says when the app is up to date, downloading or could not check', async () => {
  electron.showMessageBox.mockResolvedValue({ response: 0 });

  await checkForUpdatesFromMenu(fakeUpdates({ state: 'up-to-date' }), undefined);
  expect(shownDialog().message).toBe('Brainstrike is up to date');

  electron.showMessageBox.mockClear();
  await checkForUpdatesFromMenu(fakeUpdates({ state: 'downloading', version: '1.1.0' }), undefined);
  expect(shownDialog().message).toBe('Downloading Brainstrike 1.1.0');

  expect(
    describeUpdateCheck(
      { message: 'HttpError: 404', state: 'failed', step: 'check' },
      'Brainstrike',
      '1.0.0'
    )
  ).toMatchObject({
    buttons: ['Try again', 'OK'],
    detail: expect.stringContaining('HttpError: 404'),
    message: "Couldn't check for updates",
    type: 'error',
  });
  expect(
    describeUpdateCheck(
      { message: 'sha512 checksum mismatch', state: 'failed', step: 'download' },
      'Brainstrike',
      '1.0.0'
    ).message
  ).toBe("Couldn't download the update");
  expect(
    describeUpdateCheck({ reason: 'not-installed', state: 'off' }, 'Brainstrike', '1.0.0').message
  ).toBe('Updates come only to an installed copy of Brainstrike');
});

it('Check for Updates… runs the check again when a failed check is retried', async () => {
  const updates = fakeUpdates(
    { message: 'net::ERR_INTERNET_DISCONNECTED', state: 'failed', step: 'check' },
    { state: 'up-to-date' }
  );
  electron.showMessageBox.mockResolvedValue({ response: 0 });

  await checkForUpdatesFromMenu(updates, undefined);

  expect(updates.checks).toBe(2);
  expect(electron.showMessageBox.mock.calls.map(([options]) => options.message)).toEqual([
    "Couldn't check for updates",
    'Brainstrike is up to date',
  ]);
});

it('Check for Updates… stops after a failed check when the user picks OK', async () => {
  const updates = fakeUpdates({ message: 'HttpError: 404', state: 'failed', step: 'check' });
  electron.showMessageBox.mockResolvedValue({ response: 1 });

  await checkForUpdatesFromMenu(updates, undefined);

  expect(updates.checks).toBe(1);
  expect(shownDialog().buttons).toEqual(['Try again', 'OK']);
});

it('a macOS copy in Applications is never asked to move', async () => {
  runOn('darwin');
  electron.inApplications = true;

  await offerMoveToApplicationsFolder(createStore(), undefined);

  expect(electron.showMessageBox).not.toHaveBeenCalled();
});

it('a macOS copy outside Applications moves when asked, and Not Now is not asked again', async () => {
  runOn('darwin');
  electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
  await offerMoveToApplicationsFolder(createStore(), undefined);
  expect(shownDialog().buttons).toEqual(['Move to Applications', 'Not Now']);
  expect(electron.moveToApplicationsFolder).toHaveBeenCalledOnce();

  const store = createStore();
  electron.showMessageBox.mockReset();
  electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
  await offerMoveToApplicationsFolder(store, undefined);
  await offerMoveToApplicationsFolder(store, undefined);
  expect(electron.showMessageBox).toHaveBeenCalledOnce();
  expect(electron.moveToApplicationsFolder).toHaveBeenCalledOnce();
});

it('Windows and Linux never offer the move to Applications', async () => {
  runOn('win32');
  await offerMoveToApplicationsFolder(createStore(), undefined);
  runOn('linux');
  await offerMoveToApplicationsFolder(createStore(), undefined);

  expect(electron.showMessageBox).not.toHaveBeenCalled();
});

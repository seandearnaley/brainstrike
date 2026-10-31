import { beforeEach, expect, it, vi } from 'vitest';
import type { UpdatePreferencesStore } from '../../app-update-preferences';

/**
 * BST-2367: Settings › Updates decides whether an update check offers betas
 * (electron-updater's `allowPrerelease`). These run the real check against a
 * fake updater and a settings store kept in memory.
 */
const running = vi.hoisted(() => ({ version: '0.1.0-beta.3' }));
const updater = vi.hoisted(() => ({
  allowPrerelease: false,
  checkForUpdatesAndNotify: vi.fn(),
  logger: null as unknown,
  offeredBetas: [] as boolean[],
}));

vi.mock('electron', () => ({
  app: { getVersion: () => running.version, isPackaged: true },
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }));
vi.mock('../../desktop-database-location', () => ({ isIsolatedDesktopTestRun: () => false }));

const { checkForAppUpdate } = await import('../../app-update');
const { readUpdatePreferences, writeUpdatePreferences } = await import(
  '../../app-update-preferences'
);

function createSettingsStore(): UpdatePreferencesStore & { clear: () => void } {
  const values = new Map<string, unknown>();
  return {
    clear: () => values.clear(),
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
}

/** Launches the app at `version` and reports whether its update check offered betas. */
function launch(store: UpdatePreferencesStore, version: string): boolean {
  running.version = version;
  checkForAppUpdate(store);
  const offered = updater.offeredBetas.at(-1);
  if (offered === undefined) {
    throw new Error('The launch ran no update check');
  }
  return offered;
}

beforeEach(() => {
  updater.allowPrerelease = false;
  updater.offeredBetas = [];
  updater.checkForUpdatesAndNotify.mockImplementation(() => {
    updater.offeredBetas.push(updater.allowPrerelease);
    return Promise.resolve(null);
  });
});

it('a beta install keeps getting betas after it updates to a stable release', () => {
  const settings = createSettingsStore();

  expect(launch(settings, '0.1.0-beta.3')).toBe(true);
  expect(launch(settings, '1.0.0')).toBe(true);
  expect(readUpdatePreferences(settings, '1.0.0')).toEqual({ betaUpdates: true });
});

it('a stable install offers betas from the next check after the switch is turned on', () => {
  const settings = createSettingsStore();

  expect(launch(settings, '1.0.0')).toBe(false);
  writeUpdatePreferences(settings, { betaUpdates: true });
  expect(launch(settings, '1.0.0')).toBe(true);
});

it('turning betas off moves a beta install to stable releases at the next check', () => {
  const settings = createSettingsStore();

  expect(launch(settings, '1.1.0-beta.1')).toBe(true);
  writeUpdatePreferences(settings, { betaUpdates: false });
  expect(launch(settings, '1.1.0-beta.1')).toBe(false);
});

it('after a factory reset the running version picks the channel again', () => {
  const settings = createSettingsStore();
  writeUpdatePreferences(settings, { betaUpdates: true });

  settings.clear();

  expect(readUpdatePreferences(settings, '1.0.0')).toEqual({ betaUpdates: false });
  expect(launch(settings, '1.0.0')).toBe(false);
});

it('a malformed stored preference leaves the running version to pick the channel', () => {
  const settings = createSettingsStore();
  settings.set('updatePreferences', { v1: { betaUpdates: 'yes' } } as never);

  expect(launch(settings, '1.0.0')).toBe(false);
  expect(readUpdatePreferences(settings, '1.0.0-rc.1')).toEqual({ betaUpdates: false });
});

it('build metadata alone does not make a version a beta', () => {
  expect(readUpdatePreferences(createSettingsStore(), '1.0.0+build-7')).toEqual({
    betaUpdates: false,
  });
  expect(readUpdatePreferences(createSettingsStore(), '1.0.0-beta.1+build-7')).toEqual({
    betaUpdates: true,
  });
});

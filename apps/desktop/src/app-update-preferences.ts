import { createLogger } from '@brainstrike/logging';
import type { AppUpdatePreferences } from './ipc-domains/app-updates.contract';
import type { DesktopSettingsStoreSchema } from './store-schema';

const logger = createLogger('AppUpdatePreferences');

const UPDATE_PREFERENCES_KEY = 'updatePreferences' satisfies keyof DesktopSettingsStoreSchema;

type StoredUpdatePreferences = DesktopSettingsStoreSchema[typeof UPDATE_PREFERENCES_KEY];

/** The slice of the desktop settings store (`brainstrike-settings`) the update channel uses. */
export interface UpdatePreferencesStore {
  get(key: typeof UPDATE_PREFERENCES_KEY): unknown;
  set(key: typeof UPDATE_PREFERENCES_KEY, value: StoredUpdatePreferences): void;
}

/** A version with a prerelease part (`0.1.0-beta.3`) is a beta; build metadata (`+…`) is not. */
export function isPrereleaseVersion(version: string): boolean {
  const [release = ''] = version.split('+');
  return release.includes('-');
}

function readStored(store: UpdatePreferencesStore): AppUpdatePreferences | undefined {
  const stored = store.get(UPDATE_PREFERENCES_KEY);
  if (stored === undefined) {
    return;
  }
  const v1: unknown =
    typeof stored === 'object' && stored !== null ? Reflect.get(stored, 'v1') : undefined;
  const betaUpdates: unknown =
    typeof v1 === 'object' && v1 !== null ? Reflect.get(v1, 'betaUpdates') : undefined;
  if (typeof betaUpdates !== 'boolean') {
    logger.warn('Ignoring a malformed update preference; the running version picks the channel', {
      stored,
    });
    return;
  }
  return { betaUpdates };
}

/**
 * The update channel this install follows: the user's choice once made,
 * otherwise beta updates for a beta build and stable releases for a stable one.
 */
export function readUpdatePreferences(
  store: UpdatePreferencesStore,
  appVersion: string
): AppUpdatePreferences {
  return readStored(store) ?? { betaUpdates: isPrereleaseVersion(appVersion) };
}

/**
 * Records the channel before the first update check, so the version an update
 * installs never changes it: a beta install keeps getting betas after it
 * updates to a stable release, until the user turns them off.
 */
export function keepUpdateChannel(
  store: UpdatePreferencesStore,
  appVersion: string
): AppUpdatePreferences {
  const stored = readStored(store);
  if (stored) {
    return stored;
  }
  return writeUpdatePreferences(store, { betaUpdates: isPrereleaseVersion(appVersion) });
}

export function writeUpdatePreferences(
  store: UpdatePreferencesStore,
  preferences: AppUpdatePreferences
): AppUpdatePreferences {
  store.set(UPDATE_PREFERENCES_KEY, { v1: { betaUpdates: preferences.betaUpdates } });
  return { betaUpdates: preferences.betaUpdates };
}

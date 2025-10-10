import {
  __resetLoggingPreferencesStoreForTests,
  useLoggingPreferencesStore,
} from '@brainstrike/preferences';
import { LogLevel } from '@brainstrike/utils';
import { beforeEach, describe, expect, it } from 'vitest';

describe('logging-preferences-store', () => {
  beforeEach(() => {
    __resetLoggingPreferencesStoreForTests();
  });

  it('updates nested file preferences without dropping defaults', () => {
    const initial = useLoggingPreferencesStore.getState().preferences;
    expect(initial.file.append).toBe(true);

    useLoggingPreferencesStore.getState().updatePreferences({
      file: {
        destination: '/tmp/brainstrike.log',
        enabled: true,
      },
    });

    const next = useLoggingPreferencesStore.getState().preferences;
    expect(next.file.enabled).toBe(true);
    expect(next.file.destination).toBe('/tmp/brainstrike.log');
    expect(next.file.append).toBe(true);
    expect(next.file.mkdir).toBe(true);
  });

  it('sets hasHydrated when preferences are explicitly set', () => {
    const store = useLoggingPreferencesStore.getState();
    expect(store.hasHydrated).toBe(false);

    useLoggingPreferencesStore.getState().setPreferences({
      ...store.preferences,
      level: LogLevel.DEBUG,
    });

    const updated = useLoggingPreferencesStore.getState();
    expect(updated.hasHydrated).toBe(true);
    expect(updated.preferences.level).toBe(LogLevel.DEBUG);
  });

  it('resets to default preferences', () => {
    useLoggingPreferencesStore.getState().updatePreferences({
      level: LogLevel.ERROR,
      includeTimestamp: true,
      file: {
        enabled: true,
        destination: '/var/tmp/custom.log',
      },
    });

    useLoggingPreferencesStore.getState().resetPreferences();

    const { preferences } = useLoggingPreferencesStore.getState();
    expect(preferences.level).toBe(LogLevel.INFO);
    expect(preferences.includeTimestamp).toBe(false);
    expect(preferences.file.enabled).toBe(false);
    expect(preferences.file.destination).toBeNull();
  });
});

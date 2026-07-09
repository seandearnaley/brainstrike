import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetNotificationPreferencesStoreForTests,
  useNotificationPreferencesStore,
} from '../stores/notification-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useNotificationPreferencesStore as PersistApi<
  typeof useNotificationPreferencesStore
>;

describe('notification-preferences-store', () => {
  beforeEach(() => {
    __resetNotificationPreferencesStoreForTests();
  });

  it('defaults the master toggle OFF', () => {
    expect(useNotificationPreferencesStore.getState().masterEnabled).toBe(false);
  });

  it('defaults every per-event toggle ON', () => {
    const { events } = useNotificationPreferencesStore.getState();
    expect(events).toEqual({
      runFailed: true,
      runFinished: true,
      toolApprovalRequired: true,
    });
  });

  it('turns the master toggle on and off', () => {
    const store = useNotificationPreferencesStore.getState();
    store.setMasterEnabled(true);
    expect(useNotificationPreferencesStore.getState().masterEnabled).toBe(true);

    store.setMasterEnabled(false);
    expect(useNotificationPreferencesStore.getState().masterEnabled).toBe(false);
  });

  it('toggles a single event without touching the others', () => {
    const store = useNotificationPreferencesStore.getState();
    store.setEventEnabled('runFailed', false);

    const state = useNotificationPreferencesStore.getState();
    expect(state.events.runFailed).toBe(false);
    expect(state.events.runFinished).toBe(true);
    expect(state.events.toolApprovalRequired).toBe(true);
  });

  it('persists the master toggle and per-event flags under the expected storage key', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    useNotificationPreferencesStore.getState().setMasterEnabled(true);
    useNotificationPreferencesStore.getState().setEventEnabled('runFinished', false);

    const stored = options.storage.getItem(options.name) as unknown as {
      state?: { masterEnabled?: boolean; events?: Record<string, boolean> };
    } | null;
    expect(stored).not.toBeNull();
    expect(stored?.state?.masterEnabled).toBe(true);
    expect(stored?.state?.events).toEqual({
      runFailed: true,
      runFinished: false,
      toolApprovalRequired: true,
    });
  });

  it('migrates malformed persisted data back to safe defaults', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }

    const migrated = options.migrate(
      {
        events: { runFailed: 'nope', runFinished: true },
        masterEnabled: 'yes',
      },
      0
    ) as { masterEnabled: boolean; events: Record<string, boolean> };

    expect(migrated.masterEnabled).toBe(false);
    expect(migrated.events).toEqual({
      runFailed: true,
      runFinished: true,
      toolApprovalRequired: true,
    });
  });

  it('resets to defaults', () => {
    const store = useNotificationPreferencesStore.getState();
    store.setMasterEnabled(true);
    store.setEventEnabled('runFailed', false);

    store.resetToDefaults();

    const state = useNotificationPreferencesStore.getState();
    expect(state.masterEnabled).toBe(false);
    expect(state.events).toEqual({
      runFailed: true,
      runFinished: true,
      toolApprovalRequired: true,
    });
  });
});

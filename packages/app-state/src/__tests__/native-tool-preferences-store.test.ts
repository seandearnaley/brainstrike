import { describe, expect, it } from 'vitest';
import { useNativeToolPreferencesStore } from '../stores/native-tool-preferences-store.ts';
import type { PersistApi } from './persist-api-test-helper.ts';

const storeWithPersist = useNativeToolPreferencesStore as PersistApi<
  typeof useNativeToolPreferencesStore
>;

describe('native-tool-preferences-store', () => {
  it('defaults to enabled for known tools', () => {
    const snapshot = useNativeToolPreferencesStore.getState();
    expect(snapshot.isToolEnabled('brainstrike.readWorkspaceFile')).toBe(true);
  });

  it('tracks disabled tools and re-enables them', () => {
    const snapshot = useNativeToolPreferencesStore.getState();
    snapshot.setToolEnabled('brainstrike.readWorkspaceFile', false);

    expect(snapshot.isToolEnabled('brainstrike.readWorkspaceFile')).toBe(false);

    snapshot.setToolEnabled('brainstrike.readWorkspaceFile', true);
    expect(snapshot.isToolEnabled('brainstrike.readWorkspaceFile')).toBe(true);
  });

  it('resets tool state to defaults', () => {
    const snapshot = useNativeToolPreferencesStore.getState();
    snapshot.setToolEnabled('brainstrike.readWorkspaceFile', false);
    expect(snapshot.isToolEnabled('brainstrike.readWorkspaceFile')).toBe(false);

    snapshot.resetTools();
    expect(snapshot.isToolEnabled('brainstrike.readWorkspaceFile')).toBe(true);
  });

  it('does not persist default enabled tool state', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const snapshot = useNativeToolPreferencesStore.getState();
    snapshot.setToolEnabled('brainstrike.readWorkspaceFile', false);
    expect(options.storage.getItem(options.name)).not.toBeNull();

    snapshot.setToolEnabled('brainstrike.readWorkspaceFile', true);
    expect(options.storage.getItem(options.name)).toBeNull();
  });

  it('supports batch toggles and no-op for empty tool lists', () => {
    const snapshot = useNativeToolPreferencesStore.getState();
    snapshot.setToolsEnabled([], false);
    expect(snapshot.isToolEnabled('brainstrike.readWorkspaceFile')).toBe(true);

    snapshot.setToolsEnabled(['brainstrike.readWorkspaceFile'], false);
    expect(snapshot.isToolEnabled('brainstrike.readWorkspaceFile')).toBe(false);

    snapshot.setToolsEnabled(['brainstrike.readWorkspaceFile'], true);
    expect(snapshot.isToolEnabled('brainstrike.readWorkspaceFile')).toBe(true);
  });

  it('migrates stored tool states by keeping only known boolean values', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }

    const migrated = options.migrate(
      {
        toolStates: {
          'brainstrike.getSelection': 'false',
          'brainstrike.readWorkspaceFile': false,
          skill_read: false,
          unknownTool: false,
        },
      },
      0
    );

    expect(migrated).toEqual({
      toolStates: {
        'brainstrike.readWorkspaceFile': false,
      },
    });
  });

  it('self-heals unknown tool states persisted at the current version', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name && storeWithPersist.persist?.rehydrate)) {
      throw new Error('persist storage unavailable for test');
    }

    const storage = options.storage as unknown as {
      setItem: (
        name: string,
        value: {
          state: {
            toolStates: Record<string, boolean>;
          };
          version: number;
        }
      ) => void;
    };
    storage.setItem(options.name, {
      state: {
        toolStates: {
          'brainstrike.readWorkspaceFile': false,
          'brainstrike.removedNativeTool': false,
        },
      },
      version: 1,
    });
    await storeWithPersist.persist.rehydrate();

    expect(useNativeToolPreferencesStore.getState().toolStates).toEqual({
      'brainstrike.readWorkspaceFile': false,
    });
  });

  it('clears malformed persisted JSON before hydration', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    window.localStorage.setItem(options.name, '{not-valid-json');

    expect(options.storage.getItem(options.name)).toBeNull();
    expect(window.localStorage.getItem(options.name)).toBeNull();
  });
});

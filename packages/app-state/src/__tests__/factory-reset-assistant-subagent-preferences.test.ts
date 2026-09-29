import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset';
import {
  __resetAssistantSubagentPreferencesStoreForTests,
  useAssistantSubagentPreferencesStore,
} from '../stores/assistant-subagent-preferences-store';

const globalWindow = window as Window & typeof globalThis & { caches?: CacheStorage };

describe('factory reset wires the assistant subagent preferences store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetAssistantSubagentPreferencesStoreForTests();
    originalCaches = globalWindow.caches;
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: {
        delete: async () => true,
        keys: async () => [] as string[],
      } as unknown as CacheStorage,
    });
  });

  afterEach(() => {
    if (originalCaches) {
      Object.defineProperty(globalWindow, 'caches', { configurable: true, value: originalCaches });
    } else {
      Reflect.deleteProperty(globalWindow, 'caches');
    }
    __resetAssistantSubagentPreferencesStoreForTests();
  });

  it('resets in-memory + persisted subagent budgets during clearPersistentUiState', async () => {
    useAssistantSubagentPreferencesStore.getState().setMaxChildSteps(7);
    await clearPersistentUiState({ skipIndexedDb: true });
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });
});

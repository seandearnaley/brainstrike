import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetAssistantBudgetPreferencesStoreForTests,
  useAssistantBudgetPreferencesStore,
} from '../stores/assistant-budget-preferences-store';

describe('assistant budget preferences store', () => {
  afterEach(() => {
    __resetAssistantBudgetPreferencesStoreForTests();
  });

  it('defaults both caps to null (off)', () => {
    const state = useAssistantBudgetPreferencesStore.getState();
    expect(state.dailyCapUsd).toBeNull();
    expect(state.perRunCapUsd).toBeNull();
  });

  it('stores valid caps and clears them with null', () => {
    const store = useAssistantBudgetPreferencesStore.getState();
    store.setDailyCapUsd(12.5);
    store.setPerRunCapUsd(0.75);
    expect(useAssistantBudgetPreferencesStore.getState().dailyCapUsd).toBe(12.5);
    expect(useAssistantBudgetPreferencesStore.getState().perRunCapUsd).toBe(0.75);

    store.setDailyCapUsd(null);
    store.setPerRunCapUsd(null);
    expect(useAssistantBudgetPreferencesStore.getState().dailyCapUsd).toBeNull();
    expect(useAssistantBudgetPreferencesStore.getState().perRunCapUsd).toBeNull();
  });

  it('THROWS on non-finite or non-positive caps instead of coercing', () => {
    const store = useAssistantBudgetPreferencesStore.getState();
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.setDailyCapUsd(invalid)).toThrow(/finite/i);
      expect(() => store.setPerRunCapUsd(invalid)).toThrow(/finite/i);
    }
    // A rejected write never lands.
    expect(useAssistantBudgetPreferencesStore.getState().dailyCapUsd).toBeNull();
    expect(useAssistantBudgetPreferencesStore.getState().perRunCapUsd).toBeNull();
  });

  it('resets to defaults', () => {
    const store = useAssistantBudgetPreferencesStore.getState();
    store.setDailyCapUsd(5);
    store.setPerRunCapUsd(1);
    store.resetToDefaults();
    expect(useAssistantBudgetPreferencesStore.getState().dailyCapUsd).toBeNull();
    expect(useAssistantBudgetPreferencesStore.getState().perRunCapUsd).toBeNull();
  });
});

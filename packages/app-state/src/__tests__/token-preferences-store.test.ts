import { describe, expect, it } from 'vitest';
import {
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '../stores/token-preferences-store.ts';

describe('token-preferences-store', () => {
  it('initializes with accurate counting enabled', () => {
    const snapshot = useTokenPreferencesStore.getState();
    expect(snapshot.accurateCounting).toBe(true);
  });

  it('updates accurate counting flag via setter', () => {
    const storeState = useTokenPreferencesStore.getState();
    storeState.setAccurateCounting(false);
    const next = useTokenPreferencesStore.getState();
    expect(next.accurateCounting).toBe(false);
    expect(tokenPreferencesSelectors.accurateCounting(next)).toBe(false);
  });
});

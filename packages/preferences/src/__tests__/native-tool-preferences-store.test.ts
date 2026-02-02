import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetNativeToolPreferencesStoreForTests,
  useNativeToolPreferencesStore,
} from '../stores/native-tool-preferences-store';

describe('native-tool-preferences-store', () => {
  beforeEach(() => {
    __resetNativeToolPreferencesStoreForTests();
  });

  it('defaults to enabled for known tools', () => {
    const snapshot = useNativeToolPreferencesStore.getState();
    expect(snapshot.isToolEnabled('brainstrike.hybridSearch')).toBe(true);
  });

  it('tracks disabled tools and re-enables them', () => {
    const snapshot = useNativeToolPreferencesStore.getState();
    snapshot.setToolEnabled('brainstrike.hybridSearch', false);

    expect(snapshot.isToolEnabled('brainstrike.hybridSearch')).toBe(false);

    snapshot.setToolEnabled('brainstrike.hybridSearch', true);
    expect(snapshot.isToolEnabled('brainstrike.hybridSearch')).toBe(true);
  });

  it('resets tool state to defaults', () => {
    const snapshot = useNativeToolPreferencesStore.getState();
    snapshot.setToolEnabled('brainstrike.hybridSearch', false);
    expect(snapshot.isToolEnabled('brainstrike.hybridSearch')).toBe(false);

    snapshot.resetTools();
    expect(snapshot.isToolEnabled('brainstrike.hybridSearch')).toBe(true);
  });
});

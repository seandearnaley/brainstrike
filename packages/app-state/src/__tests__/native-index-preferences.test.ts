import { beforeEach, expect, it } from 'vitest';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '../stores/background-indexing-preferences-store';

beforeEach(() => __resetBackgroundIndexingPreferencesStoreForTests());
it('requires an explicit native mode and retains the complete selected local plan', () => {
  const store = useBackgroundIndexingPreferencesStore.getState();
  expect(store.nativeIndexMode).toBeNull();
  store.setNativeIndexMode('VECTOR');
  const plan = {
    device: 'wasm',
    dimensions: 384,
    dtype: 'q8',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  } as const;
  store.setNativeLocalSelection(plan);
  expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
    nativeIndexMode: 'VECTOR',
    nativeLocalSelection: plan,
  });
  useBackgroundIndexingPreferencesStore.getState().reset();
  expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
    nativeIndexMode: null,
    nativeLocalSelection: null,
  });
});

it('rejects incomplete saved vector selections instead of creating an inference default', () => {
  expect(() =>
    useBackgroundIndexingPreferencesStore.getState().setNativeLocalSelection({
      dimensions: 384,
      modelId: 'Xenova/all-MiniLM-L6-v2',
    } as never)
  ).toThrow('explicit');
});

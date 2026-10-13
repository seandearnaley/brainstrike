// @vitest-environment jsdom
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { type ModelCatalogCapability, projectModelCatalog } from '@brainstrike/assistant-contract';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useEnabledCatalogModels } from '../../renderer/use-enabled-catalog-models';

vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: () => 'unused',
  usePGliteDatabase: (options?: { enabled?: boolean }) => {
    if (options?.enabled !== false) {
      throw new Error('Desktop model selection must not initialize PGlite');
    }
    return null;
  },
  usePGliteLiveQuery: () => {
    throw new Error('Desktop model selection must not query PGlite');
  },
}));
const initial = projectModelCatalog({ models: [], providers: [] });
const model = initial.models.find((row) => row.providerId === 'openai');
if (!model) {
  throw new Error('The canonical catalog must include OpenAI.');
}
const modelId = model.id;
function catalog(): ModelCatalogCapability {
  return {
    initializeProviderDefaults: vi.fn(async () => ({
      outcome: 'preserved' as const,
      snapshot: initial,
    })),
    read: vi.fn(async () => initial),
    setModels: vi.fn(async () => ({ previous: [], snapshot: initial })),
    setProvider: vi.fn(async () => initial),
  };
}
beforeEach(() => __resetModelRegistryStoreForTests());
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'modelCatalog');
});
test('uses the canonical model snapshot and observes committed Settings toggles without SQL', async () => {
  const source = catalog();
  Object.defineProperty(window, 'modelCatalog', { configurable: true, value: source });
  const { result } = renderHook(useEnabledCatalogModels);
  await waitFor(() => expect(result.current.state).toBe('ready'));
  const committed = projectModelCatalog({
    models: [{ enabled: true, modelId, providerId: 'openai' }],
    providers: [],
  });
  vi.mocked(source.setModels).mockResolvedValue({ previous: [], snapshot: committed });
  await act(() => useModelRegistryStore.getState().setModelsEnabled(source, [modelId], true));
  expect(result.current).toEqual({
    keys: new Set(
      committed.models.filter((row) => row.isEnabled).map((row) => `${row.providerId}::${row.id}`)
    ),
    state: 'ready',
  });
});
test('retains a failed catalog read as an explicit error, never SQL or ready empty', async () => {
  const source = catalog();
  vi.mocked(source.read).mockRejectedValue(new Error('catalog unavailable'));
  Object.defineProperty(window, 'modelCatalog', { configurable: true, value: source });
  const { result } = renderHook(useEnabledCatalogModels);
  await waitFor(() =>
    expect(result.current).toEqual({ message: 'catalog unavailable', state: 'error' })
  );
});

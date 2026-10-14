import { type ModelCatalogCapability, projectModelCatalog } from '@brainstrike/assistant-contract';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../stores/model-registry-store';

const { diagnosticError } = vi.hoisted(() => ({ diagnosticError: vi.fn() }));
vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), error: diagnosticError, info: vi.fn(), warn: vi.fn() }),
}));

const initial = projectModelCatalog({ models: [], providers: [] });
const model = initial.models.find(
  (row) => row.providerId === 'openai' && row.capabilities.type === 'llm'
);
if (!model) {
  throw new Error('The current catalog must offer an OpenAI LLM.');
}
const modelId = model.id;

function capability(): ModelCatalogCapability {
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

describe('model registry authoritative platform capability', () => {
  it('loads the complete typed catalog without any SQL capability', async () => {
    const source = capability();
    await useModelRegistryStore.getState().fetchRegistry(source);
    expect(source.read).toHaveBeenCalledOnce();
    expect(useModelRegistryStore.getState()).toMatchObject({
      error: null,
      hasLoaded: true,
      models: initial.models,
      providers: initial.providers,
    });
  });

  it('uses committed snapshot and writer-owned previous values for bulk Undo', async () => {
    const source = capability();
    await useModelRegistryStore.getState().fetchRegistry(source);
    // Another client changed the value after this renderer loaded its snapshot.
    const committed = projectModelCatalog({
      models: [{ enabled: true, modelId, providerId: 'openai' }],
      providers: [],
    });
    vi.mocked(source.setModels).mockResolvedValue({
      previous: [{ enabled: true, modelId }],
      snapshot: committed,
    });
    const previous = await useModelRegistryStore
      .getState()
      .setModelsEnabled(source, [modelId], true);
    expect(previous).toEqual(new Map([[modelId, true]]));
    expect(source.setModels).toHaveBeenCalledWith([modelId], true);
    expect(useModelRegistryStore.getState().models).toEqual(committed.models);
  });

  it('keeps a failed read sticky until explicit Retry and never attempts SQL', async () => {
    const source = capability();
    const cause = new Error('catalog transport unavailable');
    vi.mocked(source.read).mockRejectedValueOnce(cause);
    await useModelRegistryStore.getState().ensureRegistry(source);
    expect(useModelRegistryStore.getState().error).toBe(INTERNAL_FAULT.message);
    expect(diagnosticError).toHaveBeenCalledWith('Failed to fetch model registry', cause);
    await useModelRegistryStore.getState().ensureRegistry(source);
    expect(source.read).toHaveBeenCalledTimes(1);
    await useModelRegistryStore.getState().fetchRegistry(source);
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(useModelRegistryStore.getState()).toMatchObject({ error: null, hasLoaded: true });
  });

  it('routes provider choices/default policy and single toggles through their existing owner', async () => {
    const source = capability();
    await useModelRegistryStore.getState().fetchRegistry(source);
    await useModelRegistryStore.getState().toggleProvider(source, 'openai', true);
    await useModelRegistryStore.getState().toggleModel(source, modelId, true);
    expect(source.setProvider).toHaveBeenCalledWith('openai', true);
    expect(source.setModels).toHaveBeenCalledWith([modelId], true);
    expect(
      await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(source, 'openai', { kind: 'all' })
    ).toBe('preserved');
    expect(source.initializeProviderDefaults).toHaveBeenCalledWith('openai', { kind: 'all' });
    vi.mocked(source.setModels).mockRejectedValueOnce(new Error('writer refused'));
    await expect(
      useModelRegistryStore.getState().setModelsEnabled(source, [modelId], false)
    ).rejects.toThrow('writer refused');
    expect(useModelRegistryStore.getState().models).toEqual(initial.models);
  });
});

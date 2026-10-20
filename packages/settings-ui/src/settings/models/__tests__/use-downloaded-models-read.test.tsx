import '@testing-library/jest-dom/vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureModelRuntimeServices,
  type ModelRuntimeServices,
} from '../model-runtime-services';
import { useDownloadedModelsRead } from '../use-downloaded-models-read';

/** BST-2241: "downloaded" is what the embedding realm's model cache holds. */
function row(overrides: Partial<DbModel> & Pick<DbModel, 'id' | 'providerId'>): DbModel {
  return {
    bestFor: null,
    capabilities: {
      defaultDimension: 384,
      prompts: { document: '', query: '' },
      type: 'embedding',
    },
    description: null,
    icon: null,
    isEnabled: true,
    name: overrides.id,
    parameters: null,
    sortOrder: 1,
    tagline: null,
    ...overrides,
  } as DbModel;
}

const GRANITE = row({
  id: 'granite',
  parameters: { execution: { wasm: 'q8' }, revision: '0123456789abcdef0123456789abcdef01234567' },
  providerId: 'local',
});
const MINILM = row({ id: 'minilm', providerId: 'local' });
const HOSTED = row({ id: 'text-embedding-3-small', providerId: 'openai' });
const LOCAL_CHAT = row({
  capabilities: { type: 'llm' } as DbModel['capabilities'],
  id: 'gemma',
  providerId: 'transformers',
});

let read: ReturnType<typeof vi.fn<ModelRuntimeServices['readDownloadedEmbeddingModels']>>;

beforeEach(() => {
  __resetModelRegistryStoreForTests();
  read = vi.fn<ModelRuntimeServices['readDownloadedEmbeddingModels']>();
  configureModelRuntimeServices({
    downloadEmbeddingModel: vi.fn(),
    readDownloadedEmbeddingModels: read,
  });
});
afterEach(() => {
  configureModelRuntimeServices(null);
});

function loaded(models: readonly DbModel[]): void {
  act(() => {
    useModelRegistryStore.setState({ hasLoaded: true, models: [...models] });
  });
}

describe('useDownloadedModelsRead', () => {
  it('asks the realm about its on-device embedding rows only, and stores its answer', async () => {
    read.mockResolvedValue(['granite']);
    loaded([GRANITE, MINILM, HOSTED, LOCAL_CHAT]);

    renderHook(() => useDownloadedModelsRead());

    await waitFor(() =>
      expect(useModelRegistryStore.getState().downloadedModels).toEqual({ granite: true })
    );
    expect(read).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        execution: { wasm: 'q8' },
        id: 'granite',
        revision: '0123456789abcdef0123456789abcdef01234567',
      }),
      expect.objectContaining({ id: 'minilm' }),
    ]);
  });

  it('applies only the latest read when the catalog changes mid-read', async () => {
    const first = Promise.withResolvers<readonly string[]>();
    read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(['minilm']);
    loaded([GRANITE, MINILM]);
    renderHook(() => useDownloadedModelsRead());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    loaded([MINILM]);
    await waitFor(() =>
      expect(useModelRegistryStore.getState().downloadedModels).toEqual({ minilm: true })
    );
    await act(async () => {
      first.resolve(['granite']);
      await first.promise;
    });

    expect(useModelRegistryStore.getState().downloadedModels).toEqual({ minilm: true });
  });

  it('marks nothing downloaded when the realm cannot tell', async () => {
    read.mockRejectedValue(new Error('WebGPU is not available on this device'));
    loaded([GRANITE]);

    renderHook(() => useDownloadedModelsRead());

    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(useModelRegistryStore.getState().downloadedModels).toEqual({});
  });

  it('reads nothing before the registry loads, or without on-device models', () => {
    act(() => {
      useModelRegistryStore.setState({ models: [GRANITE] });
    });
    const { rerender } = renderHook(() => useDownloadedModelsRead());
    loaded([HOSTED]);
    rerender();

    expect(read).not.toHaveBeenCalled();
  });
});

import { type ModelCatalogCapability, projectModelCatalog } from '@brainstrike/assistant-contract';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import {
  type BoundaryTransport,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnsureModelRegistry } from '../hooks/use-model-registry';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../stores/model-registry-store';

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

type CatalogRead = BoundaryTransport<ModelCatalogCapability>['read'];

function catalogTransport(read: CatalogRead): BoundaryTransport<ModelCatalogCapability> {
  const snapshot = projectModelCatalog({ models: [], providers: [] });
  return {
    initializeProviderDefaults: async () => ({
      ok: true,
      value: { outcome: 'preserved', snapshot },
    }),
    read,
    setModels: async () => ({ ok: true, value: { previous: [], snapshot } }),
    setProvider: async () => ({ ok: true, value: snapshot }),
  };
}

describe('useEnsureModelRegistry after a failed registry fetch', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a consumer that mounts later neither refetches nor clears the error; Retry fetches once', async () => {
    const read = vi.fn<CatalogRead>().mockResolvedValue({ error: INTERNAL_FAULT, ok: false });
    const transport = catalogTransport(read);
    vi.stubGlobal('modelCatalog', transport);
    renderHook(() => useEnsureModelRegistry());
    await waitFor(() => {
      expect(useModelRegistryStore.getState().error).toEqual(expect.any(String));
    });
    const retainedError = useModelRegistryStore.getState().error;
    expect(retainedError).not.toBe('');
    expect(read).toHaveBeenCalledTimes(1);

    const errors: (string | null)[] = [];
    const unsubscribe = useModelRegistryStore.subscribe((state) => errors.push(state.error));
    const later = renderHook(() => useEnsureModelRegistry());
    await act(async () => {
      await Promise.resolve();
    });
    unsubscribe();
    expect(read).toHaveBeenCalledTimes(1);
    expect(errors).not.toContain(null);
    expect(later.result.current).toBe(retainedError);

    // Retry and the header Refresh call fetchRegistry directly.
    read.mockResolvedValue({ ok: true, value: projectModelCatalog({ models: [], providers: [] }) });
    await act(async () => {
      await useModelRegistryStore
        .getState()
        .fetchRegistry(createBoundaryCapability<ModelCatalogCapability>(transport));
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(useModelRegistryStore.getState()).toMatchObject({ error: null, hasLoaded: true });
  });
});

describe('desktop model catalog consumer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the registry through the catalog capability', async () => {
    __resetModelRegistryStoreForTests();
    const snapshot = projectModelCatalog({ models: [], providers: [] });
    const read = vi.fn(async () => ({ ok: true as const, value: snapshot }));
    const catalog: BoundaryTransport<ModelCatalogCapability> = {
      initializeProviderDefaults: async () => ({
        ok: true,
        value: { outcome: 'preserved', snapshot },
      }),
      read,
      setModels: async () => ({ ok: true, value: { previous: [], snapshot } }),
      setProvider: async () => ({ ok: true, value: snapshot }),
    };
    vi.stubGlobal('modelCatalog', catalog);
    renderHook(() => useEnsureModelRegistry());
    await waitFor(() => expect(useModelRegistryStore.getState().hasLoaded).toBe(true));
    expect(read).toHaveBeenCalledOnce();
  });
});

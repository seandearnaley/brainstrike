import { type ModelCatalogCapability, projectModelCatalog } from '@brainstrike/assistant-contract';
import type { BoundaryTransport } from '@brainstrike/assistant-contract/boundary-result';
import type { IDatabase } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnsureModelRegistry } from '../hooks/use-model-registry';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../stores/model-registry-store';

vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: vi.fn(() => null) }));

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

/** One registry fetch reads providers first; count those reads. */
function registryFetches(query: ReturnType<typeof vi.fn>): number {
  return query.mock.calls.filter(([sql]) => String(sql).includes('FROM providers')).length;
}

describe('useEnsureModelRegistry after a failed registry fetch', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
  });

  it('a consumer that mounts later neither refetches nor clears the error; Retry fetches once', async () => {
    const query = vi.fn().mockRejectedValue(new Error('registry unavailable'));
    const db = { query } as unknown as IDatabase;
    renderHook(() => useEnsureModelRegistry({ db }));
    await waitFor(() => {
      expect(useModelRegistryStore.getState().error).toEqual(expect.any(String));
    });
    const retainedError = useModelRegistryStore.getState().error;
    expect(retainedError).not.toBe('');
    expect(registryFetches(query)).toBe(1);

    const errors: (string | null)[] = [];
    const unsubscribe = useModelRegistryStore.subscribe((state) => errors.push(state.error));
    const later = renderHook(() => useEnsureModelRegistry({ db }));
    await act(async () => {
      await Promise.resolve();
    });
    unsubscribe();
    expect(registryFetches(query)).toBe(1);
    expect(errors).not.toContain(null);
    expect(later.result.current).toBe(retainedError);

    // Retry and the header Refresh call fetchRegistry directly.
    query.mockResolvedValue({ rows: [] });
    await act(async () => {
      await useModelRegistryStore.getState().fetchRegistry(db);
    });
    expect(registryFetches(query)).toBe(2);
    expect(useModelRegistryStore.getState()).toMatchObject({ error: null, hasLoaded: true });
  });
});

describe('desktop model catalog consumer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads with no database and disables the lazy SQL hook even with a provided database', async () => {
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
    const query = vi.fn().mockRejectedValue(new Error('PG must be unavailable'));
    const db = { query } as unknown as IDatabase;
    renderHook(() => useEnsureModelRegistry({ db }));
    await waitFor(() => expect(useModelRegistryStore.getState().hasLoaded).toBe(true));
    expect(read).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(usePGliteDatabase).toHaveBeenLastCalledWith({ enabled: false });
  });
});

import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { useNativeWorkspaceSearchDependencies } from '@brainstrike/workspace-search/core';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = vi.hoisted(() => ({
  managedCollectionId: 'collection-a',
  nativeIndexMode: 'VECTOR',
  nativeLocalSelection: {
    device: 'webgpu',
    dimensions: 384,
    dtype: 'fp16',
    modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
    revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  },
}));
vi.mock('@brainstrike/app-state/stores/background-indexing-preferences-store', () => ({
  useBackgroundIndexingPreferencesStore: Object.assign(
    (selector: (state: typeof preferences) => unknown) => selector(preferences),
    { getState: () => preferences }
  ),
}));

import { NativeSearchProvider } from '../../../renderer/components/native-search-provider';

const profile = {
  dimensions: 384,
  dtype: 'fp16' as const,
  modelId: preferences.nativeLocalSelection.modelId,
  revision: preferences.nativeLocalSelection.revision,
  tokenCap: 256,
};
const queryPlan = {
  inferencePlan: { ...profile, device: 'webgpu' as const, dimensions: 384 as const },
  modelKey: 'native:query-fixture',
};
const ready = {
  authorizedCollectionIds: ['collection-a'],
  authorizedRootIds: ['root-a'],
  embedding: {
    indexMode: 'vector-configured' as const,
    profile,
    profileHash: '60a05b1084b11c2add2e01bb8112960f51e83e68c88ad4151b0dc54eb69e1914',
  },
  kind: 'ready' as const,
  queryPlan,
  rootReadiness: [{ rootId: 'root-a', scanComplete: true }],
  storeId: 'store-a',
};
const queryEmbedding = vi.fn<(...args: unknown[]) => Promise<number[]>>();
const cancelQueryEmbedding = vi.fn<(...args: unknown[]) => Promise<{ cancelled: boolean }>>();

beforeEach(() => {
  queryEmbedding.mockReset();
  cancelQueryEmbedding.mockReset();
  Object.defineProperty(window, 'embeddingHost', {
    configurable: true,
    value: { cancelQueryEmbedding, queryEmbedding },
  });
});
describe('native query provider cancellation wiring', () => {
  function mount() {
    const capability: IndexSearchCapability = {
      coverage: vi.fn(),
      grep: vi.fn(),
      rebuild: vi.fn(),
      search: vi.fn(),
      status: vi.fn(async () => ready),
    };
    function Wrapper({ children }: { children: ReactNode }) {
      return <NativeSearchProvider capability={capability}>{children}</NativeSearchProvider>;
    }
    const mounted = renderHook(useNativeWorkspaceSearchDependencies, { wrapper: Wrapper });
    return { capability, ...mounted };
  }
  it('forwards the exact saved inference plan and signal to the visible cancellation bridge', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current?.profile).toEqual(profile));
    const physical = Promise.withResolvers<number[]>();
    queryEmbedding.mockReturnValue(physical.promise);
    cancelQueryEmbedding.mockResolvedValue({ cancelled: true });
    const controller = new AbortController();
    const reason = new Error('search cancelled');
    const pending = result.current?.embedQuery(profile, 'needle', { signal: controller.signal });
    await waitFor(() => expect(queryEmbedding).toHaveBeenCalledOnce());
    const request = queryEmbedding.mock.calls[0];
    expect(request?.[0]).toEqual({
      dimensions: 384,
      inferencePlan: queryPlan.inferencePlan,
      modelId: profile.modelId,
      modelKey: queryPlan.modelKey,
      query: 'needle',
    });
    const token = request?.[1] as { requestId: string };
    controller.abort(reason);
    await waitFor(() =>
      expect(cancelQueryEmbedding).toHaveBeenCalledExactlyOnceWith(token.requestId)
    );
    const rejected = expect(pending).rejects.toBe(reason);
    physical.reject(new Error('Serialized main cancellation'));
    await rejected;
  });
  it('checks cancellation again after the current status read before admitting inference', async () => {
    const { result, capability } = mount();
    await waitFor(() => expect(result.current?.profile).toEqual(profile));
    const current = Promise.withResolvers<typeof ready>();
    vi.mocked(capability.status).mockReturnValueOnce(current.promise);
    const controller = new AbortController();
    const pending = result.current?.embedQuery(profile, 'needle', { signal: controller.signal });
    controller.abort();
    const rejected = expect(pending).rejects.toBe(controller.signal.reason);
    current.resolve(ready);
    await rejected;
    expect(queryEmbedding).not.toHaveBeenCalled();
  });
});

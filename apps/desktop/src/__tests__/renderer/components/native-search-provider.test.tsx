import type {
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import {
  useNativeWorkspaceSearchDependencies,
  useWorkspaceSearchStore,
} from '@brainstrike/workspace-search/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootIdentityProvider } from '../../../../../../packages/app-shell/src/roots/root-identity-context';
import { useWorkspaceSearchController } from '../../../../../../packages/app-shell/src/use-workspace-search-controller';
import { SearchEmbedderProvider } from '../../../../../../packages/vector-management/src/search-embedder/search-embedder-provider';

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
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useIdeFileEditor: () => ({ openFileInTab: vi.fn(), registerOpenFileInTab: vi.fn() }),
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
afterEach(() => {
  vi.useRealTimers();
  useWorkspaceSearchStore.getState().reset();
});
describe('native query provider cancellation wiring', () => {
  function mount() {
    const capability: IndexSearchCapability = {
      coverage: vi.fn(),
      coverageBatch: vi.fn(async () => {
        throw new Error('Unexpected coverage batch');
      }),
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

describe('native provider and search controller observation refresh', () => {
  function mountController(cloneObservations = true) {
    let observation: IndexerStatus = ready;
    const counts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
    const response = {
      candidateCount: 0,
      candidatesTruncated: false,
      embedding: ready.embedding,
      hits: [],
      scanLimited: false,
      storeId: ready.storeId,
      truncated: false,
    };
    let capability: IndexSearchCapability = {
      coverage: vi.fn(async () => ({
        embedding: ready.embedding,
        roots: [{ rootId: 'root-a', ...counts }],
        storeId: ready.storeId,
        totals: counts,
        vectorCoverageComplete: true,
      })),
      coverageBatch: vi.fn(),
      grep: vi.fn(async () => response),
      rebuild: vi.fn(),
      search: vi.fn(async () => response),
      status: vi.fn(async () => (cloneObservations ? structuredClone(observation) : observation)),
    };
    let identities = new Map([['adapter-a', 'root-a']]);
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <SearchEmbedderProvider>
          <NativeSearchProvider capability={capability}>
            <RootIdentityProvider dbRootIdByAdapterRootId={identities}>
              {children}
            </RootIdentityProvider>
          </NativeSearchProvider>
        </SearchEmbedderProvider>
      );
    }
    const mounted = renderHook(
      () => ({
        controller: useWorkspaceSearchController(),
        dependencies: useNativeWorkspaceSearchDependencies(),
      }),
      { wrapper: Wrapper }
    );
    return {
      ...mounted,
      capability,
      refresh: (next: IndexerStatus) => {
        observation = next;
      },
      replaceCapability: () => {
        capability = { ...capability };
      },
      replaceRootBinding: () => {
        identities = new Map([['adapter-b', 'root-a']]);
      },
    };
  }

  it('keeps held semantic inference alive across a readiness-only observation refresh', async () => {
    vi.useFakeTimers();
    const physical = Promise.withResolvers<number[]>();
    queryEmbedding.mockReturnValue(physical.promise);
    cancelQueryEmbedding.mockResolvedValue({ cancelled: true });
    const mounted = mountController();
    try {
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
      );
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('needle');
        useWorkspaceSearchStore.getState().setMode('semantic');
        mounted.result.current.controller.runSemanticSearch();
      });
      await vi.waitFor(() => expect(queryEmbedding).toHaveBeenCalledOnce());
      const generation = useWorkspaceSearchStore.getState().generation;
      const prior = mounted.result.current.dependencies;
      mounted.refresh({
        ...ready,
        collectionReadiness: [{ embeddingSetId: 'collection-a', scanComplete: true }],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await vi.waitFor(() => expect(mounted.result.current.dependencies).not.toBe(prior));
      expect(cancelQueryEmbedding).not.toHaveBeenCalled();
      expect(useWorkspaceSearchStore.getState().status).toBe('searching');
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
      await act(async () => {
        physical.resolve(Array.from({ length: 384 }, () => 1));
      });
      await vi.waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
      expect(useWorkspaceSearchStore.getState().results?.mode).toBe('semantic');
      expect(mounted.capability.search).toHaveBeenCalledTimes(2);
    } finally {
      physical.resolve(Array.from({ length: 384 }, () => 1));
      mounted.unmount();
    }
  });

  it('publishes readiness availability changes without cancelling the held execution', async () => {
    vi.useFakeTimers();
    const physical = Promise.withResolvers<number[]>();
    queryEmbedding.mockReturnValue(physical.promise);
    cancelQueryEmbedding.mockResolvedValue({ cancelled: true });
    const mounted = mountController();
    try {
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
      );
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('needle');
        useWorkspaceSearchStore.getState().setMode('semantic');
        mounted.result.current.controller.runSemanticSearch();
      });
      await vi.waitFor(() => expect(queryEmbedding).toHaveBeenCalledOnce());
      const generation = useWorkspaceSearchStore.getState().generation;
      mounted.refresh({ ...ready, rootReadiness: [{ rootId: 'root-a', scanComplete: false }] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(false)
      );
      expect(cancelQueryEmbedding).not.toHaveBeenCalled();
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
      mounted.refresh(structuredClone(ready));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
      );
      await act(async () => {
        physical.resolve(Array.from({ length: 384 }, () => 1));
      });
      await vi.waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
      expect(cancelQueryEmbedding).not.toHaveBeenCalled();
    } finally {
      physical.resolve(Array.from({ length: 384 }, () => 1));
      mounted.unmount();
    }
  });

  const identityChanges: readonly { readonly name: string; readonly next: IndexerStatus }[] = [
    {
      name: 'store with the same profile and plan references',
      next: { ...ready, storeId: 'store-b' },
    },
    {
      name: 'root authority with the same profile and plan references',
      next: { ...ready, authorizedRootIds: ['root-b'] },
    },
    {
      name: 'collection authority with the same profile and plan references',
      next: { ...ready, authorizedCollectionIds: ['collection-a', 'collection-b'] },
    },
    {
      name: 'profile hash',
      next: { ...ready, embedding: { ...ready.embedding, profileHash: 'b'.repeat(64) } },
    },
    ...[
      { change: { dimensions: 768 }, name: 'profile dimensions' },
      { change: { dtype: 'q8' as const }, name: 'profile dtype' },
      { change: { modelId: 'different-model' }, name: 'profile model' },
      { change: { revision: 'b'.repeat(40) }, name: 'profile revision' },
      { change: { tokenCap: 512 }, name: 'profile token cap' },
    ].map(({ name, change }) => ({
      name,
      next: { ...ready, embedding: { ...ready.embedding, profile: { ...profile, ...change } } },
    })),
    {
      name: 'query model key',
      next: { ...ready, queryPlan: { ...queryPlan, modelKey: 'different-key' } },
    },
    ...[
      { change: { device: 'wasm' as const }, name: 'query device' },
      { change: { dtype: 'q8' as const }, name: 'query dtype' },
      { change: { modelId: 'different-query-model' }, name: 'query model' },
      { change: { revision: 'b'.repeat(40) }, name: 'query revision' },
    ].map(({ name, change }) => ({
      name,
      next: {
        ...ready,
        queryPlan: { ...queryPlan, inferencePlan: { ...queryPlan.inferencePlan, ...change } },
      },
    })),
    { name: 'query plan removal', next: { ...ready, queryPlan: undefined } },
    { name: 'embedding mode', next: { ...ready, embedding: { indexMode: 'text-only' } } },
    {
      name: 'unavailable authority',
      next: { kind: 'unavailable', reason: 'Native owner retired.' },
    },
  ];

  it.each(identityChanges)(
    'cancels held inference on $name and drops its late result',
    async ({ next }) => {
      vi.useFakeTimers();
      const physical = Promise.withResolvers<number[]>();
      queryEmbedding.mockReturnValue(physical.promise);
      cancelQueryEmbedding.mockResolvedValue({ cancelled: true });
      // Deliberately reuse nested references: object churn must not be the authority guard.
      const mounted = mountController(false);
      try {
        await vi.waitFor(() =>
          expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
        );
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('needle');
          useWorkspaceSearchStore.getState().setMode('semantic');
          mounted.result.current.controller.runSemanticSearch();
        });
        await vi.waitFor(() => expect(queryEmbedding).toHaveBeenCalledOnce());
        const generation = useWorkspaceSearchStore.getState().generation;
        const token = queryEmbedding.mock.calls[0]?.[1] as { requestId: string };
        mounted.refresh(next);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        await vi.waitFor(() =>
          expect(cancelQueryEmbedding).toHaveBeenCalledExactlyOnceWith(token.requestId)
        );
        expect(useWorkspaceSearchStore.getState().generation).toBeGreaterThan(generation);
        expect(useWorkspaceSearchStore.getState().status).toBe('error');
        await act(async () => {
          physical.resolve(Array.from({ length: 384 }, () => 1));
        });
        expect(mounted.capability.search).not.toHaveBeenCalled();
        expect(useWorkspaceSearchStore.getState().results).toBeNull();
        expect(useWorkspaceSearchStore.getState().error).toBe(
          'Native workspace search scope or capability changed.'
        );
      } finally {
        physical.resolve(Array.from({ length: 384 }, () => 1));
        mounted.unmount();
      }
    }
  );

  it.each(['capability', 'root binding'] as const)(
    'cancels held inference on an actual %s replacement',
    async (change) => {
      vi.useFakeTimers();
      const physical = Promise.withResolvers<number[]>();
      queryEmbedding.mockReturnValue(physical.promise);
      cancelQueryEmbedding.mockResolvedValue({ cancelled: true });
      const mounted = mountController(false);
      try {
        await vi.waitFor(() =>
          expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
        );
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('needle');
          useWorkspaceSearchStore.getState().setMode('semantic');
          mounted.result.current.controller.runSemanticSearch();
        });
        await vi.waitFor(() => expect(queryEmbedding).toHaveBeenCalledOnce());
        const generation = useWorkspaceSearchStore.getState().generation;
        if (change === 'capability') {
          mounted.replaceCapability();
        } else {
          mounted.replaceRootBinding();
        }
        mounted.rerender();
        await vi.waitFor(() => expect(cancelQueryEmbedding).toHaveBeenCalledOnce());
        expect(useWorkspaceSearchStore.getState().generation).toBeGreaterThan(generation);
        await act(async () => {
          physical.resolve(Array.from({ length: 384 }, () => 1));
        });
        expect(mounted.capability.search).not.toHaveBeenCalled();
        expect(useWorkspaceSearchStore.getState().results).toBeNull();
        expect(useWorkspaceSearchStore.getState().error).toBe(
          'Native workspace search scope or capability changed.'
        );
      } finally {
        physical.resolve(Array.from({ length: 384 }, () => 1));
        mounted.unmount();
      }
    }
  );
});

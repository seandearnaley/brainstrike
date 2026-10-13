import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
  IndexerCoverage,
  IndexerStatus,
  IndexLifecycleCapability,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import {
  useNativeWorkspaceSearchDependencies,
  useWorkspaceSearchStore,
} from '@brainstrike/workspace-search/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { mountNativeSearchController } from './native-search-controller-fixture';

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
const queryEmbedding = vi.fn<(...args: unknown[]) => Promise<BoundaryResult<number[]>>>();
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
    const capability: IndexSearchCapability & IndexLifecycleCapability = {
      coverage: vi.fn(),
      coverageBatch: vi.fn(async () => {
        throw new Error('Unexpected coverage batch');
      }),
      grep: vi.fn(),
      onLifecycleChanged: vi.fn(() => () => {}),
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
    queryEmbedding.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
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
  function mountController(
    cloneObservations = true,
    coverageOverride?: IndexSearchCapability['coverage']
  ) {
    return mountNativeSearchController(ready, cloneObservations, coverageOverride);
  }

  function holdAvailability() {
    const pending: ReturnType<typeof Promise.withResolvers<IndexerCoverage>>[] = [];
    const mounted = mountController(true, () => {
      const read = Promise.withResolvers<IndexerCoverage>();
      pending.push(read);
      return read.promise;
    });
    return { ...mounted, pending };
  }

  it('reruns a transitioning text search once the owner publishes Ready, without a retry timer', async () => {
    const mounted = mountController();
    try {
      await waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      useWorkspaceSearchStore.getState().setQuery('pending needle');
      vi.mocked(mounted.capability.grep).mockRejectedValueOnce(
        Object.assign(new Error('Native index is transitioning.'), {
          code: 'native-index-transitioning',
        })
      );
      act(() => mounted.result.current.controller.runTextSearch());
      await waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledOnce());
      expect(useWorkspaceSearchStore.getState().status).toBe('searching');
      await act(async () => mounted.emitLifecycle({ generation: 2, kind: 'ready' }));
      await waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
      await act(async () => mounted.emitLifecycle({ generation: 2, kind: 'ready' }));
      expect(mounted.capability.grep).toHaveBeenCalledTimes(2);
    } finally {
      mounted.unmount();
    }
  });

  it('retains the pending query across preparing status and executes against the replacement Ready scope', async () => {
    const mounted = mountController();
    try {
      await waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      useWorkspaceSearchStore.getState().setQuery('retained needle');
      vi.mocked(mounted.capability.grep).mockRejectedValueOnce(
        Object.assign(new Error('Native index is transitioning.'), {
          code: 'native-index-transitioning',
        })
      );
      act(() => mounted.result.current.controller.runTextSearch());
      await act(async () => {
        await Promise.resolve();
      });
      mounted.refresh({
        cause: { kind: 'transitioning' },
        kind: 'unavailable',
        reason: 'Preparing index.',
      });
      await act(async () =>
        mounted.emitLifecycle({
          cause: { kind: 'transitioning' },
          generation: 2,
          kind: 'preparing',
        })
      );
      expect(useWorkspaceSearchStore.getState().status).toBe('searching');
      mounted.refresh({ ...ready, storeId: 'replacement-store' });
      vi.mocked(mounted.capability.grep).mockResolvedValue({
        ...mounted.response,
        storeId: 'replacement-store',
      });
      vi.mocked(mounted.capability.search).mockResolvedValue({
        ...mounted.response,
        storeId: 'replacement-store',
      });
      await act(async () => mounted.emitLifecycle({ generation: 3, kind: 'ready' }));
      await waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
      expect(useWorkspaceSearchStore.getState().status).toBe('results');
    } finally {
      mounted.unmount();
    }
  });

  it('does not revive a cancelled query when Ready arrives', async () => {
    const mounted = mountController();
    try {
      await waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      useWorkspaceSearchStore.getState().setQuery('cancelled needle');
      vi.mocked(mounted.capability.grep).mockRejectedValueOnce(
        Object.assign(new Error('Native index is transitioning.'), {
          code: 'native-index-transitioning',
        })
      );
      act(() => mounted.result.current.controller.runTextSearch());
      await act(async () => {
        await Promise.resolve();
      });
      act(() => useWorkspaceSearchStore.getState().clearResults());
      await act(async () => mounted.emitLifecycle({ generation: 3, kind: 'ready' }));
      expect(mounted.capability.grep).toHaveBeenCalledOnce();
      expect(useWorkspaceSearchStore.getState().status).toBe('idle');
    } finally {
      mounted.unmount();
    }
  });

  it('reruns when Ready arrives before the in-flight transition refusal', async () => {
    const mounted = mountController();
    try {
      await waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      const held = Promise.withResolvers<Awaited<ReturnType<IndexSearchCapability['grep']>>>();
      vi.mocked(mounted.capability.grep).mockReturnValueOnce(held.promise);
      useWorkspaceSearchStore.getState().setQuery('early ready');
      act(() => mounted.result.current.controller.runTextSearch());
      await act(async () => mounted.emitLifecycle({ generation: 2, kind: 'ready' }));
      await act(async () =>
        held.reject(
          Object.assign(new Error('Native index is transitioning.'), {
            code: 'native-index-transitioning',
          })
        )
      );
      await waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
      expect(useWorkspaceSearchStore.getState().status).toBe('results');
    } finally {
      mounted.unmount();
    }
  });

  it('shows the exact terminal failure instead of leaving a retained query preparing', async () => {
    const mounted = mountController();
    try {
      await waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      useWorkspaceSearchStore.getState().setQuery('failed needle');
      vi.mocked(mounted.capability.grep).mockRejectedValueOnce(
        Object.assign(new Error('Native index is transitioning.'), {
          code: 'native-index-transitioning',
        })
      );
      act(() => mounted.result.current.controller.runTextSearch());
      await act(async () => {
        await Promise.resolve();
      });
      const cause = { kind: 'source-failure' as const, message: 'Worker device lost.' };
      mounted.refresh({ cause, kind: 'unavailable', reason: cause.message });
      await act(async () => mounted.emitLifecycle({ cause, generation: 2, kind: 'refused' }));
      expect(useWorkspaceSearchStore.getState().status).toBe('error');
      expect(useWorkspaceSearchStore.getState().error).toBe(cause.message);
      expect(mounted.capability.grep).toHaveBeenCalledOnce();
    } finally {
      mounted.unmount();
    }
  });

  it('retains a query whose initial status already carries Transitioning', async () => {
    const mounted = mountController();
    try {
      await waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      mounted.refresh({
        cause: { kind: 'transitioning' },
        kind: 'unavailable',
        reason: 'Preparing index.',
      });
      useWorkspaceSearchStore.getState().setQuery('starting while preparing');
      act(() => mounted.result.current.controller.runTextSearch());
      await act(async () => {
        await Promise.resolve();
      });
      expect(useWorkspaceSearchStore.getState().status).toBe('searching');
      expect(mounted.capability.grep).not.toHaveBeenCalled();
      mounted.refresh(ready);
      await act(async () => mounted.emitLifecycle({ generation: 2, kind: 'ready' }));
      await waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledOnce());
      expect(useWorkspaceSearchStore.getState().status).toBe('results');
    } finally {
      mounted.unmount();
    }
  });

  it('names the setting that turns semantic search on when Text search is saved (BST-1981)', async () => {
    preferences.nativeIndexMode = 'TEXT';
    const mounted = mountController();
    try {
      // The saved Text choice reaches the index on its next status poll.
      mounted.refresh({ ...ready, embedding: { indexMode: 'text-only' }, queryPlan: undefined });
      await waitFor(
        () => expect(vi.mocked(mounted.capability.status).mock.calls.length).toBeGreaterThan(1),
        { timeout: 5000 }
      );
      await waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability).toEqual({
          available: false,
          reason:
            'Semantic search is off. Choose “Text and semantic search” in Search & Indexing settings.',
        })
      );
    } finally {
      mounted.unmount();
      preferences.nativeIndexMode = 'VECTOR';
    }
  });

  it('refreshes an invalidated scan observation through the batch API without singleton IPC failure', async () => {
    vi.useFakeTimers();
    const mounted = mountController();
    try {
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
      );
      vi.mocked(mounted.capability.coverage).mockRejectedValue(
        new Error('Strict singleton must not be called.')
      );
      vi.mocked(mounted.capability.coverageBatch).mockResolvedValueOnce({
        code: 'native-coverage-observation-invalidated',
        kind: 'invalidated',
      });
      mounted.refresh({ ...ready, rootReadiness: [{ rootId: 'root-a', scanComplete: false }] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mounted.result.current.controller.semanticAvailability).toEqual({
        available: false,
        reason: 'Native vector availability is being verified.',
      });
      expect(mounted.capability.coverage).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability).toMatchObject({
          available: true,
          hint: expect.stringContaining('Source scan incomplete'),
        })
      );
      expect(mounted.capability.coverage).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
    }
  });

  it('publishes slow availability across multiple progress polls and then refreshes current readiness', async () => {
    vi.useFakeTimers();
    const { pending, observedCoverage: coverage, ...mounted } = holdAvailability();
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      for (const acknowledgedFiles of [10, 20]) {
        mounted.refresh({
          ...ready,
          publicationProgress: [
            {
              acknowledgedFiles,
              authorityEpoch: 'epoch',
              authorityRevision: acknowledgedFiles,
              mutationRevision: acknowledgedFiles,
              ownerGeneration: 1,
              profileHash: ready.embedding.profileHash,
              requestId: 'scan',
              scanGeneration: 1,
              scope: { kind: 'workspace', rootId: 'root-a' },
              storeId: ready.storeId,
            },
          ],
          rootReadiness: [{ rootId: 'root-a', scanComplete: false }],
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
      }
      await act(async () => {
        pending[0]?.resolve(coverage);
      });
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
      );
      // One fresh follow-up consumes both queued progress observations without dropping the completed check.
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      await act(async () => {
        pending[1]?.resolve(coverage);
      });
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability?.hint).toContain(
          'Source scan incomplete'
        )
      );
    } finally {
      mounted.unmount();
      for (const read of pending) {
        read.resolve(coverage);
      }
    }
  });

  it('keeps held semantic inference alive across readiness and acknowledged-progress refreshes', async () => {
    vi.useFakeTimers();
    const physical = Promise.withResolvers<number[]>();
    queryEmbedding.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
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
        publicationProgress: [
          {
            acknowledgedFiles: 10,
            authorityEpoch: 'epoch',
            authorityRevision: 20,
            mutationRevision: 30,
            ownerGeneration: 1,
            profileHash: ready.embedding.profileHash,
            requestId: 'scan',
            scanGeneration: 1,
            scope: { kind: 'workspace', rootId: 'root-a' },
            storeId: ready.storeId,
          },
        ],
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

  it('refreshes partial coverage readiness hints without cancelling the held execution', async () => {
    vi.useFakeTimers();
    const physical = Promise.withResolvers<number[]>();
    queryEmbedding.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
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
        expect(mounted.result.current.controller.semanticAvailability?.hint).toContain(
          'Source scan incomplete'
        )
      );
      expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true);
      expect(cancelQueryEmbedding).not.toHaveBeenCalled();
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
      mounted.refresh(structuredClone(ready));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability?.hint).toBeUndefined()
      );
      expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true);
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

  it.each(identityChanges)('drops held availability when $name changes', async ({ next }) => {
    vi.useFakeTimers();
    const mounted = holdAvailability();
    try {
      await vi.waitFor(() => expect(mounted.pending).toHaveLength(1));
      mounted.refresh(next);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        mounted.pending[0]?.resolve(mounted.observedCoverage);
      });
      expect(mounted.result.current.controller.semanticAvailability?.available).toBe(false);
    } finally {
      mounted.unmount();
      for (const read of mounted.pending) {
        read.resolve(mounted.observedCoverage);
      }
    }
  });

  it.each(['capability', 'root binding', 'collection'] as const)(
    'drops held availability on an actual %s replacement',
    async (change) => {
      vi.useFakeTimers();
      const mounted = holdAvailability();
      try {
        await vi.waitFor(() => expect(mounted.pending).toHaveLength(1));
        act(() => {
          if (change === 'capability') {
            mounted.replaceCapability();
            mounted.rerender();
          }
          if (change === 'root binding') {
            mounted.replaceRootBinding();
            mounted.rerender();
          }
          if (change === 'collection') {
            useWorkspaceSearchStore.getState().setCollectionId('collection-b');
          }
        });
        await act(async () => {
          mounted.pending[0]?.resolve(mounted.observedCoverage);
        });
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(false);
      } finally {
        mounted.unmount();
        for (const read of mounted.pending) {
          read.resolve(mounted.observedCoverage);
        }
      }
    }
  );

  it('keeps a fresh replacement-scope failure visible when old coverage completes late', async () => {
    vi.useFakeTimers();
    const mounted = holdAvailability();
    try {
      await vi.waitFor(() => expect(mounted.pending).toHaveLength(1));
      act(() => {
        mounted.replaceCapability();
        mounted.rerender();
      });
      await vi.waitFor(() => expect(mounted.pending).toHaveLength(2));
      await act(async () => {
        mounted.pending[1]?.reject(new Error('Replacement native scope failed.'));
      });
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability).toMatchObject({
          available: false,
          reason: 'Replacement native scope failed.',
        })
      );
      await act(async () => {
        mounted.pending[0]?.resolve(mounted.observedCoverage);
      });
      expect(mounted.result.current.controller.semanticAvailability).toMatchObject({
        available: false,
        reason: 'Replacement native scope failed.',
      });
    } finally {
      mounted.unmount();
      for (const read of mounted.pending) {
        read.resolve(mounted.observedCoverage);
      }
    }
  });

  it('publishes a held coverage failure instead of enabling semantics optimistically', async () => {
    vi.useFakeTimers();
    const mounted = holdAvailability();
    try {
      await vi.waitFor(() => expect(mounted.pending).toHaveLength(1));
      mounted.refresh({ ...ready, rootReadiness: [{ rootId: 'root-a', scanComplete: false }] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        mounted.pending[0]?.reject(new Error('Native coverage target unavailable.'));
      });
      await vi.waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability).toMatchObject({
          available: false,
          reason: 'Native coverage target unavailable.',
        })
      );
    } finally {
      mounted.unmount();
      for (const read of mounted.pending) {
        read.resolve(mounted.observedCoverage);
      }
    }
  });

  it.each(identityChanges)(
    'cancels held inference on $name and drops its late result',
    async ({ next }) => {
      vi.useFakeTimers();
      const physical = Promise.withResolvers<number[]>();
      queryEmbedding.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
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
      queryEmbedding.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
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

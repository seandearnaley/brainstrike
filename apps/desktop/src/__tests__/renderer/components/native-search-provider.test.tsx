// @vitest-environment jsdom
import { useIndexConfigStore } from '@brainstrike/app-state/stores/index-config-store';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import type {
  IndexerCoverage,
  IndexerStatus,
  IndexLifecycleCapability,
  IndexSearchCapability,
  NativeIndexObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import { act, waitForOnFakeTimers } from '@brainstrike/test-utils/react-act';
import {
  useNativeWorkspaceSearchDependencies,
  useWorkspaceSearchStore,
} from '@brainstrike/workspace-search/core';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeSearchProvider } from '../../../renderer/components/native-search-provider';
import { mountNativeSearchController } from './native-search-controller-fixture';

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useIdeFileEditor: () => ({ openFileInTab: vi.fn(), registerOpenFileInTab: vi.fn() }),
}));
// The Search tab lives under the Explorer, whose store names each open folder.
vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>()),
  useFileExplorerStoreSelector: <T,>(selector: (state: { rootDescriptors: object }) => T): T =>
    selector({ rootDescriptors: {} }),
}));

const MODEL_ID = 'text-embedding-3-small';
const MODEL_KEY = `openai::${MODEL_ID}`;
const DIMENSIONS = 1536;
/** Main's saved semantic search: the hosted model the query plan must name. */
const SAVED_SEMANTIC: IndexConfig = {
  ...DEFAULT_INDEX_CONFIG,
  mode: 'semantic',
  model: { dimensions: DIMENSIONS, modelKey: MODEL_KEY },
};
function savedConfig(config: IndexConfig): void {
  useIndexConfigStore.setState({ state: { config, kind: 'ready' }, update: vi.fn() });
}

/** The index's profile as Main reports a hosted model: the saved key's provider and the collection's distance. */
const profile = {
  dimensions: DIMENSIONS,
  distance: 'cosine' as const,
  modelId: MODEL_ID,
  provider: 'openai' as const,
};
/** Main's query plan names the collection's model key verbatim. */
const queryPlan = { modelKey: MODEL_KEY };
const ready = {
  authorizedRootIds: ['root-a'],
  embedding: {
    indexMode: 'vector-configured' as const,
    profile,
    profileHash: '288c9286093cddf9776cab7ba498f9b313a405ebc28471ffd1e9eba9811b7758',
  },
  kind: 'ready' as const,
  queryPlan,
  rootReadiness: [{ rootId: 'root-a', scanComplete: true }],
  storeId: 'store-a',
};
const { queryPlan: _readyPlan, ...readyWithoutPlan } = ready;
const embedQuery = vi.fn<(...args: unknown[]) => Promise<BoundaryResult<number[]>>>();

beforeEach(() => {
  savedConfig(SAVED_SEMANTIC);
  embedQuery.mockReset();
  Object.defineProperty(window, 'indexSearch', { configurable: true, value: { embedQuery } });
});
afterEach(() => {
  vi.useRealTimers();
  useWorkspaceSearchStore.getState().reset();
});
function mount(
  status: IndexerStatus = ready,
  onLifecycleChanged: IndexLifecycleCapability['onLifecycleChanged'] = () => () => {}
) {
  const capability: IndexSearchCapability & IndexLifecycleCapability = {
    coverage: vi.fn(),
    coverageBatch: vi.fn(async () => {
      throw new Error('Unexpected coverage batch');
    }),
    grep: vi.fn(),
    onLifecycleChanged: vi.fn(onLifecycleChanged),
    rebuild: vi.fn(),
    search: vi.fn(),
    status: vi.fn(async () => status),
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return <NativeSearchProvider capability={capability}>{children}</NativeSearchProvider>;
  }
  const mounted = renderHook(useNativeWorkspaceSearchDependencies, { wrapper: Wrapper });
  return { capability, ...mounted };
}

describe('native search follows Main’s saved choices', () => {
  const hosted = (modelKey: string, dimensions: number): IndexConfig => ({
    ...DEFAULT_INDEX_CONFIG,
    mode: 'semantic',
    model: { dimensions, modelKey },
  });

  it('serves a hosted model only while the index holds that model’s vectors', async () => {
    savedConfig(hosted('openai::text-embedding-3-large', 3072));
    const other = mount(ready);
    await waitFor(() =>
      expect(other.result.current?.profileUnavailableReason).toBe(
        'Native search is activating the saved search mode and model.'
      )
    );
    expect(other.result.current?.profile).toBeNull();
    other.unmount();

    savedConfig(hosted(MODEL_KEY, DIMENSIONS));
    const { result } = mount(ready);
    await waitFor(() => expect(result.current?.profile).toEqual(profile));
    const embedSearchQuery = result.current?.embedQuery;
    // Main saves another model: a query made before the index follows it is refused.
    await act(async () => savedConfig(hosted('openai::text-embedding-3-large', 3072)));
    await expect(
      embedSearchQuery?.(profile, 'needle', { signal: new AbortController().signal })
    ).rejects.toThrow(
      'Native query inference no longer matches the explicit saved execution plan.'
    );
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('serves a model only from the provider whose vectors the index holds', async () => {
    savedConfig(hosted(MODEL_KEY, DIMENSIONS));
    const { result } = mount({
      ...ready,
      embedding: {
        indexMode: 'vector-configured',
        profile: { ...profile, provider: 'google' },
        profileHash: 'd'.repeat(64),
      },
      queryPlan: { modelKey: `google::${MODEL_ID}` },
    });
    await waitFor(() =>
      expect(result.current?.profileUnavailableReason).toBe(
        'Native search is activating the saved search mode and model.'
      )
    );
    expect(result.current?.profile).toBeNull();
  });

  it('says search is off when Main’s config turns it off', async () => {
    savedConfig({ ...DEFAULT_INDEX_CONFIG, mode: 'off' });
    const { result } = mount();
    await waitFor(() =>
      expect(result.current?.profileUnavailableReason).toBe(
        'Search is off. Turn it on in Settings, Search & Indexing.'
      )
    );
  });
});

describe('native search follows Main’s index observations', () => {
  it('shows the status Main pushes, and nothing new until it pushes again', async () => {
    vi.useFakeTimers();
    let push: (observation: NativeIndexObservation) => void = () => {};
    const { capability, result } = mount(ready, (listener) => {
      push = listener;
      return () => {};
    });
    await waitForOnFakeTimers(() => expect(result.current?.profile).toEqual(profile));
    // The index starts preparing, but Main has not said so: search keeps what it was told.
    const preparing: IndexerStatus = {
      cause: { kind: 'transitioning' },
      kind: 'unavailable',
      phase: 'preparing',
      reason: 'Native index is transitioning.',
    };
    vi.mocked(capability.status).mockResolvedValue(preparing);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current?.profile).toEqual(profile);
    act(() =>
      push({
        lifecycle: { cause: { kind: 'transitioning' }, generation: 2, kind: 'preparing' },
        progress: { kind: 'read', status: preparing },
      })
    );
    expect(result.current?.profile).toBeNull();
    expect(result.current?.profileUnavailableReason).toBe('Native index is transitioning.');
  });
});

describe('native query provider embedding wiring', () => {
  it("asks Main to embed the query with the index's saved model and drops an aborted answer", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current?.profile).toEqual(profile));
    const physical = Promise.withResolvers<number[]>();
    embedQuery.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
    const controller = new AbortController();
    const reason = new Error('search cancelled');
    const pending = result.current?.embedQuery(profile, 'needle', { signal: controller.signal });
    await waitFor(() => expect(embedQuery).toHaveBeenCalledOnce());
    expect(embedQuery.mock.calls[0]).toEqual([
      {
        dimensions: DIMENSIONS,
        modelId: profile.modelId,
        modelKey: queryPlan.modelKey,
        query: 'needle',
      },
    ]);
    controller.abort(reason);
    const rejected = expect(pending).rejects.toBe(reason);
    physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
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
    expect(embedQuery).not.toHaveBeenCalled();
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

  it('reruns a pending search on Ready while Main saves a change search does not read', async () => {
    vi.useFakeTimers();
    const mounted = mountController();
    try {
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.dependencies?.profile).toEqual(profile)
      );
      useWorkspaceSearchStore.getState().setQuery('pending needle');
      vi.mocked(mounted.capability.grep).mockRejectedValueOnce(
        Object.assign(new Error('Native index is transitioning.'), {
          code: 'native-index-transitioning',
        })
      );
      act(() => mounted.result.current.controller.runTextSearch());
      await waitForOnFakeTimers(() => expect(mounted.capability.grep).toHaveBeenCalledOnce());
      const read = Promise.withResolvers<IndexerStatus>();
      vi.mocked(mounted.capability.status).mockReturnValueOnce(read.promise);
      await act(async () => mounted.emitLifecycle({ generation: 2, kind: 'ready' }));
      // Each change Main publishes arrives as a fresh copy of the whole config.
      act(() => savedConfig(structuredClone({ ...SAVED_SEMANTIC, worktrees: { 'root-b': true } })));
      await act(async () => read.resolve(structuredClone(ready)));
      await waitForOnFakeTimers(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
      await waitForOnFakeTimers(() =>
        expect(useWorkspaceSearchStore.getState().status).toBe('results')
      );
    } finally {
      mounted.unmount();
    }
  });

  it('names the setting that turns semantic search on when Text search is saved (BST-1981)', async () => {
    savedConfig(DEFAULT_INDEX_CONFIG);
    const mounted = mountController();
    try {
      // Main pushes once the index follows the saved Text choice.
      mounted.refresh({ ...readyWithoutPlan, embedding: { indexMode: 'text-only' } });
      await act(async () => mounted.publish());
      await waitFor(() =>
        expect(mounted.result.current.controller.semanticAvailability).toEqual({
          available: false,
          reason: 'Semantic search is off. Choose Semantic in Settings, Search & Indexing.',
        })
      );
    } finally {
      mounted.unmount();
    }
  });

  it('refreshes an invalidated scan observation through the batch API without singleton IPC failure', async () => {
    vi.useFakeTimers();
    const mounted = mountController();
    try {
      await waitForOnFakeTimers(() =>
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
      await act(async () => mounted.publish());
      expect(mounted.result.current.controller.semanticAvailability).toEqual({
        available: false,
        reason: 'Native vector availability is being verified.',
      });
      expect(mounted.capability.coverage).not.toHaveBeenCalled();
      await act(async () => mounted.publish());
      await waitForOnFakeTimers(() =>
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

  it('publishes slow availability across several observations and then refreshes current readiness', async () => {
    vi.useFakeTimers();
    const { pending, observedCoverage: coverage, ...mounted } = holdAvailability();
    try {
      await waitForOnFakeTimers(() => expect(pending).toHaveLength(1));
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
        await act(async () => mounted.publish());
      }
      await act(async () => {
        pending[0]?.resolve(coverage);
      });
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
      );
      // One fresh follow-up consumes both queued progress observations without dropping the completed check.
      await waitForOnFakeTimers(() => expect(pending).toHaveLength(2));
      await act(async () => {
        pending[1]?.resolve(coverage);
      });
      await waitForOnFakeTimers(() =>
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
    embedQuery.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
    const mounted = mountController();
    try {
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
      );
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('needle');
        useWorkspaceSearchStore.getState().setMode('semantic');
        mounted.result.current.controller.runSemanticSearch();
      });
      await waitForOnFakeTimers(() => expect(embedQuery).toHaveBeenCalledOnce());
      const generation = useWorkspaceSearchStore.getState().generation;
      const prior = mounted.result.current.dependencies;
      mounted.refresh({
        ...ready,
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
      await act(async () => mounted.publish());
      await waitForOnFakeTimers(() => expect(mounted.result.current.dependencies).not.toBe(prior));
      expect(useWorkspaceSearchStore.getState().status).toBe('searching');
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
      await act(async () => {
        physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
      });
      await waitForOnFakeTimers(() =>
        expect(useWorkspaceSearchStore.getState().status).toBe('results')
      );
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
      expect(useWorkspaceSearchStore.getState().results?.mode).toBe('semantic');
      expect(mounted.capability.search).toHaveBeenCalledTimes(2);
    } finally {
      physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
      mounted.unmount();
    }
  });

  it('refreshes partial coverage readiness hints without cancelling the held execution', async () => {
    vi.useFakeTimers();
    const physical = Promise.withResolvers<number[]>();
    embedQuery.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
    const mounted = mountController();
    try {
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
      );
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('needle');
        useWorkspaceSearchStore.getState().setMode('semantic');
        mounted.result.current.controller.runSemanticSearch();
      });
      await waitForOnFakeTimers(() => expect(embedQuery).toHaveBeenCalledOnce());
      const generation = useWorkspaceSearchStore.getState().generation;
      mounted.refresh({ ...ready, rootReadiness: [{ rootId: 'root-a', scanComplete: false }] });
      await act(async () => mounted.publish());
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.controller.semanticAvailability?.hint).toContain(
          'Source scan incomplete'
        )
      );
      expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true);
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
      mounted.refresh(structuredClone(ready));
      await act(async () => mounted.publish());
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.controller.semanticAvailability?.hint).toBeUndefined()
      );
      expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true);
      await act(async () => {
        physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
      });
      await waitForOnFakeTimers(() =>
        expect(useWorkspaceSearchStore.getState().status).toBe('results')
      );
      expect(useWorkspaceSearchStore.getState().generation).toBe(generation);
    } finally {
      physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
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
      { change: { modelId: 'different-model' }, name: 'profile model' },
      { change: { provider: 'google' as const }, name: 'profile provider' },
    ].map(({ name, change }) => ({
      name,
      next: { ...ready, embedding: { ...ready.embedding, profile: { ...profile, ...change } } },
    })),
    {
      name: 'query model key',
      next: { ...ready, queryPlan: { ...queryPlan, modelKey: 'different-key' } },
    },
    { name: 'query plan removal', next: readyWithoutPlan },
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
      await waitForOnFakeTimers(() => expect(mounted.pending).toHaveLength(1));
      mounted.refresh(next);
      await act(async () => mounted.publish());
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

  it.each(['capability', 'root binding'] as const)(
    'drops held availability on an actual %s replacement',
    async (change) => {
      vi.useFakeTimers();
      const mounted = holdAvailability();
      try {
        await waitForOnFakeTimers(() => expect(mounted.pending).toHaveLength(1));
        act(() => {
          if (change === 'capability') {
            mounted.replaceCapability();
            mounted.rerender();
          }
          if (change === 'root binding') {
            mounted.replaceRootBinding();
            mounted.rerender();
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
      await waitForOnFakeTimers(() => expect(mounted.pending).toHaveLength(1));
      act(() => {
        mounted.replaceCapability();
        mounted.rerender();
      });
      await waitForOnFakeTimers(() => expect(mounted.pending).toHaveLength(2));
      await act(async () => {
        mounted.pending[1]?.reject(new Error('Replacement native scope failed.'));
      });
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.controller.semanticAvailability).toMatchObject({
          available: false,
          reason: INTERNAL_FAULT.message,
        })
      );
      await act(async () => {
        mounted.pending[0]?.resolve(mounted.observedCoverage);
      });
      expect(mounted.result.current.controller.semanticAvailability).toMatchObject({
        available: false,
        reason: INTERNAL_FAULT.message,
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
      await waitForOnFakeTimers(() => expect(mounted.pending).toHaveLength(1));
      mounted.refresh({ ...ready, rootReadiness: [{ rootId: 'root-a', scanComplete: false }] });
      await act(async () => mounted.publish());
      await act(async () => {
        mounted.pending[0]?.reject(new Error('Native coverage target unavailable.'));
      });
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.controller.semanticAvailability).toMatchObject({
          available: false,
          reason: INTERNAL_FAULT.message,
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
    'drops held inference on $name and its late result',
    async ({ next }) => {
      vi.useFakeTimers();
      const physical = Promise.withResolvers<number[]>();
      embedQuery.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
      // Deliberately reuse nested references: object churn must not be the authority guard.
      const mounted = mountController(false);
      try {
        await waitForOnFakeTimers(() =>
          expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
        );
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('needle');
          useWorkspaceSearchStore.getState().setMode('semantic');
          mounted.result.current.controller.runSemanticSearch();
        });
        await waitForOnFakeTimers(() => expect(embedQuery).toHaveBeenCalledOnce());
        const generation = useWorkspaceSearchStore.getState().generation;
        mounted.refresh(next);
        await act(async () => mounted.publish());
        await waitForOnFakeTimers(() =>
          expect(useWorkspaceSearchStore.getState().generation).toBeGreaterThan(generation)
        );
        expect(useWorkspaceSearchStore.getState().status).toBe('error');
        await act(async () => {
          physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
        });
        expect(mounted.capability.search).not.toHaveBeenCalled();
        expect(useWorkspaceSearchStore.getState().results).toBeNull();
        expect(useWorkspaceSearchStore.getState().error).toBe(
          'Native workspace search scope or capability changed.'
        );
      } finally {
        physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
        mounted.unmount();
      }
    }
  );

  it.each(['capability', 'root binding'] as const)(
    'drops held inference on an actual %s replacement',
    async (change) => {
      vi.useFakeTimers();
      const physical = Promise.withResolvers<number[]>();
      embedQuery.mockReturnValue(physical.promise.then((value) => ({ ok: true, value })));
      const mounted = mountController(false);
      try {
        await waitForOnFakeTimers(() =>
          expect(mounted.result.current.controller.semanticAvailability?.available).toBe(true)
        );
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('needle');
          useWorkspaceSearchStore.getState().setMode('semantic');
          mounted.result.current.controller.runSemanticSearch();
        });
        await waitForOnFakeTimers(() => expect(embedQuery).toHaveBeenCalledOnce());
        const generation = useWorkspaceSearchStore.getState().generation;
        if (change === 'capability') {
          mounted.replaceCapability();
        } else {
          mounted.replaceRootBinding();
        }
        mounted.rerender();
        await waitForOnFakeTimers(() =>
          expect(useWorkspaceSearchStore.getState().generation).toBeGreaterThan(generation)
        );
        await act(async () => {
          physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
        });
        expect(mounted.capability.search).not.toHaveBeenCalled();
        expect(useWorkspaceSearchStore.getState().results).toBeNull();
        expect(useWorkspaceSearchStore.getState().error).toBe(
          'Native workspace search scope or capability changed.'
        );
      } finally {
        physical.resolve(Array.from({ length: DIMENSIONS }, () => 1));
        mounted.unmount();
      }
    }
  );
});

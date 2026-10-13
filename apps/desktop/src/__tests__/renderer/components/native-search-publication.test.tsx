import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/core';
import { act } from '@testing-library/react';
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
describe('native source publication handoff', () => {
  function mountController() {
    return mountNativeSearchController(ready);
  }
  it.each(['before-response', 'after-response'] as const)(
    'refreshes a single text query when publication finishes %s',
    async (ordering) => {
      vi.useFakeTimers();
      const mounted = mountController();
      try {
        await vi.waitFor(() =>
          expect(mounted.result.current.dependencies?.profile).toEqual(profile)
        );
        // Rebuild smoke: reader admission is Ready before all root publication receipts complete.
        mounted.refresh({ ...ready, rootReadiness: [{ rootId: 'root-a', scanComplete: false }] });
        mounted.response.scanLimited = true;
        mounted.response.sourceComplete = false;
        const held = Promise.withResolvers<typeof mounted.response>();
        if (ordering === 'before-response') {
          vi.mocked(mounted.capability.grep).mockReturnValueOnce(held.promise);
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('notarize');
          mounted.result.current.controller.runTextSearch();
        });
        if (ordering === 'before-response') {
          await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledOnce());
          mounted.refresh(structuredClone(ready));
          await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
          });
          const partial = { ...mounted.response };
          mounted.response.scanLimited = false;
          mounted.response.sourceComplete = true;
          await act(async () => {
            held.resolve(partial);
          });
        }
        await vi.waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
        expect(useWorkspaceSearchStore.getState().results?.notices.scanLimited).toBe(
          ordering === 'after-response'
        );
        expect(mounted.capability.grep).toHaveBeenCalledTimes(
          ordering === 'after-response' ? 1 : 2
        );
        mounted.refresh(structuredClone(ready));
        mounted.response.scanLimited = false;
        mounted.response.sourceComplete = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
        expect(useWorkspaceSearchStore.getState().query).toBe('notarize');
        expect(useWorkspaceSearchStore.getState().results?.notices.scanLimited).toBe(false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000);
        });
        expect(mounted.capability.grep).toHaveBeenCalledTimes(2);
      } finally {
        mounted.unmount();
      }
    }
  );

  it.each(['clear', 'query', 'toggle', 'scope', 'store', 'refused', 'unmount'] as const)(
    'does not revive an incomplete-source query after %s',
    async (change) => {
      vi.useFakeTimers();
      const mounted = mountController();
      try {
        await vi.waitFor(() =>
          expect(mounted.result.current.dependencies?.profile).toEqual(profile)
        );
        mounted.refresh({ ...ready, rootReadiness: [{ rootId: 'root-a', scanComplete: false }] });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        mounted.response.sourceComplete = false;
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('notarize');
          mounted.result.current.controller.runTextSearch();
        });
        await vi.waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
        act(() => {
          const store = useWorkspaceSearchStore.getState();
          if (change === 'unmount') {
            mounted.unmount();
          }
          if (change === 'clear') {
            store.clearResults();
          }
          if (change === 'query') {
            store.setQuery('replacement');
          }
          if (change === 'toggle') {
            store.toggleRegex();
          }
          if (change === 'scope') {
            mounted.replaceRootBinding();
            mounted.rerender();
          }
          if (change === 'store') {
            mounted.refresh({ ...ready, storeId: 'replacement-store' });
          }
          if (change === 'refused') {
            mounted.emitLifecycle({
              cause: { kind: 'closed', reason: 'stopped' },
              generation: 9,
              kind: 'refused',
            });
          }
        });
        if (change !== 'store') {
          mounted.refresh(ready);
        }
        mounted.response.sourceComplete = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000);
        });
        expect(mounted.capability.grep).toHaveBeenCalledOnce();
        expect(useWorkspaceSearchStore.getState().nativePendingSearch).toBeNull();
        if (change === 'refused' || change === 'scope' || change === 'store') {
          expect(useWorkspaceSearchStore.getState().status).toBe('error');
        }
      } finally {
        mounted.unmount();
      }
    }
  );

  it.each(['root', 'collection'] as const)(
    'waits for the selected %s source, not unrelated completion',
    async (scope) => {
      vi.useFakeTimers();
      const mounted = mountController();
      const incomplete = {
        ...ready,
        collectionReadiness: [{ embeddingSetId: 'collection-a', scanComplete: false }],
        rootReadiness: [{ rootId: 'root-a', scanComplete: false }],
      };
      try {
        await vi.waitFor(() =>
          expect(mounted.result.current.dependencies?.profile).toEqual(profile)
        );
        mounted.refresh(incomplete);
        mounted.response.sourceComplete = false;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        act(() => {
          const store = useWorkspaceSearchStore.getState();
          if (scope === 'collection') {
            store.setCollectionId('collection-a');
          }
          store.setQuery('notarize');
          mounted.result.current.controller.runTextSearch();
        });
        await vi.waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
        mounted.refresh({
          ...incomplete,
          ...(scope === 'root'
            ? { collectionReadiness: [{ embeddingSetId: 'collection-a', scanComplete: true }] }
            : { rootReadiness: [{ rootId: 'root-a', scanComplete: true }] }),
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4000);
        });
        expect(mounted.capability.grep).toHaveBeenCalledOnce();
        mounted.refresh({
          ...ready,
          collectionReadiness: [{ embeddingSetId: 'collection-a', scanComplete: true }],
        });
        mounted.response.sourceComplete = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
      } finally {
        mounted.unmount();
      }
    }
  );

  it('does not rerun bounded results whose source is complete', async () => {
    vi.useFakeTimers();
    const mounted = mountController();
    try {
      await vi.waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      mounted.response.scanLimited = true;
      mounted.response.candidatesTruncated = true;
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('notarize');
        mounted.result.current.controller.runTextSearch();
      });
      await vi.waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mounted.capability.grep).toHaveBeenCalledOnce();
      expect(useWorkspaceSearchStore.getState().results?.notices.scanLimited).toBe(true);
    } finally {
      mounted.unmount();
    }
  });
  it('waits for a newer producer proof and never replays an unchanged completed proof', async () => {
    vi.useFakeTimers();
    const mounted = mountController();
    try {
      await vi.waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      mounted.response.sourceComplete = false;
      mounted.response.sourceObservation.readiness =
        mounted.response.sourceObservation.readiness.map((receipt) => ({
          ...receipt,
          generation: 2,
        }));
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('notarize');
        mounted.result.current.controller.runTextSearch();
      });
      await vi.waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mounted.capability.grep).toHaveBeenCalledOnce();
      const completed = {
        ...ready,
        sourceObservation: {
          ...mounted.response.sourceObservation,
          readiness: mounted.response.sourceObservation.readiness.map((receipt) => ({
            ...receipt,
            scanComplete: true,
          })),
        },
      };
      mounted.refresh(completed);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
      mounted.refresh(structuredClone(completed));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mounted.capability.grep).toHaveBeenCalledTimes(2);
      mounted.response.sourceComplete = true;
      mounted.refresh({
        ...completed,
        sourceObservation: {
          ...completed.sourceObservation,
          readiness: completed.sourceObservation.readiness.map((receipt) => ({
            ...receipt,
            generation: 3,
          })),
        },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(3));
    } finally {
      mounted.unmount();
    }
  });
});

// @vitest-environment jsdom
import { useIndexConfigStore } from '@brainstrike/app-state/stores/index-config-store';
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import { act, waitForOnFakeTimers } from '@brainstrike/test-utils/react-act';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
/** Main's saved semantic search: the hosted model the query plan must name. */
const SAVED_SEMANTIC: IndexConfig = {
  ...DEFAULT_INDEX_CONFIG,
  mode: 'semantic',
  model: { dimensions: 1536, modelKey: MODEL_KEY },
};

/** The index's profile as Main reports a hosted model: the saved key's provider and the collection's distance. */
const profile = {
  dimensions: 1536,
  distance: 'cosine' as const,
  modelId: MODEL_ID,
  provider: 'openai' as const,
};
/** Main's query plan names the collection's model key verbatim. */
const queryPlan = { modelKey: MODEL_KEY };
const ready = {
  authorizedCollectionIds: ['collection-a'],
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
beforeEach(() => {
  useIndexConfigStore.setState({
    state: { config: SAVED_SEMANTIC, kind: 'ready' },
    update: vi.fn(),
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
        await waitForOnFakeTimers(() =>
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
        await act(async () => mounted.publish());
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('notarize');
          mounted.result.current.controller.runTextSearch();
        });
        if (ordering === 'before-response') {
          await waitForOnFakeTimers(() => expect(mounted.capability.grep).toHaveBeenCalledOnce());
          mounted.refresh(structuredClone(ready));
          await act(async () => mounted.publish());
          const partial = { ...mounted.response };
          mounted.response.scanLimited = false;
          mounted.response.sourceComplete = true;
          await act(async () => {
            held.resolve(partial);
          });
        }
        await waitForOnFakeTimers(() =>
          expect(useWorkspaceSearchStore.getState().status).toBe('results')
        );
        expect(useWorkspaceSearchStore.getState().results?.notices.scanLimited).toBe(
          ordering === 'after-response'
        );
        expect(mounted.capability.grep).toHaveBeenCalledTimes(
          ordering === 'after-response' ? 1 : 2
        );
        mounted.refresh(structuredClone(ready));
        mounted.response.scanLimited = false;
        mounted.response.sourceComplete = true;
        await act(async () => mounted.publish());
        await waitForOnFakeTimers(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
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
        await waitForOnFakeTimers(() =>
          expect(mounted.result.current.dependencies?.profile).toEqual(profile)
        );
        mounted.refresh({ ...ready, rootReadiness: [{ rootId: 'root-a', scanComplete: false }] });
        await act(async () => mounted.publish());
        mounted.response.sourceComplete = false;
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('notarize');
          mounted.result.current.controller.runTextSearch();
        });
        await waitForOnFakeTimers(() =>
          expect(useWorkspaceSearchStore.getState().status).toBe('results')
        );
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
        await act(async () => mounted.publish());
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

  it('waits for the selected root source, not unrelated completion', async () => {
    vi.useFakeTimers();
    const mounted = mountController();
    // Another indexed folder, open in the app but not the one searched.
    const incomplete = {
      ...ready,
      authorizedRootIds: ['root-a', 'root-b'],
      rootReadiness: [
        { rootId: 'root-a', scanComplete: false },
        { rootId: 'root-b', scanComplete: false },
      ],
    };
    try {
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.dependencies?.profile).toEqual(profile)
      );
      mounted.refresh(incomplete);
      mounted.response.sourceComplete = false;
      await act(async () => mounted.publish());
      act(() => {
        const store = useWorkspaceSearchStore.getState();
        store.setQuery('notarize');
        mounted.result.current.controller.runTextSearch();
      });
      await waitForOnFakeTimers(() =>
        expect(useWorkspaceSearchStore.getState().status).toBe('results')
      );
      mounted.refresh({
        ...incomplete,
        rootReadiness: [
          { rootId: 'root-a', scanComplete: false },
          { rootId: 'root-b', scanComplete: true },
        ],
      });
      await act(async () => mounted.publish());
      expect(mounted.capability.grep).toHaveBeenCalledOnce();
      mounted.refresh({
        ...incomplete,
        rootReadiness: [
          { rootId: 'root-a', scanComplete: true },
          { rootId: 'root-b', scanComplete: true },
        ],
      });
      mounted.response.sourceComplete = true;
      await act(async () => mounted.publish());
      await waitForOnFakeTimers(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
    } finally {
      mounted.unmount();
    }
  });

  it('does not rerun bounded results whose source is complete', async () => {
    vi.useFakeTimers();
    const mounted = mountController();
    try {
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.dependencies?.profile).toEqual(profile)
      );
      mounted.response.scanLimited = true;
      mounted.response.candidatesTruncated = true;
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('notarize');
        mounted.result.current.controller.runTextSearch();
      });
      await waitForOnFakeTimers(() =>
        expect(useWorkspaceSearchStore.getState().status).toBe('results')
      );
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
      await waitForOnFakeTimers(() =>
        expect(mounted.result.current.dependencies?.profile).toEqual(profile)
      );
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
      await waitForOnFakeTimers(() =>
        expect(useWorkspaceSearchStore.getState().status).toBe('results')
      );
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
      await act(async () => mounted.publish());
      await waitForOnFakeTimers(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
      mounted.refresh(structuredClone(completed));
      await act(async () => mounted.publish());
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
      await act(async () => mounted.publish());
      await waitForOnFakeTimers(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(3));
    } finally {
      mounted.unmount();
    }
  });
});

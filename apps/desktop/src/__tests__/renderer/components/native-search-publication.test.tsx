// @vitest-environment jsdom
import { useIndexConfigStore } from '@brainstrike/app-state/stores/index-config-store';
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import { act } from '@brainstrike/test-utils/react-act';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { mountNativeSearchController } from './native-search-controller-fixture';

const MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';
const REVISION = 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f';
/** Main's saved semantic search: the exact local execution the query plan must match. */
const SAVED_SEMANTIC: IndexConfig = {
  ...DEFAULT_INDEX_CONFIG,
  mode: 'semantic',
  model: {
    dimensions: 384,
    local: { device: 'webgpu', dtype: 'fp16', revision: REVISION },
    modelKey: `local::${MODEL_ID}`,
  },
};

const execution = {
  dimensions: 384,
  dtype: 'fp16' as const,
  modelId: MODEL_ID,
  revision: REVISION,
};
/**
 * The index's profile as Main reports a local model: the saved key's provider, the collection's
 * distance and the execution's pins. Main's catalog facts carry no context window, so no token cap.
 */
const profile = {
  ...execution,
  distance: 'cosine' as const,
  provider: 'local' as const,
};
/** Main's query plan names the collection's model key verbatim. */
const queryPlan = {
  inferencePlan: { ...execution, device: 'webgpu' as const },
  modelKey: `local::${MODEL_ID}`,
};
const ready = {
  authorizedCollectionIds: ['collection-a'],
  authorizedRootIds: ['root-a'],
  embedding: {
    indexMode: 'vector-configured' as const,
    profile,
    profileHash: '654bee3466feeb474f0f1827badb57d458a679001b339ef3ab959eadbd2b6443',
  },
  kind: 'ready' as const,
  queryPlan,
  rootReadiness: [{ rootId: 'root-a', scanComplete: true }],
  storeId: 'store-a',
};
const queryEmbedding = vi.fn<(...args: unknown[]) => Promise<number[]>>();
const cancelQueryEmbedding = vi.fn<(...args: unknown[]) => Promise<{ cancelled: boolean }>>();

beforeEach(() => {
  useIndexConfigStore.setState({
    state: { config: SAVED_SEMANTIC, kind: 'ready' },
    update: vi.fn(),
  });
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
        await act(async () => mounted.publish());
        act(() => {
          useWorkspaceSearchStore.getState().setQuery('notarize');
          mounted.result.current.controller.runTextSearch();
        });
        if (ordering === 'before-response') {
          await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledOnce());
          mounted.refresh(structuredClone(ready));
          await act(async () => mounted.publish());
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
        await act(async () => mounted.publish());
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
        await act(async () => mounted.publish());
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
      await vi.waitFor(() => expect(mounted.result.current.dependencies?.profile).toEqual(profile));
      mounted.refresh(incomplete);
      mounted.response.sourceComplete = false;
      await act(async () => mounted.publish());
      act(() => {
        const store = useWorkspaceSearchStore.getState();
        store.setQuery('notarize');
        mounted.result.current.controller.runTextSearch();
      });
      await vi.waitFor(() => expect(useWorkspaceSearchStore.getState().status).toBe('results'));
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
      await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
    } finally {
      mounted.unmount();
    }
  });

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
      await act(async () => mounted.publish());
      await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(2));
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
      await vi.waitFor(() => expect(mounted.capability.grep).toHaveBeenCalledTimes(3));
    } finally {
      mounted.unmount();
    }
  });
});

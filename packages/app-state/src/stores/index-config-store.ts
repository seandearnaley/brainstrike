import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type {
  IndexConfig,
  IndexConfigCapability,
  IndexConfigPatch,
  IndexModel,
} from '@brainstrike/assistant-contract/index-config';
import { create } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';

export type IndexConfigView =
  | { readonly kind: 'loading' }
  | { readonly config: IndexConfig; readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly message: string };

interface IndexConfigStore {
  readonly state: IndexConfigView;
  /** Main's write path; null in a window without the index capability. */
  readonly update: ((patch: IndexConfigPatch) => Promise<IndexConfig>) | null;
}

/** Main's saved search index config as this window last heard it; Main is the only writer. */
export const useIndexConfigStore = create<IndexConfigStore>(() => ({
  state: { kind: 'loading' },
  update: null,
}));

export const selectIndexConfig = (store: IndexConfigStore): IndexConfig | null =>
  store.state.kind === 'ready' ? store.state.config : null;

const selectIndexModel = (store: IndexConfigStore): IndexModel | null =>
  selectIndexConfig(store)?.model ?? null;

const sameIndexModel = (left: IndexModel | null, right: IndexModel | null): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * The saved model, one value until Main saves a different one: every change Main publishes is a
 * fresh copy of the whole config, so a worktree, policy or chunking change keeps this identity.
 */
export function useIndexModel(): IndexModel | null {
  return useStoreWithEqualityFn(useIndexConfigStore, selectIndexModel, sameIndexModel);
}

/** Reads Main's config once and follows every change Main publishes. */
export function followIndexConfig(capability: IndexConfigCapability): () => void {
  let following = true;
  let published = false;
  const ready = (config: IndexConfig) =>
    useIndexConfigStore.setState({ state: { config, kind: 'ready' } });
  useIndexConfigStore.setState({ update: (patch) => capability.updateConfig(patch) });
  const unsubscribe = capability.onConfigChanged((config) => {
    published = true;
    ready(config);
  });
  capability.readConfig().then(
    (config) => {
      // A change Main published while the read was in flight is newer than the read.
      if (following && !published) {
        ready(config);
      }
    },
    (error: unknown) => {
      if (following && !published) {
        useIndexConfigStore.setState({
          state: { kind: 'failed', message: describeBoundaryError(error) },
        });
      }
    }
  );
  return () => {
    following = false;
    unsubscribe();
    useIndexConfigStore.setState({ update: null });
  };
}

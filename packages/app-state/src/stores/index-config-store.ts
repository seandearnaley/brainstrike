import {
  type BoundaryFailure,
  BoundaryFailureError,
  describeBoundaryError,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  type IndexConfig,
  type IndexConfigCapability,
  type IndexConfigPatch,
  type IndexModel,
  sameIndexModel,
} from '@brainstrike/assistant-contract/index-config';
import { create } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';

export type IndexConfigView =
  | { readonly kind: 'loading' }
  | { readonly config: IndexConfig; readonly kind: 'ready' }
  /** `failure` is Main's typed outcome, so a reader can tell a closed index from a damaged config. */
  | { readonly failure: BoundaryFailure; readonly kind: 'failed'; readonly message: string };

interface IndexConfigStore {
  /** Main's reset of a saved config it cannot read; null without the index capability. */
  readonly reset: (() => Promise<IndexConfig>) | null;
  readonly state: IndexConfigView;
  /** Main's write path; null in a window without the index capability. */
  readonly update: ((patch: IndexConfigPatch) => Promise<IndexConfig>) | null;
}

/** Main's saved search index config as this window last heard it; Main is the only writer. */
export const useIndexConfigStore = create<IndexConfigStore>(() => ({
  reset: null,
  state: { kind: 'loading' },
  update: null,
}));

export const selectIndexConfig = (store: IndexConfigStore): IndexConfig | null =>
  store.state.kind === 'ready' ? store.state.config : null;

const selectIndexModel = (store: IndexConfigStore): IndexModel | null =>
  selectIndexConfig(store)?.model ?? null;

const sameSavedModel = (left: IndexModel | null, right: IndexModel | null): boolean =>
  left === null || right === null ? left === right : sameIndexModel(left, right);

/**
 * The saved model, one value until Main saves a different one: every change Main publishes is a
 * fresh copy of the whole config, so a worktree, policy or chunking change keeps this identity.
 */
export function useIndexModel(): IndexModel | null {
  return useStoreWithEqualityFn(useIndexConfigStore, selectIndexModel, sameSavedModel);
}

/** Reads Main's config once and follows every change Main publishes. */
export function followIndexConfig(capability: IndexConfigCapability): () => void {
  let following = true;
  let published = false;
  const ready = (config: IndexConfig) =>
    useIndexConfigStore.setState({ state: { config, kind: 'ready' } });
  useIndexConfigStore.setState({
    reset: () => capability.resetConfig(),
    update: (patch) => capability.updateConfig(patch),
  });
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
          state: {
            failure: error instanceof BoundaryFailureError ? error.failure : INTERNAL_FAULT,
            kind: 'failed',
            message: describeBoundaryError(error),
          },
        });
      }
    }
  );
  return () => {
    following = false;
    unsubscribe();
    useIndexConfigStore.setState({ reset: null, update: null });
  };
}

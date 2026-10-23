import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type {
  IndexConfig,
  IndexConfigCapability,
  IndexConfigPatch,
} from '@brainstrike/assistant-contract/index-config';
import { create } from 'zustand';

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

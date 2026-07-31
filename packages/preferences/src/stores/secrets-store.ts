import { SECRETS_CHANGED_EVENT_NAME } from '@brainstrike/assistant-contract/provider-key-resolution';
import { create } from 'zustand';

/**
 * Simple store to track when secrets (API keys) change.
 * Components that depend on available providers can subscribe to `secretsVersion`
 * and re-check provider availability when it changes.
 */
interface SecretsState {
  /**
   * Call this after saving or deleting an API key to notify subscribers.
   */
  notifySecretsChanged: () => void;
  /**
   * Incremented whenever secrets are added, removed, or modified.
   * Components can use this as a dependency to trigger re-fetching of available providers.
   */
  secretsVersion: number;
}

export const useSecretsStore = create<SecretsState>()((set) => ({
  notifySecretsChanged: () => {
    set((state) => ({
      secretsVersion: state.secretsVersion + 1,
    }));
    // Cross-domain cache invalidation (BST-979): key caches (e.g. the
    // embeddings resolver, indexing domain) listen for this DOM event —
    // neither package may import the other, both may import the contract.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(SECRETS_CHANGED_EVENT_NAME));
    }
  },
  secretsVersion: 0,
}));

/**
 * Test helper to reset state between tests.
 * @internal
 */
export function __resetSecretsStoreForTests() {
  useSecretsStore.setState({ secretsVersion: 0 });
}

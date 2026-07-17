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
  notifySecretsChanged: () =>
    set((state) => ({
      secretsVersion: state.secretsVersion + 1,
    })),
  secretsVersion: 0,
}));

/**
 * Test helper to reset state between tests.
 * @internal
 */
export function __resetSecretsStoreForTests() {
  useSecretsStore.setState({ secretsVersion: 0 });
}

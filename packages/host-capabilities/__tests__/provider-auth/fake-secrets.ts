import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { ProviderCredential } from '@brainstrike/assistant-contract';

/** In-memory SecretsService double shared by the provider-auth tests. */
export interface FakeSecrets extends SecretsService {
  /** When set, getCredential throws it (simulates SecretReadError). */
  readCredentialError?: Error;
  readonly store: Map<string, ProviderCredential>;
}

export function makeFakeSecrets(initial: Record<string, ProviderCredential> = {}): FakeSecrets {
  const store = new Map<string, ProviderCredential>(Object.entries(initial));
  const fake: FakeSecrets = {
    clearAll: async () => {
      store.clear();
      return true;
    },
    deleteKey: async (provider) => store.delete(provider),
    getCredential: async (provider) => {
      if (fake.readCredentialError) {
        throw fake.readCredentialError;
      }
      return store.get(provider) ?? null;
    },
    getKey: async () => null,
    listProviders: async () => [...store.keys()],
    saveKey: async () => true,
    setCredential: async (provider, credential) => {
      store.set(provider, credential);
      return true;
    },
    store,
  };
  return fake;
}

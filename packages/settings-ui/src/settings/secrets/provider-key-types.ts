import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

export interface SecretsCapability {
  clearAll: (confirmationToken?: string) => Promise<{ message?: string; success: boolean }>;
  deleteKey: (provider: string) => Promise<boolean>;
  getKey: (provider: string) => Promise<null | string>;
  list: () => Promise<ProviderKeySource<SettingsProviderKeyId>[]>;
  listStored: () => Promise<string[]>;
  saveKey: (
    provider: string,
    value: string
  ) => Promise<true | { error: 'encryption_unavailable' | 'unknown_error'; ok: false }>;
}

/** Reads the optional desktop bridge by capability, without platform detection. */
export function getSecretsCapability(): SecretsCapability | undefined {
  return (window as unknown as { secrets?: SecretsCapability }).secrets;
}

/**
 * Secrets-store id for the Tavily web-search key. NOT an LLM `ProviderId`
 * (Tavily is a search service, not a model provider), so it is stored directly
 * by this id and kept out of the provider dropdown/registry.
 */
export const TAVILY_SECRET_PROVIDER = 'tavily';

export type SettingsProviderKeyId = SupportedProvider | typeof TAVILY_SECRET_PROVIDER;

/** Whether the credential-source listing has loaded, failed, or is pending. */
export type CredentialSourceState = 'error' | 'loading' | 'ready';

export interface ProviderOption {
  id: string;
  name: string;
}

import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

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

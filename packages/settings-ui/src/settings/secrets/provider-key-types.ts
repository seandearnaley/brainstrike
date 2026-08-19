import type { SecretsCapability } from '@brainstrike/assistant-contract/secrets-bridge';

/**
 * The bridge shape is defined ONCE in
 * `@brainstrike/assistant-contract/secrets-bridge`; this re-export keeps the
 * settings-ui import surface stable. The typed-credential methods are
 * optional in the capability view (older desktop preloads).
 */
export type { SecretsCapability } from '@brainstrike/assistant-contract/secrets-bridge';

/** Reads the optional desktop bridge by capability, without platform detection. */
export function getSecretsCapability(): SecretsCapability | undefined {
  return (window as unknown as { secrets?: SecretsCapability }).secrets;
}

/**
 * Secrets-store id for the Tavily web-search key. NOT an LLM `ProviderId`
 * (Tavily is a search service, not a model provider), so it is stored directly
 * by this id and kept out of the provider registry; the Credential Inventory
 * treats it as an extra slot (BST-1362).
 */
export const TAVILY_SECRET_PROVIDER = 'tavily';

/** Whether the credential-source listing has loaded, failed, or is pending. */
export type CredentialSourceState = 'error' | 'loading' | 'ready';

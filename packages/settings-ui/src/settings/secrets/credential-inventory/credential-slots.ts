import {
  listProviders,
  type ProviderAuthType,
  type ProviderDefinition,
  providerVendorEnvKey,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_VENDOR_ENV_KEY } from '@brainstrike/assistant-contract/tavily-env-keys';
import { TAVILY_SECRET_PROVIDER } from '../provider-key-types';

/**
 * One row of the Credential Inventory. Slots are a SUPERSET of registry
 * providers: every keyed registry provider gets one, and the Tavily
 * web-search key (deliberately outside the LLM provider registry) is a slot
 * of its own.
 */
export interface CredentialSlot {
  readonly authType: ProviderAuthType;
  readonly displayName: string;
  readonly docsUrl: string | null;
  /** Canonical VENDOR env var name shown in the Variable column. */
  readonly envVar: string;
  readonly id: string;
  readonly keyFormatHint: string | null;
  readonly keyNotes: string | null;
}

const TAVILY_SLOT: CredentialSlot = {
  authType: 'api_key',
  displayName: 'Tavily Web Search',
  docsUrl: null,
  envVar: TAVILY_VENDOR_ENV_KEY,
  id: TAVILY_SECRET_PROVIDER,
  keyFormatHint: null,
  keyNotes:
    "The assistant's web search tool sends your query to Tavily, an external service. Without a key, web search reports that it is unavailable.",
};

/**
 * The vendor env name of a KEY-bearing slot. A keyed provider without a
 * canonical vendor env name is a registry authoring error — surface it, never
 * invent a variable name.
 */
function requireVendorEnvKey(providerId: ProviderDefinition['id']): string {
  const envVar = providerVendorEnvKey(providerId);
  if (!envVar) {
    throw new Error(
      `Provider "${providerId}" requires a credential but declares no vendor env name.`
    );
  }
  return envVar;
}

function toProviderSlot(definition: ProviderDefinition): CredentialSlot {
  return {
    authType: definition.authType,
    displayName: definition.displayName,
    docsUrl: definition.docsUrl ?? null,
    envVar: requireVendorEnvKey(definition.id),
    id: definition.id,
    keyFormatHint: definition.keyFormatHint ?? null,
    keyNotes: definition.keyNotes ?? null,
  };
}

/** All inventory slots in registry order, Tavily last. */
export function listCredentialSlots(): readonly CredentialSlot[] {
  return [...listProviders().map(toProviderSlot), TAVILY_SLOT];
}

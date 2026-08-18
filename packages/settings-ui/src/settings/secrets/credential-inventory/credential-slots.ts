import {
  listProviders,
  type ProviderDefinition,
  providerVendorEnvKey,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_VENDOR_ENV_KEY as TAVILY_VENDOR_ENV_KEY_VALUE } from '@brainstrike/assistant-contract/tavily-env-keys';
import { TAVILY_SECRET_PROVIDER } from '../provider-key-types';

/** Auth modes the inventory can edit inline. `oauth_subscription` and `none`
 * providers keep their own dedicated surfaces. */
export type CredentialSlotAuthType = 'api_key' | 'aws';

/**
 * One row of the Credential Inventory. Slots are a SUPERSET of registry
 * providers: every keyed registry provider gets one, and the Tavily
 * web-search key (deliberately outside the LLM provider registry) is a slot
 * of its own.
 */
export interface CredentialSlot {
  readonly authType: CredentialSlotAuthType;
  readonly displayName: string;
  readonly docsUrl: string | null;
  /** Canonical VENDOR env var name shown in the Variable column. */
  readonly envVar: string;
  readonly id: string;
  readonly keyFormatHint: string | null;
  readonly keyNotes: string | null;
}

// Canonical Tavily names live in the contract so desktop and settings-ui
// cannot drift (BST-1363 review). Re-exported here to keep existing importers
// working — never re-spelled.
export { TAVILY_VENDOR_ENV_KEY } from '@brainstrike/assistant-contract/tavily-env-keys';

const TAVILY_SLOT: CredentialSlot = {
  authType: 'api_key',
  displayName: 'Tavily Web Search',
  docsUrl: null,
  envVar: TAVILY_VENDOR_ENV_KEY_VALUE,
  id: TAVILY_SECRET_PROVIDER,
  keyFormatHint: null,
  keyNotes:
    "The assistant's web search tool sends your query to Tavily, an external service. Without a key, web search reports that it is unavailable.",
};

function toProviderSlot(definition: ProviderDefinition): CredentialSlot | null {
  if (definition.authType !== 'api_key' && definition.authType !== 'aws') {
    // Keyless local runtimes (and future oauth_subscription providers) keep
    // their own settings category — deliberately not inventory rows.
    return null;
  }
  const envVar = providerVendorEnvKey(definition.id);
  if (!envVar) {
    // A keyed provider without a canonical vendor env name is a registry
    // authoring error — surface it, never invent a variable name.
    throw new Error(
      `Provider "${definition.id}" requires a credential but declares no vendor env name.`
    );
  }
  return {
    authType: definition.authType,
    displayName: definition.displayName,
    docsUrl: definition.docsUrl ?? null,
    envVar,
    id: definition.id,
    keyFormatHint: definition.keyFormatHint ?? null,
    keyNotes: definition.keyNotes ?? null,
  };
}

/** All inventory slots in registry order, Tavily last. */
export function listCredentialSlots(): readonly CredentialSlot[] {
  const slots: CredentialSlot[] = [];
  for (const definition of listProviders()) {
    const slot = toProviderSlot(definition);
    if (slot) {
      slots.push(slot);
    }
  }
  slots.push(TAVILY_SLOT);
  return slots;
}

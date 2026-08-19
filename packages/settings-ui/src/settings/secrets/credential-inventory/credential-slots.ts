import {
  listProviders,
  type ProviderDefinition,
  providerVendorEnvKey,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_VENDOR_ENV_KEY as TAVILY_VENDOR_ENV_KEY_VALUE } from '@brainstrike/assistant-contract/tavily-env-keys';
import { TAVILY_SECRET_PROVIDER } from '../provider-key-types';

/**
 * Auth modes the inventory renders a row for. `api_key` and `aws` are edited
 * inline; `oauth_subscription` rows carry a sign-in flow instead of a secret
 * field (BST-1356). Only `none` providers — keyless local runtimes — keep
 * their own dedicated surfaces and get no row.
 */
export type CredentialSlotAuthType = 'api_key' | 'aws' | 'oauth_subscription';

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
  /**
   * Canonical VENDOR env var name shown in the Variable column, or `null` for
   * an `oauth_subscription` slot. Subscription auth is interactive-desktop
   * sign-in only (OAuth legal gate, constraint 4) and such providers declare
   * `envKeys: []` — so there is no variable name to show, and inventing one
   * would advertise a way to authenticate that does not exist.
   */
  readonly envVar: string | null;
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

function isSlotAuthType(
  authType: ProviderDefinition['authType']
): authType is CredentialSlotAuthType {
  return authType === 'api_key' || authType === 'aws' || authType === 'oauth_subscription';
}

/**
 * The vendor env name of a KEY-bearing slot. A keyed provider without a
 * canonical vendor env name is a registry authoring error — surface it, never
 * invent a variable name. Deliberately NOT applied to `oauth_subscription`
 * slots: those authenticate by sign-in and declare no env keys at all.
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

function toProviderSlot(definition: ProviderDefinition): CredentialSlot | null {
  if (!isSlotAuthType(definition.authType)) {
    // Keyless local runtimes keep their own settings category — deliberately
    // not inventory rows.
    return null;
  }
  const envVar =
    definition.authType === 'oauth_subscription' ? null : requireVendorEnvKey(definition.id);
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

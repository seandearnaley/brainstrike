/**
 * Pinned-persona model resolution (persona `model: provider::modelId`).
 *
 * Builds the `resolvePinnedModel` closure `buildPersonaSubAgents` consumes.
 * Key-selection rules, in order:
 * 1. Pin targets the PARENT provider → reuse the parent's resolved key.
 * 2. Cross-provider pin → `runtime.personaProviderApiKeys[provider]`
 *    (server-resolved from the secrets bridge; never client-supplied).
 * 3. Keyless local providers (`local`, `ollama`, `lmstudio`) → no key needed.
 * 4. Anything else THROWS — the factory catches and SKIPS the persona with a
 *    visible warn. A hosted pin must never fall through to an env-var guess or
 *    an unauthenticated client (no silent fallbacks).
 */

import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { listProviders } from '@brainstrike/assistant-contract/provider-metadata';
import { findProviderDefinition } from '@brainstrike/assistant-contract/provider-registry';
import type { MastraModelConfig } from '@mastra/core/llm';
import { apiKeyAuthInput, type ProviderAuthInput } from '../providers/provider-auth-input';
import type { RuntimeData } from '../types';

/**
 * Providers whose pins never need a bearer token — derived from the registry
 * (`authType: 'none'`, BST-1349), never hand-listed. The local servers are
 * reached via `runtime.providerOptions` base URLs; the built-in on-device
 * provider is in this set too, and a pin to it refuses in the factory (it has
 * no chat model to instantiate).
 * Exported so the desktop server's key-resolution loop shares one source.
 */
export const PERSONA_PIN_KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(
  listProviders()
    .filter((provider) => provider.authType === 'none')
    .map((provider) => provider.id)
);

export interface CreatePersonaPinnedModelResolverParams {
  /**
   * The parent provider's resolved auth input (reused for same-provider pins
   * — BST-1352: the FULL input, so custom_fetch/aws pins stay intact).
   */
  readonly auth: ProviderAuthInput | undefined;
  readonly inheritedModel?:
    | { readonly name: string; readonly model: MastraModelConfig }
    | undefined;
  /** Model instantiation seam (production: `createProvider`). */
  readonly instantiate: (
    provider: string,
    auth: ProviderAuthInput | undefined,
    modelName: string,
    runtime: RuntimeData | undefined
  ) => MastraModelConfig;
  /** The parent's normalized provider id. */
  readonly parentProvider: string;
  readonly runtime: RuntimeData | undefined;
}

/**
 * Build the pin resolver for this run. Throws (from inside the returned
 * closure) when a key cannot be selected; `buildPersonaSubAgents` catches and
 * skips that persona with `subagent_persona_pin_unresolvable`.
 */
export function createPersonaPinnedModelResolver(
  params: CreatePersonaPinnedModelResolverParams
): (persona: AssistantPersonaDefinition) => MastraModelConfig {
  return (persona) => {
    const pin = persona.model;
    if (!pin) {
      throw new Error(
        `persona '${persona.id}' has no model pin; the resolver must only be called for pinned personas`
      );
    }

    if (pin.provider === params.parentProvider) {
      if (params.inheritedModel?.name === pin.modelId) {
        return params.inheritedModel.model;
      }
      return params.instantiate(pin.provider, params.auth, pin.modelId, params.runtime);
    }

    if (findProviderDefinition(pin.provider)?.authType === 'aws') {
      // Cross-provider pin keys are bearer STRINGS (personaProviderApiKeys)
      // with no region seat, so an aws-authType pin (Bedrock) cannot be
      // built even when a bearer is mapped — a region-less api_key input
      // would only fail later and less legibly in the factory. Personas
      // cannot pin Bedrock until BST-1353/BST-1358 design region-carrying
      // pins (PR #2522 review, finding 5). Same-provider pins above DO work:
      // they reuse the parent's full aws auth input, region included.
      throw new Error(
        `pinned provider '${pin.provider}' uses AWS auth, which persona pins cannot carry a region for yet (BST-1353/BST-1358); persona '${persona.id}' is skipped`
      );
    }

    const mappedKey = params.runtime?.personaProviderApiKeys?.[pin.provider];
    if (mappedKey) {
      // Cross-provider pin keys stay bearer strings (server-resolved from the
      // secrets bridge); wrap through the ONE string→union adapter.
      return params.instantiate(
        pin.provider,
        apiKeyAuthInput(mappedKey),
        pin.modelId,
        params.runtime
      );
    }

    if (PERSONA_PIN_KEYLESS_PROVIDERS.has(pin.provider)) {
      return params.instantiate(pin.provider, undefined, pin.modelId, params.runtime);
    }

    throw new Error(
      `no API key available for pinned provider '${pin.provider}' (persona '${persona.id}')`
    );
  };
}

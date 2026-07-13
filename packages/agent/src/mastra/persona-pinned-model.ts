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
import type { MastraModelConfig } from '@mastra/core/llm';
import type { RuntimeData } from '../types';

const KEYLESS_PROVIDERS = new Set(['local', 'ollama', 'lmstudio']);

export interface CreatePersonaPinnedModelResolverParams {
  /** The parent provider's resolved API key (reused for same-provider pins). */
  readonly apiKey: string | undefined;
  /** Model instantiation seam (production: `createProvider`). */
  readonly instantiate: (
    provider: string,
    apiKey: string | undefined,
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
      return params.instantiate(pin.provider, params.apiKey, pin.modelId, params.runtime);
    }

    const mappedKey = params.runtime?.personaProviderApiKeys?.[pin.provider];
    if (mappedKey) {
      return params.instantiate(pin.provider, mappedKey, pin.modelId, params.runtime);
    }

    if (KEYLESS_PROVIDERS.has(pin.provider)) {
      return params.instantiate(pin.provider, undefined, pin.modelId, params.runtime);
    }

    throw new Error(
      `no API key available for pinned provider '${pin.provider}' (persona '${persona.id}')`
    );
  };
}

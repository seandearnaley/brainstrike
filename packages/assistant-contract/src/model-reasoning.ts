/**
 * Reasoning capability resolvers for the model picker / composer model menu.
 *
 * Two DELIBERATELY separate resolvers (do not merge them):
 *
 * - `resolveModelReasoningSupport` answers "does this model think?" for
 *   badges and the thinking disclosure. It is tri-state: an undeclared
 *   OpenRouter model or a dynamically discovered local-runtime model resolves
 *   to a VISIBLE `unknown` ("unverified") — never a silent yes/no guess.
 * - `resolveReasoningControlsAvailability` answers "which reasoning controls
 *   may the UI offer?" for the Effort submenu / Thinking toggle. An
 *   undeclared OpenRouter model still gets the full effort list here (the
 *   request boundary accepts `openrouter.reasoning` for any model) even
 *   while its capability badge stays `unknown`.
 *
 * REGISTRY-ONLY metadata (no DB model-catalog migration) — same precedent as
 * `contextWindow` on `LlmModelDefinition`.
 */
import { getGoogleThinkingLevels } from '@brainstrike/types';
import { getLocalLlmModelSpec } from './local-llm-model-specs.js';
import {
  type LlmModelDefinition,
  listProviderLlmModels,
  listProviders,
  type ProviderId,
} from './provider-registry.js';
import type {
  AnthropicEffort,
  GoogleThinkingLevel,
  OpenAiReasoningEffort,
} from './runtime-data.js';

export type ModelReasoningSupport =
  | { state: 'supported'; source: 'model' | 'provider-default' | 'local-spec' }
  | { state: 'unsupported' }
  | { state: 'unknown'; reason: 'openrouter-undeclared' | 'discovered-model' };

export type ReasoningControlsAvailability =
  | {
      available: true;
      family: 'openai' | 'openrouter';
      efforts: readonly OpenAiReasoningEffort[];
      defaultEffort?: OpenAiReasoningEffort | undefined;
      mandatory?: boolean | undefined;
    }
  | { available: true; family: 'anthropic'; efforts: readonly AnthropicEffort[] }
  | { available: true; family: 'google'; levels: readonly GoogleThinkingLevel[] }
  | { available: true; family: 'local' }
  | { available: false; reason: 'no-reasoning-controls' };

/**
 * Efforts offered when an OpenAI-family model does not declare its own
 * `reasoning.supportedEfforts`. `none`/`max` are intentionally excluded from
 * the undeclared default set — `max` is only valid where a model declares it
 * (e.g. kimi-k3) and `none` is expressed as "Auto (default)" (unset).
 */
export const OPENAI_FAMILY_DEFAULT_EFFORTS: readonly OpenAiReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export const ANTHROPIC_REASONING_EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high'];

const KNOWN_PROVIDER_IDS: ReadonlySet<string> = new Set<string>(
  listProviders().map((provider) => provider.id)
);

function normalizeProviderId(providerId: string): ProviderId | undefined {
  const normalized = providerId.toLowerCase();
  return KNOWN_PROVIDER_IDS.has(normalized) ? (normalized as ProviderId) : undefined;
}

function findDeclaredLlmModel(
  provider: ProviderId,
  modelId: string
): LlmModelDefinition | undefined {
  return listProviderLlmModels(provider).find((model) => model.id === modelId);
}

/**
 * Tri-state "does this model think?" for capability badges and the thinking
 * disclosure. `unknown` is a real, renderable state ("unverified") — callers
 * must never coerce it to supported/unsupported.
 */
export function resolveModelReasoningSupport(
  providerId: string,
  modelId: string
): ModelReasoningSupport {
  const provider = normalizeProviderId(providerId);
  if (!provider) {
    return { state: 'unsupported' };
  }

  if (provider === 'local') {
    const spec = getLocalLlmModelSpec(modelId);
    if (!spec) {
      return { state: 'unsupported' };
    }
    return spec.supportsThinking
      ? { source: 'local-spec', state: 'supported' }
      : { state: 'unsupported' };
  }

  if (provider === 'ollama' || provider === 'lmstudio') {
    // Discovered runtime models carry no reasoning signal from their
    // endpoints — surface "unverified" instead of guessing.
    return { reason: 'discovered-model', state: 'unknown' };
  }

  if (findDeclaredLlmModel(provider, modelId)?.reasoning) {
    return { source: 'model', state: 'supported' };
  }

  if (provider === 'openai' || provider === 'anthropic' || provider === 'google') {
    return { source: 'provider-default', state: 'supported' };
  }

  if (provider === 'openrouter') {
    return { reason: 'openrouter-undeclared', state: 'unknown' };
  }

  // Embedding-only providers (cohere, voyage) have no LLMs to reason with.
  return { state: 'unsupported' };
}

function resolveOpenAiFamilyControls(
  family: 'openai' | 'openrouter',
  declared: LlmModelDefinition['reasoning']
): ReasoningControlsAvailability {
  if (!declared) {
    return { available: true, efforts: OPENAI_FAMILY_DEFAULT_EFFORTS, family };
  }
  return {
    available: true,
    ...(declared.defaultEffort === undefined ? {} : { defaultEffort: declared.defaultEffort }),
    efforts: declared.supportedEfforts,
    family,
    ...(declared.mandatory ? { mandatory: true } : {}),
  };
}

/**
 * Which reasoning controls the composer may offer for a provider/model pair.
 * Absorbs the old `getOpenRouterReasoningCapabilities` model-constraint
 * lookup from `provider-settings-panel.tsx`.
 */
export function resolveReasoningControlsAvailability(
  providerId: string,
  modelId: string | undefined
): ReasoningControlsAvailability {
  const provider = normalizeProviderId(providerId);
  if (!provider) {
    return { available: false, reason: 'no-reasoning-controls' };
  }

  switch (provider) {
    case 'openai':
    case 'openrouter': {
      const declared =
        modelId === undefined ? undefined : findDeclaredLlmModel(provider, modelId)?.reasoning;
      return resolveOpenAiFamilyControls(provider, declared);
    }
    case 'anthropic':
      return { available: true, efforts: ANTHROPIC_REASONING_EFFORTS, family: 'anthropic' };
    case 'google':
      return { available: true, family: 'google', levels: getGoogleThinkingLevels(modelId) };
    case 'local': {
      const spec = modelId === undefined ? undefined : getLocalLlmModelSpec(modelId);
      if (spec?.supportsThinking) {
        return { available: true, family: 'local' };
      }
      return { available: false, reason: 'no-reasoning-controls' };
    }
    case 'ollama':
    case 'lmstudio':
    case 'cohere':
    case 'voyage':
      return { available: false, reason: 'no-reasoning-controls' };
    default: {
      const exhausted: never = provider;
      throw new Error(`Unhandled provider in reasoning controls resolver: ${String(exhausted)}`);
    }
  }
}

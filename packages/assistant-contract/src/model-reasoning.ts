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
import type { OpenRouterModelMetadata } from './openrouter-model-metadata.js';
import {
  getProviderDefinition,
  type LlmModelDefinition,
  listProviderLlmModels,
  listProviders,
  type ProviderId,
} from './provider-registry.js';
import type {
  AnthropicEffort,
  BedrockReasoningEffort,
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
  | {
      available: true;
      family: 'anthropic';
      efforts: readonly AnthropicEffort[];
      defaultEffort?: AnthropicEffort | undefined;
    }
  | {
      /**
       * Its own family rather than a reuse of `anthropic` (BST-1354). The
       * Anthropic family carries a free-form thinking BUDGET toggle that
       * Bedrock has no equivalent for, so sharing it would render a switch
       * whose value the Bedrock request builder ignores. The offered efforts
       * are per-model because the three Bedrock dialects accept different
       * ladders.
       */
      available: true;
      family: 'bedrock';
      efforts: readonly BedrockReasoningEffort[];
    }
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

/**
 * OFFERED Bedrock efforts, per reasoning dialect. Same
 * offered-vs-membership discipline as the registry's `anthropicReasoning` ladders: the TYPE
 * spans the SDK's full enum, these lists span what a route is documented to
 * accept.
 *
 * - `adaptive` — AWS's adaptive-thinking `output_config.effort`. Held at
 *   low/medium/high until each Bedrock route declares its own ladder: `xhigh`/`max`
 *   are per-model (`supportsXhighEffort` in the SDK's capability table), and
 *   offering an effort a route rejects is a broken menu entry.
 * - `budget-tokens` — only the two efforts with a vendor-grounded token budget
 *   exist (see `BEDROCK_BUDGET_TOKENS_BY_EFFORT`). There is no documented
 *   low/medium budget, and inventing one would be a guess.
 * - `max-reasoning-effort` — exactly the three values Amazon's extended
 *   thinking guide documents for Nova.
 */
export const BEDROCK_REASONING_EFFORTS: Readonly<
  Record<NonNullable<LlmModelDefinition['bedrockReasoning']>, readonly BedrockReasoningEffort[]>
> = {
  adaptive: ['low', 'medium', 'high'],
  'budget-tokens': ['high', 'max'],
  'max-reasoning-effort': ['low', 'medium', 'high'],
};

/**
 * Token budgets for the legacy Bedrock `{type:'enabled', budgetTokens}` form.
 * AWS documents a 1,024-token minimum and no hard maximum below the model's
 * output window; these two values match the budgets OpenCode sends on the same
 * routes. Only these efforts are offered, so the record is total.
 */
export const BEDROCK_BUDGET_TOKENS_BY_EFFORT: Readonly<
  Partial<Record<BedrockReasoningEffort, number>>
> = {
  high: 16_000,
  max: 31_999,
};

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

  if (getProviderDefinition(provider).runtime === 'local') {
    // Local-runtime servers (registry `runtime: 'local'`, PR #2513 review
    // finding 5): discovered runtime models carry no reasoning signal from
    // their endpoints — surface "unverified" instead of guessing.
    return { reason: 'discovered-model', state: 'unknown' };
  }

  const declared = findDeclaredLlmModel(provider, modelId);
  if (declared?.reasoning) {
    return { source: 'model', state: 'supported' };
  }
  // Bedrock records reasoning as a per-model DIALECT rather than an effort
  // ladder, so it declares capability through its own field (BST-1354).
  if (declared?.bedrockReasoning) {
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
  const efforts =
    family === 'openrouter' && !declared.mandatory && !declared.supportedEfforts.includes('none')
      ? [...declared.supportedEfforts, 'none' as const]
      : declared.supportedEfforts;
  return {
    available: true,
    ...(declared.defaultEffort === undefined ? {} : { defaultEffort: declared.defaultEffort }),
    efforts,
    family,
    ...(declared.mandatory ? { mandatory: true } : {}),
  };
}

function resolveOpenRouterControls(
  modelId: string | undefined,
  metadata: OpenRouterModelMetadata | undefined
): ReasoningControlsAvailability {
  const liveReasoning = metadata && metadata.id === modelId ? metadata.reasoning : undefined;
  if (liveReasoning && !liveReasoning.supportedEfforts) {
    return liveReasoning.mandatory
      ? { available: false, reason: 'no-reasoning-controls' }
      : { available: true, efforts: ['none'], family: 'openrouter' };
  }
  const declared = liveReasoning?.supportedEfforts
    ? {
        ...(liveReasoning.defaultEffort === undefined
          ? {}
          : { defaultEffort: liveReasoning.defaultEffort }),
        mandatory: liveReasoning.mandatory,
        supportedEfforts: liveReasoning.supportedEfforts,
      }
    : modelId === undefined
      ? undefined
      : findDeclaredLlmModel('openrouter', modelId)?.reasoning;
  // OpenRouter routes must declare their own ladder. Direct OpenAI defaults
  // do not establish capabilities for an undeclared routed model.
  if (!declared) {
    return { available: false, reason: 'no-reasoning-controls' };
  }
  return resolveOpenAiFamilyControls('openrouter', declared);
}

function resolveAnthropicControls(modelId: string | undefined): ReasoningControlsAvailability {
  // Direct Anthropic uses the registry allow-list (isValidModelForProvider),
  // with no custom-model option, so a missing or uncatalogued id is the
  // no-selection edge, not a custom route. It still gets the Thinking toggle
  // with an EMPTY effort ladder — the same shape as Haiku — because
  // `buildAnthropicOptions` keeps sending a persisted legacy budget for such
  // an id, and the toggle is AUTHORITATIVE for "is Claude thinking": hiding it
  // would leave a request the user can neither see nor clear. Only the ladder
  // needs a registry row to judge against, so only the ladder is withheld.
  const model = modelId === undefined ? undefined : findDeclaredLlmModel('anthropic', modelId);
  if (!model?.anthropicReasoning) {
    return { available: true, efforts: [], family: 'anthropic' };
  }
  return {
    available: true,
    defaultEffort: model.anthropicReasoning.defaultEffort,
    efforts: model.anthropicReasoning.supportedEfforts,
    family: 'anthropic',
  };
}

/**
 * Which reasoning controls the composer may offer for a provider/model pair.
 * Absorbs the old `getOpenRouterReasoningCapabilities` model-constraint
 * lookup from `provider-settings-panel.tsx`.
 */
export function resolveReasoningControlsAvailability(
  providerId: string,
  modelId: string | undefined,
  openRouterMetadata?: OpenRouterModelMetadata
): ReasoningControlsAvailability {
  const provider = normalizeProviderId(providerId);
  if (!provider) {
    return { available: false, reason: 'no-reasoning-controls' };
  }

  if (getProviderDefinition(provider).runtime === 'local') {
    // Registry-derived (PR #2513 review, finding 5): local-runtime servers'
    // discovered models expose no reasoning controls.
    return { available: false, reason: 'no-reasoning-controls' };
  }

  switch (provider) {
    case 'openai':
      return resolveOpenAiFamilyControls(
        'openai',
        modelId === undefined ? undefined : findDeclaredLlmModel('openai', modelId)?.reasoning
      );
    case 'openai-codex':
      // BST-1356: the same GPT-5.x families as the platform `openai` entry,
      // reached through the Codex backend. Reasoning controls belong to the
      // MODEL, not the endpoint, so this shares the OpenAI control family.
      return resolveOpenAiFamilyControls(
        'openai',
        modelId === undefined ? undefined : findDeclaredLlmModel('openai-codex', modelId)?.reasoning
      );
    case 'openrouter':
      return resolveOpenRouterControls(modelId, openRouterMetadata);
    case 'anthropic':
      return resolveAnthropicControls(modelId);
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
      // Unreachable at runtime — the registry `runtime: 'local'` early return
      // above owns this answer. Retained solely so the switch keeps its
      // compile-time exhaustiveness pin over ProviderId.
      return { available: false, reason: 'no-reasoning-controls' };
    case 'cohere':
    case 'voyage':
      return { available: false, reason: 'no-reasoning-controls' };
    case 'bedrock': {
      // BST-1354: per-model, straight off the registry's declared dialect.
      // Bedrock's catalog is heterogeneous — adaptive Claude routes, one
      // legacy budget-token route, Amazon Nova, and several routes with no
      // reasoning at all — so there is no provider-wide answer to give.
      const dialect =
        modelId === undefined
          ? undefined
          : findDeclaredLlmModel(provider, modelId)?.bedrockReasoning;
      if (!dialect) {
        return { available: false, reason: 'no-reasoning-controls' };
      }
      return { available: true, efforts: BEDROCK_REASONING_EFFORTS[dialect], family: 'bedrock' };
    }
    default: {
      const exhausted: never = provider;
      throw new Error(`Unhandled provider in reasoning controls resolver: ${String(exhausted)}`);
    }
  }
}

import type { OpenAiReasoningEffort } from './runtime-data.js';

/**
 * OpenCode's coding-oriented output ceiling. OpenRouter models with a smaller
 * advertised completion limit use that limit instead.
 */
export const OPENROUTER_CODING_MAX_OUTPUT_TOKENS = 32_000;

export interface OpenRouterAutoRuntimeProfile {
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: OpenAiReasoningEffort;
}

export interface OpenRouterAutoProfileModel {
  readonly id: string;
  readonly maxOutputTokens?: number;
  readonly reasoning?: {
    /**
     * The effort the zero-configuration Auto profile sends for this model.
     *
     * Recorded per model in our catalog and takes precedence over the vendor's
     * `defaultEffort`. This is the ONLY place an Auto effort may deviate from
     * what the vendor declares — write it down here rather than deriving it,
     * including `'none'` when reasoning should deliberately be switched off.
     */
    readonly autoEffort?: OpenAiReasoningEffort;
    readonly defaultEffort?: OpenAiReasoningEffort;
    readonly defaultEnabled?: boolean;
    readonly mandatory?: boolean;
    readonly supportedEfforts?: readonly OpenAiReasoningEffort[];
    readonly supportsMaxTokens?: boolean;
  };
}

/**
 * Small, deliberately diverse coding set enabled when a readable OpenRouter
 * configuration first meets an untouched model catalog. Each route is part of
 * the supported static registry and has passed a live assistant/tooling smoke.
 */
export const OPENROUTER_RECOMMENDED_CODING_MODEL_IDS = [
  'openai/gpt-5.6-terra',
  'moonshotai/kimi-k3',
  'qwen/qwen3.7-max',
  'z-ai/glm-5.2',
  'minimax/minimax-m3',
] as const;

export function resolveOpenRouterCodingMaxOutputTokens(modelMaxOutputTokens?: number): number {
  if (modelMaxOutputTokens === undefined) {
    return OPENROUTER_CODING_MAX_OUTPUT_TOKENS;
  }
  if (!(Number.isSafeInteger(modelMaxOutputTokens) && modelMaxOutputTokens > 0)) {
    throw new Error(`modelMaxOutputTokens must be a positive integer, got ${modelMaxOutputTokens}`);
  }
  return Math.min(modelMaxOutputTokens, OPENROUTER_CODING_MAX_OUTPUT_TOKENS);
}

export function resolveOpenRouterAutoRuntimeProfile<TModel extends OpenRouterAutoProfileModel>(
  model: TModel,
  configuredMaxOutputTokens?: number
): OpenRouterAutoRuntimeProfile {
  const baselineOutputTokens =
    configuredMaxOutputTokens ?? resolveOpenRouterCodingMaxOutputTokens(model.maxOutputTokens);
  if (
    configuredMaxOutputTokens !== undefined &&
    !(Number.isSafeInteger(configuredMaxOutputTokens) && configuredMaxOutputTokens > 0)
  ) {
    throw new Error(
      `configuredMaxOutputTokens must be a positive integer, got ${configuredMaxOutputTokens}`
    );
  }
  const reasoning = model.reasoning;
  if (!reasoning?.defaultEnabled) {
    return { maxOutputTokens: baselineOutputTokens };
  }

  // DECLARED ONLY — never inferred (BST-833). The previous rule scanned
  // `supportedEfforts` for a "completion-biased" effort and, finding none,
  // silently substituted `none`, discarding the model's own declared default.
  // GLM-5.2 declares `defaultEffort: 'high'` and advertises no low tier, so it
  // lost reasoning entirely — invisibly, and for a reason unrelated to any
  // measured budget risk. The final-answer budget is protected by
  // OPENROUTER_CODING_MAX_OUTPUT_TOKENS above, which is independent of effort.
  //
  // A model that should reason less (or not at all) under Auto records that as
  // `autoEffort` in the catalog. With neither field declared we have no basis
  // for a claim, so we send no effort at all and let the provider apply its
  // own default — inventing one here is exactly the silent fallback this
  // removes.
  const declaredEffort = reasoning.autoEffort ?? reasoning.defaultEffort;
  return {
    maxOutputTokens: baselineOutputTokens,
    ...(declaredEffort ? { reasoningEffort: declaredEffort } : {}),
  };
}

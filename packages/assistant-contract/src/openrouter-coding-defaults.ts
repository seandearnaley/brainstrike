import type { OpenAiReasoningEffort } from './runtime-data.js';

/**
 * OpenCode's coding-oriented output ceiling. OpenRouter models with a smaller
 * advertised completion limit use that limit instead.
 */
export const OPENROUTER_CODING_MAX_OUTPUT_TOKENS = 32_000;

const OPENROUTER_REASONING_EFFORT_ASCENDING: readonly OpenAiReasoningEffort[] = [
  'minimal',
  'low',
  'none',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface OpenRouterAutoRuntimeProfile {
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: OpenAiReasoningEffort;
}

export interface OpenRouterAutoProfileModel {
  readonly id: string;
  readonly maxOutputTokens?: number;
  readonly reasoning?: {
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
  const supportedEfforts = reasoning?.supportedEfforts;
  if (!reasoning?.defaultEnabled) {
    return { maxOutputTokens: baselineOutputTokens };
  }

  const reasoningEffort = supportedEfforts
    ? OPENROUTER_REASONING_EFFORT_ASCENDING.find((effort) => supportedEfforts.includes(effort))
    : undefined;
  const isCompletionBiasedEffort =
    reasoningEffort === 'none' || reasoningEffort === 'minimal' || reasoningEffort === 'low';
  if (reasoning.mandatory !== true && !isCompletionBiasedEffort) {
    return {
      maxOutputTokens: baselineOutputTokens,
      reasoningEffort: 'none',
    };
  }
  return {
    maxOutputTokens: baselineOutputTokens,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

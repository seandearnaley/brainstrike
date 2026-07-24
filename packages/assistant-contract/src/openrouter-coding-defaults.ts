import type { OpenAiReasoningEffort } from './runtime-data.js';

/**
 * OpenCode's coding-oriented output ceiling. OpenRouter models with a smaller
 * advertised completion limit use that limit instead.
 */
export const OPENROUTER_CODING_MAX_OUTPUT_TOKENS = 32_000;
export const OPENROUTER_FINAL_ANSWER_RESERVE_TOKENS = 8192;

const OPENROUTER_FINAL_OUTPUT_PERCENTAGES: Readonly<
  Partial<Record<OpenAiReasoningEffort, number>>
> = {
  high: 20,
  low: 80,
  max: 5,
  medium: 50,
  minimal: 90,
  xhigh: 5,
};

export interface OpenRouterAutoRuntimeProfile {
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: OpenAiReasoningEffort;
  readonly reservedFinalAnswerTokens?: number;
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
  if (!(reasoning?.defaultEnabled && supportedEfforts && supportedEfforts.length > 0)) {
    return { maxOutputTokens: baselineOutputTokens };
  }

  const maximumOutputTokens =
    configuredMaxOutputTokens ?? model.maxOutputTokens ?? baselineOutputTokens;
  const effortsByDescendingReasoning = [...supportedEfforts].sort(
    (left, right) =>
      (OPENROUTER_FINAL_OUTPUT_PERCENTAGES[left] ?? 100) -
      (OPENROUTER_FINAL_OUTPUT_PERCENTAGES[right] ?? 100)
  );
  for (const effort of effortsByDescendingReasoning) {
    const finalOutputPercentage = OPENROUTER_FINAL_OUTPUT_PERCENTAGES[effort];
    if (finalOutputPercentage === undefined) {
      continue;
    }
    const requiredOutputTokens = Math.ceil(
      (OPENROUTER_FINAL_ANSWER_RESERVE_TOKENS * 100) / finalOutputPercentage
    );
    if (requiredOutputTokens > maximumOutputTokens) {
      continue;
    }
    return {
      maxOutputTokens: Math.max(baselineOutputTokens, requiredOutputTokens),
      reasoningEffort: effort,
      reservedFinalAnswerTokens: OPENROUTER_FINAL_ANSWER_RESERVE_TOKENS,
    };
  }

  const formattedOutput = new Intl.NumberFormat().format(baselineOutputTokens);
  const formattedReserve = new Intl.NumberFormat().format(OPENROUTER_FINAL_ANSWER_RESERVE_TOKENS);
  throw new Error(
    `OpenRouter Auto output limit ${formattedOutput} cannot reserve ${formattedReserve} tokens for the final answer with ${model.id}'s supported reasoning efforts. Increase the output limit or choose reasoning Off.`
  );
}

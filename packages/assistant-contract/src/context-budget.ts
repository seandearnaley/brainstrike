/**
 * Effective input-budget derivation for the agent loop and context meter.
 *
 * effectiveInputBudget = contextWindow − (maxOutputTokens ?? DEFAULT) − margin,
 * margin = max(MIN, ceil(RATIO × contextWindow)).
 *
 * Spec: docs/superpowers/specs/2026-06-09-token-usage-awareness-design.md §4.
 * Throws (never clamps) when the window cannot fit output + margin — a model
 * misconfiguration must surface loudly, not produce a nonsense budget.
 */

export const CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const CONTEXT_BUDGET_SAFETY_MARGIN_MIN = 1024;
export const CONTEXT_BUDGET_SAFETY_MARGIN_RATIO = 0.05;

/**
 * Conservative context-window declaration for runtime-discovered Ollama and
 * LM Studio models, whose local-server catalogs do not publish this value.
 * Large models are intentionally under-budgeted; small models rely on the
 * local server's own context cap as the final enforcement boundary.
 */
export const DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW = 32_768;

export function deriveEffectiveInputBudget(
  contextWindow: number,
  maxOutputTokens?: number
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`contextWindow must be a positive number, got ${contextWindow}`);
  }
  if (
    maxOutputTokens !== undefined &&
    (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0)
  ) {
    throw new Error(`maxOutputTokens must be a positive finite number, got ${maxOutputTokens}`);
  }
  const output = maxOutputTokens ?? CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS;
  const margin = Math.max(
    CONTEXT_BUDGET_SAFETY_MARGIN_MIN,
    Math.ceil(contextWindow * CONTEXT_BUDGET_SAFETY_MARGIN_RATIO)
  );
  const budget = contextWindow - output - margin;
  if (budget <= 0) {
    throw new Error(
      `contextWindow ${contextWindow} cannot fit maxOutputTokens ${output} plus safety margin ${margin}`
    );
  }
  return budget;
}

/**
 * The catalog facts the agent-loop input limit is derived from. Matches both
 * static registry rows and runtime-discovered local model definitions.
 */
export interface AgentLoopBudgetModelDefinition {
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
}

/**
 * THE derivation of `agentLoop.inputTokenLimit` when the user has not pinned
 * one — the ONE-DERIVATION invariant in docs/agents/assistant-persistence.md.
 * The renderer's `buildAgentLoopSettings` and desktop compaction's fallback
 * for a run carrying no `agentLoop` both call this; never re-derive it.
 *
 * OpenRouter reserves `requestMaxOutputTokens`: the output limit the run's
 * request actually sends, already resolved by the request path
 * (`buildEffectiveModelSettings` in the renderer, `buildModelSettingsOption`
 * on desktop — both size it for the run's reasoning state). There is NO
 * default here: one would be a second derivation of that window, so a
 * missing or malformed value throws. Every other provider reserves the
 * model's catalog maximum and ignores the argument. Throws rather than
 * clamping.
 */
export function deriveAgentLoopInputTokenLimit(
  model: AgentLoopBudgetModelDefinition,
  providerId: string | null | undefined,
  requestMaxOutputTokens: number | undefined
): number {
  if (providerId !== 'openrouter') {
    return deriveEffectiveInputBudget(model.contextWindow, model.maxOutputTokens);
  }
  if (
    !(
      typeof requestMaxOutputTokens === 'number' &&
      Number.isSafeInteger(requestMaxOutputTokens) &&
      requestMaxOutputTokens > 0
    )
  ) {
    throw new Error(
      `OpenRouter input budget requires the positive integer output limit the request sends, got ${requestMaxOutputTokens}`
    );
  }
  return deriveEffectiveInputBudget(model.contextWindow, requestMaxOutputTokens);
}

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

export function deriveEffectiveInputBudget(
  contextWindow: number,
  maxOutputTokens?: number
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`contextWindow must be a positive number, got ${contextWindow}`);
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

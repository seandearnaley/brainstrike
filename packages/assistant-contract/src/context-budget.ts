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
  if (
    maxOutputTokens !== undefined &&
    (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0)
  ) {
    throw new Error(`maxOutputTokens must be a positive finite number, got ${maxOutputTokens}`);
  }
  const output = maxOutputTokens ?? CONTEXT_BUDGET_DEFAULT_MAX_OUTPUT_TOKENS;
  const margin = contextBudgetSafetyMargin(contextWindow);
  const budget = contextWindow - output - margin;
  if (budget <= 0) {
    throw new Error(
      `contextWindow ${contextWindow} cannot fit maxOutputTokens ${output} plus safety margin ${margin}`
    );
  }
  return budget;
}

function contextBudgetSafetyMargin(contextWindow: number): number {
  return Math.max(
    CONTEXT_BUDGET_SAFETY_MARGIN_MIN,
    Math.ceil(contextWindow * CONTEXT_BUDGET_SAFETY_MARGIN_RATIO)
  );
}

/**
 * The largest `maxOutputTokens` that still leaves a positive input budget in
 * `contextWindow`: the bound an output control offers (BST-1810), from the
 * same margin rule as {@link deriveEffectiveInputBudget}, never a second
 * formula. Throws when the window cannot fit even one output token.
 */
export function deriveMaxOutputTokensWithinBudget(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`contextWindow must be a positive number, got ${contextWindow}`);
  }
  const maximum = contextWindow - contextBudgetSafetyMargin(contextWindow) - 1;
  if (maximum <= 0) {
    throw new Error(`contextWindow ${contextWindow} cannot fit any output plus its safety margin`);
  }
  return maximum;
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

/**
 * The compaction cap a run carries beside its input budget (BST-2526): a
 * thread compacts by this many tokens even when its budget is far larger.
 */
export const CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP = 200_000;

/** Share of the input budget a thread's request reaches before it compacts. */
const CONTEXT_COMPACTION_BUDGET_RATIO = 0.9;

/** Compaction reclaims toward 7/9 of its trigger: 70% of the budget when the ratio fires. */
const CONTEXT_COMPACTION_TARGET_RATIO = 7 / 9;

export interface ContextCompactionThreshold {
  /** The request size compaction reclaims toward. */
  readonly target: number;
  /** The request size at which a thread compacts. */
  readonly trigger: number;
}

/**
 * THE derivation of when a thread compacts — the ONE-DERIVATION invariant, as
 * for `deriveAgentLoopInputTokenLimit`: 90% of the run's input budget or its
 * compaction cap, whichever is less, reclaiming toward 7/9 of that. A run
 * that carries no cap is bounded by its budget alone. Host compaction calls
 * this; never re-derive it. Throws rather than clamping.
 */
export function deriveContextCompactionThreshold(
  inputTokenLimit: number,
  tokenCap: number | undefined
): ContextCompactionThreshold {
  if (!Number.isFinite(inputTokenLimit) || inputTokenLimit <= 0) {
    throw new Error(`inputTokenLimit must be a positive number, got ${inputTokenLimit}`);
  }
  if (tokenCap !== undefined && (!Number.isFinite(tokenCap) || tokenCap <= 0)) {
    throw new Error(`tokenCap must be a positive number, got ${tokenCap}`);
  }
  const ratio = CONTEXT_COMPACTION_BUDGET_RATIO * inputTokenLimit;
  const trigger = tokenCap === undefined ? ratio : Math.min(ratio, tokenCap);
  return { target: trigger * CONTEXT_COMPACTION_TARGET_RATIO, trigger };
}

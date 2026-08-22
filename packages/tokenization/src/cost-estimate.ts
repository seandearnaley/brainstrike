/**
 * Per-million-token pricing for a single model (USD). Mirrors the
 * `pricing` field on the static provider registry's LLM model definitions.
 * Omit / pass `undefined` for unknown pricing and local/keyless models with no
 * billing surface. Explicit zeroes are reserved for reviewed hosted routes that
 * current provider evidence identifies as free; unknown stays "cost unavailable."
 */
export interface ModelTokenPricing {
  /** USD per 1M prompt-cache READ tokens (Anthropic: 0.1× the input rate). */
  readonly cacheReadPerMTok?: number;
  /** USD per 1M prompt-cache WRITE tokens (Anthropic: 1.25× the input rate). */
  readonly cacheWritePerMTok?: number;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/** Token usage for a single billable unit (turn, run, or aggregate). */
export interface TokenUsageCounts {
  /**
   * Anthropic prompt-cache write tokens. When present, `inputTokens` is the
   * TOTAL the model saw and already includes every cache class.
   */
  readonly cacheCreationInputTokens?: number;
  /** Anthropic prompt-cache read tokens (same total-inclusive contract). */
  readonly cacheReadInputTokens?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * A cost estimate is a discriminated union, NOT a number: "no price available"
 * is a first-class state distinct from "$0.00", so the UI can render
 * "cost unavailable" instead of lying with a free price. `usdAmount` is only
 * present (and only `0` when the rates are genuinely zero) on the available
 * branch.
 */
export type CostEstimate =
  | {
      available: true;
      usdAmount: number;
      provenance: 'captured-usage-estimate' | 'exact-pricing' | 'provider-reported';
    }
  | { available: false; reason: 'unpriced_model' | 'usage_unavailable' };

/**
 * Build a TokenUsageCounts, attaching the cache token classes only when they
 * are positive (absent fields keep the pre-cache computeCost fast path and
 * exact-shape test pins intact).
 */
export function buildTokenUsageCounts(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens?: number,
  cacheCreationInputTokens?: number
): TokenUsageCounts {
  return {
    ...(cacheCreationInputTokens !== undefined && cacheCreationInputTokens > 0
      ? { cacheCreationInputTokens }
      : {}),
    ...(cacheReadInputTokens !== undefined && cacheReadInputTokens > 0
      ? { cacheReadInputTokens }
      : {}),
    inputTokens,
    outputTokens,
  };
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite, non-negative number (received ${value}).`);
  }
}

/**
 * Compute the USD cost of a single usage record against a model's pricing.
 *
 * - `usage === null` → `usage_unavailable` (usage was never captured; takes
 *   precedence over unpriced so the meter explains the more fundamental gap).
 * - `pricing === undefined` → `unpriced_model` (the model has no list price).
 * - Otherwise → exact cost: (inTok*inPerMTok + outTok*outPerMTok) / 1_000_000.
 *
 * Malformed inputs (negative or non-finite tokens/rates) THROW rather than
 * coerce — there is no silent fallback (see AGENTS.md).
 */
export function computeCost(
  usage: TokenUsageCounts | null,
  pricing: ModelTokenPricing | undefined
): CostEstimate {
  if (usage === null) {
    return { available: false, reason: 'usage_unavailable' };
  }
  if (pricing === undefined) {
    return { available: false, reason: 'unpriced_model' };
  }

  assertFiniteNonNegative(usage.inputTokens, 'inputTokens');
  assertFiniteNonNegative(usage.outputTokens, 'outputTokens');
  assertFiniteNonNegative(pricing.inputPerMTok, 'inputPerMTok');
  assertFiniteNonNegative(pricing.outputPerMTok, 'outputPerMTok');

  const cacheReadTokens = usage.cacheReadInputTokens ?? 0;
  const cacheWriteTokens = usage.cacheCreationInputTokens ?? 0;
  assertFiniteNonNegative(cacheReadTokens, 'cacheReadInputTokens');
  assertFiniteNonNegative(cacheWriteTokens, 'cacheCreationInputTokens');
  if (cacheReadTokens + cacheWriteTokens > usage.inputTokens) {
    throw new Error(
      `Cache token classes (${cacheReadTokens} read + ${cacheWriteTokens} write) exceed total inputTokens (${usage.inputTokens}).`
    );
  }
  if (cacheReadTokens > 0 && pricing.cacheReadPerMTok === undefined) {
    throw new Error(
      'Usage reports cache-read tokens but the model pricing has no cacheReadPerMTok rate.'
    );
  }
  if (cacheWriteTokens > 0 && pricing.cacheWritePerMTok === undefined) {
    throw new Error(
      'Usage reports cache-write tokens but the model pricing has no cacheWritePerMTok rate.'
    );
  }
  const cacheReadPerMTok = pricing.cacheReadPerMTok ?? 0;
  const cacheWritePerMTok = pricing.cacheWritePerMTok ?? 0;
  assertFiniteNonNegative(cacheReadPerMTok, 'cacheReadPerMTok');
  assertFiniteNonNegative(cacheWritePerMTok, 'cacheWritePerMTok');

  const uncachedInputTokens = usage.inputTokens - cacheReadTokens - cacheWriteTokens;
  const usdAmount =
    (uncachedInputTokens * pricing.inputPerMTok +
      cacheReadTokens * cacheReadPerMTok +
      cacheWriteTokens * cacheWritePerMTok +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000;

  return { available: true, provenance: 'exact-pricing', usdAmount };
}

/**
 * Format a USD amount for display. Uses enough fractional precision that a
 * real but sub-cent cost is never rounded to a misleading "$0.00" (only a
 * genuine 0 renders as $0.00). Non-finite amounts THROW — a NaN price must
 * never reach the UI.
 */
export function formatUsdCost(amount: number): string {
  if (!Number.isFinite(amount)) {
    throw new Error(`USD cost amount must be a finite number (received ${amount}).`);
  }
  // Standard 2-decimal currency for amounts ≥ $0.01 (or exactly 0); finer
  // precision (up to 6 fraction digits) below a cent so a real cost stays visible.
  const minimumFractionDigits = 2;
  const maximumFractionDigits = amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits,
    minimumFractionDigits,
    style: 'currency',
  }).format(amount);
}

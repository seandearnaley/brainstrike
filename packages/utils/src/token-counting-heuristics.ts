export function countTokensHeuristic(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function formatTokenCount(count: number): string {
  if (count < 1000) {
    return `${count} tokens`;
  }

  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}K tokens`;
  }

  return `${(count / 1_000_000).toFixed(1)}M tokens`;
}

/**
 * Per-million-token pricing for a single model (USD). Mirrors the
 * `pricing` field on the static provider registry's LLM model definitions.
 * Omit / pass `undefined` for models with unknown or keyless ($0) pricing —
 * unknown pricing must render "cost unavailable", never $0.
 */
export interface ModelTokenPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/** Token usage for a single billable unit (turn, run, or aggregate). */
export interface TokenUsageCounts {
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
  | { available: true; usdAmount: number; provenance: 'exact-pricing' }
  | { available: false; reason: 'unpriced_model' | 'usage_unavailable' };

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

  const usdAmount =
    (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) /
    1_000_000;

  return { available: true, usdAmount, provenance: 'exact-pricing' };
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
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(amount);
}

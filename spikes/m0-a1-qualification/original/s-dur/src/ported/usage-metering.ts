// PORTED VERBATIM from packages/agent/src/mastra/runtime-assembly/usage-metering.ts (readCacheTokenCount, readOpenRouterBilledCost and helpers).
/** Read a non-negative finite count or drop the field entirely. */
export function readCacheTokenCount(value: number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return;
}

/**
 * The subset of a Mastra stream part that can carry provider metadata. The
 * full stream-part shape (`MastraStreamPart` in `agent-runtime.ts`) is
 * structurally assignable to this.
 */
export interface ProviderMetadataStreamPart {
  payload?: {
    metadata?: { providerMetadata?: unknown };
  };
  providerMetadata?: unknown;
}

function readOpenRouterMetadata(
  part: ProviderMetadataStreamPart
): Record<string, unknown> | undefined {
  const providerMetadata = part.payload?.metadata?.providerMetadata ?? part.providerMetadata;
  if (providerMetadata === undefined) {
    return;
  }
  if (!providerMetadata || typeof providerMetadata !== 'object') {
    throw new Error('OpenRouter provider metadata must be an object.');
  }
  const openrouter = (providerMetadata as Record<string, unknown>)['openrouter'];
  if (openrouter === undefined) {
    return;
  }
  if (!openrouter || typeof openrouter !== 'object') {
    throw new Error('OpenRouter provider metadata must be an object.');
  }
  return openrouter as Record<string, unknown>;
}

/**
 * What a stream part says about the provider-reported billed cost.
 *
 * A THREE-WAY result, not a number-or-throw. `malformed` is a state the caller
 * must handle, which is stronger than an exception here, not weaker: an
 * exception thrown from inside the terminal accounting path destroyed the
 * completed turn, and a `try`/`catch` around it would have made the case
 * invisible. Representing it keeps the no-silent-fallback guarantee — nothing
 * is coerced, and the caller cannot ignore the variant by accident — while
 * leaving the decision about the RUN to the run.
 */
export type BilledCostReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'reported'; readonly usd: number };

const ABSENT_BILLED_COST: BilledCostReading = { kind: 'absent' };

/**
 * Extract OpenRouter's provider-reported billed cost from a stream part.
 *
 * ABSENT and MALFORMED are different facts and stay distinguishable: absent is
 * normal for anonymous/stealth routes that report no cost at all, malformed is
 * a broken provider contract someone should fix. Neither is coerced to a
 * number, and in particular neither becomes zero — a fabricated zero is the
 * undercount this whole path exists to avoid. A genuine `cost: 0` is
 * `reported`, because a measured zero is a real amount.
 */
export function readOpenRouterBilledCost(part: ProviderMetadataStreamPart): BilledCostReading {
  let openrouter: Record<string, unknown> | undefined;
  try {
    openrouter = readOpenRouterMetadata(part);
  } catch (error) {
    return { kind: 'malformed', reason: error instanceof Error ? error.message : String(error) };
  }
  const usage = openrouter?.['usage'];
  if (usage === undefined) {
    return ABSENT_BILLED_COST;
  }
  if (!usage || typeof usage !== 'object') {
    return { kind: 'malformed', reason: 'OpenRouter usage metadata must be an object.' };
  }
  const cost = (usage as Record<string, unknown>)['cost'];
  if (cost === undefined) {
    return ABSENT_BILLED_COST;
  }
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    return {
      kind: 'malformed',
      reason: 'OpenRouter billed cost must be a finite, non-negative number.',
    };
  }
  return { kind: 'reported', usd: cost };
}


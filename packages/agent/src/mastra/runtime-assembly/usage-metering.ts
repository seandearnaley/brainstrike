/**
 * Usage metering for the Mastra agent stream: provider-reported token usage,
 * Anthropic cache token classes, and the OpenRouter billed-cost contract.
 * Extracted from `agent-runtime.ts` (BST-742) — consumed by the finish-chunk
 * builder and the step-finish accumulation in `processMastraStreamPart`.
 */

/** Mastra's flattened usage shape as observed on stream parts. */
export interface UsageLike {
  /** Mastra's flattened Anthropic cache-write token count. */
  cacheCreationInputTokens?: number;
  /** Mastra's flattened Anthropic cache-read token count. */
  cachedInputTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
}

/** A Mastra stream part in the shapes that can carry usage. */
export interface UsageBearingStreamPart {
  payload?: { metadata?: { usage?: UsageLike }; output?: { usage?: UsageLike } };
  usage?: UsageLike;
}

function hasResolvableCounts(usage: UsageLike | undefined): boolean {
  if (!usage) {
    return false;
  }
  const prompt = usage.promptTokens ?? usage.inputTokens;
  const completion = usage.completionTokens ?? usage.outputTokens;
  return typeof prompt === 'number' || typeof completion === 'number';
}

/**
 * THE one place that knows where a Mastra stream part hides its usage.
 *
 * A real `step-finish`/`finish` nests it under `payload.output.usage` (or
 * `payload.metadata.usage`); only test fixtures put it top-level. Four readers
 * previously hand-rolled this chain with a comment as the only thing holding
 * the invariant — and BST-953's live-tick outage was exactly one of them
 * drifting (it read only `part.usage`, so every step event shipped
 * token-free). Route every new reader through here.
 *
 * Candidates are selected on RESOLVABLE COUNTS, not mere object presence: AI
 * SDK v5 can emit a top-level `usage` whose fields are all undefined while the
 * real numbers sit in `payload.output.usage`. Short-circuiting on presence
 * would yield a silent zero — the same failure class this helper exists to
 * prevent. Falls back to the first present candidate so a genuinely
 * all-undefined part still reports its (empty) usage rather than nothing.
 */
export function readStreamPartUsage(part: UsageBearingStreamPart): UsageLike | undefined {
  const candidates = [part.usage, part.payload?.output?.usage, part.payload?.metadata?.usage];
  return (
    candidates.find(hasResolvableCounts) ?? candidates.find((candidate) => candidate !== undefined)
  );
}

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

export interface OpenRouterDiagnostics {
  readonly provider?: string;
  readonly reasoningTokens?: number;
}

/**
 * Extract safe, bounded OpenRouter routing diagnostics for run-event metadata.
 * Reasoning content is deliberately excluded; only provider identity and token
 * counts are observable.
 *
 * NEVER THROWS — do not relitigate. This runs inside the streaming path and
 * feeds DISPLAY metadata: a provider label and a reasoning-token count on the
 * timeline. Throwing on a malformed field let a provider abort a completed turn
 * over decoration, which is the same bad trade that made `stealth/ox-alpha`
 * fail instantly on a missing billed cost — worse here, because that one at
 * least guarded accounting.
 *
 * A malformed field is DROPPED, not coerced, and dropping one does not discard
 * its well-formed siblings. Absent metadata is indistinguishable from dropped
 * metadata by design: the timeline simply omits a label it could not trust.
 *
 * The strictness that remains is in {@link readOpenRouterBilledCost}, where a
 * malformed value is a broken accounting contract rather than a cosmetic one.
 */
export function readOpenRouterDiagnostics(
  part: ProviderMetadataStreamPart
): OpenRouterDiagnostics | undefined {
  const openrouter = readOpenRouterMetadataSafely(part);
  if (!openrouter) {
    return;
  }
  const providerValue = openrouter['provider'];
  const provider =
    typeof providerValue === 'string' && providerValue.trim().length > 0
      ? providerValue.trim()
      : undefined;

  const usageValue = openrouter['usage'];
  const usage = usageValue && typeof usageValue === 'object' ? usageValue : undefined;
  const detailsValue = (usage as Record<string, unknown> | undefined)?.['completionTokensDetails'];
  const details = detailsValue && typeof detailsValue === 'object' ? detailsValue : undefined;
  const reasoningValue = (details as Record<string, unknown> | undefined)?.['reasoningTokens'];
  const reasoningTokens =
    typeof reasoningValue === 'number' && Number.isFinite(reasoningValue) && reasoningValue >= 0
      ? reasoningValue
      : undefined;

  if (provider === undefined && reasoningTokens === undefined) {
    return;
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/**
 * `readOpenRouterMetadata` for the diagnostics path, which must not throw.
 * Malformed provider metadata yields no diagnostics rather than aborting the
 * turn; the accounting path keeps the throwing reader.
 */
function readOpenRouterMetadataSafely(
  part: ProviderMetadataStreamPart
): Record<string, unknown> | undefined {
  try {
    return readOpenRouterMetadata(part);
  } catch {
    return;
  }
}

/**
 * The per-step usage accumulation slice of the stream's lifecycle state
 * (`ToolLifecycleState` satisfies this structurally).
 */
export interface UsageMeteringState {
  /** Completion usage from the latest provider step, not the billed run sum. */
  latestStepCompletionTokens?: number;
  /** Prompt usage from the latest provider step, not the billed run sum. */
  latestStepPromptTokens?: number;
  /**
   * Prompt tokens SUMMED across the leg's steps — spend, NOT context size
   * (that is `latestStepPromptTokens`). Aliases `steppedPromptTokens` on the
   * step path and Mastra's terminal usage (the same cross-step sum) at the
   * finish. The 2026-08-23 incident was this value read as one request's
   * size: a 10-step leg logged 733,954 and was investigated as a context
   * explosion that did not exist.
   */
  providerReportedPromptTokens?: number;
  steppedCompletionTokens: number;
  steppedPromptTokens: number;
}

/** Sum per-step usage (mirrors stepBilledCostUsd) for the steered finish. */
export function accumulateSteppedUsage(
  lifecycleState: UsageMeteringState,
  usage: UsageLike | undefined
): void {
  const prompt = usage?.promptTokens ?? usage?.inputTokens;
  const completion = usage?.completionTokens ?? usage?.outputTokens;
  if (typeof prompt === 'number' && Number.isFinite(prompt)) {
    lifecycleState.steppedPromptTokens += prompt;
    lifecycleState.providerReportedPromptTokens = lifecycleState.steppedPromptTokens;
    lifecycleState.latestStepPromptTokens = prompt;
  }
  if (typeof completion === 'number' && Number.isFinite(completion)) {
    lifecycleState.steppedCompletionTokens += completion;
    lifecycleState.latestStepCompletionTokens = completion;
  }
}

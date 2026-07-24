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

/**
 * Extract OpenRouter's provider-reported billed cost from a stream part.
 * Strict by contract: present-but-malformed metadata THROWS (a silently
 * dropped cost would undercount the provider bill — no-silent-fallbacks);
 * absent metadata simply returns undefined.
 */
export function readOpenRouterBilledCost(part: ProviderMetadataStreamPart): number | undefined {
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
  const usage = (openrouter as Record<string, unknown>)['usage'];
  if (usage === undefined) {
    return;
  }
  if (!usage || typeof usage !== 'object') {
    throw new Error('OpenRouter usage metadata must be an object.');
  }
  const cost = (usage as Record<string, unknown>)['cost'];
  if (cost === undefined) {
    return;
  }
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    throw new Error('OpenRouter billed cost must be a finite, non-negative number.');
  }
  return cost;
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
  /** Actual provider/Mastra prompt usage, absent when the stream never reported it. */
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

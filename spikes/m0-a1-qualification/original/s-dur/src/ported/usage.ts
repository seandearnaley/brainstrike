// P-C: AI SDK v7 LanguageModelUsage -> Brainstrike's usage model.
// Mirrors packages/agent/src/mastra/tool-lifecycle-processors.ts makeFinishChunk (promptTokens = total input incl. cache
// classes; cache classes only when includeCacheTokenClasses, which turn-attempts.ts:473 sets to provider === 'anthropic')
// and usage-metering.ts accumulateSteppedUsage (per-step sums) + readOpenRouterBilledCost (billed cost per step).
import type { LanguageModelUsage } from 'ai';
import type { BrainstrikeStepUsage } from '../events.js';
import { buildTokenUsageCounts, type TokenUsageCounts } from './cost-estimate.js';
import { readCacheTokenCount, readOpenRouterBilledCost } from './usage-metering.js';

const finite = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

export function mapStepUsage(provider: string, usage: LanguageModelUsage, providerMetadata?: unknown): BrainstrikeStepUsage {
  const includeCacheTokenClasses = provider === 'anthropic';
  const cacheReadInputTokens = includeCacheTokenClasses ? readCacheTokenCount(usage.inputTokenDetails?.cacheReadTokens) : undefined;
  const cacheCreationInputTokens = includeCacheTokenClasses ? readCacheTokenCount(usage.inputTokenDetails?.cacheWriteTokens) : undefined;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
  return {
    promptTokens: finite(usage.inputTokens),
    completionTokens: finite(usage.outputTokens),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
    billedCost: readOpenRouterBilledCost({ providerMetadata }),
  };
}

/** Run total for the cost panel (Brainstrike sums per step: accumulateSteppedUsage). */
export function runTokenUsage(steps: BrainstrikeStepUsage[]): TokenUsageCounts {
  const sum = (k: keyof BrainstrikeStepUsage) => steps.reduce((a, s) => a + ((s[k] as number | undefined) ?? 0), 0);
  return buildTokenUsageCounts(sum('promptTokens'), sum('completionTokens'), sum('cacheReadInputTokens'), sum('cacheCreationInputTokens'));
}

/** The naive port (reads Mastra's old flattened field names off an AI SDK v7 usage object) — the regression P-C guards. */
export function naiveMastraFieldMapping(usage: LanguageModelUsage): TokenUsageCounts {
  const u = usage as unknown as { cachedInputTokens?: number; cacheCreationInputTokens?: number };
  return buildTokenUsageCounts(finite(usage.inputTokens), finite(usage.outputTokens), u.cachedInputTokens, u.cacheCreationInputTokens);
}

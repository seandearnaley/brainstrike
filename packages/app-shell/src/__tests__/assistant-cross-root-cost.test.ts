import { describe, expect, it } from 'vitest';
import { resolveCrossRootCostRows } from '../assistant-cross-root-cost';
import type { CrossRootUsageRow } from '../assistant-memory-repository';

const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'openai:gpt-5.2': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'anthropic:claude-opus-4-8': { inputPerMTok: 15, outputPerMTok: 120 },
};

function resolvePricing(provider: string, model: string) {
  return PRICING[`${provider}:${model}`];
}

describe('resolveCrossRootCostRows', () => {
  it('returns an empty list when there is no usage', () => {
    expect(resolveCrossRootCostRows([], resolvePricing)).toEqual([]);
  });

  it('groups per root, prices each model with its own rate, and sums per root', () => {
    const rows: CrossRootUsageRow[] = [
      // root-a mixes two models — each priced with its own rate, then summed.
      // The display name rides on the row (from the aggregation's roots JOIN).
      {
        rootId: 'root-a',
        rootDisplayName: 'project-alpha',
        provider: 'openai',
        model: 'gpt-5.2',
        inputTokens: 1000,
        outputTokens: 200,
      },
      {
        rootId: 'root-a',
        rootDisplayName: 'project-alpha',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        inputTokens: 500,
        outputTokens: 100,
      },
    ];

    const result = resolveCrossRootCostRows(rows, resolvePricing);
    expect(result).toHaveLength(1);
    const [rootA] = result;
    expect(rootA?.rootId).toBe('root-a');
    expect(rootA?.displayName).toBe('project-alpha');
    expect(rootA?.totalTokens).toBe(1800);
    expect(rootA?.cost.available).toBe(true);
    if (rootA?.cost.available) {
      // openai: (1000*1.25 + 200*10)/1e6 = 0.00325
      // anthropic: (500*15 + 100*120)/1e6 = 0.0195
      expect(rootA.cost.usdAmount).toBeCloseTo(0.022_75, 8);
    }
  });

  it('reports cost unavailable (never $0) for a root whose model has no pricing', () => {
    const rows: CrossRootUsageRow[] = [
      {
        rootId: 'root-a',
        rootDisplayName: 'project-alpha',
        provider: 'openai',
        model: 'gpt-5.2',
        inputTokens: 100,
        outputTokens: 50,
      },
      // unpriced model in the SAME root makes that root's whole cost unavailable.
      {
        rootId: 'root-a',
        rootDisplayName: 'project-alpha',
        provider: 'local',
        model: 'gemma',
        inputTokens: 200,
        outputTokens: 75,
      },
    ];

    const result = resolveCrossRootCostRows(rows, resolvePricing);
    expect(result).toHaveLength(1);
    expect(result[0]?.totalTokens).toBe(425);
    expect(result[0]?.cost).toEqual({ available: false, reason: 'unpriced_model' });
  });

  it('renders the unattributed (null) root with a stable label and a truncated id fallback for join misses', () => {
    const rows: CrossRootUsageRow[] = [
      {
        rootId: null,
        rootDisplayName: null,
        provider: 'openai',
        model: 'gpt-5.2',
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        // Join miss (e.g. legacy path-remapped id): no display name on the row.
        rootId: 'unknown-root-id-1234567890',
        rootDisplayName: null,
        provider: 'openai',
        model: 'gpt-5.2',
        inputTokens: 20,
        outputTokens: 10,
      },
    ];

    const result = resolveCrossRootCostRows(rows, resolvePricing);
    const unattributed = result.find((row) => row.rootId === null);
    const unknown = result.find((row) => row.rootId === 'unknown-root-id-1234567890');

    // Null root → an explicit "Unattributed" label, never a fabricated root.
    expect(unattributed?.displayName).toBe('Unattributed');
    // Join-miss root → a short id fallback, never a wrong name.
    expect(unknown?.displayName).toContain('unknown-');
    expect(unknown?.displayName).not.toBe('Unattributed');
  });
});

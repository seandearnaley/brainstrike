// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveCrossRootCostRows } from '../assistant-cross-root-cost';
import type { CrossRootUsageRow } from '../assistant-memory-repository';

describe('resolveCrossRootCostRows', () => {
  it('returns an empty list when there is no usage', () => {
    expect(resolveCrossRootCostRows([])).toEqual([]);
  });

  it('groups per root, and sums each model’s cost per root', () => {
    const rows: CrossRootUsageRow[] = [
      // root-a mixes two models — each already priced call by call, then summed.
      // The display name rides on the row (from the aggregation's roots JOIN).
      {
        estimatedCostUsd: 0.003_25,
        inputTokens: 1000,
        model: 'gpt-5.2',
        outputTokens: 200,
        provider: 'openai',
        rootDisplayName: 'project-alpha',
        rootId: 'root-a',
      },
      {
        estimatedCostUsd: 0.0195,
        inputTokens: 500,
        model: 'claude-opus-4-8',
        outputTokens: 100,
        provider: 'anthropic',
        rootDisplayName: 'project-alpha',
        rootId: 'root-a',
      },
    ];

    const result = resolveCrossRootCostRows(rows);
    expect(result).toHaveLength(1);
    const [rootA] = result;
    expect(rootA?.rootId).toBe('root-a');
    expect(rootA?.displayName).toBe('project-alpha');
    expect(rootA?.totalTokens).toBe(1800);
    expect(rootA?.cost.available).toBe(true);
    if (rootA?.cost.available) {
      expect(rootA.cost.usdAmount).toBeCloseTo(0.022_75, 8);
      expect(rootA.cost.provenance).toBe('captured-usage-estimate');
    }
  });

  it('reports cost unavailable (never $0) for a root whose model has no pricing', () => {
    const rows: CrossRootUsageRow[] = [
      {
        estimatedCostUsd: 0.0003,
        inputTokens: 100,
        model: 'gpt-5.2',
        outputTokens: 50,
        provider: 'openai',
        rootDisplayName: 'project-alpha',
        rootId: 'root-a',
      },
      // unpriced model in the SAME root makes that root's whole cost unavailable.
      {
        estimatedCostUsd: null,
        inputTokens: 200,
        model: 'some-vendor/unregistered-model',
        outputTokens: 75,
        provider: 'openrouter',
        rootDisplayName: 'project-alpha',
        rootId: 'root-a',
      },
    ];

    const result = resolveCrossRootCostRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.totalTokens).toBe(425);
    expect(result[0]?.cost).toEqual({ available: false, reason: 'unpriced_model' });
  });

  it('uses exact OpenRouter cost even when a model has no static price', () => {
    const rows: CrossRootUsageRow[] = [
      {
        billedCostUsd: 0.0065,
        estimatedCostUsd: null,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        inputTokens: 5000,
        model: 'new-model-not-yet-priced',
        outputTokens: 900,
        provider: 'openrouter',
        rootDisplayName: 'project-alpha',
        rootId: 'root-a',
      },
    ];

    expect(resolveCrossRootCostRows(rows)[0]?.cost).toEqual({
      available: true,
      provenance: 'provider-reported',
      usdAmount: 0.0065,
    });
  });

  it('renders the unattributed (null) root with a stable label and a truncated id fallback for join misses', () => {
    const rows: CrossRootUsageRow[] = [
      {
        estimatedCostUsd: 0,
        inputTokens: 10,
        model: 'gpt-5.2',
        outputTokens: 5,
        provider: 'openai',
        rootDisplayName: null,
        rootId: null,
      },
      {
        estimatedCostUsd: 0,
        inputTokens: 20,
        model: 'gpt-5.2',
        outputTokens: 10,
        provider: 'openai',
        rootDisplayName: null,
        // Join miss (e.g. legacy path-remapped id): no display name on the row.
        rootId: 'unknown-root-id-1234567890',
      },
    ];

    const result = resolveCrossRootCostRows(rows);
    const unattributed = result.find((row) => row.rootId === null);
    const unknown = result.find((row) => row.rootId === 'unknown-root-id-1234567890');

    // Null root → an explicit "Unattributed" label, never a fabricated root.
    expect(unattributed?.displayName).toBe('Unattributed');
    // Join-miss root → a short id fallback, never a wrong name.
    expect(unknown?.displayName).toContain('unknown-');
    expect(unknown?.displayName).not.toBe('Unattributed');
  });
});

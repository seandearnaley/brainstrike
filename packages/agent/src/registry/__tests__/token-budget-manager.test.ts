import { describe, expect, it } from 'vitest';
import { TokenBudgetManager } from '../token-budget-manager';
import type { UnifiedToolMetadata } from '../unified-registry';

const createTool = (overrides: Partial<UnifiedToolMetadata>): UnifiedToolMetadata => ({
  id: `tool.${overrides.id ?? 'test'}`,
  source: 'native',
  category: 'analysis',
  loadingTier: 'conditional',
  description: 'Test tool',
  enabled: true,
  discoveredAt: Date.now(),
  estimatedTokens: 10,
  requiresApproval: false,
  ...overrides,
});

describe('TokenBudgetManager', () => {
  it('rejects negative allocation values', () => {
    expect(
      () =>
        new TokenBudgetManager({
          contextWindowTokens: 1000,
          allocation: { conditionalTools: -0.1 },
        })
    ).toThrow(/must be positive/);
  });

  it('rejects allocations that do not sum to ~1.0', () => {
    expect(
      () =>
        new TokenBudgetManager({
          contextWindowTokens: 1000,
          allocation: { conditionalTools: 0.5 },
        })
    ).toThrow(/must sum to 1.0/);
  });

  it('selects tools within the available budget', () => {
    const manager = new TokenBudgetManager({ contextWindowTokens: 100 });
    const tools: UnifiedToolMetadata[] = [
      createTool({ id: 'critical-1', loadingTier: 'critical', estimatedTokens: 10 }),
      createTool({ id: 'critical-2', loadingTier: 'critical', estimatedTokens: 20 }),
      createTool({ id: 'conditional-1', loadingTier: 'conditional', estimatedTokens: 5 }),
      createTool({ id: 'conditional-2', loadingTier: 'conditional', estimatedTokens: 30 }),
    ];

    const critical = manager.selectCriticalTools(tools);
    expect(critical.tokensUsed).toBeLessThanOrEqual(manager.getCriticalToolsBudget());

    const conditional = manager.selectConditionalTools(tools, critical.tokensUsed);
    expect(conditional.tokensUsed).toBeLessThanOrEqual(manager.getConditionalToolsBudget());
  });
});

import { describe, expect, it } from 'vitest';
import { TokenBudgetManager } from '../token-budget-manager';
import type { UnifiedToolMetadata } from '../unified-registry';

const createTool = (overrides: Partial<UnifiedToolMetadata>): UnifiedToolMetadata => ({
  category: 'analysis',
  description: 'Test tool',
  discoveredAt: Date.now(),
  enabled: true,
  estimatedTokens: 10,
  id: `tool.${overrides.id ?? 'test'}`,
  loadingTier: 'conditional',
  requiresApproval: false,
  source: 'native',
  ...overrides,
});

describe('TokenBudgetManager', () => {
  it('rejects negative allocation values', () => {
    expect(
      () =>
        new TokenBudgetManager({
          allocation: { conditionalTools: -0.1 },
          contextWindowTokens: 1000,
        })
    ).toThrow(/must be positive/);
  });

  it('rejects allocations that do not sum to ~1.0', () => {
    expect(
      () =>
        new TokenBudgetManager({
          allocation: { conditionalTools: 0.5 },
          contextWindowTokens: 1000,
        })
    ).toThrow(/must sum to 1.0/);
  });

  it('selects tools within the available budget', () => {
    const manager = new TokenBudgetManager({ contextWindowTokens: 100 });
    const tools: UnifiedToolMetadata[] = [
      createTool({ estimatedTokens: 10, id: 'critical-1', loadingTier: 'critical' }),
      createTool({ estimatedTokens: 20, id: 'critical-2', loadingTier: 'critical' }),
      createTool({ estimatedTokens: 5, id: 'conditional-1', loadingTier: 'conditional' }),
      createTool({ estimatedTokens: 30, id: 'conditional-2', loadingTier: 'conditional' }),
    ];

    const critical = manager.selectCriticalTools(tools);
    expect(critical.tokensUsed).toBeLessThanOrEqual(manager.getCriticalToolsBudget());

    const conditional = manager.selectConditionalTools(tools, critical.tokensUsed);
    expect(conditional.tokensUsed).toBeLessThanOrEqual(manager.getConditionalToolsBudget());
  });
});

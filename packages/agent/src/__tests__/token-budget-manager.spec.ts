import { beforeEach, describe, expect, it } from 'vitest';
import {
  COMMON_CONTEXT_WINDOWS,
  createBudgetManagerForTier,
  createTokenBudgetManager,
  DEFAULT_BUDGET_ALLOCATION,
  TokenBudgetManager,
} from '../registry/token-budget-manager';
import type { UnifiedToolMetadata } from '../registry/unified-registry';

/**
 * Helper to create mock tool metadata.
 */
function createMockTool(
  id: string,
  options: Partial<UnifiedToolMetadata> = {}
): UnifiedToolMetadata {
  return {
    category: 'retrieval',
    description: `Mock tool ${id}`,
    discoveredAt: Date.now(),
    enabled: true,
    estimatedTokens: 100,
    id,
    loadingTier: 'conditional',
    requiresApproval: false,
    source: 'native',
    ...options,
  };
}

describe('TokenBudgetManager', () => {
  const CONTEXT_WINDOW = 16_000; // 16K tokens
  let manager: TokenBudgetManager;

  beforeEach(() => {
    manager = createTokenBudgetManager(CONTEXT_WINDOW);
  });

  describe('constructor', () => {
    it('creates manager with default allocation', () => {
      expect(manager).toBeInstanceOf(TokenBudgetManager);
    });

    it('throws if budget allocation does not sum to 1.0', () => {
      expect(() => {
        new TokenBudgetManager({
          allocation: {
            conditionalTools: 0.5,
            contextResults: 0.5, // Sum = 2.5
            criticalTools: 0.5,
            responseBuffer: 0.5,
            systemPrompt: 0.5,
          },
          contextWindowTokens: 16_000,
        });
      }).toThrow('Budget allocation must sum to 1.0');
    });

    it('accepts custom allocation that sums to 1.0', () => {
      const customManager = new TokenBudgetManager({
        allocation: {
          conditionalTools: 0.3,
          contextResults: 0.25,
          criticalTools: 0.1,
          responseBuffer: 0.15,
          systemPrompt: 0.2,
        },
        contextWindowTokens: 16_000,
      });
      expect(customManager).toBeInstanceOf(TokenBudgetManager);
    });
  });

  describe('budget calculations', () => {
    it('getCriticalToolsBudget returns correct allocation', () => {
      const budget = manager.getCriticalToolsBudget();
      expect(budget).toBe(Math.floor(CONTEXT_WINDOW * DEFAULT_BUDGET_ALLOCATION.criticalTools));
    });

    it('getConditionalToolsBudget returns correct allocation', () => {
      const budget = manager.getConditionalToolsBudget();
      expect(budget).toBe(Math.floor(CONTEXT_WINDOW * DEFAULT_BUDGET_ALLOCATION.conditionalTools));
    });

    it('getContextResultsBudget returns correct allocation', () => {
      const budget = manager.getContextResultsBudget();
      expect(budget).toBe(Math.floor(CONTEXT_WINDOW * DEFAULT_BUDGET_ALLOCATION.contextResults));
    });
  });

  describe('selectToolsWithinBudget', () => {
    it('selects tools that fit within budget', () => {
      const tools = [
        createMockTool('tool1', { estimatedTokens: 100 }),
        createMockTool('tool2', { estimatedTokens: 150 }),
        createMockTool('tool3', { estimatedTokens: 200 }),
      ];

      const result = manager.selectToolsWithinBudget(tools, 300);

      expect(result.selectedTools).toHaveLength(2);
      expect(result.tokensUsed).toBe(250); // 100 + 150
      expect(result.skippedTools).toHaveLength(1);
      expect(result.tokensRemaining).toBe(50);
    });

    it('skips disabled tools', () => {
      const tools = [
        createMockTool('tool1', { enabled: true, estimatedTokens: 100 }),
        createMockTool('tool2', { enabled: false, estimatedTokens: 100 }),
        createMockTool('tool3', { enabled: true, estimatedTokens: 100 }),
      ];

      const result = manager.selectToolsWithinBudget(tools, 500);

      expect(result.selectedTools).toHaveLength(2);
      expect(result.tokensUsed).toBe(200);
    });

    it('prioritizes by category order', () => {
      const tools = [
        createMockTool('action.tool', { category: 'action', estimatedTokens: 100 }),
        createMockTool('retrieval.tool', { category: 'retrieval', estimatedTokens: 100 }),
        createMockTool('analysis.tool', { category: 'analysis', estimatedTokens: 100 }),
      ];

      const result = manager.selectToolsWithinBudget(tools, 150, {
        categoryOrder: ['retrieval', 'analysis', 'action', 'configuration', 'validation'],
        preferSmaller: false,
      });

      // Should select retrieval first (highest priority), fits in budget
      expect(result.selectedTools[0]?.id).toBe('retrieval.tool');
    });

    it('prefers smaller tools when configured', () => {
      const tools = [
        createMockTool('large.tool', { category: 'action', estimatedTokens: 300 }),
        createMockTool('small.tool', { category: 'action', estimatedTokens: 100 }),
      ];

      const result = manager.selectToolsWithinBudget(tools, 200, {
        categoryOrder: ['action', 'retrieval', 'analysis', 'configuration', 'validation'],
        preferSmaller: true,
      });

      expect(result.selectedTools).toHaveLength(1);
      expect(result.selectedTools[0]?.id).toBe('small.tool');
      expect(result.tokensUsed).toBe(100);
    });

    it('handles empty tool list', () => {
      const result = manager.selectToolsWithinBudget([], 1000);

      expect(result.selectedTools).toHaveLength(0);
      expect(result.tokensUsed).toBe(0);
      expect(result.tokensRemaining).toBe(1000);
    });

    it('handles zero budget', () => {
      const tools = [createMockTool('tool1', { estimatedTokens: 100 })];
      const result = manager.selectToolsWithinBudget(tools, 0);

      expect(result.selectedTools).toHaveLength(0);
      expect(result.skippedTools).toHaveLength(1);
    });
  });

  describe('selectCriticalTools', () => {
    it('selects only critical tier tools', () => {
      const tools = [
        createMockTool('critical1', { estimatedTokens: 100, loadingTier: 'critical' }),
        createMockTool('conditional1', { estimatedTokens: 100, loadingTier: 'conditional' }),
        createMockTool('critical2', { estimatedTokens: 100, loadingTier: 'critical' }),
      ];

      const result = manager.selectCriticalTools(tools);

      expect(result.selectedTools).toHaveLength(2);
      expect(result.selectedTools.every((t) => t.loadingTier === 'critical')).toBe(true);
    });
  });

  describe('selectConditionalTools', () => {
    it('reduces budget when critical tools overflow', () => {
      const tools = [
        createMockTool('cond1', { estimatedTokens: 100, loadingTier: 'conditional' }),
        createMockTool('cond2', { estimatedTokens: 100, loadingTier: 'conditional' }),
      ];

      const criticalBudget = manager.getCriticalToolsBudget();
      const conditionalBudget = manager.getConditionalToolsBudget();

      // Simulate critical tools using more than their budget
      const criticalOverflow = 500;
      const result = manager.selectConditionalTools(tools, criticalBudget + criticalOverflow);

      // Budget should be reduced by overflow amount
      expect(result.budgetAvailable).toBe(Math.max(0, conditionalBudget - criticalOverflow));
    });
  });

  describe('selectAllTools', () => {
    it('performs full three-tier selection', () => {
      const tools = [
        createMockTool('c1', { estimatedTokens: 100, loadingTier: 'critical' }),
        createMockTool('c2', { estimatedTokens: 100, loadingTier: 'critical' }),
        createMockTool('co1', { estimatedTokens: 100, loadingTier: 'conditional' }),
        createMockTool('co2', { estimatedTokens: 100, loadingTier: 'conditional' }),
        createMockTool('d1', { estimatedTokens: 100, loadingTier: 'deferred' }),
      ];

      const result = manager.selectAllTools(tools);

      expect(result.critical.selectedTools.length).toBeGreaterThan(0);
      expect(result.deferred).toHaveLength(1);
      expect(result.totalTokensUsed).toBe(
        result.critical.tokensUsed + result.conditional.tokensUsed
      );
    });
  });

  describe('getUtilizationReport', () => {
    it('returns correct utilization report', () => {
      const criticalUsed = 1000;
      const conditionalUsed = 2000;

      const report = manager.getUtilizationReport(criticalUsed, conditionalUsed);

      expect(report.contextWindowTokens).toBe(CONTEXT_WINDOW);
      expect(report.usedTokens.criticalTools).toBe(criticalUsed);
      expect(report.usedTokens.conditionalTools).toBe(conditionalUsed);
      expect(report.utilizationPercent).toBeGreaterThan(0);
    });

    it('calculates remaining context correctly', () => {
      const report = manager.getUtilizationReport(0, 0);

      // When no tools used, remaining should include all tool budget plus context budget
      const toolBudget =
        report.allocatedTokens.criticalTools + report.allocatedTokens.conditionalTools;
      const contextBudget = report.allocatedTokens.contextResults;

      expect(report.remainingForContext).toBe(toolBudget + contextBudget);
    });
  });

  describe('estimateToolTokens', () => {
    it('estimates tokens from description and schema', () => {
      const tool = {
        description: 'A test tool for searching',
        inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
      };

      const estimate = manager.estimateToolTokens(tool);

      expect(estimate).toBeGreaterThan(0);
    });

    it('handles tool without schema', () => {
      const tool = {
        description: 'Simple tool',
      };

      const estimate = manager.estimateToolTokens(tool);

      expect(estimate).toBeGreaterThan(0);
    });
  });

  describe('wouldExceedBudget', () => {
    it('returns true when adding tool would exceed budget', () => {
      expect(manager.wouldExceedBudget(900, 150, 1000)).toBe(true);
    });

    it('returns false when adding tool fits in budget', () => {
      expect(manager.wouldExceedBudget(800, 100, 1000)).toBe(false);
    });

    it('returns false when exactly at budget', () => {
      expect(manager.wouldExceedBudget(800, 200, 1000)).toBe(false);
    });
  });
});

describe('createBudgetManagerForTier', () => {
  it('creates manager for large tier (128K)', () => {
    const manager = createBudgetManagerForTier('large');
    expect(manager.getCriticalToolsBudget()).toBe(
      Math.floor(COMMON_CONTEXT_WINDOWS.large * DEFAULT_BUDGET_ALLOCATION.criticalTools)
    );
  });

  it('creates manager for medium tier (32K)', () => {
    const manager = createBudgetManagerForTier('medium');
    expect(manager.getCriticalToolsBudget()).toBe(
      Math.floor(COMMON_CONTEXT_WINDOWS.medium * DEFAULT_BUDGET_ALLOCATION.criticalTools)
    );
  });

  it('creates manager for small tier (16K)', () => {
    const manager = createBudgetManagerForTier('small');
    expect(manager.getCriticalToolsBudget()).toBe(
      Math.floor(COMMON_CONTEXT_WINDOWS.small * DEFAULT_BUDGET_ALLOCATION.criticalTools)
    );
  });

  it('creates manager for minimal tier (8K)', () => {
    const manager = createBudgetManagerForTier('minimal');
    expect(manager.getCriticalToolsBudget()).toBe(
      Math.floor(COMMON_CONTEXT_WINDOWS.minimal * DEFAULT_BUDGET_ALLOCATION.criticalTools)
    );
  });
});

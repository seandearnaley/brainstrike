/**
 * Tool Loader Tests
 *
 * Tests three-tier tool loading with budget awareness.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createTokenBudgetManager } from '../registry/token-budget-manager';
import { createToolLoader, loadToolsForAgent, ToolLoader } from '../registry/tool-loader';
import { createUnifiedToolRegistry, type UnifiedToolRegistry } from '../registry/unified-registry';

describe('ToolLoader', () => {
  let registry: UnifiedToolRegistry;

  beforeEach(() => {
    registry = createUnifiedToolRegistry();

    // Register test tools across all tiers
    registry.registerNativeTools([
      {
        category: 'retrieval',
        description: 'Critical tool 1',
        estimatedTokens: 100,
        id: 'critical.tool1',
        loadingTier: 'critical',
      },
      {
        category: 'retrieval',
        description: 'Critical tool 2',
        estimatedTokens: 150,
        id: 'critical.tool2',
        loadingTier: 'critical',
      },
      {
        category: 'action',
        description: 'Conditional tool 1',
        estimatedTokens: 200,
        id: 'conditional.tool1',
        loadingTier: 'conditional',
      },
      {
        category: 'analysis',
        description: 'Conditional tool 2',
        estimatedTokens: 250,
        id: 'conditional.tool2',
        loadingTier: 'conditional',
      },
      {
        category: 'action',
        description: 'Deferred tool 1',
        estimatedTokens: 300,
        id: 'deferred.tool1',
        loadingTier: 'deferred',
        requiresApproval: true,
      },
      {
        category: 'configuration',
        description: 'Deferred tool 2',
        estimatedTokens: 100,
        id: 'deferred.tool2',
        loadingTier: 'deferred',
      },
    ]);
  });

  describe('createToolLoader', () => {
    it('creates a tool loader instance', () => {
      const loader = createToolLoader(registry);
      expect(loader).toBeInstanceOf(ToolLoader);
    });
  });

  describe('loadTools', () => {
    it('loads all enabled tools by tier without budget manager', () => {
      const loader = createToolLoader(registry);
      const result = loader.loadTools();

      expect(result.loadedTools).toHaveLength(4); // 2 critical + 2 conditional
      expect(result.deferredTools).toHaveLength(2);
      expect(result.budgetSkippedTools).toHaveLength(0);
    });

    it('loads only critical tools when specified', () => {
      const loader = createToolLoader(registry);
      const result = loader.loadTools({ loadTiers: ['critical'] });

      expect(result.loadedTools).toHaveLength(2);
      expect(result.loadedTools.every((t) => t.loadingTier === 'critical')).toBe(true);
    });

    it('loads deferred tools when specified', () => {
      const loader = createToolLoader(registry);
      const result = loader.loadTools({ loadTiers: ['deferred'] });

      expect(result.loadedTools).toHaveLength(2);
      expect(result.loadedTools.every((t) => t.loadingTier === 'deferred')).toBe(true);
      expect(result.tokensUsed).toBe(400);
    });

    it('respects token budget for conditional tools', () => {
      // Use a 2000 token context window with default allocation:
      // - Critical tools: 15% = 300 tokens (can fit 100+150=250)
      // - Conditional tools: 35% = 700 tokens (can fit 200+250=450)
      const budgetManager = createTokenBudgetManager(2000);

      const loader = createToolLoader(registry, budgetManager);
      const result = loader.loadTools();

      // Should load critical tools (250 tokens fits in 300 token budget)
      expect(result.loadedTools.filter((t) => t.loadingTier === 'critical')).toHaveLength(2);

      // Conditional tools should also load (450 tokens fits in 700 token budget)
      const conditionalLoaded = result.loadedTools.filter((t) => t.loadingTier === 'conditional');
      expect(conditionalLoaded.length).toBe(2);
    });

    it('filters by source', () => {
      // Add MCP tool
      registry.registerMcpTools({
        serverName: 'test-server',
        tools: {
          'mcp.tool1': { description: 'MCP tool' },
        },
      });

      const loader = createToolLoader(registry);
      const nativeResult = loader.loadTools({ source: 'native' });
      const mcpResult = loader.loadTools({ source: 'mcp' });

      expect(nativeResult.loadedTools.every((t) => t.source === 'native')).toBe(true);
      expect(mcpResult.loadedTools.every((t) => t.source === 'mcp')).toBe(true);
    });

    it('filters by tool IDs', () => {
      const loader = createToolLoader(registry);
      const result = loader.loadTools({ toolIds: ['critical.tool1', 'conditional.tool1'] });

      expect(result.loadedTools).toHaveLength(2);
      expect(result.loadedTools.map((t) => t.id).sort()).toEqual([
        'conditional.tool1',
        'critical.tool1',
      ]);
    });

    it('excludes specified tool IDs', () => {
      const loader = createToolLoader(registry);
      const result = loader.loadTools({ excludeToolIds: ['critical.tool1'] });

      expect(result.loadedTools.find((t) => t.id === 'critical.tool1')).toBeUndefined();
    });

    it('tracks loaded tool IDs', () => {
      const loader = createToolLoader(registry);
      loader.loadTools({ loadTiers: ['critical'] });

      expect(loader.isToolLoaded('critical.tool1')).toBe(true);
      expect(loader.isToolLoaded('critical.tool2')).toBe(true);
      expect(loader.isToolLoaded('conditional.tool1')).toBe(false);
    });
  });

  describe('loadOnDemand', () => {
    it('loads specific deferred tools', () => {
      const loader = createToolLoader(registry);
      const result = loader.loadOnDemand({ toolIds: ['deferred.tool1'] });

      expect(result.loaded).toHaveLength(1);
      expect(result.loaded[0].id).toBe('deferred.tool1');
      expect(result.notFound).toHaveLength(0);
    });

    it('reports not found for unknown tools', () => {
      const loader = createToolLoader(registry);
      const result = loader.loadOnDemand({
        toolIds: ['deferred.tool1', 'unknown.tool'],
      });

      expect(result.loaded).toHaveLength(1);
      expect(result.notFound).toContain('unknown.tool');
    });

    it('respects max tokens limit', () => {
      const loader = createToolLoader(registry);
      const result = loader.loadOnDemand({
        maxTokens: 150, // Only fits tool2 (100 tokens), not tool1 (300 tokens)
        toolIds: ['deferred.tool1', 'deferred.tool2'],
      });

      // Since tool1 comes first and is 300 tokens, it won't fit
      // Then tool2 (100 tokens) will be loaded
      expect(result.loaded).toHaveLength(1);
      expect(result.loaded[0].id).toBe('deferred.tool2');
      expect(result.tokensUsed).toBe(100);
    });
  });

  describe('getApprovalRequiredTools', () => {
    it('returns loaded tools that require approval', () => {
      const loader = createToolLoader(registry);

      // Load all tiers including deferred
      loader.loadTools();
      loader.loadOnDemand({ toolIds: ['deferred.tool1', 'deferred.tool2'] });

      const approvalRequired = loader.getApprovalRequiredTools();

      expect(approvalRequired).toHaveLength(1);
      expect(approvalRequired[0].id).toBe('deferred.tool1');
      expect(approvalRequired[0].requiresApproval).toBe(true);
    });
  });

  describe('searchTools', () => {
    it('searches tools by query', () => {
      const loader = createToolLoader(registry);
      const results = loader.searchTools('conditional');

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((t) => t.id.includes('conditional'))).toBe(true);
    });

    it('respects tier filter', () => {
      const loader = createToolLoader(registry);
      const results = loader.searchTools('tool', { tiers: ['deferred'] });

      expect(results.every((t) => t.loadingTier === 'deferred')).toBe(true);
    });

    it('respects limit', () => {
      const loader = createToolLoader(registry);
      const results = loader.searchTools('tool', { limit: 2 });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty for empty query', () => {
      const loader = createToolLoader(registry);
      const results = loader.searchTools('');

      expect(results).toHaveLength(0);
    });
  });

  describe('filterToLoaded', () => {
    it('filters tools object to only loaded tools', () => {
      const loader = createToolLoader(registry);
      loader.loadTools({ loadTiers: ['critical'] });

      const allTools = {
        'conditional.tool1': { id: 'conditional.tool1' },
        'critical.tool1': { id: 'critical.tool1' },
        'critical.tool2': { id: 'critical.tool2' },
      };

      const filtered = loader.filterToLoaded(allTools as never);

      expect(Object.keys(filtered)).toEqual(['critical.tool1', 'critical.tool2']);
    });
  });

  describe('unloadTool', () => {
    it('removes tool from loaded set', () => {
      const loader = createToolLoader(registry);
      loader.loadTools({ loadTiers: ['critical'] });

      expect(loader.isToolLoaded('critical.tool1')).toBe(true);

      const removed = loader.unloadTool('critical.tool1');

      expect(removed).toBe(true);
      expect(loader.isToolLoaded('critical.tool1')).toBe(false);
    });

    it('returns false for non-loaded tool', () => {
      const loader = createToolLoader(registry);
      const removed = loader.unloadTool('unknown.tool');

      expect(removed).toBe(false);
    });
  });

  describe('clearLoaded', () => {
    it('clears all loaded tools', () => {
      const loader = createToolLoader(registry);
      loader.loadTools();

      expect(loader.getLoadedToolIds().length).toBeGreaterThan(0);

      loader.clearLoaded();

      expect(loader.getLoadedToolIds()).toHaveLength(0);
    });
  });
});

describe('loadToolsForAgent', () => {
  it('returns filtered tools and loading result', () => {
    const registry = createUnifiedToolRegistry();
    registry.registerNativeTools([
      {
        description: 'Test tool 1',
        estimatedTokens: 100,
        id: 'test.tool1',
        loadingTier: 'critical',
      },
    ]);

    const availableTools = {
      'test.tool1': { description: 'Test tool 1' },
      'test.tool2': { description: 'Test tool 2' },
    };

    const { tools, result } = loadToolsForAgent(registry, availableTools as never);

    expect(Object.keys(tools)).toContain('test.tool1');
    expect(Object.keys(tools)).not.toContain('test.tool2');
    expect(result.loadedTools).toHaveLength(1);
  });
});

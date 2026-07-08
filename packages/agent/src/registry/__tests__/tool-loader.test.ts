import { describe, expect, it } from 'vitest';
import { TokenBudgetManager } from '../token-budget-manager';
import { createToolLoader } from '../tool-loader';
import type { NativeToolRegistrationOptions } from '../unified-registry';
import { createUnifiedToolRegistry } from '../unified-registry';

const createNativeTool = (
  overrides: Partial<NativeToolRegistrationOptions>
): NativeToolRegistrationOptions => ({
  category: overrides.category,
  description: overrides.description ?? 'Test tool',
  enabled: overrides.enabled,
  estimatedTokens: overrides.estimatedTokens,
  id: `tool.${overrides.id ?? 'test'}`,
  loadingTier: overrides.loadingTier,
  requiresApproval: overrides.requiresApproval,
});

describe('ToolLoader', () => {
  it('loads critical and conditional tools when no budget manager is provided', () => {
    const registry = createUnifiedToolRegistry();
    registry.registerNativeTools([
      createNativeTool({ id: 'critical', loadingTier: 'critical' }),
      createNativeTool({ id: 'conditional', loadingTier: 'conditional' }),
      createNativeTool({ id: 'deferred', loadingTier: 'deferred' }),
    ]);

    const loader = createToolLoader(registry);
    const result = loader.loadTools();

    const ids = result.loadedTools.map((tool) => tool.id);
    expect(ids).toContain('tool.critical');
    expect(ids).toContain('tool.conditional');
    expect(ids).not.toContain('tool.deferred');
  });

  it('uses budget manager selection for conditional tools', () => {
    const registry = createUnifiedToolRegistry();
    registry.registerNativeTools([
      createNativeTool({ estimatedTokens: 10, id: 'critical', loadingTier: 'critical' }),
      createNativeTool({ estimatedTokens: 5, id: 'conditional-small', loadingTier: 'conditional' }),
      createNativeTool({
        estimatedTokens: 50,
        id: 'conditional-large',
        loadingTier: 'conditional',
      }),
    ]);

    const manager = new TokenBudgetManager({
      allocation: {
        conditionalTools: 0.1,
        contextResults: 0.4,
        criticalTools: 0.1,
        responseBuffer: 0.2,
        systemPrompt: 0.2,
      },
      contextWindowTokens: 100,
    });

    const loader = createToolLoader(registry, manager);
    const result = loader.loadTools();

    const ids = result.loadedTools.map((tool) => tool.id);
    expect(ids).toContain('tool.critical');
    expect(ids).toContain('tool.conditional-small');
    expect(ids).not.toContain('tool.conditional-large');
  });

  it('loads deferred tools on demand within token budget', () => {
    const registry = createUnifiedToolRegistry();
    registry.registerNativeTools([
      createNativeTool({ estimatedTokens: 10, id: 'deferred-small', loadingTier: 'deferred' }),
      createNativeTool({ estimatedTokens: 50, id: 'deferred-large', loadingTier: 'deferred' }),
    ]);

    const loader = createToolLoader(registry);
    const result = loader.loadOnDemand({
      maxTokens: 20,
      toolIds: ['tool.deferred-small', 'tool.deferred-large'],
    });

    expect(result.loaded.map((tool) => tool.id)).toEqual(['tool.deferred-small']);
    expect(result.tokensUsed).toBe(10);
  });

  it('searches enabled tools by query', () => {
    const registry = createUnifiedToolRegistry();
    registry.registerNativeTools([
      createNativeTool({
        description: 'Alpha search',
        id: 'search.alpha',
        loadingTier: 'conditional',
      }),
      createNativeTool({
        description: 'Beta search',
        id: 'search.beta',
        loadingTier: 'conditional',
      }),
      createNativeTool({ description: 'Misc tool', id: 'misc', loadingTier: 'deferred' }),
    ]);

    const loader = createToolLoader(registry);
    const results = loader.searchTools('beta');

    expect(results.map((tool) => tool.id)).toEqual(['tool.search.beta']);
  });
});

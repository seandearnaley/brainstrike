import { describe, expect, it } from 'vitest';
import { TokenBudgetManager } from '../token-budget-manager';
import { createToolLoader } from '../tool-loader';
import type { NativeToolRegistrationOptions } from '../unified-registry';
import { createUnifiedToolRegistry } from '../unified-registry';

const createNativeTool = (
  overrides: Partial<NativeToolRegistrationOptions>
): NativeToolRegistrationOptions => ({
  id: `tool.${overrides.id ?? 'test'}`,
  description: overrides.description ?? 'Test tool',
  category: overrides.category,
  loadingTier: overrides.loadingTier,
  estimatedTokens: overrides.estimatedTokens,
  requiresApproval: overrides.requiresApproval,
  enabled: overrides.enabled,
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
      createNativeTool({ id: 'critical', loadingTier: 'critical', estimatedTokens: 10 }),
      createNativeTool({ id: 'conditional-small', loadingTier: 'conditional', estimatedTokens: 5 }),
      createNativeTool({
        id: 'conditional-large',
        loadingTier: 'conditional',
        estimatedTokens: 50,
      }),
    ]);

    const manager = new TokenBudgetManager({
      contextWindowTokens: 100,
      allocation: {
        systemPrompt: 0.2,
        responseBuffer: 0.2,
        criticalTools: 0.1,
        conditionalTools: 0.1,
        contextResults: 0.4,
      },
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
      createNativeTool({ id: 'deferred-small', loadingTier: 'deferred', estimatedTokens: 10 }),
      createNativeTool({ id: 'deferred-large', loadingTier: 'deferred', estimatedTokens: 50 }),
    ]);

    const loader = createToolLoader(registry);
    const result = loader.loadOnDemand({
      toolIds: ['tool.deferred-small', 'tool.deferred-large'],
      maxTokens: 20,
    });

    expect(result.loaded.map((tool) => tool.id)).toEqual(['tool.deferred-small']);
    expect(result.tokensUsed).toBe(10);
  });

  it('searches enabled tools by query', () => {
    const registry = createUnifiedToolRegistry();
    registry.registerNativeTools([
      createNativeTool({
        id: 'search.alpha',
        description: 'Alpha search',
        loadingTier: 'conditional',
      }),
      createNativeTool({
        id: 'search.beta',
        description: 'Beta search',
        loadingTier: 'conditional',
      }),
      createNativeTool({ id: 'misc', description: 'Misc tool', loadingTier: 'deferred' }),
    ]);

    const loader = createToolLoader(registry);
    const results = loader.searchTools('beta');

    expect(results.map((tool) => tool.id)).toEqual(['tool.search.beta']);
  });
});

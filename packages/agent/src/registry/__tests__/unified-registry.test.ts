import type { ToolsInput } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { createUnifiedToolRegistry } from '../unified-registry';

describe('UnifiedToolRegistry', () => {
  it('registers native tools and toggles enabled state', () => {
    const registry = createUnifiedToolRegistry();

    registry.registerNativeTool({
      description: 'Custom tool',
      id: 'custom.tool',
    });

    const tool = registry.getTool('custom.tool');
    expect(tool).toBeDefined();
    expect(tool?.source).toBe('native');
    expect(tool?.enabled).toBe(true);

    registry.disableTools(['custom.tool']);
    expect(registry.getTool('custom.tool')?.enabled).toBe(false);

    registry.enableTools(['custom.tool']);
    expect(registry.getTool('custom.tool')?.enabled).toBe(true);
  });

  it('refreshes MCP tools and removes stale entries', () => {
    const registry = createUnifiedToolRegistry();

    const initialTools = {
      'mcp.alpha': { description: 'Alpha tool' },
    } as ToolsInput;

    registry.registerMcpTools({ serverName: 'server-a', tools: initialTools });
    expect(registry.getTool('mcp.alpha')).toBeDefined();

    const nextTools = {
      'mcp.beta': { description: 'Beta tool' },
    } as ToolsInput;

    registry.registerMcpTools({ serverName: 'server-a', tools: nextTools });
    expect(registry.getTool('mcp.alpha')).toBeUndefined();
    expect(registry.getTool('mcp.beta')).toBeDefined();
  });

  it('filters enabled tools and preserves unknown tool entries', () => {
    const registry = createUnifiedToolRegistry();
    registry.registerNativeTool({
      description: 'Custom tool',
      id: 'custom.tool',
    });

    registry.disableTools(['custom.tool']);

    const toolsInput = {
      'custom.tool': { description: 'Custom tool' },
      'unknown.tool': { description: 'Unknown tool' },
    } as ToolsInput;

    const filtered = registry.filterEnabledTools(toolsInput);
    expect(filtered['custom.tool']).toBeUndefined();
    expect(filtered['unknown.tool']).toBeDefined();
  });

  it('notifies listeners and removes unstable ones after repeated errors', () => {
    const registry = createUnifiedToolRegistry();
    const stableListener = vi.fn();
    const unstableListener = vi.fn(() => {
      throw new Error('boom');
    });

    registry.subscribe(stableListener);
    registry.subscribe(unstableListener);

    registry.registerNativeTool({
      description: 'Tool one',
      id: 'tool.one',
    });
    registry.registerNativeTool({
      description: 'Tool two',
      id: 'tool.two',
    });
    registry.registerNativeTool({
      description: 'Tool three',
      id: 'tool.three',
    });
    registry.registerNativeTool({
      description: 'Tool four',
      id: 'tool.four',
    });

    expect(stableListener).toHaveBeenCalled();
    expect(unstableListener).toHaveBeenCalled();
    const callsAfterRemoval = stableListener.mock.calls.length;

    registry.registerNativeTool({
      description: 'Tool five',
      id: 'tool.five',
    });

    expect(stableListener).toHaveBeenCalledTimes(callsAfterRemoval + 1);
    expect(unstableListener).toHaveBeenCalledTimes(3);
  });
});

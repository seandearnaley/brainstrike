import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUnifiedToolRegistry,
  type McpToolRegistrationOptions,
  type NativeToolRegistrationOptions,
  type UnifiedToolRegistry,
} from '../registry/unified-registry';

/**
 * Helper to create mock MCP tool entries with required inputSchema.
 */
function mockMcpTool(description: string, inputSchema: unknown = { type: 'object' }) {
  return { description, inputSchema };
}

describe('UnifiedToolRegistry', () => {
  let registry: UnifiedToolRegistry;

  beforeEach(() => {
    registry = createUnifiedToolRegistry();
  });

  describe('registerNativeTool', () => {
    it('registers a native tool with default values', () => {
      registry.registerNativeTool({
        description: 'A test tool',
        id: 'test.tool',
      });

      const tool = registry.getTool('test.tool');
      expect(tool).toBeDefined();
      expect(tool?.id).toBe('test.tool');
      expect(tool?.source).toBe('native');
      expect(tool?.description).toBe('A test tool');
      expect(tool?.enabled).toBe(true);
    });

    it('applies known native tool defaults', () => {
      registry.registerNativeTool({
        description: 'Read workspace file tool',
        id: 'brainstrike.readWorkspaceFile',
      });

      const tool = registry.getTool('brainstrike.readWorkspaceFile');
      expect(tool?.category).toBe('retrieval');
      expect(tool?.loadingTier).toBe('critical');
      expect(tool?.requiresApproval).toBe(false);
    });

    it('requires approval for native workspace context mutation tools', () => {
      registry.registerNativeTool({
        description: 'Update workspace context selection',
        id: 'brainstrike.updateWorkspaceContextSelection',
      });
      registry.registerNativeTool({
        description: 'Update workspace Tapestry selections',
        id: 'brainstrike.updateWorkspaceTapestrySelections',
      });

      expect(
        registry.getTool('brainstrike.updateWorkspaceContextSelection')?.requiresApproval
      ).toBe(true);
      expect(
        registry.getTool('brainstrike.updateWorkspaceTapestrySelections')?.requiresApproval
      ).toBe(true);
    });

    it('allows overriding category and tier', () => {
      registry.registerNativeTool({
        category: 'validation',
        description: 'Custom tool',
        id: 'custom.tool',
        loadingTier: 'deferred',
      });

      const tool = registry.getTool('custom.tool');
      expect(tool?.category).toBe('validation');
      expect(tool?.loadingTier).toBe('deferred');
    });

    it('preserves enabled state on re-registration', () => {
      registry.registerNativeTool({
        description: 'Test tool',
        id: 'test.tool',
      });

      registry.disableTools(['test.tool']);
      expect(registry.getTool('test.tool')?.enabled).toBe(false);

      // Re-register
      registry.registerNativeTool({
        description: 'Updated test tool',
        id: 'test.tool',
      });

      expect(registry.getTool('test.tool')?.enabled).toBe(false);
      expect(registry.getTool('test.tool')?.description).toBe('Updated test tool');
    });
  });

  describe('registerNativeTools', () => {
    it('registers multiple tools at once', () => {
      const tools: NativeToolRegistrationOptions[] = [
        { description: 'Tool one', id: 'tool.one' },
        { description: 'Tool two', id: 'tool.two' },
        { description: 'Tool three', id: 'tool.three' },
      ];

      registry.registerNativeTools(tools);

      expect(registry.getAllTools()).toHaveLength(3);
      expect(registry.getTool('tool.one')).toBeDefined();
      expect(registry.getTool('tool.two')).toBeDefined();
      expect(registry.getTool('tool.three')).toBeDefined();
    });
  });

  describe('registerMcpTools', () => {
    it('registers MCP tools from a server', () => {
      const options: McpToolRegistrationOptions = {
        serverName: 'test-server',
        tools: {
          'mcp.tool1': mockMcpTool('MCP Tool 1'),
          'mcp.tool2': mockMcpTool('MCP Tool 2'),
        },
      };

      registry.registerMcpTools(options);

      expect(registry.getAllTools()).toHaveLength(2);

      const tool1 = registry.getTool('mcp.tool1');
      expect(tool1?.source).toBe('mcp');
      expect(tool1?.serverName).toBe('test-server');
      expect(tool1?.description).toBe('MCP Tool 1');
    });

    it('removes stale tools when server registration shrinks', () => {
      registry.registerMcpTools({
        serverName: 'shrink-server',
        tools: {
          'mcp.drop': mockMcpTool('Drop tool'),
          'mcp.keep': mockMcpTool('Keep tool'),
        },
      });

      registry.registerMcpTools({
        serverName: 'shrink-server',
        tools: {
          'mcp.keep': mockMcpTool('Keep tool updated'),
        },
      });

      expect(registry.getTool('mcp.keep')).toBeDefined();
      expect(registry.getTool('mcp.drop')).toBeUndefined();
      expect(registry.getAllTools()).toHaveLength(1);
    });

    it('applies category override to all server tools', () => {
      registry.registerMcpTools({
        categoryOverride: 'retrieval',
        serverName: 'retrieval-server',
        tierOverride: 'critical',
        tools: {
          'search.one': mockMcpTool('Search 1'),
          'search.two': mockMcpTool('Search 2'),
        },
      });

      const tools = registry.getToolsForServer('retrieval-server');
      expect(tools).toHaveLength(2);
      for (const tool of tools) {
        expect(tool.category).toBe('retrieval');
        expect(tool.loadingTier).toBe('critical');
      }
    });
  });

  describe('enable/disable tools', () => {
    beforeEach(() => {
      registry.registerNativeTools([
        { description: 'Tool A', id: 'tool.a' },
        { description: 'Tool B', id: 'tool.b' },
        { description: 'Tool C', id: 'tool.c' },
      ]);
    });

    it('disables specific tools', () => {
      registry.disableTools(['tool.a', 'tool.c']);

      expect(registry.getTool('tool.a')?.enabled).toBe(false);
      expect(registry.getTool('tool.b')?.enabled).toBe(true);
      expect(registry.getTool('tool.c')?.enabled).toBe(false);
    });

    it('enables previously disabled tools', () => {
      registry.disableTools(['tool.a']);
      expect(registry.getTool('tool.a')?.enabled).toBe(false);

      registry.enableTools(['tool.a']);
      expect(registry.getTool('tool.a')?.enabled).toBe(true);
    });

    it('toggles tool state', () => {
      expect(registry.getTool('tool.a')?.enabled).toBe(true);

      const newState = registry.toggleTool('tool.a');
      expect(newState).toBe(false);
      expect(registry.getTool('tool.a')?.enabled).toBe(false);

      const newState2 = registry.toggleTool('tool.a');
      expect(newState2).toBe(true);
      expect(registry.getTool('tool.a')?.enabled).toBe(true);
    });

    it('returns false when toggling non-existent tool', () => {
      const result = registry.toggleTool('nonexistent.tool');
      expect(result).toBe(false);
    });
  });

  describe('getFilteredTools', () => {
    beforeEach(() => {
      registry.registerNativeTools([
        {
          category: 'retrieval',
          description: 'Search',
          id: 'retrieval.search',
          loadingTier: 'critical',
        },
        {
          category: 'retrieval',
          description: 'Query',
          id: 'retrieval.query',
          loadingTier: 'conditional',
        },
        {
          category: 'action',
          description: 'Create',
          id: 'action.create',
          loadingTier: 'conditional',
          requiresApproval: true,
        },
        {
          category: 'action',
          description: 'Delete',
          id: 'action.delete',
          loadingTier: 'deferred',
          requiresApproval: true,
        },
      ]);
    });

    it('filters by category', () => {
      const tools = registry.getFilteredTools({ category: 'retrieval' });
      expect(tools).toHaveLength(2);
      for (const tool of tools) {
        expect(tool.category).toBe('retrieval');
      }
    });

    it('filters by loading tier', () => {
      const tools = registry.getFilteredTools({ loadingTier: 'conditional' });
      expect(tools).toHaveLength(2);
      for (const tool of tools) {
        expect(tool.loadingTier).toBe('conditional');
      }
    });

    it('filters by enabled state', () => {
      registry.disableTools(['retrieval.search', 'action.create']);

      const enabledTools = registry.getFilteredTools({ enabled: true });
      expect(enabledTools).toHaveLength(2);

      const disabledTools = registry.getFilteredTools({ enabled: false });
      expect(disabledTools).toHaveLength(2);
    });

    it('filters by approval requirement', () => {
      const approvalTools = registry.getFilteredTools({ requiresApproval: true });
      expect(approvalTools).toHaveLength(2);
      for (const tool of approvalTools) {
        expect(tool.requiresApproval).toBe(true);
      }
    });

    it('filters by patterns', () => {
      const tools = registry.getFilteredTools({ patterns: ['retrieval.*'] });
      expect(tools).toHaveLength(2);
    });

    it('treats regex metacharacters as literals in patterns', () => {
      registry.registerNativeTool({
        description: 'Pattern-safe tool',
        id: 'tool[abc]',
      });

      const tools = registry.getFilteredTools({ patterns: ['tool[abc]'] });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.id).toBe('tool[abc]');
    });

    it('does not throw when patterns contain invalid regex fragments', () => {
      expect(() => registry.getFilteredTools({ patterns: ['tool[1'] })).not.toThrow();
    });

    it('excludes patterns', () => {
      const tools = registry.getFilteredTools({ excludePatterns: ['action.*'] });
      expect(tools).toHaveLength(2);
      for (const tool of tools) {
        expect(tool.id.startsWith('action.')).toBe(false);
      }
    });

    it('combines multiple filters', () => {
      const tools = registry.getFilteredTools({
        category: 'action',
        loadingTier: 'deferred',
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.id).toBe('action.delete');
    });
  });

  describe('getToolsByCategory', () => {
    it('groups tools by category', () => {
      registry.registerNativeTools([
        { category: 'retrieval', description: 'R1', id: 'r1' },
        { category: 'retrieval', description: 'R2', id: 'r2' },
        { category: 'action', description: 'A1', id: 'a1' },
      ]);

      const byCategory = registry.getToolsByCategory();
      expect(byCategory['retrieval']).toHaveLength(2);
      expect(byCategory['action']).toHaveLength(1);
    });
  });

  describe('getToolsBySource', () => {
    it('separates native and MCP tools', () => {
      registry.registerNativeTool({ description: 'Native', id: 'native.tool' });
      registry.registerMcpTools({
        serverName: 'server1',
        tools: { 'mcp.tool1': mockMcpTool('MCP 1') },
      });
      registry.registerMcpTools({
        serverName: 'server2',
        tools: { 'mcp.tool2': mockMcpTool('MCP 2') },
      });

      const bySource = registry.getToolsBySource();
      expect(bySource.native).toHaveLength(1);
      expect(bySource.mcp['server1']).toHaveLength(1);
      expect(bySource.mcp['server2']).toHaveLength(1);
    });
  });

  describe('getToolsByTier', () => {
    beforeEach(() => {
      registry.registerNativeTools([
        { description: 'C1', id: 'critical.1', loadingTier: 'critical' },
        { description: 'C2', id: 'critical.2', loadingTier: 'critical' },
        { description: 'Co1', id: 'conditional.1', loadingTier: 'conditional' },
        { description: 'D1', id: 'deferred.1', loadingTier: 'deferred' },
      ]);
    });

    it('returns critical tools', () => {
      const tools = registry.getCriticalTools();
      expect(tools).toHaveLength(2);
    });

    it('returns conditional tools', () => {
      const tools = registry.getConditionalTools();
      expect(tools).toHaveLength(1);
    });

    it('returns deferred tools', () => {
      const tools = registry.getDeferredTools();
      expect(tools).toHaveLength(1);
    });

    it('excludes disabled tools', () => {
      registry.disableTools(['critical.1']);
      const tools = registry.getCriticalTools();
      expect(tools).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      registry.registerNativeTools([
        { category: 'retrieval', description: 'N1', id: 'n1', loadingTier: 'critical' },
        { category: 'action', description: 'N2', id: 'n2', loadingTier: 'conditional' },
      ]);
      registry.registerMcpTools({
        serverName: 'server1',
        tools: { 'mcp.t1': mockMcpTool('M1') },
      });
      registry.disableTools(['n2']);

      const stats = registry.getStats();
      expect(stats.total).toBe(3);
      expect(stats.enabled).toBe(2);
      expect(stats.disabled).toBe(1);
      expect(stats.bySource.native).toBe(2);
      expect(stats.bySource.mcp).toBe(1);
      expect(stats.mcpServers).toBe(1);
    });
  });

  describe('getTotalEstimatedTokens', () => {
    it('calculates total tokens for enabled tools', () => {
      registry.registerNativeTools([
        { description: 'T1', estimatedTokens: 100, id: 't1' },
        { description: 'T2', estimatedTokens: 150, id: 't2' },
        { description: 'T3', estimatedTokens: 200, id: 't3' },
      ]);
      registry.disableTools(['t3']);

      const total = registry.getTotalEstimatedTokens();
      expect(total).toBe(250); // Only enabled tools
    });
  });

  describe('subscribe', () => {
    it('notifies listeners on tool state changes', () => {
      const listener = vi.fn();
      registry.subscribe(listener);

      registry.registerNativeTool({ description: 'Test', id: 'test' });
      expect(listener).toHaveBeenCalledTimes(1);

      registry.disableTools(['test']);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('allows unsubscribing', () => {
      const listener = vi.fn();
      const unsubscribe = registry.subscribe(listener);

      registry.registerNativeTool({ description: 'Test', id: 'test' });
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      registry.registerNativeTool({ description: 'Test 2', id: 'test2' });
      expect(listener).toHaveBeenCalledTimes(1); // No new calls
    });

    it('removes listeners after repeated failures', () => {
      const failingListener = vi.fn(() => {
        throw new Error('Listener failed');
      });
      const healthyListener = vi.fn();

      registry.subscribe(failingListener);
      registry.subscribe(healthyListener);

      registry.registerNativeTool({ description: 'T1', id: 't1' });
      registry.registerNativeTool({ description: 'T2', id: 't2' });
      registry.registerNativeTool({ description: 'T3', id: 't3' });
      registry.registerNativeTool({ description: 'T4', id: 't4' });

      expect(failingListener).toHaveBeenCalledTimes(3);
      expect(healthyListener).toHaveBeenCalledTimes(4);
    });
  });

  describe('exportState / importState', () => {
    it('exports and imports enabled/disabled state', () => {
      registry.registerNativeTools([
        { description: 'T1', id: 't1' },
        { description: 'T2', id: 't2' },
        { description: 'T3', id: 't3' },
      ]);
      registry.disableTools(['t2']);

      const state = registry.exportState();
      expect(state).toEqual({
        t1: true,
        t2: false,
        t3: true,
      });

      // Create new registry and import state
      const newRegistry = createUnifiedToolRegistry();
      newRegistry.registerNativeTools([
        { description: 'T1', id: 't1' },
        { description: 'T2', id: 't2' },
        { description: 'T3', id: 't3' },
      ]);
      newRegistry.importState(state);

      expect(newRegistry.getTool('t1')?.enabled).toBe(true);
      expect(newRegistry.getTool('t2')?.enabled).toBe(false);
      expect(newRegistry.getTool('t3')?.enabled).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all tools', () => {
      registry.registerNativeTools([
        { description: 'T1', id: 't1' },
        { description: 'T2', id: 't2' },
      ]);
      registry.registerMcpTools({
        serverName: 'server',
        tools: { 'mcp.t': mockMcpTool('MCP') },
      });

      expect(registry.getAllTools()).toHaveLength(3);

      registry.clear();

      expect(registry.getAllTools()).toHaveLength(0);
    });
  });

  describe('clearServer', () => {
    it('removes only tools from specific server', () => {
      registry.registerNativeTool({ description: 'Native', id: 'native' });
      registry.registerMcpTools({
        serverName: 'server1',
        tools: { 'mcp.s1': mockMcpTool('S1') },
      });
      registry.registerMcpTools({
        serverName: 'server2',
        tools: { 'mcp.s2': mockMcpTool('S2') },
      });

      expect(registry.getAllTools()).toHaveLength(3);

      registry.clearServer('server1');

      expect(registry.getAllTools()).toHaveLength(2);
      expect(registry.getTool('mcp.s1')).toBeUndefined();
      expect(registry.getTool('mcp.s2')).toBeDefined();
    });
  });

  describe('filterEnabledTools', () => {
    it('filters ToolsInput to only enabled tools', () => {
      registry.registerNativeTools([
        { description: 'T1', id: 't1' },
        { description: 'T2', id: 't2' },
        { description: 'T3', id: 't3' },
      ]);
      registry.disableTools(['t2']);

      const originalTools = {
        t1: mockMcpTool('Tool 1'),
        t2: mockMcpTool('Tool 2'),
        t3: mockMcpTool('Tool 3'),
      };

      const filtered = registry.filterEnabledTools(originalTools);

      expect(Object.keys(filtered)).toEqual(['t1', 't3']);
      expect(filtered['t2']).toBeUndefined();
    });

    it('passes through unknown tools', () => {
      const originalTools = {
        unknown: mockMcpTool('Unknown'),
      };

      const filtered = registry.filterEnabledTools(originalTools);
      expect(filtered['unknown']).toBeDefined();
    });
  });
});

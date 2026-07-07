import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../mcp/tool-registry';

describe('MCP ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  const createMockTool = (id: string, description: string) =>
    createTool({
      description,
      execute: async () => ({ result: 'test' }),
      id,
      inputSchema: z.object({ query: z.string() }),
    });

  const mockTools = {
    'tool.read': createMockTool('tool.read', 'Read a document'),
    'tool.search': createMockTool('tool.search', 'Search for documents'),
    'tool.write': createMockTool('tool.write', 'Write a document'),
  } as ToolsInput;

  describe('register', () => {
    it('should register tools from a server', () => {
      registry.register('test-server', mockTools);

      const tools = registry.getToolsForServer('test-server');
      expect(tools).toHaveLength(3);
      const searchTool = tools.find((tool) => tool.id === 'tool.search');
      expect(searchTool?.serverName).toBe('test-server');
      expect(searchTool?.enabled).toBe(true);
    });

    it('should preserve enabled state when re-registering', () => {
      registry.register('test-server', mockTools);
      registry.disableTools(['tool.search']);

      registry.register('test-server', mockTools);

      const tools = registry.getToolsForServer('test-server');
      const searchTool = tools.find((t) => t.id === 'tool.search');
      expect(searchTool?.enabled).toBe(false);
    });

    it('should respect filter config on initial registration', () => {
      registry.register('test-server', mockTools, {
        enabledTools: ['tool.search', 'tool.read'],
      });

      const tools = registry.getToolsForServer('test-server');
      expect(tools.find((t) => t.id === 'tool.search')?.enabled).toBe(true);
      expect(tools.find((t) => t.id === 'tool.read')?.enabled).toBe(true);
      expect(tools.find((t) => t.id === 'tool.write')?.enabled).toBe(false);
    });

    it('should support wildcard enabledTools', () => {
      registry.register('test-server', mockTools, {
        enabledTools: ['*'],
      });

      const tools = registry.getToolsForServer('test-server');
      expect(tools.every((t) => t.enabled)).toBe(true);
    });

    it('should support exclusion patterns', () => {
      registry.register('test-server', mockTools, {
        enabledTools: ['*', '!tool.write'],
      });

      const tools = registry.getToolsForServer('test-server');
      expect(tools.find((t) => t.id === 'tool.search')?.enabled).toBe(true);
      expect(tools.find((t) => t.id === 'tool.read')?.enabled).toBe(true);
      expect(tools.find((t) => t.id === 'tool.write')?.enabled).toBe(false);
    });
  });

  describe('enableTools/disableTools', () => {
    beforeEach(() => {
      registry.register('test-server', mockTools);
    });

    it('should enable specific tools', () => {
      registry.disableTools(['tool.search']);
      expect(
        registry.getToolsForServer('test-server').find((tool) => tool.id === 'tool.search')?.enabled
      ).toBe(false);

      registry.enableTools(['tool.search']);
      expect(
        registry.getToolsForServer('test-server').find((tool) => tool.id === 'tool.search')?.enabled
      ).toBe(true);
    });

    it('should disable specific tools', () => {
      registry.disableTools(['tool.search', 'tool.read']);

      const tools = registry.getToolsForServer('test-server');
      expect(tools.find((t) => t.id === 'tool.search')?.enabled).toBe(false);
      expect(tools.find((t) => t.id === 'tool.read')?.enabled).toBe(false);
      expect(tools.find((t) => t.id === 'tool.write')?.enabled).toBe(true);
    });
  });

  describe('enableServerTools/disableServerTools', () => {
    beforeEach(() => {
      registry.register('test-server', mockTools);
    });

    it('should enable all tools from a server', () => {
      registry.disableTools(['tool.search', 'tool.read']);

      registry.enableServerTools('test-server');

      const tools = registry.getToolsForServer('test-server');
      expect(tools.every((t) => t.enabled)).toBe(true);
    });

    it('should disable all tools from a server', () => {
      registry.disableServerTools('test-server');

      const tools = registry.getToolsForServer('test-server');
      expect(tools.every((t) => !t.enabled)).toBe(true);
    });
  });

  describe('getEnabledTools', () => {
    beforeEach(() => {
      registry.register('test-server', mockTools);
    });

    it('should return only enabled tools', () => {
      registry.disableTools(['tool.write']);

      const filtered = registry.getEnabledTools(mockTools);

      expect(Object.keys(filtered)).toHaveLength(2);
      expect('tool.search' in filtered).toBe(true);
      expect('tool.read' in filtered).toBe(true);
      expect('tool.write' in filtered).toBe(false);
    });

    it('should return all tools when none are disabled', () => {
      const filtered = registry.getEnabledTools(mockTools);

      expect(Object.keys(filtered)).toHaveLength(3);
    });

    it('should return empty object when all tools are disabled', () => {
      registry.disableServerTools('test-server');

      const filtered = registry.getEnabledTools(mockTools);

      expect(Object.keys(filtered)).toHaveLength(0);
    });
  });

  describe('getAllTools', () => {
    it('should return tools grouped by server', () => {
      const server1Tools = {
        'server1.tool': createMockTool('server1.tool', 'Server 1 tool'),
      } as ToolsInput;
      const server2Tools = {
        'server2.tool': createMockTool('server2.tool', 'Server 2 tool'),
      } as ToolsInput;

      registry.register('server1', server1Tools);
      registry.register('server2', server2Tools);

      const allTools = registry.getAllTools();

      expect(Object.keys(allTools)).toHaveLength(2);
      expect(allTools['server1']).toHaveLength(1);
      expect(allTools['server2']).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      registry.register('server1', mockTools);
      registry.disableTools(['tool.write']);

      const stats = registry.getStats();

      expect(stats).toEqual({
        disabled: 1,
        enabled: 2,
        servers: 1,
        total: 3,
      });
    });

    it('should handle multiple servers', () => {
      registry.register('server1', mockTools);
      registry.register('server2', {
        'server2.tool': createMockTool('server2.tool', 'Tool'),
      } as ToolsInput);

      const stats = registry.getStats();

      expect(stats.total).toBe(4);
      expect(stats.servers).toBe(2);
    });
  });

  describe('reset', () => {
    it('should reset all tools to default enabled state', () => {
      registry.register('test-server', mockTools);
      registry.disableTools(['tool.search', 'tool.read']);

      registry.reset();

      const tools = registry.getToolsForServer('test-server');
      expect(tools.every((t) => t.enabled)).toBe(true);
    });

    it('should respect filter config when resetting', () => {
      registry.register('test-server', mockTools, {
        enabledTools: ['tool.search'],
      });

      registry.enableTools(['tool.read', 'tool.write']);

      registry.reset({ enabledTools: ['tool.search'] });

      const tools = registry.getToolsForServer('test-server');
      expect(tools.find((t) => t.id === 'tool.search')?.enabled).toBe(true);
      expect(tools.find((t) => t.id === 'tool.read')?.enabled).toBe(false);
      expect(tools.find((t) => t.id === 'tool.write')?.enabled).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all registered tools', () => {
      registry.register('test-server', mockTools);

      registry.clear();

      expect(registry.getToolsForServer('test-server')).toHaveLength(0);
      expect(registry.getStats().total).toBe(0);
    });
  });

  describe('matchPattern with regex metacharacters', () => {
    it('should match tool.read as a literal dot pattern', () => {
      const fresh = new ToolRegistry();
      fresh.register('test-server', mockTools, {
        enabledTools: ['tool.read'],
      });

      const tools = fresh.getToolsForServer('test-server');
      expect(tools.find((t) => t.id === 'tool.read')?.enabled).toBe(true);
      expect(tools.find((t) => t.id === 'tool.write')?.enabled).toBe(false);
    });

    it('should not match toolXread when pattern is tool.read (dot is escaped)', () => {
      const fresh = new ToolRegistry();
      const extraTools = {
        ...mockTools,
        toolXread: createMockTool('toolXread', 'Extra tool'),
      } as ToolsInput;

      fresh.register('test-server', extraTools, {
        enabledTools: ['tool.read'],
      });

      const tools = fresh.getToolsForServer('test-server');
      expect(tools.find((t) => t.id === 'tool.read')?.enabled).toBe(true);
      expect(tools.find((t) => t.id === 'toolXread')?.enabled).toBe(false);
    });

    it('should handle glob wildcard with metacharacter patterns', () => {
      const fresh = new ToolRegistry();
      fresh.register('test-server', mockTools, {
        enabledTools: ['tool.*'],
      });

      const tools = fresh.getToolsForServer('test-server');
      expect(tools.every((t) => t.enabled)).toBe(true);
    });
  });

  describe('subscribe', () => {
    it('should notify listeners on tool state changes', () => {
      let notificationCount = 0;

      const unsubscribe = registry.subscribe(() => {
        notificationCount += 1;
      });

      registry.register('test-server', mockTools);
      expect(notificationCount).toBe(1);

      registry.disableTools(['tool.search']);
      expect(notificationCount).toBe(2);

      unsubscribe();

      registry.enableTools(['tool.search']);
      expect(notificationCount).toBe(2); // Should not increment after unsubscribe
    });
  });
});

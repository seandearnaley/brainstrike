import type { ToolsInput } from '@mastra/core/agent';
import type { MCPClient } from '@mastra/mcp';
import { describe, expect, it, vi } from 'vitest';
import { collectCombinedTools } from '../mastra/mcp-tool-loader';

describe('mcp-tool-loader', () => {
  describe('collectCombinedTools', () => {
    it('returns only local tools when no MCP client', async () => {
      const localTools: ToolsInput = {
        local_tool: { id: 'local_tool', description: 'local' },
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: localTools,
        mcpClient: undefined,
        mcpConfig: undefined,
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).toEqual(localTools);
    });

    it('returns only local tools when no MCP config', async () => {
      const localTools: ToolsInput = {
        local_tool: { id: 'local_tool', description: 'local' },
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: localTools,
        mcpClient: {} as MCPClient,
        mcpConfig: undefined,
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).toEqual(localTools);
    });

    it('returns empty object when no local tools and no MCP', async () => {
      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: undefined,
        mcpConfig: undefined,
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).toEqual({});
    });

    it('handles MCP client with empty servers array', async () => {
      const localTools: ToolsInput = {
        local_tool: { id: 'local_tool', description: 'local' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue({}),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: localTools,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: { servers: [] },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).toEqual(localTools);
    });

    it('merges local and MCP tools', async () => {
      const localTools: ToolsInput = {
        local_tool: { id: 'local_tool', description: 'local' },
      };

      const mockMcpTools: ToolsInput = {
        'server1.remote_tool': { id: 'server1.remote_tool', description: 'remote' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: localTools,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'server1',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(Object.keys(result)).toHaveLength(2);
      expect(result['local_tool']).toBeDefined();
      expect(result['server1_remote_tool']).toBeDefined();
    });

    it('handles MCP tool discovery timeout', async () => {
      const localTools: ToolsInput = {
        local_tool: { id: 'local_tool', description: 'local' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockImplementation(() => {
          return new Promise((resolve) => {
            setTimeout(() => resolve({}), 10_000); // Will timeout
          });
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: localTools,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'server1',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: 100, // Short timeout
      });

      // Should still return local tools even if MCP times out
      expect(result).toEqual(localTools);
    });

    it('handles MCP tool discovery error', async () => {
      const localTools: ToolsInput = {
        local_tool: { id: 'local_tool', description: 'local' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockRejectedValue(new Error('Connection failed')),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: localTools,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'server1',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      // Should still return local tools even if MCP fails
      expect(result).toEqual(localTools);
    });

    it('filters tools for specific server', async () => {
      const mockMcpTools: ToolsInput = {
        'server1.tool1': { id: 'server1.tool1', description: 'server1 tool' },
        'server2.tool2': { id: 'server2.tool2', description: 'server2 tool' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'server1',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      // Should only include server1 tools
      const keys = Object.keys(result);
      expect(keys.every((key) => key.includes('server1'))).toBe(true);
    });

    it('handles servers without names', async () => {
      const mockMcpTools: ToolsInput = {
        remote_tool: { id: 'remote_tool', description: 'remote' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: undefined as unknown as string,
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      // Server without name should be skipped
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('handles single server with all tools', async () => {
      const mockMcpTools: ToolsInput = {
        tool1: { id: 'tool1', description: 'tool 1' },
        tool2: { id: 'tool2', description: 'tool 2' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'single-server',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      // With single server, all tools should be included
      expect(Object.keys(result).length).toBeGreaterThan(0);
    });

    it('respects enabledTools filter', async () => {
      const mockMcpTools: ToolsInput = {
        'server.tool1': { id: 'server.tool1', description: 'tool 1' },
        'server.tool2': { id: 'server.tool2', description: 'tool 2' },
        'server.tool3': { id: 'server.tool3', description: 'tool 3' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'server',
              transport: 'stdio' as const,
              command: 'echo',
              enabledTools: ['server.tool1', 'server.tool2'],
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      // Should only include enabled tools
      const keys = Object.keys(result);
      expect(keys.length).toBeLessThanOrEqual(2);
    });

    it('uses custom timeout value when provided', async () => {
      const mockMcpClient = {
        getTools: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({}), 50);
            })
        ),
      };

      const start = Date.now();
      await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'server',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: 10, // Very short timeout
      });
      const duration = Date.now() - start;

      // Should timeout quickly (within reasonable margin)
      expect(duration).toBeLessThan(100);
    });

    it('handles invalid timeout values by using default', async () => {
      const mockMcpTools: ToolsInput = {
        tool: { id: 'tool', description: 'tool' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'server',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: -1, // Invalid timeout
      });

      // Should use default timeout (5000ms) and still work
      expect(mockMcpClient.getTools).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('handles tools with case-insensitive server matching', async () => {
      const mockMcpTools: ToolsInput = {
        'MyServer.tool1': { id: 'MyServer.tool1', description: 'tool 1' },
        myserver_tool2: { id: 'myserver_tool2', description: 'tool 2' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'myserver',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      // Should match both variations
      const keys = Object.keys(result);
      expect(keys.length).toBeGreaterThan(0);
    });

    it('includes all tools when single server has no matching prefix', async () => {
      const mockMcpTools: ToolsInput = {
        other_tool: { id: 'other_tool', description: 'other tool' },
      };

      const mockMcpClient = {
        getTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'empty-server',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      // When there's only one server, all tools are assumed to belong to that server
      expect(Object.keys(result)).toHaveLength(1);
      expect(result).toHaveProperty('other_tool');
    });
  });
});

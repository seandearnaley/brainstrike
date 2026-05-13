import type { ToolsInput } from '@mastra/core/agent';
import type { MCPClient } from '@mastra/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectCombinedTools } from '../mastra/mcp-tool-loader';
import { toolRegistry as mcpToolRegistry } from '../mcp/tool-registry';

describe('mcp-tool-loader', () => {
  afterEach(() => {
    mcpToolRegistry.clear();
  });

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
        listTools: vi.fn().mockResolvedValue({}),
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
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
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
      // Tool names are sanitized: '.' gets replaced with '_'
      expect(result['server1_remote_tool']).toBeDefined();
    });

    it('marks generic filesystem MCP tools as non-preferred for workspace questions', async () => {
      const mockMcpTools: ToolsInput = {
        'filesystem.search_files': {
          id: 'filesystem.search_files',
          description: 'Search files',
        },
      };

      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: {
          brainstrike_listEmbeddingSpaces: {
            id: 'brainstrike_listEmbeddingSpaces',
            description: 'List Brainstrike embedding spaces',
          },
        },
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'filesystem',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result['filesystem_search_files']?.description).toContain(
        'Not preferred for Brainstrike workspace or codebase questions'
      );
      expect(result['brainstrike_listEmbeddingSpaces']?.description).toBe(
        'List Brainstrike embedding spaces'
      );
    });

    it('handles MCP tool discovery timeout', async () => {
      const localTools: ToolsInput = {
        local_tool: { id: 'local_tool', description: 'local' },
      };

      const mockMcpClient = {
        listTools: vi.fn().mockImplementation(() => {
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
        listTools: vi.fn().mockRejectedValue(new Error('Connection failed')),
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
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
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
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
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
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
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
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
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
        listTools: vi.fn().mockImplementation(
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
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
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
      expect(mockMcpClient.listTools).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('handles tools with case-insensitive server matching', async () => {
      const mockMcpTools: ToolsInput = {
        'MyServer.tool1': { id: 'MyServer.tool1', description: 'tool 1' },
        myserver_tool2: { id: 'myserver_tool2', description: 'tool 2' },
      };

      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
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
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
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

    it('applies persisted enabled state using original MCP ids after sanitization', async () => {
      mcpToolRegistry.register('filesystem', {
        'filesystem.read_file': { id: 'filesystem.read_file', description: 'read file' },
        'filesystem.list_directory': { id: 'filesystem.list_directory', description: 'list dir' },
      });
      mcpToolRegistry.disableTools(['filesystem.read_file']);

      const mockMcpTools: ToolsInput = {
        'filesystem.read_file': { id: 'filesystem.read_file', description: 'read file' },
        'filesystem.list_directory': { id: 'filesystem.list_directory', description: 'list dir' },
      };

      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'filesystem',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
      expect(mcpToolRegistry.getToolsForServer('filesystem')).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'filesystem.read_file' })])
      );
    });
  });
});

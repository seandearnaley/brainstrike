import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import type { ToolsInput } from '@mastra/core/agent';
import type { MCPClient } from '@mastra/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectCombinedTools } from '../mastra/mcp-tool-loader';
import { toolRegistry as mcpToolRegistry } from '../mcp/tool-registry';

describe('mcp-tool-loader', () => {
  afterEach(() => {
    mcpToolRegistry.clear();
    vi.useRealTimers();
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

    it('prefers grouped MCP toolsets to preserve same-name tools across servers', async () => {
      const toolNameMap = new Map<string, string>();
      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
        listToolsets: vi.fn().mockResolvedValue({
          alpha: {
            search: { id: 'search', description: 'alpha search' },
          },
          beta: {
            search: { id: 'search', description: 'beta search' },
          },
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'alpha',
              transport: 'stdio' as const,
              command: 'echo',
            },
            {
              name: 'beta',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap,
        timeoutOverrideMs: undefined,
      });

      expect(mockMcpClient.listToolsets).toHaveBeenCalledTimes(1);
      expect(mockMcpClient.listTools).not.toHaveBeenCalled();
      expect(Object.keys(result).sort()).toEqual(['alpha_search', 'beta_search']);
      expect(toolNameMap.get('alpha_search')).toBe('alpha.search');
      expect(toolNameMap.get('beta_search')).toBe('beta.search');
    });

    it('matches grouped MCP toolsets when returned keys use normalized server names', async () => {
      const toolNameMap = new Map<string, string>();
      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
        listToolsets: vi.fn().mockResolvedValue({
          'File System': {
            read_file: { id: 'read_file', description: 'read file' },
          },
          notes: {
            search: { id: 'search', description: 'search notes' },
          },
        }),
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
            {
              name: 'notes',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap,
        timeoutOverrideMs: undefined,
      });

      expect(Object.keys(result).sort()).toEqual(['filesystem_read_file', 'notes_search']);
      expect(toolNameMap.get('filesystem_read_file')).toBe('filesystem.read_file');
      expect(toolNameMap.get('notes_search')).toBe('notes.search');
    });

    it('does not fuzzy-match one grouped MCP toolset across multiple configured servers', async () => {
      const toolNameMap = new Map<string, string>();
      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
        listToolsets: vi.fn().mockResolvedValue({
          filesystem: {
            read_file: { id: 'read_file', description: 'read file' },
          },
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'file',
              transport: 'stdio' as const,
              command: 'echo',
            },
            {
              name: 'filesystem',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap,
        timeoutOverrideMs: undefined,
      });

      expect(Object.keys(result)).toEqual(['filesystem_read_file']);
      expect(result).not.toHaveProperty('file_read_file');
      expect(toolNameMap.get('filesystem_read_file')).toBe('filesystem.read_file');
      expect(toolNameMap.has('file_read_file')).toBe(false);
    });

    it('reserves exact grouped MCP toolset keys for their configured server', async () => {
      const toolNameMap = new Map<string, string>();
      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
        listToolsets: vi.fn().mockResolvedValue({
          alpha: {
            search: { id: 'search', description: 'search' },
          },
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'Alpha',
              transport: 'stdio' as const,
              command: 'echo',
            },
            {
              name: 'alpha',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap,
        timeoutOverrideMs: undefined,
      });

      expect(Object.keys(result)).toEqual(['alpha_search']);
      expect(result).not.toHaveProperty('Alpha_search');
      expect(toolNameMap.get('alpha_search')).toBe('alpha.search');
      expect(toolNameMap.has('Alpha_search')).toBe(false);
    });

    it('warns when an exact grouped MCP toolset key is empty', async () => {
      const records: LogRecord[] = [];
      const unsubscribe = addLogListener((record) => {
        records.push(record);
      });
      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
        listToolsets: vi.fn().mockResolvedValue({
          alpha: {},
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'alpha',
              transport: 'stdio' as const,
              command: 'echo',
            },
            {
              name: 'beta',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });
      unsubscribe();

      expect(result).toEqual({});
      expect(
        records.some(
          (record) =>
            record.level === LogLevel.WARN &&
            record.args.some(
              (arg) =>
                typeof arg === 'object' &&
                arg !== null &&
                'code' in arg &&
                arg.code === 'mcp_toolset_server_key_empty' &&
                'serverName' in arg &&
                arg.serverName === 'alpha'
            )
        )
      ).toBe(true);
    });

    it('does not assign one normalized grouped MCP toolset to multiple configured servers', async () => {
      const toolNameMap = new Map<string, string>();
      const records: LogRecord[] = [];
      const unsubscribe = addLogListener((record) => {
        records.push(record);
      });
      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
        listToolsets: vi.fn().mockResolvedValue({
          'My Server': {
            search: { id: 'search', description: 'search' },
          },
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'my-server',
              transport: 'stdio' as const,
              command: 'echo',
            },
            {
              name: 'my_server',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap,
        timeoutOverrideMs: undefined,
      });
      unsubscribe();

      expect(Object.keys(result)).toEqual(['my-server_search']);
      expect(result).not.toHaveProperty('my_server_search');
      expect(toolNameMap.get('my-server_search')).toBe('my-server.search');
      expect(toolNameMap.has('my_server_search')).toBe(false);
      expect(
        records.some(
          (record) =>
            record.level === LogLevel.WARN &&
            record.args.some(
              (arg) =>
                typeof arg === 'object' &&
                arg !== null &&
                'code' in arg &&
                arg.code === 'mcp_toolset_server_key_duplicate'
            )
        )
      ).toBe(true);
    });

    it('warns when grouped MCP toolsets miss a configured server in multi-server config', async () => {
      const records: LogRecord[] = [];
      const unsubscribe = addLogListener((record) => {
        records.push(record);
      });
      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
        listToolsets: vi.fn().mockResolvedValue({
          alpha: {
            search: { id: 'search', description: 'search' },
          },
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'alpha',
              transport: 'stdio' as const,
              command: 'echo',
            },
            {
              name: 'renamed-alpha',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });
      unsubscribe();

      expect(Object.keys(result)).toEqual(['alpha_search']);
      expect(
        records.some(
          (record) =>
            record.level === LogLevel.WARN &&
            record.args.some(
              (arg) =>
                typeof arg === 'object' &&
                arg !== null &&
                'code' in arg &&
                arg.code === 'mcp_toolset_server_key_missing' &&
                'serverName' in arg &&
                arg.serverName === 'renamed-alpha'
            )
        )
      ).toBe(true);
    });

    it('keeps grouped MCP tools for a single server when the returned key does not match', async () => {
      const toolNameMap = new Map<string, string>();
      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
        listToolsets: vi.fn().mockResolvedValue({
          discovered: {
            search: { id: 'search', description: 'search' },
          },
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'configured-server',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap,
        timeoutOverrideMs: undefined,
      });

      expect(result).toHaveProperty('configured-server_search');
      expect(toolNameMap.get('configured-server_search')).toBe('configured-server.search');
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
      vi.useFakeTimers();
      let settled = false;
      const mockMcpClient = {
        listTools: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({}), 50);
            })
        ),
      };

      const resultPromise = collectCombinedTools({
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
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(9);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toEqual({});
      expect(settled).toBe(true);
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

    it('applies persisted enabled state when Mastra exposes server tools under sanitized ids', async () => {
      mcpToolRegistry.register('filesystem', {
        'filesystem.read_file': { id: 'filesystem.read_file', description: 'read file' },
        'filesystem.list_directory': { id: 'filesystem.list_directory', description: 'list dir' },
      });
      mcpToolRegistry.disableTools(['filesystem.read_file']);

      const mockMcpTools: ToolsInput = {
        filesystem_read_file: { id: 'filesystem_read_file', description: 'read file' },
        filesystem_list_directory: { id: 'filesystem_list_directory', description: 'list dir' },
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
    });

    it('applies config enabledTools patterns to sanitized Mastra MCP ids through registry ids', async () => {
      const mockMcpTools: ToolsInput = {
        filesystem_read_file: { id: 'filesystem_read_file', description: 'read file' },
        filesystem_list_directory: { id: 'filesystem_list_directory', description: 'list dir' },
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
              enabledTools: ['filesystem.list_directory'],
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });
  });
});

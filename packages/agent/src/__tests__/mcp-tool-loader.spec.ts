import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import type { ToolsInput } from '@mastra/core/agent';
import type { MCPClient } from '@mastra/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectCombinedTools } from '../mastra/mcp-tool-loader';
import { toolRegistry as mcpToolRegistry } from '../mcp/tool-registry';

interface MockMcpClient {
  listTools: ReturnType<typeof vi.fn>;
  listToolsetsWithErrors: ReturnType<typeof vi.fn>;
}

function createMockMcpClient(
  toolsets: Record<string, ToolsInput>,
  errors: Record<string, string> = {}
): MockMcpClient {
  return {
    listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
    listToolsetsWithErrors: vi.fn().mockResolvedValue({ toolsets, errors }),
  };
}

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

    it('loads MCP tools from the official server-grouped toolsets API', async () => {
      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            filesystem: {
              read_file: { id: 'read_file', description: 'read file' },
            },
          },
          errors: {},
        }),
      };

      const toolNameMap = new Map<string, string>();

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
        toolNameMap,
        timeoutOverrideMs: undefined,
      });

      expect(mockMcpClient.listToolsetsWithErrors).toHaveBeenCalledOnce();
      expect(mockMcpClient.listTools).not.toHaveBeenCalled();
      expect(result).toHaveProperty('filesystem_read_file');
      expect(toolNameMap.get('filesystem_read_file')).toBe('filesystem.read_file');
    });

    it('keeps healthy MCP server tools when another server reports a discovery error', async () => {
      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            healthy: {
              search: { id: 'search', description: 'search' },
            },
          },
          errors: {
            broken: 'Connection closed',
          },
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'healthy',
              transport: 'stdio' as const,
              command: 'echo',
            },
            {
              name: 'broken',
              transport: 'stdio' as const,
              command: 'false',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).toHaveProperty('healthy_search');
      expect(result).not.toHaveProperty('broken_search');
    });

    it('logs when a configured MCP server has neither a toolset nor a discovery error', async () => {
      const logRecords: LogRecord[] = [];
      const removeLogListener = addLogListener((record) => logRecords.push(record));
      const mockMcpClient = createMockMcpClient({
        healthy: {
          search: { id: 'search', description: 'search' },
        },
      });

      try {
        const result = await collectCombinedTools({
          sanitizedLocalTools: undefined,
          mcpClient: mockMcpClient as unknown as MCPClient,
          mcpConfig: {
            servers: [
              {
                name: 'healthy',
                transport: 'stdio' as const,
                command: 'echo',
              },
              {
                name: 'missing',
                transport: 'stdio' as const,
                command: 'echo',
              },
            ],
          },
          toolNameMap: new Map(),
          timeoutOverrideMs: undefined,
        });

        expect(result).toHaveProperty('healthy_search');
        expect(logRecords).toContainEqual(
          expect.objectContaining({
            level: 'warn',
            message: 'MCP toolset did not match configured server',
            scope: 'MastraAgentMcpTools',
            args: [
              'MCP toolset did not match configured server',
              expect.objectContaining({
                code: 'mcp_toolset_server_key_missing',
                serverName: 'missing',
              }),
            ],
          })
        );
      } finally {
        removeLogListener();
      }
    });

    it('does not infer server ownership from substring matches', async () => {
      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            github: {
              create_issue: { id: 'create_issue', description: 'create issue' },
            },
          },
          errors: {},
        }),
      };

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'git',
              transport: 'stdio' as const,
              command: 'echo',
            },
            {
              name: 'github',
              transport: 'stdio' as const,
              command: 'echo',
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).toHaveProperty('github_create_issue');
      expect(Object.keys(result)).toEqual(['github_create_issue']);
    });

    it('applies persisted dot-id disablement to grouped Mastra tools after flattening', async () => {
      mcpToolRegistry.register('filesystem', {
        'filesystem.read_file': { id: 'filesystem.read_file', description: 'read file' },
        'filesystem.list_directory': { id: 'filesystem.list_directory', description: 'list dir' },
      });
      mcpToolRegistry.disableTools(['filesystem.read_file']);

      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            filesystem: {
              read_file: { id: 'read_file', description: 'read file' },
              list_directory: { id: 'list_directory', description: 'list dir' },
            },
          },
          errors: {},
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
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });

    it('applies persisted raw-id disablement to grouped Mastra tools after flattening', async () => {
      mcpToolRegistry.register('filesystem', {
        read_file: { id: 'read_file', description: 'read file' },
        list_directory: { id: 'list_directory', description: 'list dir' },
      });
      mcpToolRegistry.disableTools(['read_file']);

      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            filesystem: {
              read_file: { id: 'read_file', description: 'read file' },
              list_directory: { id: 'list_directory', description: 'list dir' },
            },
          },
          errors: {},
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
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });

    it('merges local and MCP tools', async () => {
      const localTools: ToolsInput = {
        local_tool: { id: 'local_tool', description: 'local' },
      };

      const mockMcpClient = createMockMcpClient({
        server1: {
          remote_tool: { id: 'remote_tool', description: 'remote' },
        },
      });

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

    it('prefers grouped MCP toolsets to preserve same-name tools across servers', async () => {
      const toolNameMap = new Map<string, string>();
      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            alpha: {
              search: { id: 'search', description: 'alpha search' },
            },
            beta: {
              search: { id: 'search', description: 'beta search' },
            },
          },
          errors: {},
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

      expect(mockMcpClient.listToolsetsWithErrors).toHaveBeenCalledTimes(1);
      expect(mockMcpClient.listTools).not.toHaveBeenCalled();
      expect(Object.keys(result).sort()).toEqual(['alpha_search', 'beta_search']);
      expect(toolNameMap.get('alpha_search')).toBe('alpha.search');
      expect(toolNameMap.get('beta_search')).toBe('beta.search');
    });

    it('matches grouped MCP toolsets when returned keys use normalized server names', async () => {
      const toolNameMap = new Map<string, string>();
      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            'File System': {
              read_file: { id: 'read_file', description: 'read file' },
            },
            notes: {
              search: { id: 'search', description: 'search notes' },
            },
          },
          errors: {},
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
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            filesystem: {
              read_file: { id: 'read_file', description: 'read file' },
            },
          },
          errors: {},
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
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            alpha: {
              search: { id: 'search', description: 'search' },
            },
          },
          errors: {},
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
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            alpha: {},
          },
          errors: {},
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
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            'My Server': {
              search: { id: 'search', description: 'search' },
            },
          },
          errors: {},
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
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            alpha: {
              search: { id: 'search', description: 'search' },
            },
          },
          errors: {},
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
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          toolsets: {
            discovered: {
              search: { id: 'search', description: 'search' },
            },
          },
          errors: {},
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
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ toolsets: {}, errors: {} }), 10_000);
            })
        ),
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
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockRejectedValue(new Error('Connection failed')),
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
      const mockMcpClient = createMockMcpClient({
        server1: {
          tool1: { id: 'tool1', description: 'server1 tool' },
        },
        server2: {
          tool2: { id: 'tool2', description: 'server2 tool' },
        },
      });

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

      const keys = Object.keys(result);
      expect(keys).toEqual(['server1_tool1']);
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
      const mockMcpClient = createMockMcpClient({
        'single-server': {
          tool1: { id: 'tool1', description: 'tool 1' },
          tool2: { id: 'tool2', description: 'tool 2' },
        },
      });

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

      expect(Object.keys(result)).toEqual(['single-server_tool1', 'single-server_tool2']);
    });

    it('respects enabledTools filter', async () => {
      const mockMcpClient = createMockMcpClient({
        server: {
          tool1: { id: 'tool1', description: 'tool 1' },
          tool2: { id: 'tool2', description: 'tool 2' },
          tool3: { id: 'tool3', description: 'tool 3' },
        },
      });

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

      expect(Object.keys(result)).toEqual(['server_tool1', 'server_tool2']);
    });

    it('uses custom timeout value when provided', async () => {
      vi.useFakeTimers();
      let settled = false;
      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ toolsets: {}, errors: {} }), 50);
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
      const mockMcpClient = createMockMcpClient({
        server: {
          tool: { id: 'tool', description: 'tool' },
        },
      });

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

      expect(mockMcpClient.listToolsetsWithErrors).toHaveBeenCalledOnce();
      expect(result).toHaveProperty('server_tool');
    });

    it('loads tools from the matching grouped server name', async () => {
      const mockMcpClient = createMockMcpClient({
        myserver: {
          tool1: { id: 'tool1', description: 'tool 1' },
          tool2: { id: 'tool2', description: 'tool 2' },
        },
      });

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

      expect(Object.keys(result)).toEqual(['myserver_tool1', 'myserver_tool2']);
    });

    it('prefixes grouped single-server tools without ownership guessing', async () => {
      const mockMcpClient = createMockMcpClient({
        'empty-server': {
          other_tool: { id: 'other_tool', description: 'other tool' },
        },
      });

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

      expect(Object.keys(result)).toHaveLength(1);
      expect(result).toHaveProperty('empty-server_other_tool');
    });

    it('applies persisted enabled state using original MCP ids after sanitization', async () => {
      mcpToolRegistry.register('filesystem', {
        'filesystem.read_file': { id: 'filesystem.read_file', description: 'read file' },
        'filesystem.list_directory': { id: 'filesystem.list_directory', description: 'list dir' },
      });
      mcpToolRegistry.disableTools(['filesystem.read_file']);

      const mockMcpClient = createMockMcpClient({
        filesystem: {
          read_file: { id: 'read_file', description: 'read file' },
          list_directory: { id: 'list_directory', description: 'list dir' },
        },
      });

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

    it('applies persisted enabled state to grouped Mastra tool names', async () => {
      mcpToolRegistry.register('filesystem', {
        'filesystem.read_file': { id: 'filesystem.read_file', description: 'read file' },
        'filesystem.list_directory': { id: 'filesystem.list_directory', description: 'list dir' },
      });
      mcpToolRegistry.disableTools(['filesystem.read_file']);

      const mockMcpClient = createMockMcpClient({
        filesystem: {
          read_file: { id: 'read_file', description: 'read file' },
          list_directory: { id: 'list_directory', description: 'list dir' },
        },
      });

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
      const mockMcpClient = createMockMcpClient({
        filesystem: {
          read_file: { id: 'read_file', description: 'read file' },
          list_directory: { id: 'list_directory', description: 'list dir' },
        },
      });

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

    it('applies config enabledTools patterns to grouped Mastra MCP ids through raw ids', async () => {
      const mockMcpClient = createMockMcpClient({
        filesystem: {
          read_file: { id: 'read_file', description: 'read file' },
          list_directory: { id: 'list_directory', description: 'list dir' },
        },
      });

      const result = await collectCombinedTools({
        sanitizedLocalTools: undefined,
        mcpClient: mockMcpClient as unknown as MCPClient,
        mcpConfig: {
          servers: [
            {
              name: 'filesystem',
              transport: 'stdio' as const,
              command: 'echo',
              enabledTools: ['list_directory'],
            },
          ],
        },
        toolNameMap: new Map(),
        timeoutOverrideMs: undefined,
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });

    it('bounds oversized MCP tool output before it reaches the model stream', async () => {
      const mockMcpClient = createMockMcpClient({
        filesystem: {
          read_file: {
            id: 'read_file',
            description: 'read file',
            execute: vi.fn(async () => 'x'.repeat(13_000)),
          },
        },
      });

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

      const tool = result['filesystem_read_file'];
      expect(typeof (tool as { execute?: unknown } | undefined)?.execute).toBe('function');

      const output = await (tool as { execute: () => Promise<unknown> }).execute();

      expect(output).toMatchObject({
        code: 'tool_result_too_large',
        truncated: true,
      });
    });
  });
});

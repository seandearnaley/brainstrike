import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import type { ToolsInput } from '@mastra/core/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpRuntimeClient } from '../mastra/mcp-runtime-client';
import { collectCombinedTools } from '../mastra/mcp-tool-loader';
import { toolRegistry as mcpToolRegistry } from '../mcp/tool-registry';
import { MAX_TOOL_RESULT_TOKENS } from '../stream/tool-output-limits';

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
    listToolsetsWithErrors: vi.fn().mockResolvedValue({ errors, toolsets }),
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
        local_tool: { description: 'local', id: 'local_tool' },
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: undefined,
        mcpConfig: undefined,
        sanitizedLocalTools: localTools,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).toEqual(localTools);
    });

    it('returns only local tools when no MCP config', async () => {
      const localTools: ToolsInput = {
        local_tool: { description: 'local', id: 'local_tool' },
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: { configuredServers: [] } as McpRuntimeClient,
        mcpConfig: undefined,
        sanitizedLocalTools: localTools,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).toEqual(localTools);
    });

    it('returns empty object when no local tools and no MCP', async () => {
      const { tools: result } = await collectCombinedTools({
        mcpClient: undefined,
        mcpConfig: undefined,
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).toEqual({});
    });

    it('handles MCP client with empty servers array', async () => {
      const localTools: ToolsInput = {
        local_tool: { description: 'local', id: 'local_tool' },
      };

      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue({}),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: { servers: [] },
        sanitizedLocalTools: localTools,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).toEqual(localTools);
    });

    it('loads MCP tools from the official server-grouped toolsets API', async () => {
      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          errors: {},
          toolsets: {
            filesystem: {
              read_file: { description: 'read file', id: 'read_file' },
            },
          },
        }),
      };

      const toolNameMap = new Map<string, string>();

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap,
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
          errors: {
            broken: 'Connection closed',
          },
          toolsets: {
            healthy: {
              search: { description: 'search', id: 'search' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'healthy',
              transport: 'stdio' as const,
            },
            {
              command: 'false',
              name: 'broken',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).toHaveProperty('healthy_search');
      expect(result).not.toHaveProperty('broken_search');
    });

    it('logs when a configured MCP server has neither a toolset nor a discovery error', async () => {
      const logRecords: LogRecord[] = [];
      const removeLogListener = addLogListener((record) => logRecords.push(record));
      const mockMcpClient = createMockMcpClient({
        healthy: {
          search: { description: 'search', id: 'search' },
        },
      });

      try {
        const { tools: result } = await collectCombinedTools({
          mcpClient: mockMcpClient as unknown as McpRuntimeClient,
          mcpConfig: {
            servers: [
              {
                command: 'echo',
                name: 'healthy',
                transport: 'stdio' as const,
              },
              {
                command: 'echo',
                name: 'missing',
                transport: 'stdio' as const,
              },
            ],
          },
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
          timeoutOverrideMs: undefined,
          toolNameMap: new Map(),
        });

        expect(result).toHaveProperty('healthy_search');
        expect(logRecords).toContainEqual(
          expect.objectContaining({
            args: [
              'MCP toolset did not match configured server',
              expect.objectContaining({
                code: 'mcp_toolset_server_key_missing',
                serverName: 'missing',
              }),
            ],
            level: 'warn',
            message: 'MCP toolset did not match configured server',
            scope: 'MastraAgentMcpTools',
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
          errors: {},
          toolsets: {
            github: {
              create_issue: { description: 'create issue', id: 'create_issue' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'git',
              transport: 'stdio' as const,
            },
            {
              command: 'echo',
              name: 'github',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).toHaveProperty('github_create_issue');
      expect(Object.keys(result)).toEqual(['github_create_issue']);
    });

    it('applies persisted dot-id disablement to grouped Mastra tools after flattening', async () => {
      mcpToolRegistry.register('filesystem', {
        'filesystem.list_directory': { description: 'list dir', id: 'filesystem.list_directory' },
        'filesystem.read_file': { description: 'read file', id: 'filesystem.read_file' },
      });
      mcpToolRegistry.disableTools(['filesystem.read_file']);

      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          errors: {},
          toolsets: {
            filesystem: {
              list_directory: { description: 'list dir', id: 'list_directory' },
              read_file: { description: 'read file', id: 'read_file' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });

    it('applies persisted raw-id disablement to grouped Mastra tools after flattening', async () => {
      mcpToolRegistry.register('filesystem', {
        list_directory: { description: 'list dir', id: 'list_directory' },
        read_file: { description: 'read file', id: 'read_file' },
      });
      mcpToolRegistry.disableTools(['read_file']);

      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockResolvedValue({
          errors: {},
          toolsets: {
            filesystem: {
              list_directory: { description: 'list dir', id: 'list_directory' },
              read_file: { description: 'read file', id: 'read_file' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });

    it('merges local and MCP tools', async () => {
      const localTools: ToolsInput = {
        local_tool: { description: 'local', id: 'local_tool' },
      };

      const mockMcpClient = createMockMcpClient({
        server1: {
          remote_tool: { description: 'remote', id: 'remote_tool' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'server1',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: localTools,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
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
          errors: {},
          toolsets: {
            alpha: {
              search: { description: 'alpha search', id: 'search' },
            },
            beta: {
              search: { description: 'beta search', id: 'search' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'alpha',
              transport: 'stdio' as const,
            },
            {
              command: 'echo',
              name: 'beta',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap,
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
          errors: {},
          toolsets: {
            'File System': {
              read_file: { description: 'read file', id: 'read_file' },
            },
            notes: {
              search: { description: 'search notes', id: 'search' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
            {
              command: 'echo',
              name: 'notes',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap,
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
          errors: {},
          toolsets: {
            filesystem: {
              read_file: { description: 'read file', id: 'read_file' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'file',
              transport: 'stdio' as const,
            },
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap,
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
          errors: {},
          toolsets: {
            alpha: {
              search: { description: 'search', id: 'search' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'Alpha',
              transport: 'stdio' as const,
            },
            {
              command: 'echo',
              name: 'alpha',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap,
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
          errors: {},
          toolsets: {
            alpha: {},
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'alpha',
              transport: 'stdio' as const,
            },
            {
              command: 'echo',
              name: 'beta',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
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
          errors: {},
          toolsets: {
            'My Server': {
              search: { description: 'search', id: 'search' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'my-server',
              transport: 'stdio' as const,
            },
            {
              command: 'echo',
              name: 'my_server',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap,
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
          errors: {},
          toolsets: {
            alpha: {
              search: { description: 'search', id: 'search' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'alpha',
              transport: 'stdio' as const,
            },
            {
              command: 'echo',
              name: 'renamed-alpha',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
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
          errors: {},
          toolsets: {
            discovered: {
              search: { description: 'search', id: 'search' },
            },
          },
        }),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'configured-server',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap,
      });

      expect(result).toHaveProperty('configured-server_search');
      expect(toolNameMap.get('configured-server_search')).toBe('configured-server.search');
    });

    it('handles MCP tool discovery timeout', async () => {
      const localTools: ToolsInput = {
        local_tool: { description: 'local', id: 'local_tool' },
      };

      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ errors: {}, toolsets: {} }), 10_000);
            })
        ),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'server1',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: localTools,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: 100, // Short timeout
        toolNameMap: new Map(),
      });

      // Should still return local tools even if MCP times out
      expect(result).toEqual(localTools);
    });

    it('handles MCP tool discovery error', async () => {
      const localTools: ToolsInput = {
        local_tool: { description: 'local', id: 'local_tool' },
      };

      const mockMcpClient = {
        listTools: vi.fn().mockRejectedValue(new Error('listTools should not be called')),
        listToolsetsWithErrors: vi.fn().mockRejectedValue(new Error('Connection failed')),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'server1',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: localTools,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      // Should still return local tools even if MCP fails
      expect(result).toEqual(localTools);
    });

    it('filters tools for specific server', async () => {
      const mockMcpClient = createMockMcpClient({
        server1: {
          tool1: { description: 'server1 tool', id: 'tool1' },
        },
        server2: {
          tool2: { description: 'server2 tool', id: 'tool2' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'server1',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      const keys = Object.keys(result);
      expect(keys).toEqual(['server1_tool1']);
    });

    it('handles servers without names', async () => {
      const mockMcpTools: ToolsInput = {
        remote_tool: { description: 'remote', id: 'remote_tool' },
      };

      const mockMcpClient = {
        listTools: vi.fn().mockResolvedValue(mockMcpTools),
      };

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: undefined as unknown as string,
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      // Server without name should be skipped
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('handles single server with all tools', async () => {
      const mockMcpClient = createMockMcpClient({
        'single-server': {
          tool1: { description: 'tool 1', id: 'tool1' },
          tool2: { description: 'tool 2', id: 'tool2' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'single-server',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(Object.keys(result)).toEqual(['single-server_tool1', 'single-server_tool2']);
    });

    it('respects enabledTools filter', async () => {
      const mockMcpClient = createMockMcpClient({
        server: {
          tool1: { description: 'tool 1', id: 'tool1' },
          tool2: { description: 'tool 2', id: 'tool2' },
          tool3: { description: 'tool 3', id: 'tool3' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              enabledTools: ['server.tool1', 'server.tool2'],
              name: 'server',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
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
              setTimeout(() => resolve({ errors: {}, toolsets: {} }), 50);
            })
        ),
      };

      const resultPromise = collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'server',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: 10, // Very short timeout
        toolNameMap: new Map(),
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(9);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      // The honoured override also reaches the skip it reports, so the run
      // records WHICH ceiling it lost against rather than a bare "no tools".
      await expect(resultPromise).resolves.toEqual({
        mcpDiscoverySkips: [
          {
            reason: 'mcp_tool_discovery_timeout: timeout_10',
            scope: 'client',
            serverNames: ['server'],
            timeoutMs: 10,
          },
        ],
        tools: {},
      });
      expect(settled).toBe(true);
    });

    it('handles invalid timeout values by using default', async () => {
      const mockMcpClient = createMockMcpClient({
        server: {
          tool: { description: 'tool', id: 'tool' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'server',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: -1, // Invalid timeout
        toolNameMap: new Map(),
      });

      expect(mockMcpClient.listToolsetsWithErrors).toHaveBeenCalledOnce();
      expect(result).toHaveProperty('server_tool');
    });

    it('loads tools from the matching grouped server name', async () => {
      const mockMcpClient = createMockMcpClient({
        myserver: {
          tool1: { description: 'tool 1', id: 'tool1' },
          tool2: { description: 'tool 2', id: 'tool2' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'myserver',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(Object.keys(result)).toEqual(['myserver_tool1', 'myserver_tool2']);
    });

    it('prefixes grouped single-server tools without ownership guessing', async () => {
      const mockMcpClient = createMockMcpClient({
        'empty-server': {
          other_tool: { description: 'other tool', id: 'other_tool' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'empty-server',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(Object.keys(result)).toHaveLength(1);
      expect(result).toHaveProperty('empty-server_other_tool');
    });

    it('applies persisted enabled state using original MCP ids after sanitization', async () => {
      mcpToolRegistry.register('filesystem', {
        'filesystem.list_directory': { description: 'list dir', id: 'filesystem.list_directory' },
        'filesystem.read_file': { description: 'read file', id: 'filesystem.read_file' },
      });
      mcpToolRegistry.disableTools(['filesystem.read_file']);

      const mockMcpClient = createMockMcpClient({
        filesystem: {
          list_directory: { description: 'list dir', id: 'list_directory' },
          read_file: { description: 'read file', id: 'read_file' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
      expect(mcpToolRegistry.getToolsForServer('filesystem')).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'filesystem.read_file' })])
      );
    });

    it('applies persisted enabled state to grouped Mastra tool names', async () => {
      mcpToolRegistry.register('filesystem', {
        'filesystem.list_directory': { description: 'list dir', id: 'filesystem.list_directory' },
        'filesystem.read_file': { description: 'read file', id: 'filesystem.read_file' },
      });
      mcpToolRegistry.disableTools(['filesystem.read_file']);

      const mockMcpClient = createMockMcpClient({
        filesystem: {
          list_directory: { description: 'list dir', id: 'list_directory' },
          read_file: { description: 'read file', id: 'read_file' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });

    it('applies config enabledTools patterns to sanitized Mastra MCP ids through registry ids', async () => {
      const mockMcpClient = createMockMcpClient({
        filesystem: {
          list_directory: { description: 'list dir', id: 'list_directory' },
          read_file: { description: 'read file', id: 'read_file' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              enabledTools: ['filesystem.list_directory'],
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });

    it('applies config enabledTools patterns to grouped Mastra MCP ids through raw ids', async () => {
      const mockMcpClient = createMockMcpClient({
        filesystem: {
          list_directory: { description: 'list dir', id: 'list_directory' },
          read_file: { description: 'read file', id: 'read_file' },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              enabledTools: ['list_directory'],
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result).not.toHaveProperty('filesystem_read_file');
      expect(result).toHaveProperty('filesystem_list_directory');
    });

    it('keeps oversized text-only MCP persistence within the resolved transport ceiling', async () => {
      const mockMcpClient = createMockMcpClient({
        filesystem: {
          read_file: {
            description: 'read file',
            execute: vi.fn(async () => 'x'.repeat(13_000)),
            id: 'read_file',
          },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: 1000,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      const tool = result['filesystem_read_file'];
      expect(typeof (tool as { execute?: unknown } | undefined)?.execute).toBe('function');

      const output = await (tool as { execute: () => Promise<unknown> }).execute();

      expect(output).toMatchObject({
        code: 'tool_result_truncated',
        maxTokens: 1000,
        truncated: true,
      });
      expect(JSON.stringify(output).length).toBeLessThanOrEqual(4000);
    });

    it('preserves complete oversized MCP output when durable settlement is enabled', async () => {
      const completeOutput = `head-${'x'.repeat(13_000)}-tail`;
      const mockMcpClient = createMockMcpClient({
        filesystem: {
          read_file: {
            description: 'read file',
            execute: vi.fn(async () => completeOutput),
            id: 'read_file',
          },
        },
      });

      const { tools: result } = await collectCombinedTools({
        durableArtifactSettlement: true,
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'filesystem',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      const tool = result['filesystem_read_file'] as { execute: () => Promise<unknown> };
      await expect(tool.execute()).resolves.toBe(completeOutput);
    });

    it('preserves bounded MCP image and audio output for model-native projection', async () => {
      const rawOutput = {
        content: [
          { text: 'A tiny caption.', type: 'text' },
          { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
          { data: 'UklGRg==', mimeType: 'audio/wav', type: 'audio' },
        ],
      };
      const mockMcpClient = createMockMcpClient({
        remote: {
          multimodal: {
            description: 'return media',
            execute: vi.fn(async () => rawOutput),
            id: 'multimodal',
          },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'remote',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      const tool = result['remote_multimodal'] as { execute: () => Promise<unknown> };
      await expect(tool.execute()).resolves.toEqual(rawOutput);
    });

    it.each([false, true])(
      'fails visibly when MCP inline media exceeds its ceiling (durable settlement: %s)',
      async (durableArtifactSettlement) => {
        const mockMcpClient = createMockMcpClient({
          remote: {
            oversized_media: {
              description: 'return oversized media',
              execute: vi.fn(async () => ({
                content: [
                  {
                    data: 'x'.repeat(14_000_000),
                    mimeType: 'image/png',
                    type: 'image',
                  },
                ],
              })),
              id: 'oversized_media',
            },
          },
        });

        const { tools: result } = await collectCombinedTools({
          durableArtifactSettlement,
          mcpClient: mockMcpClient as unknown as McpRuntimeClient,
          mcpConfig: {
            servers: [
              {
                command: 'echo',
                name: 'remote',
                transport: 'stdio' as const,
              },
            ],
          },
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
          timeoutOverrideMs: undefined,
          toolNameMap: new Map(),
        });

        const tool = result['remote_oversized_media'] as { execute: () => Promise<unknown> };
        await expect(tool.execute()).rejects.toThrow(
          'MCP tool remote.oversized_media returned 14000000 inline media characters'
        );
      }
    );

    it('fails visibly when MCP media metadata hides an oversized text payload', async () => {
      const mockMcpClient = createMockMcpClient({
        remote: {
          oversized_caption: {
            description: 'return oversized caption',
            execute: vi.fn(async () => ({
              content: [
                { text: 'x'.repeat(13_000), type: 'text' },
                { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
              ],
            })),
            id: 'oversized_caption',
          },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'remote',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      const tool = result['remote_oversized_caption'] as { execute: () => Promise<unknown> };
      await expect(tool.execute()).rejects.toThrow(
        'MCP tool remote.oversized_caption returned 13089 non-media serialized characters'
      );
    });

    it('fails visibly when MCP media accompanies oversized structured content', async () => {
      const mockMcpClient = createMockMcpClient({
        remote: {
          oversized_structured_content: {
            description: 'return media with oversized structured content',
            execute: vi.fn(async () => ({
              content: [{ data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' }],
              structuredContent: { payload: 'x'.repeat(13_000) },
            })),
            id: 'oversized_structured_content',
          },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'remote',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      const tool = result['remote_oversized_structured_content'] as {
        execute: () => Promise<unknown>;
      };
      await expect(tool.execute()).rejects.toThrow(
        /MCP tool remote\.oversized_structured_content returned \d+ non-media serialized characters/
      );
    });

    it('fails visibly when malformed MCP content would escape persistence accounting', async () => {
      const mockMcpClient = createMockMcpClient({
        remote: {
          malformed_content: {
            description: 'return malformed media content',
            execute: vi.fn(async () => ({
              content: [
                'x'.repeat(13_000),
                { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
              ],
            })),
            id: 'malformed_content',
          },
        },
      });

      const { tools: result } = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'remote',
              transport: 'stdio' as const,
            },
          ],
        },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      const tool = result['remote_malformed_content'] as { execute: () => Promise<unknown> };
      await expect(tool.execute()).rejects.toThrow(
        'MCP multimodal content must contain only object parts'
      );
    });
  });

  describe('discovery skip reporting (BST-1602)', () => {
    const stdioServer = (name: string) => ({ command: 'echo', name, transport: 'stdio' as const });

    it('reports a client-scope skip and logs at warn when discovery rejects', async () => {
      const logRecords: LogRecord[] = [];
      const removeLogListener = addLogListener((record) => logRecords.push(record));
      const mockMcpClient = {
        listTools: vi.fn(),
        // "Connection closed" is one of the two reasons the deleted
        // `pickMcpDiscoveryLogMethod` demoted to `debug`.
        listToolsetsWithErrors: vi.fn().mockRejectedValue(new Error('Connection closed')),
      };

      try {
        const result = await collectCombinedTools({
          mcpClient: mockMcpClient as unknown as McpRuntimeClient,
          mcpConfig: { servers: [stdioServer('alpha'), stdioServer('beta')] },
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
          timeoutOverrideMs: undefined,
          toolNameMap: new Map(),
        });

        // ONE skip for one lost race, naming both servers — never two skips.
        expect(result.mcpDiscoverySkips).toEqual([
          {
            reason: 'Connection closed',
            scope: 'client',
            serverNames: ['alpha', 'beta'],
            timeoutMs: 5000,
          },
        ]);
        expect(logRecords).toContainEqual(
          expect.objectContaining({
            level: 'warn',
            message: 'MCP tool discovery skipped',
            scope: 'MastraAgentMcpTools',
          })
        );
      } finally {
        removeLogListener();
      }
    });

    it('reports a client-scope skip and logs at warn when discovery times out', async () => {
      vi.useFakeTimers();
      const logRecords: LogRecord[] = [];
      const removeLogListener = addLogListener((record) => logRecords.push(record));
      const mockMcpClient = {
        listTools: vi.fn(),
        listToolsetsWithErrors: vi.fn().mockReturnValue(new Promise(() => undefined)),
      };

      try {
        const resultPromise = collectCombinedTools({
          mcpClient: mockMcpClient as unknown as McpRuntimeClient,
          mcpConfig: { servers: [stdioServer('alpha')] },
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
          timeoutOverrideMs: undefined,
          toolNameMap: new Map(),
        });
        await vi.advanceTimersByTimeAsync(5000);
        const result = await resultPromise;

        expect(result.mcpDiscoverySkips).toEqual([
          {
            reason: 'mcp_tool_discovery_timeout: timeout_5000',
            scope: 'client',
            serverNames: ['alpha'],
            timeoutMs: 5000,
          },
        ]);
        // The second reason the deleted heuristic demoted to `debug`.
        expect(logRecords).toContainEqual(
          expect.objectContaining({ level: 'warn', message: 'MCP tool discovery skipped' })
        );
      } finally {
        removeLogListener();
      }
    });

    it('reports one server-scope skip per failing server and logs each at warn', async () => {
      const logRecords: LogRecord[] = [];
      const removeLogListener = addLogListener((record) => logRecords.push(record));
      const mockMcpClient = createMockMcpClient(
        { alpha: { search: { description: 'search', id: 'search' } } },
        { beta: 'Connection closed' }
      );

      try {
        const result = await collectCombinedTools({
          mcpClient: mockMcpClient as unknown as McpRuntimeClient,
          mcpConfig: { servers: [stdioServer('alpha'), stdioServer('beta')] },
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
          timeoutOverrideMs: undefined,
          toolNameMap: new Map(),
        });

        expect(result.tools).toHaveProperty('alpha_search');
        expect(result.mcpDiscoverySkips).toEqual([
          { reason: 'Connection closed', scope: 'server', serverName: 'beta', timeoutMs: 5000 },
        ]);
        expect(logRecords).toContainEqual(
          expect.objectContaining({
            level: 'warn',
            message: 'MCP server tool discovery skipped',
          })
        );
      } finally {
        removeLogListener();
      }
    });

    it('reports no skips when discovery is healthy', async () => {
      const mockMcpClient = createMockMcpClient({
        alpha: { search: { description: 'search', id: 'search' } },
      });

      const result = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: { servers: [stdioServer('alpha')] },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result.mcpDiscoverySkips).toEqual([]);
    });

    it('bounds a long reason before it becomes durable metadata', async () => {
      const mockMcpClient = {
        listTools: vi.fn(),
        listToolsetsWithErrors: vi.fn().mockRejectedValue(new Error('x'.repeat(500))),
      };

      const result = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: { servers: [stdioServer('alpha')] },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      // 199 + the ellipsis: the bound is a TOTAL, ellipsis included.
      expect(result.mcpDiscoverySkips[0]?.reason).toBe(`${'x'.repeat(199)}\u2026`);
    });
  });
});

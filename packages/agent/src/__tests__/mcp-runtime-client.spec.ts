import { addLogListener, type LogRecord } from '@brainstrike/utils/logger';
import type { ToolsInput } from '@mastra/core/agent';
import { type StandardSchemaWithJSON, standardSchemaToJSONSchema } from '@mastra/core/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpRuntimeClient,
  MCP_PROGRESS_STREAM_PART_TYPE,
  mapMcpProgressStreamPart,
} from '../mastra/mcp-runtime-client';
import type {
  ExplicitHttpMcpCallToolParams,
  ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpRequestOptions,
} from '../mcp/explicit-http-client';

type ExecutableTool = ToolsInput[string] & {
  execute: (input: unknown, context?: unknown) => Promise<unknown>;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

function requireExecutableTool(tool: ToolsInput[string] | undefined): ExecutableTool {
  if (!tool || typeof (tool as { execute?: unknown }).execute !== 'function') {
    throw new Error('Expected an executable MCP tool');
  }
  return tool as ExecutableTool;
}

describe('MCP runtime client', () => {
  it('rejects duplicate server names before constructing any transport client', () => {
    const createExplicitHttpClient = vi.fn();
    const createMastraClient = vi.fn();

    expect(() =>
      createMcpRuntimeClient({
        config: {
          servers: [
            { command: 'node', name: 'duplicate', transport: 'stdio' },
            {
              name: 'duplicate',
              transport: 'streamable-http',
              url: 'https://example.com/mcp',
            },
          ],
        },
        dependencies: { createExplicitHttpClient, createMastraClient },
        id: 'duplicate-test',
      })
    ).toThrow('duplicate server name');
    expect(createMastraClient).not.toHaveBeenCalled();
    expect(createExplicitHttpClient).not.toHaveBeenCalled();
  });

  it('partitions stdio into Mastra while explicit HTTP clients keep their selected transports', async () => {
    const stdioClient = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      listToolsetsWithErrors: vi.fn().mockResolvedValue({
        errors: {},
        toolsets: {
          local: {
            inspect: { description: 'Inspect locally', id: 'inspect' },
          },
        },
      }),
    };
    const createMastraClient = vi.fn(() => stdioClient);
    const streamableClient = {
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    };
    const sseClient = {
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    };
    const createExplicitHttpClient = vi.fn((options: { name: string }) =>
      options.name === 'streamable' ? streamableClient : sseClient
    );

    const runtimeClient = createMcpRuntimeClient({
      config: {
        servers: [
          {
            args: ['server.js'],
            command: 'node',
            env: { NODE_ENV: 'test' },
            name: 'local',
            transport: 'stdio',
          },
          {
            headers: { Authorization: 'Bearer streamable' },
            name: 'streamable',
            transport: 'streamable-http',
            url: 'https://example.com/sse',
          },
          {
            headers: { Authorization: 'Bearer legacy' },
            name: 'legacy',
            transport: 'sse',
            url: 'https://example.com/mcp',
          },
        ],
      },
      dependencies: { createExplicitHttpClient, createMastraClient },
      id: 'partition-test',
    });

    expect(runtimeClient).toBeDefined();
    expect(createMastraClient).toHaveBeenCalledOnce();
    expect(createMastraClient).toHaveBeenCalledWith({
      id: 'partition-test-stdio',
      servers: {
        local: {
          args: ['server.js'],
          command: 'node',
          env: { NODE_ENV: 'test' },
        },
      },
    });
    expect(createExplicitHttpClient).toHaveBeenNthCalledWith(1, {
      headers: { Authorization: 'Bearer streamable' },
      name: 'streamable',
      transport: 'streamable-http',
      url: 'https://example.com/sse',
    });
    expect(createExplicitHttpClient).toHaveBeenNthCalledWith(2, {
      headers: { Authorization: 'Bearer legacy' },
      name: 'legacy',
      transport: 'sse',
      url: 'https://example.com/mcp',
    });

    await runtimeClient?.disconnect();
    expect(stdioClient.disconnect).toHaveBeenCalledOnce();
    expect(streamableClient.close).toHaveBeenCalledOnce();
    expect(sseClient.close).toHaveBeenCalledOnce();
  });

  it('logs disconnect failures without poisoning a completed run or skipping other clients', async () => {
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    const brokenClient = {
      callTool: vi.fn(),
      close: vi.fn().mockRejectedValue(new Error('DELETE failed')),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    };
    const healthyClient = {
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    };
    const runtimeClient = createMcpRuntimeClient({
      config: {
        servers: [
          {
            name: 'broken',
            transport: 'streamable-http',
            url: 'https://broken.example/mcp',
          },
          {
            name: 'healthy',
            transport: 'sse',
            url: 'https://healthy.example/sse',
          },
        ],
      },
      dependencies: {
        createExplicitHttpClient: vi.fn((options: { name: string }) =>
          options.name === 'broken' ? brokenClient : healthyClient
        ),
        createMastraClient: vi.fn(() => {
          throw new Error('Mastra must not receive HTTP servers');
        }),
      },
      id: 'disconnect-test',
    });

    try {
      await expect(runtimeClient?.disconnect()).resolves.toBeUndefined();
      expect(brokenClient.close).toHaveBeenCalledOnce();
      expect(healthyClient.close).toHaveBeenCalledOnce();
      expect(logRecords).toContainEqual(
        expect.objectContaining({
          args: ['MCP client disconnect failed', expect.objectContaining({ serverName: 'broken' })],
          level: 'warn',
          scope: 'MastraAgentMcpRuntimeClient',
        })
      );
    } finally {
      removeLogListener();
    }
  });

  it('converts explicit HTTP tools without losing schemas, metadata, cancellation, or progress', async () => {
    const abortController = new AbortController();
    const progressWrites: unknown[] = [];
    const callTool = vi.fn(
      async (
        _params: ExplicitHttpMcpCallToolParams,
        options?: ExplicitHttpMcpRequestOptions
      ): Promise<ExplicitHttpMcpCallToolResult> => {
        options?.onprogress?.({ message: 'Halfway', progress: 1, total: 2 });
        return {
          content: [{ text: 'fallback text', type: 'text' }],
          structuredContent: { echoed: 'hello' },
        };
      }
    );
    const explicitClient = {
      callTool,
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            _meta: {
              mastra: { strict: true },
              ui: { resourceUri: 'ui://echo/card' },
            },
            annotations: { readOnlyHint: true, title: 'Echo' },
            description: 'Echo a value',
            inputSchema: {
              properties: { value: { type: 'string' } },
              required: ['value'],
              type: 'object',
            },
            name: 'echo',
            outputSchema: {
              properties: { echoed: { type: 'string' } },
              required: ['echoed'],
              type: 'object',
            },
          },
        ],
      }),
    };
    const runtimeClient = createMcpRuntimeClient({
      config: {
        servers: [
          {
            name: 'remote',
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        ],
      },
      dependencies: {
        createExplicitHttpClient: vi.fn(() => explicitClient),
        createMastraClient: vi.fn(() => {
          throw new Error('Mastra must not receive HTTP servers');
        }),
      },
      id: 'conversion-test',
    });

    const discovered = await runtimeClient?.listToolsetsWithErrors();
    expect(discovered?.errors).toEqual({});
    const tool = requireExecutableTool(discovered?.toolsets['remote']?.['echo']);
    expect(tool).toMatchObject({
      description: 'Echo a value',
      id: 'remote_echo',
      mcp: {
        _meta: {
          mastra: { strict: true },
          ui: { resourceUri: 'ui://echo/card', serverId: 'remote' },
        },
        annotations: { readOnlyHint: true, title: 'Echo' },
      },
      mcpMetadata: { serverName: 'remote' },
      strict: true,
    });
    expect(
      standardSchemaToJSONSchema(tool.inputSchema as StandardSchemaWithJSON, { io: 'input' })
    ).toMatchObject({
      properties: { value: { type: 'string' } },
      required: ['value'],
      type: 'object',
    });
    expect(standardSchemaToJSONSchema(tool.outputSchema as StandardSchemaWithJSON)).toMatchObject({
      properties: { echoed: { type: 'string' } },
      required: ['echoed'],
      type: 'object',
    });

    await expect(
      tool.execute(
        { value: 'hello' },
        {
          _meta: { traceId: 'trace-1' },
          abortSignal: abortController.signal,
          agent: { toolCallId: 'call-1' },
          writer: {
            custom: async (part: unknown) => {
              progressWrites.push(part);
            },
          },
        }
      )
    ).resolves.toEqual({ echoed: 'hello' });
    expect(callTool).toHaveBeenCalledWith(
      {
        _meta: { traceId: 'trace-1' },
        arguments: { value: 'hello' },
        name: 'echo',
      },
      expect.objectContaining({
        onprogress: expect.any(Function),
        signal: abortController.signal,
      })
    );
    expect(progressWrites).toEqual([
      {
        message: 'Halfway',
        progress: 1,
        toolCallId: 'call-1',
        toolName: 'remote.echo',
        total: 2,
        type: MCP_PROGRESS_STREAM_PART_TYPE,
      },
    ]);
    expect(mapMcpProgressStreamPart(progressWrites[0])).toEqual({
      name: 'remote.echo',
      payload: {
        callId: 'call-1',
        note: 'Halfway',
        percent: 50,
        raw: { done: 1, message: 'Halfway', total: 2 },
        toolCallId: 'call-1',
      },
      status: 'progress',
      type: 'tool-event',
    });

    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    try {
      await expect(
        tool.execute(
          { value: 'hello' },
          {
            agent: { toolCallId: 'call-progress-failure' },
            writer: {
              custom: vi.fn().mockRejectedValue(new Error('progress channel closed')),
            },
          }
        )
      ).resolves.toEqual({ echoed: 'hello' });
      expect(logRecords).toContainEqual(
        expect.objectContaining({
          args: [
            'MCP progress delivery failed',
            expect.objectContaining({ serverName: 'remote', toolName: 'echo' }),
          ],
          level: 'warn',
          scope: 'MastraAgentMcpRuntimeClient',
        })
      );
    } finally {
      removeLogListener();
    }
  });

  it('isolates explicit HTTP discovery failures and throws in-band tool errors', async () => {
    const healthyClient = {
      callTool: vi.fn(
        async (
          _params: unknown,
          options?: { onprogress?: (progress: unknown) => void }
        ): Promise<unknown> => {
          options?.onprogress?.({ progress: 1, total: 2 });
          return {
            content: [{ text: 'intentional failure', type: 'text' }],
            isError: true,
          };
        }
      ),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            description: 'Fail intentionally',
            inputSchema: { type: 'object' },
            name: 'fail',
          },
        ],
      }),
    };
    const brokenClient = {
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const runtimeClient = createMcpRuntimeClient({
      config: {
        servers: [
          {
            name: 'healthy',
            transport: 'streamable-http',
            url: 'https://healthy.example/mcp',
          },
          {
            name: 'broken',
            transport: 'sse',
            url: 'https://broken.example/sse',
          },
        ],
      },
      dependencies: {
        createExplicitHttpClient: vi.fn((options: { name: string }) =>
          options.name === 'healthy' ? healthyClient : brokenClient
        ),
        createMastraClient: vi.fn(() => {
          throw new Error('Mastra must not receive HTTP servers');
        }),
      },
      id: 'error-test',
    });

    const discovered = await runtimeClient?.listToolsetsWithErrors();
    expect(discovered?.errors).toEqual({ broken: 'connection refused' });
    const tool = requireExecutableTool(discovered?.toolsets['healthy']?.['fail']);
    await expect(
      tool.execute(
        {},
        {
          agent: { toolCallId: 'call-error' },
          writer: {
            custom: vi.fn().mockRejectedValue(new Error('progress channel closed')),
          },
        }
      )
    ).rejects.toThrow('intentional failure');
  });
});

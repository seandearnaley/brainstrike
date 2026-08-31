import { type McpHostPort, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
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

interface TestHostClient {
  callTool: (...args: unknown[]) => Promise<ExplicitHttpMcpCallToolResult>;
  close: ReturnType<typeof vi.fn>;
  listTools: () => Promise<{ tools: unknown[] }>;
  release?: () => void;
}

function createTestHost(clients: Record<string, TestHostClient>) {
  const unwatch = vi.fn();
  const host: McpHostPort = {
    close: vi.fn(async () => ({
      callbacksClosed: 0,
      childProcessesClosed: 0,
      clientsClosed: 0,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 0,
      subscriptionsClosed: 0,
    })),
    invoke: vi.fn(async (operation, options) => {
      const client = clients[operation.configuredServerId];
      if (!client) {
        throw new Error('unknown server');
      }
      if (operation.type === 'tools/list') {
        return { result: await client.listTools(), type: 'tools/list' } as const;
      }
      return {
        result: await client.callTool(
          {
            ...(operation._meta ? { _meta: operation._meta } : {}),
            ...(operation.arguments ? { arguments: operation.arguments } : {}),
            name: operation.toolName,
          },
          {
            ...(options?.onProgress ? { onprogress: options.onProgress } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
          }
        ),
        type: 'tools/call',
      } as const;
    }),
    replaceConfig: vi.fn(),
    snapshot: () => ({
      revision: 1,
      servers: Object.keys(clients).map((name) => ({
        configuredProtocol: 'legacy' as const,
        configuredServerId: parseConfiguredMcpServerId(name),
        generation: 7,
        state: 'disconnected' as const,
        transport: 'stdio' as const,
      })),
    }),
    watch: vi.fn((filter) => {
      const ids = filter.configuredServerIds;
      if (ids?.length !== 1) {
        throw new Error('test host requires one configured server id per lease');
      }
      return clients[ids[0]]?.release ?? unwatch;
    }),
  };
  return { host, unwatch };
}

describe('MCP runtime client', () => {
  it('rejects legacy runtime MCP config without a host capability', async () => {
    await expect(
      createMcpRuntimeClient({
        config: {
          servers: [{ command: 'node', name: 'legacy', transport: 'stdio' }],
        },
      })
    ).rejects.toThrow('MCP host capability');
  });

  it('discovers every configured transport through one host authority', async () => {
    const stdioClient = {
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            description: 'Inspect locally',
            inputSchema: { type: 'object' },
            name: 'inspect',
          },
        ],
      }),
    };
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
    const { host } = createTestHost({
      legacy: sseClient,
      local: stdioClient,
      streamable: streamableClient,
    });

    const runtimeClient = await createMcpRuntimeClient({
      config: undefined,
      host,
    });

    expect(runtimeClient).toBeDefined();

    await expect(runtimeClient?.listToolsetsWithErrors()).resolves.toMatchObject({
      errors: {},
      toolsets: {
        local: {
          inspect: expect.objectContaining({
            description: 'Inspect locally',
            id: 'local_inspect',
          }),
        },
      },
    });
    const runtimeB = await createMcpRuntimeClient({ config: undefined, host });
    const approvalResume = await createMcpRuntimeClient({ config: undefined, host });
    await runtimeClient?.disconnect();
    await approvalResume?.disconnect();
    await expect(runtimeB?.listToolsetsWithErrors()).resolves.toMatchObject({ errors: {} });
    expect(host.watch).toHaveBeenCalledTimes(9);
    expect(host.replaceConfig).not.toHaveBeenCalled();
    expect(host.close).not.toHaveBeenCalled();
    expect(stdioClient.close).not.toHaveBeenCalled();
    await runtimeB?.disconnect();
  });

  it('logs adapter release failures without closing host-owned clients', async () => {
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    const brokenClient = {
      callTool: vi.fn(),
      close: vi.fn().mockRejectedValue(new Error('DELETE failed')),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      release: vi.fn(() => {
        throw new Error('watch release failed');
      }),
    };
    const healthyClient = {
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    };
    const { host, unwatch } = createTestHost({ broken: brokenClient, healthy: healthyClient });
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });

    try {
      await expect(runtimeClient?.disconnect()).resolves.toBeUndefined();
      expect(brokenClient.close).not.toHaveBeenCalled();
      expect(healthyClient.close).not.toHaveBeenCalled();
      expect(unwatch).toHaveBeenCalledOnce();
      expect(logRecords).toContainEqual(
        expect.objectContaining({
          args: ['MCP adapter release failed', expect.objectContaining({ serverName: 'broken' })],
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
    const { host } = createTestHost({ remote: explicitClient });
    const runtimeClient = await createMcpRuntimeClient({
      config: undefined,
      host,
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
    expect((tool.inputSchema as StandardSchemaWithJSON)['~standard'].validate({})).toMatchObject({
      issues: expect.any(Array),
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
        signal: expect.any(AbortSignal),
      })
    );
    const forwardedSignal = callTool.mock.calls[0]?.[1]?.signal;
    expect(forwardedSignal?.aborted).toBe(false);
    abortController.abort();
    expect(forwardedSignal?.aborted).toBe(true);
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

    const mixedStructuredMediaResult: ExplicitHttpMcpCallToolResult = {
      content: [
        { text: 'A bounded caption.', type: 'text' },
        { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
        { data: 'UklGRg==', mimeType: 'audio/wav', type: 'audio' },
      ],
      structuredContent: { echoed: 'hello' },
    };
    callTool.mockResolvedValueOnce(mixedStructuredMediaResult);
    await expect(tool.execute({ value: 'hello' })).resolves.toEqual(mixedStructuredMediaResult);

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
        ): Promise<ExplicitHttpMcpCallToolResult> => {
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
      callTool: vi.fn<() => Promise<ExplicitHttpMcpCallToolResult>>(),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const { host } = createTestHost({ broken: brokenClient, healthy: healthyClient });
    const runtimeClient = await createMcpRuntimeClient({
      config: undefined,
      host,
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

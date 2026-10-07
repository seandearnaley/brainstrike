import type { McpTaskPresentation } from '@brainstrike/assistant-contract';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import type { CreateTaskResult } from '@brainstrike/mcp-tasks-extension';
import { type StandardSchemaWithJSON, standardSchemaToJSONSchema } from '@mastra/core/schema';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  MCP_PROGRESS_STREAM_PART_TYPE,
  mapMcpProgressStreamPart,
  retainRawMcpCallToolResult,
} from '../mastra/mcp-runtime-client';
import { applyToolModelOutputProjections } from '../mastra/tool-model-output';
import { REGISTERED_EXTENSION_RESULT_KEY } from '../mcp/client-extension-registry';
import type {
  ExplicitHttpMcpCallToolParams,
  ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpRequestOptions,
} from '../mcp/explicit-http-client';
import type { McpTaskTrackingCapability } from '../mcp/task-tracking';
import { createMcpRuntimeClient } from '../mcp-client';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';
import {
  readToolGuardDeadlineSignal,
  registerToolGuardDeadlineSignal,
} from '../tools/tool-guard-deadline';
import { createTestHost, type ExecutableTool, requireExecutableTool } from './fixtures/mcp-runtime';

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

  it('retains adapter release failures while attempting all leases without closing host-owned clients', async () => {
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
      await expect(runtimeClient?.disconnect()).rejects.toThrow('watch release failed');
      await expect(runtimeClient?.disconnect()).rejects.toThrow('watch release failed');
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

  it.each(['agent', 'host'] as const)(
    'converts explicit HTTP tools without losing schemas, metadata, cancellation, or progress through %s context',
    async (contextShape) => {
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
      expect(standardSchemaToJSONSchema(tool.outputSchema as StandardSchemaWithJSON)).toMatchObject(
        {
          properties: { echoed: { type: 'string' } },
          required: ['echoed'],
          type: 'object',
        }
      );

      await expect(
        tool.execute(
          { value: 'hello' },
          {
            _meta: { traceId: 'trace-1' },
            abortSignal: abortController.signal,
            ...(contextShape === 'agent'
              ? { agent: { toolCallId: 'call-1' } }
              : { toolCallId: 'call-1' }),
            writer: {
              custom: async (part: unknown) => {
                progressWrites.push(part);
              },
            },
          }
        )
      ).resolves.toEqual({
        app: {
          mimeType: 'text/html;profile=mcp-app',
          resourceUri: 'ui://echo/card',
          serverId: 'remote',
          toolName: 'echo',
        },
        kind: 'mcp-app',
        result: { echoed: 'hello' },
      });
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
      await expect(tool.execute({ value: 'hello' })).resolves.toEqual({
        app: {
          mimeType: 'text/html;profile=mcp-app',
          resourceUri: 'ui://echo/card',
          serverId: 'remote',
          toolName: 'echo',
        },
        kind: 'mcp-app',
        result: mixedStructuredMediaResult,
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
        ).resolves.toEqual({
          app: {
            mimeType: 'text/html;profile=mcp-app',
            resourceUri: 'ui://echo/card',
            serverId: 'remote',
            toolName: 'echo',
          },
          kind: 'mcp-app',
          result: { echoed: 'hello' },
        });
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
    }
  );

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

  it('keeps a complete 2020-12 schema usable at the model boundary', async () => {
    const schema = {
      $defs: { identifier: { minLength: 1, type: 'string' } },
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      if: { properties: { mode: { const: 'text' } } },
      properties: {
        id: { $ref: '#/$defs/identifier' },
        mode: { oneOf: [{ const: 'text' }, { const: 'number' }] },
        value: {},
      },
      required: ['id', 'mode'],
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditionals use the canonical keyword.
      then: { required: ['value'] },
      type: 'object',
    };
    const remote = {
      callTool: vi.fn(async () => ({
        content: [{ text: 'ok', type: 'text' }],
        structuredContent: { ok: true },
      })),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ inputSchema: schema, name: 'complex' }],
      }),
    };
    const { host } = createTestHost({ remote });
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
    const discovered = await runtimeClient?.listToolsetsWithErrors();
    const tool = requireExecutableTool(discovered?.toolsets['remote']?.['complex']);

    expect(discovered?.errors).toEqual({});
    expect((tool.inputSchema as StandardSchemaWithJSON)['~standard'].jsonSchema.input({})).toEqual(
      schema
    );
    expect(tool.inputSchema?.['~standard'].validate({ id: 'x', mode: 'invalid' })).toMatchObject({
      issues: expect.any(Array),
    });
  });

  it('does not emit regressing remote progress', async () => {
    const callTool = vi.fn(
      async (
        _params: ExplicitHttpMcpCallToolParams,
        options?: ExplicitHttpMcpRequestOptions
      ): Promise<ExplicitHttpMcpCallToolResult> => {
        options?.onprogress?.({ progress: 0.4, total: 1 });
        options?.onprogress?.({ progress: 0.2, total: 1 });
        options?.onprogress?.({ progress: 0.8, total: 1 });
        return { content: [{ text: 'ok', type: 'text' }] };
      }
    );
    const remote = {
      callTool,
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [{ inputSchema: { type: 'object' }, name: 'progress' }] }),
    };
    const { host } = createTestHost({ remote });
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
    const discovered = await runtimeClient?.listToolsetsWithErrors();
    const tool = requireExecutableTool(discovered?.toolsets['remote']?.['progress']);
    const writes: unknown[] = [];

    await tool.execute(
      {},
      {
        agent: { toolCallId: 'progress-call' },
        writer: { custom: async (part: unknown) => writes.push(part) },
      }
    );

    expect(writes).toEqual([
      expect.objectContaining({ progress: 0.4 }),
      expect.objectContaining({ progress: 0.8 }),
    ]);
  });

  it('cancels the in-flight host request when the tool guard deadline fires', async () => {
    const callTool = vi.fn(
      async (
        _params: ExplicitHttpMcpCallToolParams,
        _options?: ExplicitHttpMcpRequestOptions
      ): Promise<ExplicitHttpMcpCallToolResult> => ({
        content: [{ text: 'ok', type: 'text' }],
      })
    );
    const remote = {
      callTool,
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [{ inputSchema: { type: 'object' }, name: 'slow' }] }),
    };
    const { host } = createTestHost({ remote });
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
    const discovered = await runtimeClient?.listToolsetsWithErrors();
    const tool = requireExecutableTool(discovered?.toolsets['remote']?.['slow']);
    const caller = new AbortController();
    const guard = new AbortController();
    const context = { abortSignal: caller.signal, agent: { toolCallId: 'slow-call' } };
    const releaseDeadline = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    // The registry is module-global and keyed by tool-call id, so an assertion
    // failure below would otherwise leave 'slow-call' registered for the rest
    // of the file and turn one real failure into cascading ones.
    onTestFinished(releaseDeadline);

    await tool.execute({}, context);

    const forwarded = callTool.mock.calls[0]?.[1]?.signal;
    expect(forwarded).toBeInstanceOf(AbortSignal);
    expect(forwarded?.aborted).toBe(false);
    guard.abort(new Error('guard deadline'));
    expect(forwarded?.aborted).toBe(true);
    // The caller's own signal identity is untouched, so identity-marked
    // execution signals keep their meaning.
    expect(caller.signal.aborted).toBe(false);

    releaseDeadline();
    expect(readToolGuardDeadlineSignal(context)).toBeUndefined();
  });

  it('still cancels on the caller signal when no tool guard deadline is registered', async () => {
    const callTool = vi.fn(
      async (
        _params: ExplicitHttpMcpCallToolParams,
        _options?: ExplicitHttpMcpRequestOptions
      ): Promise<ExplicitHttpMcpCallToolResult> => ({
        content: [{ text: 'ok', type: 'text' }],
      })
    );
    const remote = {
      callTool,
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [{ inputSchema: { type: 'object' }, name: 'plain' }] }),
    };
    const { host } = createTestHost({ remote });
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
    const discovered = await runtimeClient?.listToolsetsWithErrors();
    const tool = requireExecutableTool(discovered?.toolsets['remote']?.['plain']);
    const caller = new AbortController();

    await tool.execute({}, { abortSignal: caller.signal, agent: { toolCallId: 'plain-call' } });

    const forwarded = callTool.mock.calls[0]?.[1]?.signal;
    expect(forwarded?.aborted).toBe(false);
    caller.abort(new Error('caller cancelled'));
    expect(forwarded?.aborted).toBe(true);
  });

  describe('MCP Apps tool results', () => {
    function createResultServer(
      result: ExplicitHttpMcpCallToolResult,
      ui: unknown = { resourceUri: 'ui://issues/detail' }
    ) {
      return {
        callTool: vi.fn(async (): Promise<ExplicitHttpMcpCallToolResult> => result),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              _meta: { ui },
              inputSchema: { type: 'object' },
              name: 'show_issue',
            },
          ],
        }),
      };
    }

    it('persists an app marker for structured content while projecting the ordinary result', async () => {
      const ordinaryResult = { issueId: 'BST-1572', title: 'MCP Apps enablement' };
      const remote = createResultServer({
        content: [{ text: 'Issue BST-1572', type: 'text' }],
        structuredContent: ordinaryResult,
      });
      const { host } = createTestHost({ remote });
      const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const tool = requireExecutableTool(discovered?.toolsets['remote']?.['show_issue']);

      const raw = await tool.execute({}, { agent: { toolCallId: 'app-call' } });
      expect(raw).toEqual({
        app: {
          mimeType: 'text/html;profile=mcp-app',
          resourceUri: 'ui://issues/detail',
          serverId: 'remote',
          toolName: 'show_issue',
        },
        kind: 'mcp-app',
        result: ordinaryResult,
      });

      const budget = resolveScaledToolResultBudget(128_000);
      const projected = applyToolModelOutputProjections(
        { remote_show_issue: tool },
        new Map([['remote_show_issue', 'remote.show_issue']]),
        undefined,
        budget
      );
      const ordinaryProjected = applyToolModelOutputProjections(
        { ordinary: { execute: async () => ordinaryResult } },
        new Map([['ordinary', 'remote.show_issue']]),
        undefined,
        budget
      );
      const modelOutput = (projected['remote_show_issue'] as ExecutableTool).toModelOutput?.(raw);
      const ordinaryModelOutput = (ordinaryProjected['ordinary'] as ExecutableTool).toModelOutput?.(
        ordinaryResult
      );

      expect(modelOutput).toEqual(ordinaryModelOutput);
      expect(JSON.stringify(modelOutput)).not.toContain('mcp-app');
    });

    it('persists an app marker whose result is the complete ordinary raw CallToolResult', async () => {
      const ordinaryResult: ExplicitHttpMcpCallToolResult = {
        content: [{ text: 'Rendered from text content', type: 'text' }],
      };
      const remote = createResultServer(ordinaryResult);
      const { host } = createTestHost({ remote });
      const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const tool = requireExecutableTool(discovered?.toolsets['remote']?.['show_issue']);

      await expect(tool.execute({}, { agent: { toolCallId: 'app-call' } })).resolves.toEqual({
        app: {
          mimeType: 'text/html;profile=mcp-app',
          resourceUri: 'ui://issues/detail',
          serverId: 'remote',
          toolName: 'show_issue',
        },
        kind: 'mcp-app',
        result: ordinaryResult,
      });
    });

    it('leaves tool definitions without _meta.ui on the ordinary result path', async () => {
      const ordinaryResult = { issueId: 'BST-1572' };
      const remote = createResultServer({
        content: [{ text: 'Issue BST-1572', type: 'text' }],
        structuredContent: ordinaryResult,
      });
      remote.listTools.mockResolvedValueOnce({
        tools: [{ inputSchema: { type: 'object' }, name: 'show_issue' }],
      });
      const { host } = createTestHost({ remote });
      const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const tool = requireExecutableTool(discovered?.toolsets['remote']?.['show_issue']);

      await expect(tool.execute({}, { agent: { toolCallId: 'ordinary-call' } })).resolves.toEqual(
        ordinaryResult
      );
      expect(tool.toModelOutput).toBeUndefined();
    });

    it('rejects malformed _meta.ui before invoking the remote tool', async () => {
      const remote = createResultServer(
        { content: [{ text: 'must not execute', type: 'text' }] },
        { resourceUri: 'https://example.test/not-an-app' }
      );
      const { host } = createTestHost({ remote });
      const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const tool = requireExecutableTool(discovered?.toolsets['remote']?.['show_issue']);

      await expect(tool.execute({}, { agent: { toolCallId: 'malformed-call' } })).rejects.toThrow(
        'MCP Apps tool metadata.resourceUri must use the ui:// scheme'
      );
      expect(remote.callTool).not.toHaveBeenCalled();
    });

    it('throws an MCP isError result before constructing an app marker', async () => {
      const remote = createResultServer({
        content: [{ text: 'remote app failure', type: 'text' }],
        isError: true,
      });
      const { host } = createTestHost({ remote });
      const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const tool = requireExecutableTool(discovered?.toolsets['remote']?.['show_issue']);

      await expect(tool.execute({}, { agent: { toolCallId: 'error-call' } })).rejects.toThrow(
        'remote app failure'
      );
    });
  });

  describe('MCP task results', () => {
    const createdTask: CreateTaskResult = {
      createdAt: '2026-09-01T05:00:00.000Z',
      lastUpdatedAt: '2026-09-01T05:00:00.000Z',
      resultType: 'task',
      status: 'working',
      taskId: 'task-a',
      ttlMs: null,
    };
    const handle = {
      authorityEpoch: '00000000-0000-7000-8000-000000000000',
      principalId: 'principal-a',
      resource: 'https://tasks.example.test',
      serverId: 'remote',
      taskId: 'task-a',
    } as const;
    const live: McpTaskPresentation = {
      canCancel: true,
      createdAt: '2026-09-01T05:00:00.000Z',
      handle,
      history: [{ at: '2026-09-01T05:00:00.000Z', status: 'working' }],
      omittedHistoryEntries: 0,
      recovery: 'live',
      status: 'working',
      statusMessage: 'Preparing export',
      updatedAt: '2026-09-01T05:00:01.000Z',
    };
    const settled: McpTaskPresentation = {
      ...live,
      canCancel: false,
      history: [
        { at: '2026-09-01T05:00:00.000Z', status: 'working' },
        { at: '2026-09-01T05:00:05.000Z', status: 'completed' },
      ],
      recovery: 'terminal',
      status: 'completed',
      statusMessage: null,
      updatedAt: '2026-09-01T05:00:05.000Z',
    };

    function createTaskServer(result: ExplicitHttpMcpCallToolResult) {
      return {
        callTool: vi.fn(async (): Promise<ExplicitHttpMcpCallToolResult> => result),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi
          .fn()
          .mockResolvedValue({ tools: [{ inputSchema: { type: 'object' }, name: 'export' }] }),
      };
    }

    it('throws when a task result arrives on a host without task tracking', async () => {
      const remote = createTaskServer(createdTask as unknown as ExplicitHttpMcpCallToolResult);
      const { host } = createTestHost({ remote });
      const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const tool = requireExecutableTool(discovered?.toolsets['remote']?.['export']);

      await expect(tool.execute({}, { agent: { toolCallId: 'task-call' } })).rejects.toThrow(
        'MCP tool "remote.export" returned a task but this host has no task tracking capability'
      );
      expect(tool.toModelOutput).toBeUndefined();
    });

    it.each([
      { name: 'direct', result: createdTask },
      {
        name: 'registry-wrapped',
        result: {
          [REGISTERED_EXTENSION_RESULT_KEY]: createdTask,
          content: [],
          resultType: 'complete',
        },
      },
    ])(
      'tracks a $name task result, waits for settlement, and persists the task marker',
      async ({ result }) => {
        const remote = createTaskServer(result as unknown as ExplicitHttpMcpCallToolResult);
        const mcpTaskTracking: McpTaskTrackingCapability = {
          awaitSettlement: vi.fn(async () => ({ settled: true as const, task: settled })),
          track: vi.fn(async () => live),
        };
        const { host } = createTestHost({ remote });
        const runtimeClient = await createMcpRuntimeClient({
          config: undefined,
          host,
          mcpTaskTracking,
          toolTimeoutMs: 60_000,
        });
        const discovered = await runtimeClient?.listToolsetsWithErrors();
        const tool = requireExecutableTool(discovered?.toolsets['remote']?.['export']);
        const abortController = new AbortController();

        await expect(
          tool.execute(
            {},
            { abortSignal: abortController.signal, agent: { toolCallId: 'task-call' } }
          )
        ).resolves.toEqual({ kind: 'mcp-task', task: settled });
        expect(mcpTaskTracking.track).toHaveBeenCalledWith(
          { configuredServerId: 'remote', result: createdTask, toolName: 'export' },
          abortController.signal
        );
        expect(mcpTaskTracking.awaitSettlement).toHaveBeenCalledWith(handle, {
          signal: abortController.signal,
          timeoutMs: 45_000,
        });
      }
    );

    it.each([
      { name: 'direct', result: createdTask },
      {
        name: 'registry-wrapped',
        result: {
          [REGISTERED_EXTENSION_RESULT_KEY]: createdTask,
          content: [],
          resultType: 'complete',
        },
      },
    ])(
      'returns the canonical CreateTaskResult for an app-originated ($name) call after tracking, without awaiting settlement',
      async ({ result }) => {
        const remote = createTaskServer(result as unknown as ExplicitHttpMcpCallToolResult);
        const mcpTaskTracking: McpTaskTrackingCapability = {
          awaitSettlement: vi.fn(async () => ({ settled: true as const, task: settled })),
          track: vi.fn(async () => live),
        };
        const { host } = createTestHost({ remote });
        const runtimeClient = await createMcpRuntimeClient({
          config: undefined,
          host,
          mcpTaskTracking,
          toolTimeoutMs: 60_000,
        });
        const discovered = await runtimeClient?.listToolsetsWithErrors();
        const tool = requireExecutableTool(discovered?.toolsets['remote']?.['export']);
        const abortSignal = retainRawMcpCallToolResult(new AbortController().signal);

        await expect(
          tool.execute({}, { abortSignal, agent: { toolCallId: 'app-task-call' } })
        ).resolves.toEqual(createdTask);
        expect(mcpTaskTracking.track).toHaveBeenCalledWith(
          { configuredServerId: 'remote', result: createdTask, toolName: 'export' },
          abortSignal
        );
        expect(mcpTaskTracking.awaitSettlement).not.toHaveBeenCalled();
      }
    );

    it('throws for an app-originated task on a host without task tracking', async () => {
      const remote = createTaskServer(createdTask as unknown as ExplicitHttpMcpCallToolResult);
      const { host } = createTestHost({ remote });
      const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const tool = requireExecutableTool(discovered?.toolsets['remote']?.['export']);
      const abortSignal = retainRawMcpCallToolResult(new AbortController().signal);

      await expect(
        tool.execute({}, { abortSignal, agent: { toolCallId: 'app-task-call' } })
      ).rejects.toThrow(
        'MCP tool "remote.export" returned a task but this host has no task tracking capability'
      );
    });

    it('returns the live task when settlement times out and projects only bounded status', async () => {
      const remote = createTaskServer(createdTask as unknown as ExplicitHttpMcpCallToolResult);
      const mcpTaskTracking: McpTaskTrackingCapability = {
        awaitSettlement: vi.fn(async () => ({
          reason: 'timeout' as const,
          settled: false as const,
          task: live,
        })),
        track: vi.fn(async () => live),
      };
      const { host } = createTestHost({ remote });
      const runtimeClient = await createMcpRuntimeClient({
        config: undefined,
        host,
        mcpTaskTracking,
        toolTimeoutMs: 60_000,
      });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const tool = requireExecutableTool(discovered?.toolsets['remote']?.['export']);

      const raw = await tool.execute({}, { agent: { toolCallId: 'task-call' } });
      expect(raw).toEqual({ kind: 'mcp-task', task: live });
      const projector = tool.toModelOutput;
      if (typeof projector !== 'function') {
        throw new Error('Expected a task-aware MCP model projector');
      }
      expect(projector(raw)).toEqual({
        type: 'json',
        value: {
          history: live.history,
          kind: 'mcp_task_status',
          omittedHistoryEntries: 0,
          status: 'working',
          statusMessage: 'Preparing export',
          updatedAt: live.updatedAt,
        },
      });
      expect(projector({ content: [{ text: 'plain', type: 'text' }] })).toBeUndefined();
    });
  });
});

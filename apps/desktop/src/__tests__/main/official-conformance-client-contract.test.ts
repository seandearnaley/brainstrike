import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopMcpHostRuntimeDependencies } from '../../mcp/host-runtime.js';
import {
  type ProductionConformanceClientRuntime,
  runProductionMcpConformanceClient,
} from '../../mcp/official-conformance-client.js';
import { OFFICIAL_AUTH_SCENARIO_NAMES } from '../../mcp/official-conformance-oauth.js';
import {
  parseOfficialConformanceProcessInput,
  runOfficialConformanceProcess,
} from '../../official-conformance-client-process.js';

const SOURCE_PATH = path.resolve(import.meta.dirname, '../../mcp/official-conformance-client.ts');
const SERVER_ID = parseConfiguredMcpServerId('official-conformance');

function connectedSnapshot(): McpHostServerSnapshot {
  return {
    configuredProtocol: '2026-07-28',
    configuredServerId: SERVER_ID,
    generation: 1,
    negotiated: {
      advertisedCapabilityIds: ['tools'],
      era: 'modern',
      revision: '2026-07-28',
    },
    state: 'connected',
    transport: 'streamable-http',
  };
}

function authenticationRequiredSnapshot(): McpHostServerSnapshot {
  return {
    configuredProtocol: '2026-07-28',
    configuredServerId: SERVER_ID,
    generation: 1,
    state: 'authentication-required',
    transport: 'streamable-http',
  };
}

function closeReport(
  failures: readonly { category: 'operation'; code: string; message: string }[] = []
) {
  return {
    callbacksClosed: 0,
    childProcessesClosed: 0,
    clientsClosed: 1,
    failures,
    loopbackPortsClosed: 0,
    probesClosed: 0,
    requestsSettled: 1,
    subscriptionsClosed: 0,
  } as const;
}

type ListedInputSchema = Extract<
  McpHostOperationResult,
  { type: 'tools/list' }
>['result']['tools'][number]['inputSchema'];

function runtimeReturningToolCall(
  result: McpHostOperationResult,
  toolName: string | readonly string[] = 'add_numbers',
  inputSchemas: Readonly<Record<string, ListedInputSchema>> = {}
): {
  close: ReturnType<typeof vi.fn>;
  operations: McpHostOperation[];
  replaceResolvedConfig: ReturnType<typeof vi.fn>;
  runtime: ProductionConformanceClientRuntime;
} {
  const close = vi.fn(async () => closeReport());
  const control = vi.fn(async () => connectedSnapshot());
  const operations: McpHostOperation[] = [];
  const replaceResolvedConfig = vi.fn(async () => ({ revision: 1, servers: [] }));
  const runtime = {
    host: {
      close,
      control,
      invoke: vi.fn(async (operation: McpHostOperation): Promise<McpHostOperationResult> => {
        operations.push(operation);
        if (operation.type === 'tools/list') {
          return {
            result: {
              tools: (typeof toolName === 'string' ? [toolName] : toolName).map((name) => ({
                inputSchema: inputSchemas[name] ?? { type: 'object' },
                name,
              })),
            },
            type: 'tools/list',
          };
        }
        if (operation.type === 'resources/list') {
          return {
            result: { resources: [{ name: 'header-resource', uri: 'test://header-resource' }] },
            type: 'resources/list',
          };
        }
        if (operation.type === 'resources/read') {
          return {
            result: { contents: [{ text: 'header resource', uri: operation.uri }] },
            type: 'resources/read',
          };
        }
        if (operation.type === 'prompts/list') {
          return {
            result: { prompts: [{ name: 'header-prompt' }] },
            type: 'prompts/list',
          };
        }
        if (operation.type === 'prompts/get') {
          return { result: { messages: [] }, type: 'prompts/get' };
        }
        return result;
      }),
    },
    replaceResolvedConfig,
  } satisfies ProductionConformanceClientRuntime;
  return { close, operations, replaceResolvedConfig, runtime };
}

const INVALID_TOOL_CALL_RESULTS: readonly {
  expected: RegExp;
  result: McpHostOperationResult;
}[] = [
  {
    expected: /invalid tools\/call result/u,
    result: { result: { tools: [] }, type: 'tools/list' },
  },
  {
    expected: /reported a tools\/call error/u,
    result: {
      result: { content: [{ text: 'boom', type: 'text' }], isError: true },
      type: 'tools/call',
    },
  },
];

describe('production MCP conformance client contract', () => {
  it('routes auth/basic-cimd through OAuth-user production host composition', async () => {
    const { replaceResolvedConfig, runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'ok', type: 'text' }] }, type: 'tools/call' },
      'test-tool'
    );
    let captured: DesktopMcpHostRuntimeDependencies | undefined;

    await runProductionMcpConformanceClient(
      {
        protocolVersion: '2026-07-28',
        scenario: 'auth/basic-cimd',
        serverUrl: 'http://127.0.0.1:4000/mcp',
      },
      {
        createRuntime: (dependencies) => {
          captured = dependencies;
          return runtime;
        },
        openAuthorization: vi.fn(),
      }
    );

    expect(replaceResolvedConfig).toHaveBeenCalledWith({
      servers: [
        expect.objectContaining({
          auth: { type: 'oauth-user' },
          protocol: '2026-07-28',
          startup: 'authentication-required',
          transport: 'streamable-http',
        }),
      ],
    });
    expect(captured).toMatchObject({
      createOAuthProvider: expect.any(Function),
      oauthStore: expect.any(Object),
      openExternal: expect.any(Function),
    });
    expect(runtime.host.control).toHaveBeenCalledWith({
      action: 'connect',
      configuredServerId: 'official-conformance',
    });
    expect(runtime.host.invoke).toHaveBeenLastCalledWith({
      arguments: {},
      configuredServerId: 'official-conformance',
      toolName: 'test-tool',
      type: 'tools/call',
    });
  });

  it('fails closed before tools/list when OAuth connect is not connected', async () => {
    const { close, runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'ok', type: 'text' }] }, type: 'tools/call' },
      'test-tool'
    );
    vi.mocked(runtime.host.control).mockResolvedValueOnce(authenticationRequiredSnapshot());

    await expect(
      runProductionMcpConformanceClient(
        {
          protocolVersion: '2026-07-28',
          scenario: 'auth/basic-cimd',
          serverUrl: 'http://127.0.0.1:4000/mcp',
        },
        { createRuntime: () => runtime, openAuthorization: vi.fn() }
      )
    ).rejects.toThrow('OAuth connection did not reach connected state');
    expect(runtime.host.invoke).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves an empty auth context so strict scenario validation rejects it', async () => {
    const createRuntime = vi.fn();

    await expect(
      runProductionMcpConformanceClient(
        {
          context: '',
          protocolVersion: '2026-07-28',
          scenario: 'auth/basic-cimd',
          serverUrl: 'http://127.0.0.1:4000/mcp',
        },
        { createRuntime }
      )
    ).rejects.toThrow('Official MCP conformance OAuth context is invalid');
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it.each(
    OFFICIAL_AUTH_SCENARIO_NAMES.flatMap((scenario) =>
      (['2025-11-25', '2026-07-28'] as const).map((protocolVersion) => ({
        protocolVersion,
        scenario,
      }))
    )
  )('maps canonical $scenario at $protocolVersion', async ({ protocolVersion, scenario }) => {
    const { operations, replaceResolvedConfig, runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'ok', type: 'text' }] }, type: 'tools/call' },
      'test-tool'
    );

    await runProductionMcpConformanceClient(
      {
        ...(scenario === 'auth/pre-registration'
          ? {
              context: JSON.stringify({
                client_id: 'pre-registered-client',
                client_secret: 'pre-registered-secret',
                issuer: 'http://127.0.0.1:4001',
                name: scenario,
              }),
            }
          : {}),
        protocolVersion,
        scenario,
        serverUrl: 'http://127.0.0.1:4000/mcp',
      },
      { createRuntime: () => runtime, openAuthorization: vi.fn() }
    );

    expect(replaceResolvedConfig.mock.calls[0]?.[0].servers[0]).toMatchObject({
      auth: { type: 'oauth-user' },
      protocol: protocolVersion === '2025-11-25' ? 'legacy' : '2026-07-28',
      startup: 'authentication-required',
    });
    expect(runtime.host.control).toHaveBeenCalledOnce();
    const calls = operations.map((operation) => operation.type);
    expect(calls).toEqual(
      scenario === 'auth/pre-registration' ? ['tools/list'] : ['tools/list', 'tools/call']
    );
  });

  it('wires exact elicitation defaults through the production runtime options', async () => {
    const { replaceResolvedConfig, runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'accepted', type: 'text' }] }, type: 'tools/call' },
      'test_client_elicitation_defaults'
    );
    let captured: DesktopMcpHostRuntimeDependencies | undefined;

    await runProductionMcpConformanceClient(
      {
        protocolVersion: '2025-11-25',
        scenario: 'elicitation-sep1034-client-defaults',
        serverUrl: 'https://mcp.example.test/mcp',
      },
      {
        createRuntime: (dependencies) => {
          captured = dependencies;
          return runtime;
        },
      }
    );

    const server = replaceResolvedConfig.mock.calls[0]?.[0].servers[0];
    const resolveCapabilities = captured?.resolveClientCapabilities;
    if (!(server && resolveCapabilities)) {
      throw new Error('Production runtime capability resolver was not composed');
    }
    const elicitation = resolveCapabilities(server)?.elicitation;
    expect(elicitation).toMatchObject({ applyDefaults: true, form: true, url: false });
    if (!elicitation) {
      throw new Error('Production elicitation capability was not composed');
    }
    const request = {
      method: 'elicitation/create',
      params: {
        message: 'Apply defaults?',
        requestedSchema: { properties: {}, type: 'object' },
      },
    } as const;
    const active = new AbortController();
    await expect(
      elicitation.handle(request, {
        requestId: 'elicitation-active',
        serverName: 'official-conformance',
        signal: active.signal,
      })
    ).resolves.toEqual({ action: 'accept', content: {} });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      elicitation.handle(request, {
        requestId: 'elicitation-aborted',
        serverName: 'official-conformance',
        signal: aborted.signal,
      })
    ).rejects.toThrow();
  });

  it.each([
    ['initialize', 'add_numbers'],
    ['tools_call', 'add_numbers'],
    ['sse-retry', 'test_reconnection'],
  ] as const)('does not advertise elicitation defaults for %s', async (scenario, toolName) => {
    const { replaceResolvedConfig, runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'ok', type: 'text' }] }, type: 'tools/call' },
      toolName
    );
    let captured: DesktopMcpHostRuntimeDependencies | undefined;

    await runProductionMcpConformanceClient(
      {
        protocolVersion: '2025-11-25',
        scenario,
        serverUrl: 'https://mcp.example.test/mcp',
      },
      {
        createRuntime: (dependencies) => {
          captured = dependencies;
          return runtime;
        },
      }
    );

    const server = replaceResolvedConfig.mock.calls[0]?.[0].servers[0];
    const resolveCapabilities = captured?.resolveClientCapabilities;
    if (!(server && resolveCapabilities)) {
      throw new Error('Production runtime capability resolver was not composed');
    }
    expect(resolveCapabilities(server)).toBeUndefined();
  });

  it('limits initialize to the production connection lifecycle handshake', async () => {
    const { operations, replaceResolvedConfig, runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'unused', type: 'text' }] }, type: 'tools/call' },
      'unused'
    );

    await runProductionMcpConformanceClient(
      {
        protocolVersion: '2025-11-25',
        scenario: 'initialize',
        serverUrl: 'https://mcp.example.test/mcp',
      },
      { createRuntime: () => runtime }
    );

    expect(replaceResolvedConfig).toHaveBeenCalledOnce();
    expect(operations).toEqual([]);
    expect(runtime.host.control).toHaveBeenCalledExactlyOnceWith({
      action: 'connect',
      configuredServerId: 'official-conformance',
    });
  });

  it('drives elicitation defaults through the host tool seam', async () => {
    const { runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'accepted', type: 'text' }] }, type: 'tools/call' },
      'test_client_elicitation_defaults'
    );

    await runProductionMcpConformanceClient(
      {
        protocolVersion: '2025-11-25',
        scenario: 'elicitation-sep1034-client-defaults',
        serverUrl: 'https://mcp.example.test/mcp',
      },
      { createRuntime: () => runtime }
    );

    expect(runtime.host.invoke).toHaveBeenLastCalledWith({
      arguments: {},
      configuredServerId: 'official-conformance',
      toolName: 'test_client_elicitation_defaults',
      type: 'tools/call',
    });
  });

  it('drives SSE retry through the host tool seam', async () => {
    const { runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'reconnected', type: 'text' }] }, type: 'tools/call' },
      'test_reconnection'
    );

    await runProductionMcpConformanceClient(
      {
        protocolVersion: '2025-11-25',
        scenario: 'sse-retry',
        serverUrl: 'https://mcp.example.test',
      },
      { createRuntime: () => runtime }
    );

    expect(runtime.host.invoke).toHaveBeenLastCalledWith({
      arguments: {},
      configuredServerId: 'official-conformance',
      toolName: 'test_reconnection',
      type: 'tools/call',
    });
  });

  it.each([
    { expectedTypes: [], scenario: 'request-metadata', toolNames: ['unused'] },
    {
      expectedTypes: ['tools/list', 'tools/call', 'tools/call', 'tools/call', 'tools/call'],
      scenario: 'sep-2322-client-request-state',
      toolNames: [
        'test_mrtr_echo_state',
        'test_mrtr_unrelated',
        'test_mrtr_no_state',
        'test_mrtr_no_result_type',
      ],
    },
    {
      expectedTypes: [
        'tools/list',
        'tools/call',
        'resources/list',
        'resources/read',
        'prompts/list',
        'prompts/get',
      ],
      scenario: 'http-standard-headers',
      toolNames: ['test_headers'],
    },
    {
      context: JSON.stringify({
        name: 'http-custom-headers',
        toolCalls: [
          {
            arguments: { priority: 42, region: 'us-west1', verbose: false },
            name: 'test_custom_headers',
          },
          {
            arguments: { priority: 1, region: 'us-east1', verbose: null },
            name: 'test_custom_headers_null',
          },
        ],
      }),
      expectedTypes: ['tools/list', 'tools/call', 'tools/call'],
      scenario: 'http-custom-headers',
      toolNames: ['test_custom_headers', 'test_custom_headers_null'],
    },
    {
      expectedTypes: ['tools/list', 'tools/call'],
      scenario: 'http-invalid-tool-headers',
      toolNames: ['valid_tool'],
    },
    {
      expectedTypes: ['tools/list'],
      scenario: 'json-schema-ref-no-deref',
      toolNames: ['unused'],
    },
  ] as const)(
    'accepts and executes the pinned modern non-auth scenario $scenario',
    async ({ context, expectedTypes, scenario, toolNames }) => {
      const { operations, replaceResolvedConfig, runtime } = runtimeReturningToolCall(
        { result: { content: [{ text: 'ok', type: 'text' }] }, type: 'tools/call' },
        toolNames
      );

      await expect(
        runProductionMcpConformanceClient(
          {
            ...(context === undefined ? {} : { context }),
            protocolVersion: '2026-07-28',
            scenario,
            serverUrl: 'https://mcp.example.test/mcp',
          },
          { createRuntime: () => runtime }
        )
      ).resolves.toBeUndefined();

      expect(replaceResolvedConfig).toHaveBeenCalledOnce();
      expect(operations.map(({ type }) => type)).toEqual(expectedTypes);
      expect(runtime.host.control).toHaveBeenCalledTimes(scenario === 'request-metadata' ? 1 : 0);
    }
  );

  it('preserves both upstream custom-header tool calls and their arguments', async () => {
    const toolCalls = [
      {
        arguments: { priority: 42, region: 'us-west1', verbose: false },
        name: 'test_custom_headers',
      },
      {
        arguments: { priority: 1, region: 'us-east1', verbose: null },
        name: 'test_custom_headers_null',
      },
    ] as const;
    const { operations, runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'ok', type: 'text' }] }, type: 'tools/call' },
      toolCalls.map(({ name }) => name)
    );

    await runProductionMcpConformanceClient(
      {
        context: JSON.stringify({ name: 'http-custom-headers', toolCalls }),
        protocolVersion: '2026-07-28',
        scenario: 'http-custom-headers',
        serverUrl: 'https://mcp.example.test/mcp',
      },
      { createRuntime: () => runtime }
    );

    expect(operations.filter(({ type }) => type === 'tools/call')).toEqual(
      toolCalls.map((toolCall) => ({
        arguments: toolCall.arguments,
        configuredServerId: 'official-conformance',
        toolName: toolCall.name,
        type: 'tools/call',
      }))
    );
  });

  it.each(['2025-11-25', '2026-07-28'] as const)(
    'echoes the 2020-12 focal schema exactly as the host listed it at %s',
    async (protocolVersion) => {
      const focalSchema = {
        $defs: { address: { $anchor: 'address', type: 'object' } },
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        allOf: [{ required: ['name'] }],
        if: { properties: { kind: { const: 'home' } } },
        properties: { name: { type: 'string' } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword; never awaited.
        then: { required: ['address'] },
        type: 'object',
      } satisfies ListedInputSchema;
      const { operations, runtime } = runtimeReturningToolCall(
        { result: { content: [{ text: 'ok', type: 'text' }] }, type: 'tools/call' },
        ['json_schema_2020_12_tool', 'json_schema_echo'],
        { json_schema_2020_12_tool: focalSchema }
      );

      await runProductionMcpConformanceClient(
        {
          protocolVersion,
          scenario: 'json-schema-2020-12-preservation',
          serverUrl: 'https://mcp.example.test/mcp',
        },
        { createRuntime: () => runtime }
      );

      expect(operations.filter(({ type }) => type === 'tools/call')).toEqual([
        {
          arguments: { schema: focalSchema },
          configuredServerId: 'official-conformance',
          toolName: 'json_schema_echo',
          type: 'tools/call',
        },
      ]);
    }
  );

  it('wires MRTR elicitation through the production capability engine', async () => {
    const { replaceResolvedConfig, runtime } = runtimeReturningToolCall(
      { result: { content: [{ text: 'ok', type: 'text' }] }, type: 'tools/call' },
      [
        'test_mrtr_echo_state',
        'test_mrtr_unrelated',
        'test_mrtr_no_state',
        'test_mrtr_no_result_type',
      ]
    );
    let captured: DesktopMcpHostRuntimeDependencies | undefined;

    await runProductionMcpConformanceClient(
      {
        protocolVersion: '2026-07-28',
        scenario: 'sep-2322-client-request-state',
        serverUrl: 'https://mcp.example.test/mcp',
      },
      {
        createRuntime: (dependencies) => {
          captured = dependencies;
          return runtime;
        },
      }
    );

    const server = replaceResolvedConfig.mock.calls[0]?.[0].servers[0];
    const resolveCapabilities = captured?.resolveClientCapabilities;
    if (!(server && resolveCapabilities)) {
      throw new Error('Production MRTR capability resolver was not composed');
    }
    const elicitation = resolveCapabilities(server)?.elicitation;
    if (!elicitation) {
      throw new Error('Production MRTR elicitation capability was not composed');
    }
    expect(elicitation).toMatchObject({ form: true, url: false });
    const controller = new AbortController();
    await expect(
      elicitation.handle(
        {
          method: 'elicitation/create',
          params: {
            message: 'Confirm?',
            requestedSchema: {
              properties: { confirmed: { type: 'boolean' } },
              required: ['confirmed'],
              type: 'object',
            },
          },
        },
        {
          requestId: 'mrtr-elicitation',
          serverName: 'official-conformance',
          signal: controller.signal,
        }
      )
    ).resolves.toEqual({ action: 'accept', content: { confirmed: true } });
    await expect(
      elicitation.handle(
        {
          method: 'elicitation/create',
          params: {
            message: 'Unexpected shape',
            requestedSchema: {
              properties: { answer: { type: 'string' } },
              type: 'object',
            },
          },
        },
        {
          requestId: 'mrtr-elicitation-invalid',
          serverName: 'official-conformance',
          signal: controller.signal,
        }
      )
    ).rejects.toThrow('MRTR elicitation schema is unsupported');
  });

  it.each([
    ['elicitation-sep1034-client-defaults', 'test_client_elicitation_defaults'],
    ['sse-retry', 'test_reconnection'],
  ] as const)('fails and closes when %s does not expose %s', async (scenario, expectedTool) => {
    const { close, runtime } = runtimeReturningToolCall(
      { result: { content: [] }, type: 'tools/call' },
      'wrong_tool'
    );

    await expect(
      runProductionMcpConformanceClient(
        { protocolVersion: '2025-11-25', scenario, serverUrl: 'https://mcp.example.test/mcp' },
        { createRuntime: () => runtime }
      )
    ).rejects.toThrow(`does not expose ${expectedTool}`);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['elicitation-sep1034-client-defaults', 'sse-retry'] as const)(
    'rejects legacy-only %s at 2026-07-28',
    async (scenario) => {
      await expect(
        runProductionMcpConformanceClient({
          protocolVersion: '2026-07-28',
          scenario,
          serverUrl: 'https://mcp.example.test/mcp',
        })
      ).rejects.toThrow(/protocolVersion/u);
    }
  );

  it('parses only the official positional URL and exact runner environment', () => {
    expect(
      parseOfficialConformanceProcessInput(['https://mcp.example.test/mcp'], {
        MCP_CONFORMANCE_PROTOCOL_VERSION: '2026-07-28',
        MCP_CONFORMANCE_SCENARIO: 'tools_call',
      })
    ).toEqual({
      protocolVersion: '2026-07-28',
      scenario: 'tools_call',
      serverUrl: 'https://mcp.example.test/mcp',
    });
    expect(() =>
      parseOfficialConformanceProcessInput(['https://user:secret@example.test/mcp'], {
        MCP_CONFORMANCE_PROTOCOL_VERSION: '2026-07-28',
        MCP_CONFORMANCE_SCENARIO: 'tools_call',
      })
    ).toThrow(/credentials/);
  });

  it('accepts custom-header context only for its exact scenario contract', () => {
    const context = JSON.stringify({
      name: 'http-custom-headers',
      toolCalls: [
        { arguments: { region: 'us-west1' }, name: 'test_custom_headers' },
        { arguments: { region: 'us-east1' }, name: 'test_custom_headers_null' },
      ],
    });
    expect(
      parseOfficialConformanceProcessInput(['https://mcp.example.test/mcp'], {
        MCP_CONFORMANCE_CONTEXT: context,
        MCP_CONFORMANCE_PROTOCOL_VERSION: '2026-07-28',
        MCP_CONFORMANCE_SCENARIO: 'http-custom-headers',
      })
    ).toMatchObject({ context, scenario: 'http-custom-headers' });
    expect(() =>
      parseOfficialConformanceProcessInput(['https://mcp.example.test/mcp'], {
        MCP_CONFORMANCE_PROTOCOL_VERSION: '2026-07-28',
        MCP_CONFORMANCE_SCENARIO: 'http-custom-headers',
      })
    ).toThrow(/custom-header context is required/u);
    expect(() =>
      parseOfficialConformanceProcessInput(['https://mcp.example.test/mcp'], {
        MCP_CONFORMANCE_CONTEXT: context,
        MCP_CONFORMANCE_PROTOCOL_VERSION: '2026-07-28',
        MCP_CONFORMANCE_SCENARIO: 'request-metadata',
      })
    ).toThrow(/context is invalid/u);
  });

  it('passes the exact pre-registration context without writing it', async () => {
    const context = JSON.stringify({
      client_id: 'pre-registered-client',
      client_secret: 'super-secret-client-value',
      issuer: 'https://auth.example.test',
      name: 'auth/pre-registration',
    });
    const writeError = vi.fn();
    const runClient = vi.fn(async () => undefined);

    await expect(
      runOfficialConformanceProcess(
        ['https://mcp.example.test/mcp'],
        {
          MCP_CONFORMANCE_CONTEXT: context,
          MCP_CONFORMANCE_PROTOCOL_VERSION: '2025-11-25',
          MCP_CONFORMANCE_SCENARIO: 'auth/pre-registration',
        },
        { runClient, writeError }
      )
    ).resolves.toBe(0);

    expect(runClient).toHaveBeenCalledWith({
      context,
      protocolVersion: '2025-11-25',
      scenario: 'auth/pre-registration',
      serverUrl: 'https://mcp.example.test/mcp',
    });
    expect(writeError).not.toHaveBeenCalled();
  });

  it('rejects malformed auth context without exposing it and emits only a fixed error', async () => {
    const secret = 'super-secret-client-value';
    const writeError = vi.fn();
    const runClient = vi.fn();

    await expect(
      runOfficialConformanceProcess(
        ['https://mcp.example.test/mcp'],
        {
          MCP_CONFORMANCE_CONTEXT: JSON.stringify({ client_secret: secret }),
          MCP_CONFORMANCE_PROTOCOL_VERSION: '2025-11-25',
          MCP_CONFORMANCE_SCENARIO: 'auth/pre-registration',
        },
        { runClient, writeError }
      )
    ).resolves.toBe(1);

    expect(runClient).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledWith(
      'Production MCP conformance client failed: invalid process input\n'
    );
    expect(JSON.stringify(writeError.mock.calls)).not.toContain(secret);
  });

  it('reports a sanitized runtime failure cause without leaking credentials', async () => {
    const writeError = vi.fn();
    const runClient = vi.fn().mockRejectedValue(
      new Error('token exchange rejected access_token=sk-live-runtime-9', {
        cause: new Error('HTTP 401 from https://auth.example.test/token?client_secret=oops'),
      })
    );

    await expect(
      runOfficialConformanceProcess(
        ['https://mcp.example.test/mcp'],
        {
          MCP_CONFORMANCE_PROTOCOL_VERSION: '2025-11-25',
          MCP_CONFORMANCE_SCENARIO: 'auth/basic-cimd',
        },
        { runClient, writeError }
      )
    ).resolves.toBe(1);

    const written = String(writeError.mock.calls[0]?.[0]);
    expect(written).toMatch(/^Production MCP conformance client failed: Error: token exchange/u);
    expect(written).toContain('[redacted-oauth-parameter]');
    expect(written).not.toContain('sk-live-runtime-9');
    expect(written).not.toContain('client_secret=oops');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('traverses AggregateError members in the sanitized failure cause', async () => {
    const writeError = vi.fn();
    const runClient = vi
      .fn()
      .mockRejectedValue(
        new AggregateError(
          [
            new Error('scenario timeout access_token=sk-agg-leak'),
            new Error('cleanup close failed'),
          ],
          'Production MCP conformance client and cleanup failed'
        )
      );

    await expect(
      runOfficialConformanceProcess(
        ['https://mcp.example.test/mcp'],
        {
          MCP_CONFORMANCE_PROTOCOL_VERSION: '2025-11-25',
          MCP_CONFORMANCE_SCENARIO: 'auth/basic-cimd',
        },
        { runClient, writeError }
      )
    ).resolves.toBe(1);

    const written = String(writeError.mock.calls[0]?.[0]);
    expect(written).toContain('Production MCP conformance client and cleanup failed');
    expect(written).toContain('scenario timeout');
    expect(written).toContain('cleanup close failed');
    expect(written).not.toContain('sk-agg-leak');
  });

  it('reports an unprintable rejected value without escaping the error path', async () => {
    const writeError = vi.fn();
    const runClient = vi.fn().mockRejectedValue(Object.create(null));

    await expect(
      runOfficialConformanceProcess(
        ['https://mcp.example.test/mcp'],
        {
          MCP_CONFORMANCE_PROTOCOL_VERSION: '2025-11-25',
          MCP_CONFORMANCE_SCENARIO: 'auth/basic-cimd',
        },
        { runClient, writeError }
      )
    ).resolves.toBe(1);

    expect(String(writeError.mock.calls[0]?.[0])).toContain('unprintable cause');
  });

  it('uses the production host runtime without constructing a parallel MCP client', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const sourceFile = ts.createSourceFile(
      SOURCE_PATH,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const imports = sourceFile.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : []
    );

    expect(imports).toContain('./host-runtime');
    expect(imports.some((specifier) => specifier.includes('@modelcontextprotocol/'))).toBe(false);
    expect(imports).not.toContain('./http-client');
    expect(imports).not.toContain('./stdio-client');
  });

  it('closes the host and reports both execution and cleanup failures', async () => {
    const executionFailure = new Error('scenario execution failed');
    const close = vi.fn(async () =>
      closeReport([
        { category: 'operation', code: 'client-close-failed', message: 'cleanup failed' },
      ])
    );
    const runtime = {
      host: {
        close,
        control: vi.fn(async () => connectedSnapshot()),
        invoke: vi.fn(async () => {
          throw executionFailure;
        }),
      },
      replaceResolvedConfig: vi.fn(async () => ({ revision: 1, servers: [] })),
    } satisfies ProductionConformanceClientRuntime;

    const result = runProductionMcpConformanceClient(
      {
        protocolVersion: '2026-07-28',
        scenario: 'tools_call',
        serverUrl: 'https://mcp.example.test/mcp',
      },
      { createRuntime: () => runtime }
    );

    await expect(result).rejects.toMatchObject({
      errors: [executionFailure, expect.any(Error)],
      message: 'Production MCP conformance client and cleanup failed',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(INVALID_TOOL_CALL_RESULTS)(
    'rejects $expected instead of recording false conformance',
    async ({ expected, result }) => {
      const { close, runtime } = runtimeReturningToolCall(result);

      await expect(
        runProductionMcpConformanceClient(
          {
            protocolVersion: '2026-07-28',
            scenario: 'tools_call',
            serverUrl: 'https://mcp.example.test/mcp',
          },
          { createRuntime: () => runtime }
        )
      ).rejects.toThrow(expected);
      expect(close).toHaveBeenCalledOnce();
    }
  );
});

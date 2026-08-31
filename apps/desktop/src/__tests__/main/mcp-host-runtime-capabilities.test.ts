import type { ExplicitHttpMcpClient } from '@brainstrike/agent/mcp-client';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import type { ResolvedMcpConfig, ResolvedMcpServer } from '../../mcp-loader';

const transportClient = () => ({
  callTool: vi.fn(async () => ({ content: [] })),
  close: vi.fn(async () => undefined),
  connect: vi.fn(async (_options?: TransportConnectOptions) => undefined),
  getNegotiatedProtocolVersion: vi.fn(() => '2026-07-28'),
  getProtocolEra: vi.fn(() => 'modern' as const),
  getServerCapabilities: vi.fn(() => ({ tools: {} })),
  getServerVersion: vi.fn(() => ({ name: 'test', version: '1.0.0' })),
  listTools: vi.fn(async () => ({ tools: [] })),
});
type HttpServer = Extract<ResolvedMcpServer, { transport: 'streamable-http' }>;
type StdioServer = Extract<ResolvedMcpServer, { transport: 'stdio' }>;
type TransportConnectOptions = Parameters<ExplicitHttpMcpClient['connect']>[0];
const http = (): HttpServer => ({
  headers: { Authorization: 'Bearer private-token' },
  name: parseConfiguredMcpServerId('team.linear.prod'),
  protocol: 'auto',
  startup: 'automatic',
  transport: 'streamable-http',
  url: 'https://linear.example/mcp',
});
const stdio = (): StdioServer => ({
  args: ['--private-arg'],
  command: '/private/mcp-server',
  env: { PRIVATE_TOKEN: 'stdio-secret' },
  name: parseConfiguredMcpServerId('local.tools'),
  protocol: 'auto',
  startup: 'automatic',
  transport: 'stdio',
});
const resolved = (...servers: ResolvedMcpServer[]): ResolvedMcpConfig => ({ servers });

afterEach(() => vi.restoreAllMocks());

describe('DesktopMcpHostRuntime client capability composition', () => {
  it.each([
    { childProcessesClosed: 0, cursor: '', server: http() },
    { childProcessesClosed: 1, cursor: 'next-page', server: stdio() },
  ])('composes $server.transport with exact close accounting', async (testCase) => {
    const clientCapabilities = {
      sampling: {
        handle: vi.fn(async () => ({
          content: { text: 'ok', type: 'text' as const },
          model: 'test-model',
          role: 'assistant' as const,
        })),
      },
    };
    const explicitClient = transportClient();
    const createHttpTransportClient = vi.fn(() => explicitClient);
    const createStdioTransportClient = vi.fn(() => explicitClient);
    const resolveClientCapabilities = vi.fn(() => clientCapabilities);
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient,
      createStdioTransportClient,
      resolveClientCapabilities,
    });
    await runtime.replaceResolvedConfig(resolved(testCase.server));
    await runtime.host.invoke({
      _meta: { traceId: 'trace-1' },
      configuredServerId: testCase.server.name,
      cursor: testCase.cursor,
      type: 'tools/list',
    });
    expect(explicitClient.listTools).toHaveBeenCalledWith(
      { signal: expect.any(AbortSignal) },
      { _meta: { traceId: 'trace-1' }, cursor: testCase.cursor }
    );
    const onProgress = vi.fn();
    await runtime.host.invoke(
      {
        arguments: { value: 'hello' },
        configuredServerId: testCase.server.name,
        toolName: 'echo',
        type: 'tools/call',
      },
      { onProgress }
    );
    expect(explicitClient.callTool).toHaveBeenCalledWith(
      { arguments: { value: 'hello' }, name: 'echo' },
      expect.objectContaining({ onprogress: onProgress, signal: expect.any(AbortSignal) })
    );
    const report = await runtime.host.close();
    expect(report).toMatchObject({
      callbacksClosed: 1,
      childProcessesClosed: testCase.childProcessesClosed,
      clientsClosed: 1,
      requestsSettled: 2,
    });
    if (testCase.server.transport === 'stdio') {
      expect(createStdioTransportClient).toHaveBeenCalledWith(
        expect.objectContaining({ clientCapabilities })
      );
    } else {
      expect(createHttpTransportClient).toHaveBeenCalledWith(
        expect.objectContaining({
          clientCapabilities,
          lifecycle: 'host-owned',
          onUnexpectedClose: expect.any(Function),
        })
      );
    }
    expect(resolveClientCapabilities).toHaveBeenCalledWith(testCase.server);
  });

  it.each([http(), stdio()])(
    'omits clientCapabilities entirely when desktop has no explicit resolver for $transport',
    async (server) => {
      const explicitClient = transportClient();
      const createHttpTransportClient = vi.fn((_options: unknown) => explicitClient);
      const createStdioTransportClient = vi.fn((_options: unknown) => explicitClient);
      const runtime = createDesktopMcpHostRuntime({
        createHttpTransportClient,
        createStdioTransportClient,
      });
      await runtime.replaceResolvedConfig(resolved(server));

      await runtime.host.invoke({
        configuredServerId: server.name,
        type: 'tools/list',
      });

      const factory =
        server.transport === 'stdio' ? createStdioTransportClient : createHttpTransportClient;
      expect(factory).toHaveBeenCalledOnce();
      expect(factory.mock.calls[0]?.[0]).not.toHaveProperty('clientCapabilities');
      await runtime.host.close();
    }
  );
});

import type { ExplicitHttpMcpClient } from '@brainstrike/agent/mcp-client';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import type {
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from '@brainstrike/host-capabilities/mcp/config-file';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';

const transportClient = () => ({
  callTool: vi.fn(async () => ({ content: [] })),
  close: vi.fn(async () => undefined),
  complete: vi.fn(async () => ({ completion: { values: [] } })),
  connect: vi.fn(async (_options?: TransportConnectOptions) => undefined),
  getNegotiatedProtocolVersion: vi.fn(() => '2026-07-28'),
  getPrompt: vi.fn(async () => ({ messages: [] })),
  getProtocolEra: vi.fn(() => 'modern' as const),
  getServerCapabilities: vi.fn(() => ({ tools: {} })),
  getServerVersion: vi.fn(() => ({ name: 'test', version: '1.0.0' })),
  listen: vi.fn(),
  listPrompts: vi.fn(async () => ({ prompts: [] })),
  listResources: vi.fn(async () => ({ resources: [] })),
  listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
  listTools: vi.fn(async () => ({ tools: [] })),
  readResource: vi.fn(async () => ({ contents: [] })),
  subscribeResource: vi.fn(async () => undefined),
  unsubscribeResource: vi.fn(async () => undefined),
  watchServerFeatures: vi.fn(() => vi.fn()),
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

describe('DesktopMcpHostRuntime core feature composition', () => {
  it('retires suspended elicitation on every production authority invalidation path', async () => {
    for (const cause of [
      'unexpected-close',
      'disconnect',
      'replacement',
      'reset',
      'close',
      'invalid-reauthorize',
    ]) {
      let authority: ReturnType<typeof createDesktopMcpHostRuntime>['elicitationPresenter'];
      let activePresentation: Parameters<Parameters<typeof authority.attach>[0]>[0] | undefined;
      let unexpectedClose: (() => void) | undefined;
      const dispatchStarted = Promise.withResolvers<void>();
      const elicitationResult = Promise.withResolvers<unknown>();
      const presented = Promise.withResolvers<void>();
      const explicitClient = transportClient();
      explicitClient.callTool.mockImplementation(async () => {
        dispatchStarted.resolve();
        await elicitationResult.promise;
        return { content: [] };
      });
      const runtime = createDesktopMcpHostRuntime({
        createHttpTransportClient: (options) => {
          unexpectedClose = options.onUnexpectedClose;
          return explicitClient;
        },
      });
      authority = runtime.elicitationPresenter;
      authority.attach((presentation) => {
        activePresentation = presentation;
        presented.resolve();
      });
      await runtime.replaceResolvedConfig(resolved(http()));
      await runtime.host.invoke({ configuredServerId: http().name, type: 'tools/list' });
      const pending = runtime.host.invoke({
        arguments: {},
        configuredServerId: http().name,
        toolName: 'suspend',
        type: 'tools/call',
      });
      await dispatchStarted.promise;
      void authority.presenter
        .presentForm(
          {
            method: 'elicitation/create',
            params: {
              message: 'Choose',
              mode: 'form',
              requestedSchema: { properties: {}, type: 'object' },
            },
          },
          {
            requestId: 'queued',
            serverName: http().name,
            signal: new AbortController().signal,
          }
        )
        .then(elicitationResult.resolve, elicitationResult.reject);
      await presented.promise;
      if (cause === 'invalid-reauthorize') {
        await expect(
          runtime.host.control({ action: 'reauthorize', configuredServerId: http().name })
        ).rejects.toMatchObject({ code: 'mcp-host-reauthorize-requires-oauth' });
        authority.settle({
          action: 'cancel',
          configuredServerId: http().name,
          generation: 1,
          id: activePresentation?.id,
          requestId: 'queued',
        });
      } else if (cause === 'unexpected-close') {
        unexpectedClose?.();
      } else if (cause === 'disconnect') {
        await runtime.host.control({ action: 'disconnect', configuredServerId: http().name });
      } else if (cause === 'replacement') {
        await runtime.replaceResolvedConfig(
          resolved({ ...http(), url: 'https://new.example/mcp' })
        );
      } else if (cause === 'reset') {
        await runtime.replaceResolvedConfig(resolved());
      } else {
        await runtime.host.close();
      }
      await (cause === 'invalid-reauthorize'
        ? expect(pending).resolves.toBeDefined()
        : expect(pending).rejects.toBeDefined());
      if (cause !== 'close') {
        await runtime.host.close();
      }
    }
  });
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
    // The runtime resolves capabilities against the EFFECTIVE private
    // definition, which carries the registered-extension dials (BST-1604).
    expect(resolveClientCapabilities).toHaveBeenCalledWith({
      ...testCase.server,
      extensions: { apps: true, tasks: true },
    });
  });

  it('closes the feature subscription before closing its transport client', async () => {
    let subscriptionClosed = false;
    const closeOrder: string[] = [];
    const explicitClient = transportClient();
    explicitClient.getServerCapabilities.mockReturnValue({ tools: { listChanged: true } });
    explicitClient.listen.mockResolvedValue({
      close: vi.fn(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        subscriptionClosed = true;
        closeOrder.push('subscription');
      }),
      closed: new Promise<'graceful' | 'local' | 'remote'>(() => undefined),
      honoredFilter: { toolsListChanged: true },
    });
    explicitClient.watchServerFeatures.mockImplementation(() =>
      vi.fn(() => {
        closeOrder.push('feature-events');
      })
    );
    explicitClient.close.mockImplementation(async () => {
      if (!subscriptionClosed) {
        throw new Error('transport closed before feature subscription');
      }
      closeOrder.push('client');
    });
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => explicitClient,
    });
    await runtime.replaceResolvedConfig(resolved(http()));
    await runtime.host.invoke({
      configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
      type: 'tools/list',
    });

    const report = await runtime.host.close();

    expect(report.failures).toEqual([]);
    expect(report.subscriptionsClosed).toBe(1);
    expect(closeOrder).toEqual(['feature-events', 'subscription', 'client']);
  });

  it.each([http(), stdio()])(
    'omits clientCapabilities entirely when an explicit resolver declines for $transport',
    async (server) => {
      const explicitClient = transportClient();
      const createHttpTransportClient = vi.fn((_options: unknown) => explicitClient);
      const createStdioTransportClient = vi.fn((_options: unknown) => explicitClient);
      const runtime = createDesktopMcpHostRuntime({
        createHttpTransportClient,
        createStdioTransportClient,
        resolveClientCapabilities: () => undefined,
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

  it('routes raw catalog causes to the internal sink without exposing them in snapshots', async () => {
    const explicitClient = transportClient();
    const raw = new Error('authorization=Bearer private-token');
    const onInternalError = vi.fn();
    explicitClient.listTools.mockRejectedValueOnce(raw);
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => explicitClient,
      onInternalError,
    });

    await runtime.replaceResolvedConfig(resolved(http()));
    await runtime.host.invoke({
      configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
      cursor: 'page-two',
      type: 'tools/list',
    });

    expect(onInternalError).toHaveBeenCalledWith('mcp-tools-failed', raw);
    expect(runtime.host.snapshot().servers[0]).toMatchObject({
      catalog: {
        errors: {
          tools: {
            category: 'operation',
            code: 'mcp-tools-failed',
            message: 'MCP catalog operation failed',
          },
        },
      },
    });
    expect(JSON.stringify(runtime.host.snapshot())).not.toContain('Bearer private-token');
    await runtime.host.close();
  });

  it('advertises form and URL elicitation backed by the process-local presenter', async () => {
    const captured: Record<'http' | 'stdio', unknown> = { http: undefined, stdio: undefined };
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: (options) => {
        captured.http = options.clientCapabilities;
        return transportClient();
      },
      createStdioTransportClient: (options) => {
        captured.stdio = options.clientCapabilities;
        return transportClient();
      },
    });
    expect(runtime.elicitationPresenter.presenter).toMatchObject({ form: true, url: true });
    await runtime.replaceResolvedConfig(resolved(http(), stdio()));
    await runtime.host.invoke({ configuredServerId: http().name, type: 'tools/list' });
    await runtime.host.invoke({ configuredServerId: stdio().name, type: 'tools/list' });
    for (const transport of ['http', 'stdio'] as const) {
      expect(captured[transport], transport).toEqual({
        elicitation: {
          form: true,
          handle: expect.any(Function),
          url: true,
          urlPolicy: 'https-only',
        },
      });
    }
    const advertised = captured.http as {
      elicitation: {
        handle: (request: unknown, context: unknown) => Promise<unknown>;
      };
    };
    // Fail closed: with no renderer listener attached, an inbound
    // elicitation/create rejects instead of auto-accepting.
    await expect(
      advertised.elicitation.handle(
        {
          method: 'elicitation/create',
          params: {
            message: 'Confirm',
            mode: 'form',
            requestedSchema: { properties: {}, type: 'object' },
          },
        },
        { requestId: 'unattended', serverName: http().name, signal: new AbortController().signal }
      )
    ).rejects.toMatchObject({ code: 'mcp-elicitation-presenter-unavailable' });
    await runtime.host.close();
  });
});

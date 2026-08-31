import type { ExplicitHttpMcpClient } from '@brainstrike/agent/mcp-client';
import type { McpHostCloseReport, McpHostConfig } from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId, parseMcpHostConfig } from '@brainstrike/assistant-contract';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime, getDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { McpHostService } from '../../mcp/host-service';
import type { McpServerActorClientFactory } from '../../mcp/server-actor';
import type { ResolvedMcpConfig, ResolvedMcpServer } from '../../mcp-loader';

const REF = '00000000-0000-4000-8000-000000000001';
const UNKNOWN = '00000000-0000-4000-8000-000000000099';
const CLEAN: McpHostCloseReport = {
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 1,
  failures: [],
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
};
const client = () => ({
  close: vi.fn(async () => CLEAN),
  invoke: vi.fn(async () => ({ tools: [] })),
  negotiated: {
    advertisedCapabilityIds: ['tools'],
    era: 'modern' as const,
    revision: '2026-07-28',
  },
});
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
type ActorContext = Parameters<McpServerActorClientFactory>[0];
type TransportConnectOptions = Parameters<ExplicitHttpMcpClient['connect']>[0];
const http = (patch: Partial<HttpServer> = {}): HttpServer => ({
  headers: { Authorization: 'Bearer private-token' },
  name: parseConfiguredMcpServerId('team.linear.prod'),
  protocol: 'auto',
  startup: 'automatic',
  transport: 'streamable-http',
  url: 'https://linear.example/mcp',
  ...patch,
});
const stdio = (patch: Partial<StdioServer> = {}): StdioServer => ({
  args: ['--private-arg'],
  command: '/private/mcp-server',
  env: { PRIVATE_TOKEN: 'stdio-secret' },
  name: parseConfiguredMcpServerId('local.tools'),
  protocol: 'auto',
  startup: 'automatic',
  transport: 'stdio',
  ...patch,
});
const resolved = (...servers: ResolvedMcpServer[]): ResolvedMcpConfig => ({ servers });

function setup() {
  let next = 0;
  const onInternalError = vi.fn();
  const createActorClient = vi.fn((_server: ResolvedMcpServer, _context: ActorContext) => client());
  const runtime = createDesktopMcpHostRuntime({
    createActorClient,
    createConfigRef: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    onInternalError,
  });
  return { createActorClient, onInternalError, runtime };
}
const publicConfig = (
  configRef: string,
  type: 'stdio' | 'streamable-http',
  patch: Partial<McpHostConfig['servers'][number]> = {}
): McpHostConfig =>
  parseMcpHostConfig({
    servers: [
      {
        auth: { type: 'none' },
        configuredProtocol: 'auto',
        configuredServerId: 'team.linear.prod',
        transport: { configRef, type },
        ...patch,
      },
    ],
  });

afterEach(() => vi.restoreAllMocks());

describe('DesktopMcpHostRuntime', () => {
  it('reuses refs only for identical private configs and exposes no private material', async () => {
    const replace = vi.spyOn(McpHostService.prototype, 'replaceConfig');
    const { runtime } = setup();
    const variants = [
      [http(), http({ url: 'https://linear.example/v2' })],
      [http(), http({ headers: { Authorization: 'Bearer changed' } })],
      [stdio(), stdio({ command: '/private/other-server' })],
      [stdio(), stdio({ args: ['--changed'] })],
      [stdio(), stdio({ env: { PRIVATE_TOKEN: 'changed' } })],
      [http(), http({ name: parseConfiguredMcpServerId('team.linear.next') })],
      [http(), http({ protocol: 'legacy' })],
      [http(), stdio({ name: parseConfiguredMcpServerId('team.linear.prod') })],
    ] satisfies [ResolvedMcpServer, ResolvedMcpServer][];
    for (const [base, changed] of variants) {
      await runtime.replaceResolvedConfig(resolved(base));
      const first = replace.mock.lastCall?.[0].servers[0]?.transport.configRef;
      await runtime.replaceResolvedConfig(resolved(base));
      expect(replace.mock.lastCall?.[0].servers[0]?.transport.configRef).toBe(first);
      await runtime.replaceResolvedConfig(resolved(changed));
      expect(replace.mock.lastCall?.[0].servers[0]?.transport.configRef).not.toBe(first);
    }
    await runtime.replaceResolvedConfig(resolved(http({ enabledTools: ['issues.list'] })));
    const preferenceRef = replace.mock.lastCall?.[0].servers[0]?.transport.configRef;
    await runtime.replaceResolvedConfig(resolved(http({ enabledTools: ['issues.get'] })));
    expect(replace.mock.lastCall?.[0].servers[0]?.transport.configRef).toBe(preferenceRef);
    expect(replace.mock.lastCall?.[0].servers[0]?.enabledTools).toEqual(['issues.get']);
    const snapshot = await runtime.replaceResolvedConfig(resolved(http(), stdio()));
    const exposed = JSON.stringify({ config: replace.mock.lastCall?.[0], snapshot });
    for (const value of [
      'linear.example',
      'Authorization',
      'private-token',
      '/private/mcp-server',
      '--private-arg',
      'PRIVATE_TOKEN',
      'stdio-secret',
    ]) {
      expect(exposed).not.toContain(value);
    }
  });

  it('snapshots private config and preserves committed refs during self-heal', async () => {
    const firstClose = Promise.withResolvers<void>();
    let created = 0;
    let invalidate: (() => void) | undefined;
    const createActorClient = vi.fn((_server: ResolvedMcpServer, context: ActorContext) => {
      created += 1;
      invalidate = context.onUnexpectedClose;
      const actorClient = client();
      if (created === 1) {
        actorClient.close = vi.fn(async () => {
          await firstClose.promise;
          return CLEAN;
        });
      }
      return actorClient;
    });
    const runtime = createDesktopMcpHostRuntime({ createActorClient, createConfigRef: () => REF });
    const original = http();
    await runtime.replaceResolvedConfig(resolved(original));
    if (!original.headers) {
      throw new Error('HTTP fixture must define private headers');
    }
    original.headers['Authorization'] = 'Bearer mutated-after-replacement';
    const operation = {
      configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
      type: 'tools/list' as const,
    };
    await runtime.host.invoke(operation);
    expect(createActorClient.mock.calls[0]?.[0]).toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
    });
    if (!invalidate) {
      throw new Error('Expected the actor invalidation callback');
    }
    invalidate();
    const selfHeal = runtime.host.invoke(operation);
    const replacement = runtime.replaceResolvedConfig(
      resolved(http({ url: 'https://linear.example/next' }))
    );
    firstClose.resolve();
    await Promise.all([selfHeal, replacement]);
    await runtime.host.invoke(operation);
    expect(createActorClient.mock.lastCall?.[0]).toMatchObject({
      url: 'https://linear.example/next',
    });
  });

  it('isolates committed private config from actor-client mutation', async () => {
    const firstClose = Promise.withResolvers<void>();
    let created = 0;
    let invalidate: (() => void) | undefined;
    const observedServers: ResolvedMcpServer[] = [];
    const createActorClient = vi.fn((server: ResolvedMcpServer, context: ActorContext) => {
      created += 1;
      invalidate = context.onUnexpectedClose;
      observedServers.push(structuredClone(server));
      if (server.transport === 'streamable-http' && server.headers) {
        server.headers['Authorization'] = 'Bearer actor-mutated';
      }
      const actorClient = client();
      if (created === 1) {
        actorClient.close = vi.fn(async () => {
          await firstClose.promise;
          return CLEAN;
        });
      }
      return actorClient;
    });
    const runtime = createDesktopMcpHostRuntime({ createActorClient, createConfigRef: () => REF });
    await runtime.replaceResolvedConfig(resolved(http()));
    const operation = {
      configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
      type: 'tools/list' as const,
    };
    await runtime.host.invoke(operation);
    if (!invalidate) {
      throw new Error('Expected the actor invalidation callback');
    }
    invalidate();
    const selfHeal = runtime.host.invoke(operation);
    firstClose.resolve();
    await selfHeal;
    expect(observedServers[1]).toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
    });
  });

  it('snapshots resolved config synchronously before queued replacement work', async () => {
    const deferred = Promise.withResolvers<ReturnType<McpHostService['snapshot']>>();
    vi.spyOn(McpHostService.prototype, 'replaceConfig').mockImplementationOnce(
      async () => await deferred.promise
    );
    const { createActorClient, runtime } = setup();
    const blocker = runtime.host.replaceConfig({ servers: [] });
    const next = http({ url: 'https://linear.example/next' });
    const replacement = runtime.replaceResolvedConfig(resolved(next));
    next.url = 'https://linear.example/mutated-before-enqueue-runs';
    deferred.resolve({ revision: 1, servers: [] });
    await Promise.all([blocker, replacement]);
    await runtime.host.invoke({
      configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
      type: 'tools/list',
    });
    expect(createActorClient.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://linear.example/next',
    });
  });

  it('serializes direct replacements behind the resolved-config queue', async () => {
    const deferred = Promise.withResolvers<ReturnType<McpHostService['snapshot']>>();
    const replace = vi
      .spyOn(McpHostService.prototype, 'replaceConfig')
      .mockImplementationOnce(async () => await deferred.promise)
      .mockResolvedValue({ revision: 2, servers: [] });
    const { runtime } = setup();
    const resolvedReplacement = runtime.replaceResolvedConfig(resolved(http()));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    const directReplacement = runtime.host.replaceConfig(publicConfig(REF, 'streamable-http'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(replace).toHaveBeenCalledOnce();
    deferred.resolve({ revision: 1, servers: [] });
    await Promise.all([resolvedReplacement, directReplacement]);
  });

  it('isolates rejected async diagnostic sinks', async () => {
    const onInternalError = vi.fn(async () => {
      throw new Error('diagnostic sink rejected');
    });
    const failing = createDesktopMcpHostRuntime({
      createActorClient: vi.fn(async () => {
        throw new Error('connect failed');
      }),
      createConfigRef: () => REF,
      onInternalError,
    });
    await failing.replaceResolvedConfig(resolved(http()));
    await expect(
      failing.host.invoke({
        configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
        type: 'tools/list',
      })
    ).rejects.toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onInternalError).toHaveBeenCalled();
  });

  it('rejects malformed, duplicate, unknown, and mismatched refs visibly', async () => {
    const malformed = setup().runtime;
    const invalid = {
      servers: [
        {
          ...publicConfig(REF, 'streamable-http').servers[0],
          transport: { configRef: 'bad', type: 'streamable-http' },
        },
      ],
    } as unknown as McpHostConfig;
    await expect(malformed.host.replaceConfig(invalid)).rejects.toBeDefined();
    let refAttempt = 0;
    const recovering = createDesktopMcpHostRuntime({
      createActorClient: vi.fn(() => client()),
      createConfigRef: () => (++refAttempt === 1 ? 'bad' : REF),
    });
    await expect(recovering.replaceResolvedConfig(resolved(http()))).rejects.toBeDefined();
    await expect(recovering.replaceResolvedConfig(resolved(http()))).resolves.toBeDefined();
    expect(() =>
      parseMcpHostConfig({
        servers: [
          publicConfig(REF, 'streamable-http').servers[0],
          publicConfig(UNKNOWN, 'streamable-http').servers[0],
        ],
      })
    ).toThrow('duplicate configured server id');
    const unknown = setup();
    await expect(
      unknown.runtime.host.replaceConfig(publicConfig(UNKNOWN, 'streamable-http'))
    ).rejects.toMatchObject({ code: 'mcp-host-actor-create-failed' });
    expect(unknown.onInternalError).toHaveBeenCalledWith(
      'mcp-host-actor-create-failed',
      expect.objectContaining({ code: 'mcp-config-ref-unknown' })
    );
    for (const [config, code] of [
      [publicConfig(REF, 'stdio'), 'mcp-config-ref-transport-mismatch'],
      [
        publicConfig(REF, 'streamable-http', { configuredProtocol: 'legacy' }),
        'mcp-config-ref-protocol-mismatch',
      ],
      [
        publicConfig(REF, 'streamable-http', {
          configuredServerId: parseConfiguredMcpServerId('team.linear.next'),
        }),
        'mcp-config-ref-server-mismatch',
      ],
    ] as const) {
      const mismatch = setup();
      await mismatch.runtime.replaceResolvedConfig(resolved(http()));
      await expect(mismatch.runtime.host.replaceConfig(config)).rejects.toMatchObject({
        code: 'mcp-host-actor-create-failed',
      });
      expect(mismatch.onInternalError).toHaveBeenCalledWith(
        'mcp-host-actor-create-failed',
        expect.objectContaining({ code })
      );
    }
  });

  it.each([
    { childProcessesClosed: 0, cursor: '', server: http() },
    { childProcessesClosed: 1, cursor: 'next-page', server: stdio() },
  ])('composes $server.transport with exact close accounting', async (testCase) => {
    const explicitClient = transportClient();
    const createHttpTransportClient = vi.fn(() => explicitClient);
    const createStdioTransportClient = vi.fn(() => explicitClient);
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient,
      createStdioTransportClient,
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
    if (testCase.server.transport !== 'stdio') {
      expect(createHttpTransportClient).toHaveBeenCalledWith(
        expect.objectContaining({
          lifecycle: 'host-owned',
          onUnexpectedClose: expect.any(Function),
        })
      );
    }
  });

  it('projects sanitized stdio diagnostics and sends the same text through durable logging', async () => {
    const explicitClient = transportClient();
    const records: LogRecord[] = [];
    const stop = addLogListener((record) => records.push(record));
    const runtime = createDesktopMcpHostRuntime({
      createStdioTransportClient: (options) => {
        options.onStderr?.(
          'Authorize at https://auth.example/callback?code=private-code&state=private-state\n'
        );
        return explicitClient;
      },
    });
    try {
      await runtime.replaceResolvedConfig(resolved(stdio({ startup: 'authentication-required' })));
      expect(runtime.host.snapshot().servers[0]?.state).toBe('authentication-required');

      await runtime.host.control({
        action: 'connect',
        configuredServerId: parseConfiguredMcpServerId('local.tools'),
      });

      const diagnostic = runtime.host.snapshot().servers[0]?.diagnostics?.[0]?.message;
      expect(diagnostic).toBe('Authorize at https://auth.example/callback?[redacted-query]');
      expect(records).toContainEqual(
        expect.objectContaining({
          args: ['MCP stdio diagnostic', expect.objectContaining({ diagnostic })],
          level: LogLevel.WARN,
          message: 'MCP stdio diagnostic',
          scope: 'DesktopMcpHostRuntime',
        })
      );
      expect(JSON.stringify({ diagnostic, records })).not.toMatch(/private-code|private-state/u);
    } finally {
      stop();
      await runtime.host.close();
    }
  });

  it('keeps explicit authentication user-paced beyond the automatic ten-second deadline', async () => {
    vi.useFakeTimers();
    const connectGate = Promise.withResolvers<void>();
    const explicitClient = transportClient();
    explicitClient.connect.mockImplementation(async (options) => {
      expect(options).not.toHaveProperty('timeout');
      await connectGate.promise;
    });
    const runtime = createDesktopMcpHostRuntime({
      createStdioTransportClient: () => explicitClient,
    });
    try {
      await runtime.replaceResolvedConfig(resolved(stdio({ startup: 'authentication-required' })));
      const connect = runtime.host.control({
        action: 'connect',
        configuredServerId: parseConfiguredMcpServerId('local.tools'),
      });
      await vi.waitFor(() => expect(explicitClient.connect).toHaveBeenCalledOnce());

      let settled = false;
      void connect.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(settled).toBe(false);

      connectGate.resolve();
      await expect(connect).resolves.toMatchObject({ state: 'connected' });
    } finally {
      await runtime.host.close();
      vi.useRealTimers();
    }
  });

  it('surfaces connection and cleanup failures together', async () => {
    const explicitClient = transportClient();
    const onInternalError = vi.fn();
    explicitClient.connect.mockRejectedValue(new Error('connect failed'));
    explicitClient.close.mockRejectedValue(new Error('cleanup failed'));
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => explicitClient,
      onInternalError,
    });
    await runtime.replaceResolvedConfig(resolved(http()));
    await expect(
      runtime.host.invoke({
        configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
        type: 'tools/list',
      })
    ).rejects.toMatchObject({ code: 'mcp-client-creation-failed' });
    expect(onInternalError).toHaveBeenCalledWith(
      'mcp-client-creation-failed',
      expect.objectContaining({
        errors: [
          expect.objectContaining({
            cause: expect.objectContaining({ message: 'connect failed' }),
            code: 'mcp-connection-failed',
          }),
          expect.objectContaining({ message: 'cleanup failed' }),
        ],
      })
    );
    await expect(runtime.host.close()).resolves.toMatchObject({
      failures: [expect.objectContaining({ code: 'mcp-client-creation-cleanup-failed' })],
    });
  });

  it('drains accepted operations before reporting close and exposes one singleton', async () => {
    const listing = Promise.withResolvers<{ tools: [] }>();
    const explicitClient = transportClient();
    explicitClient.listTools.mockImplementation(async () => await listing.promise);
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => explicitClient,
    });
    await runtime.replaceResolvedConfig(resolved(http()));
    const invocation = runtime.host.invoke({
      configuredServerId: parseConfiguredMcpServerId('team.linear.prod'),
      type: 'tools/list',
    });
    await vi.waitFor(() => expect(explicitClient.listTools).toHaveBeenCalledOnce());
    const closing = runtime.host.close();
    await Promise.resolve();
    expect(explicitClient.close).not.toHaveBeenCalled();
    listing.resolve({ tools: [] });
    await expect(invocation).rejects.toMatchObject({ category: 'generation-retired' });
    await expect(closing).resolves.toMatchObject({ requestsSettled: 1 });
    expect(getDesktopMcpHostRuntime()).toBe(getDesktopMcpHostRuntime());
  });
});

/**
 * Extension registration seam + task host binding on the desktop host runtime
 * (BST-1566). The truthfulness gate here uses the REAL default resolver, not
 * a registry the test builds itself.
 */
import type { McpClientExtensionRegistry } from '@brainstrike/agent/mcp-client';
import { MCP_SUPPORT_MATRIX, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { MCP_APPS_CLIENT_CAPABILITY } from '@brainstrike/mcp-app-host';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultMcpExtensionRegistry } from '../../mcp/host-extensions';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import type { McpDesktopTaskHostPort, McpTaskConnection } from '../../mcp/task-host';
import type { ResolvedMcpConfig, ResolvedMcpServer } from '../../mcp-loader';

type HttpServer = Extract<ResolvedMcpServer, { transport: 'streamable-http' }>;
type StdioServer = Extract<ResolvedMcpServer, { transport: 'stdio' }>;
const http = (patch: Partial<HttpServer> = {}): HttpServer => ({
  name: parseConfiguredMcpServerId('team.tasks.prod'),
  protocol: '2026-07-28',
  startup: 'automatic',
  transport: 'streamable-http',
  url: 'https://tasks.example.test/mcp',
  ...patch,
});
const stdio = (patch: Partial<StdioServer> = {}): StdioServer => ({
  command: '/usr/local/bin/tasks',
  name: parseConfiguredMcpServerId('local.tasks'),
  protocol: '2026-07-28',
  startup: 'automatic',
  transport: 'stdio',
  ...patch,
});
const resolved = (...servers: ResolvedMcpServer[]): ResolvedMcpConfig => ({ servers });
/** Actors connect lazily; a config load alone never opens a transport. */
async function loadAndConnect(
  runtime: ReturnType<typeof createDesktopMcpHostRuntime>,
  ...servers: ResolvedMcpServer[]
) {
  await runtime.replaceResolvedConfig(resolved(...servers));
  return await Promise.all(
    servers.map((server) =>
      runtime.host.control({ action: 'connect', configuredServerId: server.name })
    )
  );
}
const transportClient = () => ({
  callTool: vi.fn(async () => ({ content: [] })),
  close: vi.fn(async () => undefined),
  complete: vi.fn(async () => ({ completion: { values: [] } })),
  connect: vi.fn(async () => undefined),
  getNegotiatedProtocolVersion: vi.fn(() => '2026-07-28'),
  getPrompt: vi.fn(async () => ({ messages: [] })),
  getProtocolEra: vi.fn(() => 'modern' as const),
  getServerCapabilities: vi.fn(() => ({ tools: {} })),
  getServerVersion: vi.fn(() => ({ name: 'test', version: '1.0.0' })),
  listen: vi.fn(),
  listenTasks: vi.fn(),
  listPrompts: vi.fn(async () => ({ prompts: [] })),
  listResources: vi.fn(async () => ({ resources: [] })),
  listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
  listTools: vi.fn(async () => ({ tools: [] })),
  readResource: vi.fn(async () => ({ contents: [] })),
  requestExtension: vi.fn(),
  subscribeResource: vi.fn(async () => undefined),
  unsubscribeResource: vi.fn(async () => undefined),
  watchServerFeatures: vi.fn(() => vi.fn()),
});

function createTaskHost() {
  const events: string[] = [];
  const connections: McpTaskConnection[] = [];
  const taskHost: McpDesktopTaskHostPort = {
    act: vi.fn(),
    awaitSettlement: vi.fn(),
    close: vi.fn(async () => {
      events.push('close');
    }),
    connected: vi.fn(async (connection) => {
      connections.push(connection);
      events.push(`connected:${connection.configuredServerId}:${connection.generation}`);
    }),
    disconnected: vi.fn(async (id, generation) => {
      events.push(`disconnected:${id}:${generation}`);
    }),
    list: vi.fn(() => ({ tasks: [] })),
    retired: vi.fn(async (id, reason) => {
      events.push(`retired:${id}:${reason}`);
    }),
    subscribe: vi.fn(() => () => undefined),
    track: vi.fn(),
  };
  return { connections, events, taskHost };
}

describe('createDefaultMcpExtensionRegistry', () => {
  const supportedExtensionIds = MCP_SUPPORT_MATRIX.filter(
    ({ kind, status }) => kind === 'extension' && status === 'supported'
  ).map(({ id }) => id);

  it.each([stdio(), http()])('advertises exactly the support matrix on $transport', (server) => {
    const registry = createDefaultMcpExtensionRegistry(server);
    const capabilities = registry?.toClientExtensionCapabilities() ?? {};
    expect(Object.keys(capabilities)).toEqual(supportedExtensionIds);
    expect(capabilities['io.modelcontextprotocol/ui']).toEqual(MCP_APPS_CLIENT_CAPABILITY);
    expect(supportedExtensionIds).toEqual([
      'io.modelcontextprotocol/ui',
      'io.modelcontextprotocol/tasks',
    ]);
  });

  it('registers nothing on the legacy sse transport', () => {
    expect(
      createDefaultMcpExtensionRegistry({ ...http(), protocol: 'legacy', transport: 'sse' })
    ).toBeUndefined();
  });

  it.each([stdio(), http()])(
    'advertises only the enabled extensions on $transport (BST-1604)',
    (server) => {
      const appsOnly = createDefaultMcpExtensionRegistry({
        ...server,
        extensions: { apps: true, tasks: false },
      });
      expect(Object.keys(appsOnly?.toClientExtensionCapabilities() ?? {})).toEqual([
        'io.modelcontextprotocol/ui',
      ]);
      const tasksOnly = createDefaultMcpExtensionRegistry({
        ...server,
        extensions: { apps: false, tasks: true },
      });
      expect(Object.keys(tasksOnly?.toClientExtensionCapabilities() ?? {})).toEqual([
        'io.modelcontextprotocol/tasks',
      ]);
    }
  );

  it.each([stdio(), http()])(
    'registers no registry at all when both dials are off on $transport (BST-1604)',
    (server) => {
      expect(
        createDefaultMcpExtensionRegistry({
          ...server,
          extensions: { apps: false, tasks: false },
        })
      ).toBeUndefined();
    }
  );

  it('returns a fresh registry per call because a registry seals on first projection', () => {
    const first = createDefaultMcpExtensionRegistry(stdio());
    const second = createDefaultMcpExtensionRegistry(stdio());
    expect(first).not.toBe(second);
    first?.toClientExtensionCapabilities();
    expect(() =>
      (first as McpClientExtensionRegistry).register(
        { id: 'example/later', version: '1' } as never,
        {} as never
      )
    ).toThrow(/sealed/u);
  });
});

describe('DesktopMcpHostRuntime task host binding', () => {
  it('threads a fresh registry per generation into both transports and binds the task host', async () => {
    const registries: (McpClientExtensionRegistry | undefined)[] = [];
    const resolveExtensionRegistry = vi.fn((server: ResolvedMcpServer) => {
      const registry = createDefaultMcpExtensionRegistry(server);
      registries.push(registry);
      return registry;
    });
    const explicitClient = transportClient();
    const createHttpTransportClient = vi.fn(() => explicitClient);
    const createStdioTransportClient = vi.fn(() => explicitClient);
    const { connections, events, taskHost } = createTaskHost();
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient,
      createStdioTransportClient,
      resolveExtensionRegistry,
      taskHost,
    });
    await loadAndConnect(runtime, http(), stdio());
    expect(createHttpTransportClient).toHaveBeenCalledWith(
      expect.objectContaining({ extensionRegistry: registries[0] })
    );
    expect(createStdioTransportClient).toHaveBeenCalledWith(
      expect.objectContaining({ extensionRegistry: registries[1] })
    );
    expect(registries[0]).not.toBe(registries[1]);
    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({
      configuredServerId: http().name,
      generation: 1,
      registry: registries[0],
      server: http(),
    });
    expect(connections[0]?.configRef).toEqual(expect.any(String));
    expect(connections[0]?.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

    // enabledTools-only reload: no retirement, same private definition (configRef).
    await loadAndConnect(runtime, http({ enabledTools: ['echo'] }), stdio());
    expect(events.filter((event) => event.startsWith('retired'))).toEqual([]);
    expect(connections[2]?.configRef).toBe(connections[0]?.configRef);
    expect(connections[2]?.generation).toBe(2);
    // Definition replacement retires before the old generation disconnects.
    await loadAndConnect(
      runtime,
      http({ enabledTools: ['echo'], url: 'https://new.example/mcp' }),
      stdio()
    );
    expect(connections[3]?.configRef).not.toBe(connections[0]?.configRef);
    // Removal.
    await runtime.replaceResolvedConfig(resolved(stdio()));
    await runtime.host.close();
    const httpEvents = events.filter((event) => event.includes(http().name));
    expect(httpEvents).toEqual([
      `connected:${http().name}:1`,
      `disconnected:${http().name}:1`,
      `connected:${http().name}:2`,
      `retired:${http().name}:server-replaced`,
      `disconnected:${http().name}:2`,
      `connected:${http().name}:3`,
      `retired:${http().name}:server-removed`,
      `disconnected:${http().name}:3`,
    ]);
    expect(events.at(-1)).toBe('close');
  });

  it('keeps the old Tasks session when a replacement definition fails to prepare', async () => {
    const explicitClient = transportClient();
    const { events, taskHost } = createTaskHost();
    const inspect = vi
      .fn<() => Promise<{ state: 'stored' }>>()
      .mockResolvedValueOnce({ state: 'stored' })
      .mockRejectedValueOnce(new Error('credential store unavailable'));
    const runtime = createDesktopMcpHostRuntime({
      bearerCredentialAuthority: {
        createFetch: vi.fn(() => async () => new Response(null, { status: 204 })),
        inspect,
      },
      createHttpTransportClient: () => explicitClient,
      taskHost,
    });
    const bearer = (id: string) =>
      http({ auth: { credential: { id, store: 'mcp-credentials' }, type: 'bearer' } });
    await loadAndConnect(runtime, bearer('11111111-1111-4111-8111-111111111111'));
    expect(events).toEqual([`connected:${http().name}:1`]);

    // Private definition changes (new credential), but preparation rejects.
    await expect(
      runtime.replaceResolvedConfig(resolved(bearer('22222222-2222-4222-8222-222222222222')))
    ).rejects.toThrow('credential store unavailable');
    expect(events).toEqual([`connected:${http().name}:1`]);
    expect(runtime.host.snapshot().servers[0]).toMatchObject({ generation: 1 });
    await runtime.host.close();
    expect(events.filter((event) => event.startsWith('retired'))).toEqual([]);
  });

  it('opens no task session when Tasks is off but Apps is still advertised (BST-1604)', async () => {
    const explicitClient = transportClient();
    const { events, taskHost } = createTaskHost();
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => explicitClient,
      taskHost,
    });
    await loadAndConnect(runtime, http({ extensions: { apps: true, tasks: false } }));
    // The connection is live and advertises Apps, but the durable task host
    // was never handed the generation: `track()` fails exactly as it does for
    // a server that never advertised Tasks.
    expect(taskHost.connected).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await runtime.host.close();
    expect(events).toEqual(['close']);
  });

  it('retires the Tasks epoch and advances the generation when the global dial flips (BST-1604)', async () => {
    const explicitClient = transportClient();
    const { connections, events, taskHost } = createTaskHost();
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => explicitClient,
      createStdioTransportClient: () => explicitClient,
      taskHost,
    });
    // `local.tasks` already opted out per server; only `team.tasks.prod` is affected.
    await loadAndConnect(runtime, http(), stdio({ extensions: { apps: true, tasks: false } }));
    expect(runtime.mcpExtensionPreferences).toEqual({ apps: true, tasks: true });
    expect(connections).toHaveLength(1);
    const stdioGeneration = runtime.host
      .snapshot()
      .servers.find(({ configuredServerId }) => configuredServerId === stdio().name)?.generation;

    await runtime.setMcpExtensionPreferences({ apps: true, tasks: false });
    expect(runtime.mcpExtensionPreferences).toEqual({ apps: true, tasks: false });
    expect(events).toEqual([
      `connected:${http().name}:1`,
      `retired:${http().name}:server-replaced`,
      `disconnected:${http().name}:1`,
    ]);
    const servers = runtime.host.snapshot().servers;
    expect(
      servers.find(({ configuredServerId }) => configuredServerId === http().name)
    ).toMatchObject({ extensions: { apps: true, tasks: false }, generation: 2 });
    // A server whose EFFECTIVE state did not change keeps its generation.
    expect(
      servers.find(({ configuredServerId }) => configuredServerId === stdio().name)
    ).toMatchObject({ extensions: { apps: true, tasks: false }, generation: stdioGeneration });
    await runtime.host.close();
  });

  it('rejects a malformed global preference instead of degrading (BST-1604)', async () => {
    const runtime = createDesktopMcpHostRuntime({ taskHost: createTaskHost().taskHost });
    await expect(runtime.setMcpExtensionPreferences({ apps: 'no' } as never)).rejects.toThrow();
    expect(runtime.mcpExtensionPreferences).toEqual({ apps: true, tasks: true });
    await runtime.host.close();
  });

  it('does not bind the task host when no registry is resolved', async () => {
    const explicitClient = transportClient();
    const { events, taskHost } = createTaskHost();
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => explicitClient,
      resolveExtensionRegistry: () => undefined,
      taskHost,
    });
    await loadAndConnect(runtime, http());
    await runtime.host.close();
    expect(events).toEqual(['close']);
  });

  it('closes the transport and surfaces the failure when the task session cannot open', async () => {
    const explicitClient = transportClient();
    const { taskHost } = createTaskHost();
    (taskHost.connected as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('authority store unavailable')
    );
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => explicitClient,
      taskHost,
    });
    await runtime.replaceResolvedConfig(resolved(http()));
    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: http().name })
    ).rejects.toMatchObject({ code: 'mcp-client-creation-failed' });
    expect(runtime.host.snapshot().servers[0]).toMatchObject({ state: 'error' });
    expect(explicitClient.close).toHaveBeenCalledTimes(1);
    await runtime.host.close();
  });
});

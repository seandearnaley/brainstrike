import type { ExplicitHttpMcpClientOptions } from '@brainstrike/agent/mcp-client';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import type { McpBearerCredentialAuthority } from '../../mcp/bearer-credential';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import type { ResolvedMcpServer } from '../../mcp-loader';

const REFERENCE_ID = '00000000-0000-4000-8000-000000000001';

type HttpServer = Extract<ResolvedMcpServer, { transport: 'streamable-http' }>;

const server = (): HttpServer => ({
  auth: {
    credential: { id: REFERENCE_ID, store: 'mcp-credentials' },
    type: 'bearer',
  },
  name: parseConfiguredMcpServerId('bearer.runtime'),
  protocol: 'auto',
  startup: 'automatic',
  transport: 'streamable-http',
  url: 'https://mcp.example.test/resource',
});

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
  listPrompts: vi.fn(async () => ({ prompts: [] })),
  listResources: vi.fn(async () => ({ resources: [] })),
  listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
  listTools: vi.fn(async () => ({ tools: [] })),
  readResource: vi.fn(async () => ({ contents: [] })),
  subscribeResource: vi.fn(async () => undefined),
  unsubscribeResource: vi.fn(async () => undefined),
  watchServerFeatures: vi.fn(() => vi.fn()),
});

describe('Desktop MCP bearer host composition', () => {
  it('projects credential state without placing a secret in host or transport options', async () => {
    const secret = 'bearer-secret-must-not-escape';
    const bearerFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const bearerCredentialAuthority: McpBearerCredentialAuthority = {
      createFetch: vi.fn((_reference, _resourceUrl, onStateChanged) => {
        onStateChanged?.('stored');
        return bearerFetch;
      }),
      inspect: vi.fn(async () => ({ state: 'stored' as const })),
    };
    const createHttpTransportClient = vi.fn((_options: ExplicitHttpMcpClientOptions) =>
      transportClient()
    );
    const runtime = createDesktopMcpHostRuntime({
      bearerCredentialAuthority,
      createHttpTransportClient,
    });
    const configuredServer = server();

    const snapshot = await runtime.replaceResolvedConfig({ servers: [configuredServer] });
    await runtime.host.invoke({
      configuredServerId: configuredServer.name,
      type: 'tools/list',
    });

    expect(snapshot.servers[0]).toMatchObject({
      auth: { credentialState: 'stored', type: 'bearer' },
    });
    if (configuredServer.auth?.type !== 'bearer') {
      throw new Error('Expected the bearer fixture');
    }
    expect(bearerCredentialAuthority.inspect).toHaveBeenCalledWith(
      configuredServer.auth.credential
    );
    expect(bearerCredentialAuthority.createFetch).toHaveBeenCalledWith(
      configuredServer.auth.credential,
      configuredServer.url,
      expect.any(Function)
    );
    expect(createHttpTransportClient).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: bearerFetch, lifecycle: 'host-owned' })
    );
    const exposed = JSON.stringify({
      options: createHttpTransportClient.mock.lastCall?.[0],
      snapshot,
    });
    expect(exposed).not.toContain(secret);
    expect(exposed).not.toContain('authorization');
    await runtime.host.close();
  });

  it.each(['malformed', 'missing', 'unreadable'] as const)(
    'projects a %s reference without claiming the bearer credential is configured',
    async (state) => {
      const bearerCredentialAuthority: McpBearerCredentialAuthority = {
        createFetch: vi.fn(() => vi.fn(async () => new Response(null, { status: 204 }))),
        inspect: vi.fn(async () => ({ state })),
      };
      const runtime = createDesktopMcpHostRuntime({
        bearerCredentialAuthority,
      });

      await expect(runtime.replaceResolvedConfig({ servers: [server()] })).resolves.toMatchObject({
        servers: [expect.objectContaining({ auth: { credentialState: state, type: 'bearer' } })],
      });
      await runtime.host.close();
    }
  );

  it('refreshes a stale presence projection when the owned fetch resolves the credential', async () => {
    const bearerCredentialAuthority: McpBearerCredentialAuthority = {
      createFetch: vi.fn((_reference, _resourceUrl, onStateChanged) => {
        onStateChanged?.('stored');
        return vi.fn(async () => new Response(null, { status: 204 }));
      }),
      inspect: vi.fn(async () => ({ state: 'missing' as const })),
    };
    const runtime = createDesktopMcpHostRuntime({
      bearerCredentialAuthority,
      createHttpTransportClient: vi.fn(() => transportClient()),
    });
    const configuredServer = server();

    await expect(
      runtime.replaceResolvedConfig({ servers: [configuredServer] })
    ).resolves.toMatchObject({
      servers: [expect.objectContaining({ auth: { credentialState: 'missing', type: 'bearer' } })],
    });
    await runtime.host.invoke({ configuredServerId: configuredServer.name, type: 'tools/list' });
    expect(runtime.host.snapshot().servers[0]).toMatchObject({
      auth: { credentialState: 'stored', type: 'bearer' },
    });
    await runtime.host.close();
  });
});

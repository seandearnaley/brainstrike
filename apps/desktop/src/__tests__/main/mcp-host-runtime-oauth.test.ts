import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import {
  createInMemoryMcpOAuthStore,
  createMcpOAuthClientProvider,
  createMcpOAuthStoreIdentity,
  type McpOAuthClientProvider,
} from '../../mcp/oauth-client-provider';
import type { ResolvedMcpServer } from '../../mcp-loader';

let runtime: ReturnType<typeof createDesktopMcpHostRuntime> | undefined;

const oauthServer = {
  auth: { type: 'oauth-user' },
  name: parseConfiguredMcpServerId('team.linear.prod'),
  protocol: 'auto',
  startup: 'authentication-required',
  transport: 'streamable-http',
  url: 'https://linear.example/mcp',
} satisfies ResolvedMcpServer;

function failingTransportClient() {
  return {
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => {
      throw new Error('client cleanup failed');
    }),
    complete: vi.fn(async () => ({ completion: { values: [] } })),
    connect: vi.fn(async () => {
      throw new Error('connect failed');
    }),
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
  };
}

const staleIssuer = 'https://auth.linear.example';

function requireOAuthProvider(value: unknown): McpOAuthClientProvider {
  if (!(value && typeof value === 'object' && 'requiresReauthorization' in value)) {
    throw new Error('MCP host did not pass an OAuth client provider to the transport.');
  }
  return value as McpOAuthClientProvider;
}

afterEach(async () => {
  await runtime?.host.close();
  runtime = undefined;
  vi.restoreAllMocks();
});

describe('DesktopMcpHostRuntime OAuth cleanup', () => {
  it('preserves the connection failure with client and provider cleanup failures', async () => {
    let provider: McpOAuthClientProvider | undefined;
    const onInternalError = vi.fn();
    runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: failingTransportClient,
      createOAuthProvider: async (options) => {
        provider = await createMcpOAuthClientProvider(options);
        const close = provider.close.bind(provider);
        vi.spyOn(provider, 'close').mockImplementation(async () => {
          await close();
          throw new Error('provider cleanup failed');
        });
        return provider;
      },
      oauthStore: createInMemoryMcpOAuthStore(),
      onInternalError,
      openExternal: vi.fn(async () => undefined),
    });
    await runtime.replaceResolvedConfig({ servers: [oauthServer] });

    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: oauthServer.name })
    ).rejects.toMatchObject({ code: 'mcp-client-creation-failed' });
    const diagnostic = onInternalError.mock.calls.find(
      ([code]) => code === 'mcp-client-creation-failed'
    );
    expect(diagnostic?.[1]).toMatchObject({
      errors: [
        { cause: { message: 'connect failed' } },
        {
          errors: [{ message: 'client cleanup failed' }, { message: 'provider cleanup failed' }],
        },
      ],
    });
    expect(provider?.close).toHaveBeenCalledOnce();
    await runtime.host.close();
  });
});

describe('DesktopMcpHostRuntime OAuth reauthorization', () => {
  it('reports a discarded client registration as authentication-required, not a connection fault', async () => {
    const store = createInMemoryMcpOAuthStore();
    // A record persisted before loopback ports were stable: its dynamic client
    // registration points at a redirect URI this launch can no longer serve.
    await store.write(createMcpOAuthStoreIdentity(oauthServer.name, oauthServer.url), {
      [staleIssuer]: {
        clientInformation: {
          client_id: 'stale-client',
          redirect_uris: ['http://127.0.0.1:65000/mcp/oauth/callback'],
        },
        tokens: { access_token: 'stored-access', token_type: 'Bearer' },
        updatedAt: 1,
      },
    });
    const onInternalError = vi.fn();
    runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: (options) => ({
        ...failingTransportClient(),
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => {
          // The SDK reads client information while recovering from a 401.
          await requireOAuthProvider(options.authProvider).clientInformation({
            issuer: staleIssuer,
          });
          throw new Error('connect failed');
        }),
      }),
      oauthStore: store,
      onInternalError,
      openExternal: vi.fn(async () => undefined),
    });
    await runtime.replaceResolvedConfig({ servers: [oauthServer] });

    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: oauthServer.name })
    ).rejects.toMatchObject({ category: 'authentication', code: 'mcp-authentication-required' });
    expect(runtime.host.snapshot().servers[0]?.state).toBe('authentication-required');
  });

  /**
   * The latch cannot strand a later, unrelated fault: the OAuth provider is
   * built inside the per-attempt client factory and closed with the failing
   * attempt, so the next connect gets a fresh provider that re-reads the store.
   * With the port now stable that provider finds a redirect-compatible
   * registration, never discards, and a plain transport fault keeps its own
   * classification (BST-1597 review).
   */
  it('reports the real connection fault on the attempt after the registration was replaced', async () => {
    const store = createInMemoryMcpOAuthStore();
    await store.write(createMcpOAuthStoreIdentity(oauthServer.name, oauthServer.url), {
      [staleIssuer]: {
        clientInformation: {
          client_id: 'stale-client',
          redirect_uris: ['http://127.0.0.1:65000/mcp/oauth/callback'],
        },
        tokens: { access_token: 'stored-access', token_type: 'Bearer' },
        updatedAt: 1,
      },
    });
    let reregistered = false;
    runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: (options) => ({
        ...failingTransportClient(),
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => {
          const provider = requireOAuthProvider(options.authProvider);
          if (!reregistered) {
            await provider.clientInformation({ issuer: staleIssuer });
            if (!provider.saveClientInformation) {
              throw new Error('OAuth provider did not expose client-information persistence.');
            }
            await provider.saveClientInformation(
              { client_id: 'replacement-client', redirect_uris: [provider.redirectUrl] },
              { issuer: staleIssuer }
            );
            reregistered = true;
          }
          throw new Error('connect failed');
        }),
      }),
      oauthStore: store,
      onInternalError: vi.fn(),
      openExternal: vi.fn(async () => undefined),
    });
    await runtime.replaceResolvedConfig({ servers: [oauthServer] });

    // The replacement is written but its authorization never completed, so this
    // attempt still owes the user a reconnect.
    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: oauthServer.name })
    ).rejects.toMatchObject({ category: 'authentication', code: 'mcp-authentication-required' });

    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: oauthServer.name })
    ).rejects.toMatchObject({ category: 'connection', code: 'mcp-connection-failed' });
  });
});

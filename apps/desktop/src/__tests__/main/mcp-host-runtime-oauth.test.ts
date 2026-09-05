import {
  parseConfiguredMcpServerId,
  resolveMcpHostControlActions,
} from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectClient } from '../../mcp/host-connection';
import { createDesktopMcpHostRuntime, type ExplicitClient } from '../../mcp/host-runtime';
import { McpLifecycleFailure } from '../../mcp/lifecycle-errors';
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

describe('DesktopMcpHostRuntime OAuth restart', () => {
  it('bounds a non-interactive transport when the context omits the optional mode', async () => {
    const connect = vi.fn<ExplicitClient['connect']>(async () => undefined);
    const connected = await connectClient(
      { ...failingTransportClient(), close: vi.fn(async () => undefined), connect },
      oauthServer,
      {
        configuredServerId: oauthServer.name,
        generation: 1,
        onDiagnostic: vi.fn(),
        onUnexpectedClose: vi.fn(),
        signal: new AbortController().signal,
      },
      vi.fn(),
      undefined
    );
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ timeout: 10_000 }));
    await connected.close();
  });

  it.each([false, true])(
    'handles an explicit Connect during background authentication (cancelled=%s)',
    async (cancelled) => {
      const store = createInMemoryMcpOAuthStore();
      await store.write(createMcpOAuthStoreIdentity(oauthServer.name, oauthServer.url), {
        [staleIssuer]: {
          tokens: { access_token: 'stored-access', token_type: 'Bearer' },
          updatedAt: 1,
        },
      });
      const entered = Promise.withResolvers<void>();
      const background = Promise.withResolvers<void>();
      const modes: (boolean | undefined)[] = [];
      runtime = createDesktopMcpHostRuntime({
        createHttpTransportClient: () => ({
          ...failingTransportClient(),
          close: vi.fn(async () => undefined),
          connect: async () => {
            if (modes.length === 1) {
              entered.resolve();
              await background.promise;
            }
          },
        }),
        createOAuthProvider: (options) => {
          modes.push(options.allowInteractiveAuthorization);
          return createMcpOAuthClientProvider(options);
        },
        oauthStore: store,
        onInternalError: vi.fn(),
        openExternal: vi.fn(async () => undefined),
        resolveExtensionRegistry: () => undefined,
      });
      await runtime.replaceResolvedConfig({ servers: [oauthServer] });
      const discovery = runtime.host
        .invoke({ configuredServerId: oauthServer.name, type: 'tools/list' })
        .catch((error: unknown) => error);
      await entered.promise;
      const control = runtime.host
        .control({ action: 'connect', configuredServerId: oauthServer.name })
        .catch((error: unknown) => error);
      if (cancelled) {
        await runtime.host.control({ action: 'cancel', configuredServerId: oauthServer.name });
      }
      background.reject(new McpLifecycleFailure('authentication', 'mcp-authentication-required'));
      await discovery;
      expect(await control).toMatchObject(
        cancelled ? { name: 'AbortError' } : { state: 'connected' }
      );
      expect(modes).toEqual(cancelled ? [false] : [false, true]);
    }
  );

  it('does not construct a transport or open a browser when credentials are missing', async () => {
    const createHttpTransportClient = vi.fn(failingTransportClient);
    const openExternal = vi.fn(async () => undefined);
    runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient,
      oauthStore: createInMemoryMcpOAuthStore(),
      openExternal,
    });
    await runtime.replaceResolvedConfig({ servers: [oauthServer] });
    await expect(
      runtime.host.invoke({ configuredServerId: oauthServer.name, type: 'tools/list' })
    ).rejects.toMatchObject({
      code: 'mcp-authentication-required',
      message:
        'MCP authentication required. Connect or reauthorize this server in Settings > AI Tools.',
    });
    expect(createHttpTransportClient).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('requires an explicit Connect when stored credentials need browser authorization', async () => {
    const store = createInMemoryMcpOAuthStore();
    await store.write(createMcpOAuthStoreIdentity(oauthServer.name, oauthServer.url), {
      [staleIssuer]: {
        tokens: { access_token: 'rejected-access', token_type: 'Bearer' },
        updatedAt: 1,
      },
    });
    const openExternal = vi.fn(async () => undefined);
    const modes: (boolean | undefined)[] = [];
    const close = vi.fn(async () => undefined);
    runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: (options) => ({
        ...failingTransportClient(),
        close,
        connect: async () => {
          if (modes.length === 1) {
            const provider = requireOAuthProvider(options.authProvider);
            if (!(provider.invalidateCredentials && provider.saveDiscoveryState)) {
              throw new Error('Missing SDK credential invalidation');
            }
            await provider.saveDiscoveryState({ authorizationServerUrl: staleIssuer });
            await provider.invalidateCredentials('tokens');
            await provider.redirectToAuthorization(
              new URL('https://auth.linear.example/authorize')
            );
          }
        },
      }),
      createOAuthProvider: (options) => {
        modes.push(options.allowInteractiveAuthorization);
        return createMcpOAuthClientProvider(options);
      },
      oauthStore: store,
      onInternalError: vi.fn(),
      openExternal,
      resolveExtensionRegistry: () => undefined,
    });
    await runtime.replaceResolvedConfig({ servers: [oauthServer] });
    await expect(
      runtime.host.invoke({ configuredServerId: oauthServer.name, type: 'tools/list' })
    ).rejects.toMatchObject({ code: 'mcp-authentication-required' });
    expect(runtime.host.snapshot().servers[0]).toMatchObject({
      auth: { credentialState: 'missing', grantedScopes: [] },
      state: 'authentication-required',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();
    // Failed background auth is not retried by every model request.
    await expect(
      runtime.host.invoke({ configuredServerId: oauthServer.name, type: 'tools/list' })
    ).rejects.toMatchObject({ code: 'mcp-authentication-required' });
    expect(modes).toEqual([false]);
    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: oauthServer.name })
    ).resolves.toMatchObject({ state: 'connected' });
    expect(modes).toEqual([false, true]);
  });

  it('keeps replacement OAuth credentials after cancelled-attempt cleanup settles late', async () => {
    const store = createInMemoryMcpOAuthStore();
    await store.write(createMcpOAuthStoreIdentity(oauthServer.name, oauthServer.url), {
      [staleIssuer]: { tokens: { access_token: 'old-access', token_type: 'Bearer' }, updatedAt: 1 },
    });
    const cleanupEntered = Promise.withResolvers<void>();
    const cleanupRelease = Promise.withResolvers<void>();
    let attempt = 0;
    runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: (options) => {
        const first = ++attempt === 1;
        const provider = requireOAuthProvider(options.authProvider);
        return {
          ...failingTransportClient(),
          close: async () => {
            if (first) {
              cleanupEntered.resolve();
              await cleanupRelease.promise;
            }
          },
          connect: async () => {
            if (
              !(
                provider.saveDiscoveryState &&
                provider.invalidateCredentials &&
                provider.saveTokens
              )
            ) {
              throw new Error('Missing SDK credential methods');
            }
            await provider.saveDiscoveryState({ authorizationServerUrl: staleIssuer });
            if (first) {
              await provider.invalidateCredentials('tokens');
              throw new McpLifecycleFailure('authentication', 'mcp-authentication-required');
            }
            await provider.saveTokens(
              {
                access_token: 'replacement-access',
                issuer: staleIssuer,
                scope: 'read',
                token_type: 'Bearer',
              },
              { issuer: staleIssuer }
            );
          },
        };
      },
      oauthStore: store,
      onInternalError: vi.fn(),
      openExternal: vi.fn(async () => undefined),
      resolveExtensionRegistry: () => undefined,
    });
    await runtime.replaceResolvedConfig({ servers: [oauthServer] });
    const discovery = runtime.host
      .invoke({ configuredServerId: oauthServer.name, type: 'tools/list' })
      .catch((error: unknown) => error);
    try {
      await cleanupEntered.promise;
      await runtime.host.control({ action: 'cancel', configuredServerId: oauthServer.name });
      await expect(
        runtime.host.control({ action: 'connect', configuredServerId: oauthServer.name })
      ).resolves.toMatchObject({
        auth: { credentialState: 'stored', grantedScopes: ['read'] },
        state: 'connected',
      });
      cleanupRelease.resolve();
      await discovery;
      // Connect on the existing client returns the actor's current authority
      // snapshot; it cannot hide a stale closure behind a cached publication.
      await expect(
        runtime.host.control({ action: 'connect', configuredServerId: oauthServer.name })
      ).resolves.toMatchObject({
        auth: { credentialState: 'stored', grantedScopes: ['read'] },
        state: 'connected',
      });
    } finally {
      cleanupRelease.resolve();
      await discovery;
    }
  });

  it('discovers tools on the first request after restart using stored credentials without a Connect action', async () => {
    const store = createInMemoryMcpOAuthStore();
    await store.write(createMcpOAuthStoreIdentity(oauthServer.name, oauthServer.url), {
      [staleIssuer]: {
        tokens: { access_token: 'stored-access', token_type: 'Bearer' },
        updatedAt: 1,
      },
    });
    const openExternal = vi.fn(async () => undefined);
    const connect = vi.fn<ExplicitClient['connect']>(async () => undefined);
    runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: (options) => ({
        ...failingTransportClient(),
        close: vi.fn(async () => undefined),
        connect: async (request) => {
          expect(await requireOAuthProvider(options.authProvider).tokens()).toMatchObject({
            access_token: 'stored-access',
          });
          await connect(request);
        },
        listTools: vi.fn(async () => ({
          tools: [{ inputSchema: { type: 'object' as const }, name: 'list_issues' }],
        })),
      }),
      oauthStore: store,
      onInternalError: vi.fn(),
      openExternal,
      resolveExtensionRegistry: () => undefined,
    });
    const storedRead = store.read.bind(store);
    const ready = Promise.withResolvers<void>();
    const read = vi.spyOn(store, 'read').mockImplementation(async (identity) => {
      await ready.promise;
      return await storedRead(identity);
    });
    const replacing = runtime.replaceResolvedConfig({ servers: [oauthServer] });
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    expect(runtime.host.snapshot().servers).toEqual([]);
    ready.resolve();
    await replacing;
    const server = runtime.host.snapshot().servers[0];
    if (!server) {
      throw new Error('Missing staged server');
    }
    expect(resolveMcpHostControlActions(server)).toContain('connect');

    await expect(
      runtime.host.invoke({ configuredServerId: oauthServer.name, type: 'tools/list' })
    ).resolves.toMatchObject({ result: { tools: [{ name: 'list_issues' }] }, type: 'tools/list' });
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ timeout: 10_000 }));
    expect(openExternal).not.toHaveBeenCalled();
    expect(runtime.host.snapshot().servers[0]?.state).toBe('connected');
  });
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

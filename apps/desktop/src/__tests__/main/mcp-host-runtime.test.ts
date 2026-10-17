import type { ExplicitHttpMcpClient } from '@brainstrike/agent/mcp-client';
import type { McpHostCloseReport, McpHostConfig } from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId, parseMcpHostConfig } from '@brainstrike/assistant-contract';
import type {
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from '@brainstrike/host-capabilities/mcp/config-file';
import { McpHostService } from '@brainstrike/host-capabilities/mcp/host-service';
import {
  createInMemoryMcpOAuthStore,
  createMcpOAuthClientProvider,
  createMcpOAuthStoreIdentity,
  type McpOAuthClientProvider,
  type McpOAuthStore,
} from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import type { McpServerActorClientFactory } from '@brainstrike/host-capabilities/mcp/server-actor';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { openExternalWithElectron } from '../../mcp/open-external';
import type { MutableFixture } from '../fixtures/mutable-schema-fixture';

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
type ActorContext = Parameters<McpServerActorClientFactory>[0];
type TransportConnectOptions = Parameters<ExplicitHttpMcpClient['connect']>[0];
const http = (patch: Partial<HttpServer> = {}): MutableFixture<HttpServer> => ({
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

describe('Electron shell loader', () => {
  it.each(['namespace', 'default'] as const)(
    'opens through the %s CommonJS interop shape',
    async (shape) => {
      const openExternal = vi.fn(async () => undefined);
      const shell = { openExternal };
      const electron = shape === 'namespace' ? { shell } : { default: { shell } };

      await openExternalWithElectron('https://authorize.example.test', async () => electron);

      expect(openExternal).toHaveBeenCalledWith('https://authorize.example.test');
    }
  );

  it('fails visibly when Electron exposes no shell module', async () => {
    await expect(
      openExternalWithElectron('https://authorize.example.test', async () => ({ default: {} }))
    ).rejects.toThrow('Electron shell module is unavailable');
  });
});

describe('DesktopMcpHostRuntime', () => {
  it('does not connect a user-paced authentication server during startup replacement', async () => {
    const createActorClient = vi.fn((_server: ResolvedMcpServer, _context: ActorContext) =>
      client()
    );
    const runtime = createDesktopMcpHostRuntime({ createActorClient, createConfigRef: () => REF });

    await runtime.replaceResolvedConfig(resolved(stdio({ startup: 'authentication-required' })));

    expect(createActorClient).not.toHaveBeenCalled();
    expect(runtime.host.snapshot().servers[0]).toMatchObject({
      state: 'authentication-required',
    });
  });

  it('composes native OAuth only after Connect and preserves credentials on ordinary close', async () => {
    const store = createInMemoryMcpOAuthStore();
    const openExternal = vi.fn(async () => undefined);
    let provider: McpOAuthClientProvider | undefined;
    const createOAuthProvider = vi.fn(async (options) => {
      provider = await createMcpOAuthClientProvider(options);
      return provider;
    });
    const explicitClient = transportClient();
    const createHttpTransportClient = vi.fn(() => explicitClient);
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient,
      createOAuthProvider,
      oauthStore: store,
      openExternal,
    });
    const server = http({
      auth: { type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    await store.write(createMcpOAuthStoreIdentity(server.name, server.url), {
      'https://auth.example.test': {
        tokens: {
          access_token: 'persisted-secret',
          issuer: 'https://auth.example.test',
          scope: 'read',
          token_type: 'Bearer',
        },
        updatedAt: 1,
      },
    });

    await runtime.replaceResolvedConfig(resolved(server));
    expect(createOAuthProvider).not.toHaveBeenCalled();
    expect(createHttpTransportClient).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();

    await runtime.host.control({ action: 'connect', configuredServerId: server.name });
    expect(createOAuthProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        openExternal,
        serverId: server.name,
        serverUrl: server.url,
        store,
      })
    );
    expect(createHttpTransportClient).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCallbackSource: provider,
        authProvider: provider,
        fetch: provider?.fetch,
        lifecycle: 'host-owned',
        onInsufficientScope: 'reauthorize',
      })
    );
    expect(openExternal).not.toHaveBeenCalled();

    if (!provider) {
      throw new Error('OAuth provider was not composed');
    }
    await expect(runtime.host.close()).resolves.toMatchObject({
      callbacksClosed: 2,
      loopbackPortsClosed: 1,
    });

    await expect(
      store.read({ resourceUrl: server.url, scopeKey: '', serverId: server.name })
    ).resolves.toMatchObject({
      'https://auth.example.test': {
        tokens: { access_token: 'persisted-secret', scope: 'read' },
      },
    });
  });

  it('clears only the selected OAuth server on Disconnect and Reauthorize', async () => {
    const store = createInMemoryMcpOAuthStore();
    const createHttpTransportClient = vi.fn((options) => {
      const result = transportClient();
      result.connect.mockImplementation(async () => {
        const authProvider = options.authProvider;
        if (!(authProvider && 'authSnapshot' in authProvider)) {
          return;
        }
        await authProvider.saveDiscoveryState?.({
          authorizationServerUrl: 'https://auth.example.test',
        });
        await authProvider.saveTokens(
          {
            access_token: 'fresh-secret',
            issuer: 'https://auth.example.test',
            token_type: 'Bearer',
          },
          { issuer: 'https://auth.example.test' }
        );
      });
      return result;
    });
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient,
      oauthStore: store,
      openExternal: vi.fn(async () => undefined),
    });
    const writable = http({
      auth: { type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    const readonly = http({
      auth: { type: 'oauth-user' },
      headers: undefined,
      name: parseConfiguredMcpServerId('team.linear.readonly'),
      startup: 'authentication-required',
      url: 'https://linear.example/mcp/readonly',
    });
    const writableIdentity = createMcpOAuthStoreIdentity(writable.name, writable.url);
    const readonlyIdentity = createMcpOAuthStoreIdentity(readonly.name, readonly.url);
    const credentials = (accessToken: string) => ({
      'https://auth.example.test': {
        tokens: { access_token: accessToken, token_type: 'Bearer' as const },
        updatedAt: 1,
      },
    });
    await store.write(writableIdentity, credentials('write-secret'));
    await store.write(readonlyIdentity, credentials('read-secret'));
    await runtime.replaceResolvedConfig(resolved(writable, readonly));

    await runtime.host.control({ action: 'connect', configuredServerId: writable.name });
    await runtime.host.control({ action: 'disconnect', configuredServerId: writable.name });

    await expect(store.read(writableIdentity)).resolves.toEqual({});
    await expect(store.read(readonlyIdentity)).resolves.toMatchObject({
      'https://auth.example.test': { tokens: { access_token: 'read-secret' } },
    });
    expect(runtime.host.snapshot().servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configuredServerId: writable.name,
          state: 'authentication-required',
        }),
        expect.objectContaining({
          configuredServerId: readonly.name,
          state: 'disconnected',
        }),
      ])
    );

    await store.write(writableIdentity, credentials('stale-write-secret'));
    await runtime.host.control({ action: 'reauthorize', configuredServerId: writable.name });
    const reauthorized = await store.read(writableIdentity);
    expect(reauthorized).toMatchObject({
      'https://auth.example.test': { tokens: { access_token: 'fresh-secret' } },
    });
    expect(JSON.stringify(reauthorized)).not.toContain('stale-write-secret');
    await expect(store.read(readonlyIdentity)).resolves.toMatchObject({
      'https://auth.example.test': { tokens: { access_token: 'read-secret' } },
    });
    expect(createHttpTransportClient).toHaveBeenCalledTimes(2);
    await runtime.host.close();
  });

  it('publishes token-free OAuth state and configured scope policy', async () => {
    const store = createInMemoryMcpOAuthStore();
    const server = http({
      auth: { scopes: ['read'], type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    const identity = createMcpOAuthStoreIdentity(server.name, server.url, ['read']);
    await store.write(identity, {
      'https://auth.example.test': {
        discoveryState: { authorizationServerUrl: 'https://auth.example.test' },
        lastSuccessfulConnectionAt: 1,
        tokens: {
          access_token: 'never-project-access',
          refresh_token: 'never-project-refresh',
          scope: 'read',
          token_type: 'Bearer',
        },
        updatedAt: 1,
      },
    });
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => transportClient(),
      oauthStore: store,
      openExternal: vi.fn(async () => undefined),
    });

    await runtime.replaceResolvedConfig(resolved(server));
    const initial = runtime.host.snapshot().servers[0];
    expect(initial).toMatchObject({
      auth: {
        authorizationServer: 'https://auth.example.test',
        credentialState: 'stored',
        grantedScopes: ['read'],
        lastSuccessfulConnectionAt: 1,
        requestedScopes: ['read'],
        resourceUrl: server.url,
        type: 'oauth-user',
      },
      state: 'disconnected',
    });
    expect(JSON.stringify(initial)).not.toMatch(/never-project-access|never-project-refresh/u);

    await runtime.host.control({ action: 'connect', configuredServerId: server.name });
    expect(runtime.host.snapshot().servers[0]).toMatchObject({
      auth: { credentialState: 'stored', lastSuccessfulConnectionAt: expect.any(Number) },
      state: 'connected',
    });
    await runtime.host.control({ action: 'disconnect', configuredServerId: server.name });
    expect(runtime.host.snapshot().servers[0]).toMatchObject({
      auth: { credentialState: 'missing', grantedScopes: [] },
      state: 'authentication-required',
    });
    await runtime.host.close();
  });

  it('partitions grants by scope and retries obsolete credential cleanup', async () => {
    const backingStore = createInMemoryMcpOAuthStore();
    let rejectOldClear = true;
    const store: McpOAuthStore = {
      clear: vi.fn(async (identity) => {
        if (identity.scopeKey === 'read' && rejectOldClear) {
          rejectOldClear = false;
          throw new Error('credential cleanup failed');
        }
        await backingStore.clear(identity);
      }),
      clearAll: async () => await backingStore.clearAll(),
      read: async (identity) => await backingStore.read(identity),
      write: async (identity, records) => await backingStore.write(identity, records),
    };
    const readOnly = http({
      auth: { scopes: ['read'], type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    const readWrite = http({
      auth: { scopes: ['read', 'write'], type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    const oldIdentity = createMcpOAuthStoreIdentity(readOnly.name, readOnly.url, ['read']);
    const nextIdentity = createMcpOAuthStoreIdentity(readWrite.name, readWrite.url, [
      'read',
      'write',
    ]);
    await store.write(oldIdentity, {
      'https://auth.example.test': {
        tokens: { access_token: 'old-read-secret', token_type: 'Bearer' },
        updatedAt: 1,
      },
    });
    const runtime = createDesktopMcpHostRuntime({ oauthStore: store });

    await runtime.replaceResolvedConfig(resolved(readOnly));
    await expect(runtime.replaceResolvedConfig(resolved(readWrite))).rejects.toThrow(
      'MCP OAuth credential cleanup failed'
    );
    await expect(store.read(oldIdentity)).resolves.toMatchObject({
      'https://auth.example.test': { tokens: { access_token: 'old-read-secret' } },
    });
    await expect(store.read(nextIdentity)).resolves.toEqual({});

    await expect(runtime.replaceResolvedConfig(resolved(readWrite))).resolves.toBeDefined();
    await expect(store.read(oldIdentity)).resolves.toEqual({});
    expect(store.clear).toHaveBeenCalledTimes(2);
    await runtime.host.close();
  });

  it('clears an OAuth grant only after its config is successfully removed', async () => {
    const store = createInMemoryMcpOAuthStore();
    const server = http({
      auth: { scopes: ['read'], type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    const identity = createMcpOAuthStoreIdentity(server.name, server.url, ['read']);
    await store.write(identity, {
      'https://auth.example.test': {
        tokens: { access_token: 'removed-config-secret', token_type: 'Bearer' },
        updatedAt: 1,
      },
    });
    const runtime = createDesktopMcpHostRuntime({ oauthStore: store });

    await runtime.replaceResolvedConfig(resolved(server));
    await expect(store.read(identity)).resolves.not.toEqual({});
    await runtime.replaceResolvedConfig(resolved());
    await expect(store.read(identity)).resolves.toEqual({});
    await runtime.host.close();
  });

  it('surfaces unreadable OAuth state without blocking unauthenticated siblings', async () => {
    const backingStore = createInMemoryMcpOAuthStore();
    const store: McpOAuthStore = {
      clear: async (identity) => await backingStore.clear(identity),
      clearAll: async () => await backingStore.clearAll(),
      read: vi.fn(async () => {
        throw new Error('safeStorage unavailable');
      }),
      write: async (identity, records) => await backingStore.write(identity, records),
    };
    const onInternalError = vi.fn();
    const runtime = createDesktopMcpHostRuntime({
      createActorClient: vi.fn(() => client()),
      oauthStore: store,
      onInternalError,
    });
    const oauth = http({
      auth: { scopes: ['read'], type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    const sibling = stdio();

    await runtime.replaceResolvedConfig(resolved(oauth, sibling));
    await expect(
      runtime.host.invoke({ configuredServerId: sibling.name, type: 'tools/list' })
    ).resolves.toMatchObject({ type: 'tools/list' });

    expect(runtime.host.snapshot().servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auth: expect.objectContaining({ credentialState: 'unreadable' }),
          configuredServerId: oauth.name,
          state: 'authentication-required',
        }),
        expect.objectContaining({ configuredServerId: sibling.name, state: 'connected' }),
      ])
    );
    expect(onInternalError).toHaveBeenCalledWith(
      'mcp-oauth-credential-read-failed',
      expect.objectContaining({ message: 'safeStorage unavailable' })
    );
    await runtime.host.close();
  });

  it('closes OAuth resources when HTTP transport construction throws', async () => {
    const store = createInMemoryMcpOAuthStore();
    let provider: McpOAuthClientProvider | undefined;
    const createOAuthProvider = vi.fn(async (options) => {
      provider = await createMcpOAuthClientProvider(options);
      const close = provider.close.bind(provider);
      vi.spyOn(provider, 'close').mockImplementation(async () => {
        await close();
        throw new Error('provider cleanup failed');
      });
      return provider;
    });
    const onInternalError = vi.fn();
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: vi.fn(() => {
        throw new Error('transport constructor failed');
      }),
      createOAuthProvider,
      oauthStore: store,
      onInternalError,
      openExternal: vi.fn(async () => undefined),
    });
    const server = http({
      auth: { type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    await runtime.replaceResolvedConfig(resolved(server));

    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: server.name })
    ).rejects.toMatchObject({ code: 'mcp-client-creation-failed' });
    expect(provider?.close).toHaveBeenCalledOnce();
    expect(onInternalError).toHaveBeenCalledWith(
      'mcp-client-creation-failed',
      expect.objectContaining({
        errors: [
          expect.objectContaining({ message: 'transport constructor failed' }),
          expect.objectContaining({ message: 'provider cleanup failed' }),
        ],
      })
    );
    await runtime.host.close();
  });

  it('keeps a verified connection while reporting success-marker persistence failure', async () => {
    const onInternalError = vi.fn();
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: () => transportClient(),
      oauthStore: createInMemoryMcpOAuthStore(),
      onInternalError,
      openExternal: vi.fn(async () => undefined),
    });
    const server = http({
      auth: { type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    await runtime.replaceResolvedConfig(resolved(server));

    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: server.name })
    ).resolves.toMatchObject({ state: 'connected' });
    expect(onInternalError).toHaveBeenCalledWith(
      'mcp-oauth-connection-record-failed',
      expect.objectContaining({
        message: 'MCP OAuth connection succeeded without stored credentials.',
      })
    );
    await runtime.host.close();
  });

  it('opens OAuth authorization only from explicit Connect or Reauthorize actions', async () => {
    const openExternal = vi.fn(async () => undefined);
    const createHttpTransportClient = vi.fn((options) => {
      const result = transportClient();
      result.connect.mockImplementation(async () => {
        const authProvider = options.authProvider;
        if (!(authProvider && 'authSnapshot' in authProvider)) {
          throw new Error('Expected the native OAuth provider');
        }
        const state = await authProvider.state?.();
        if (typeof state !== 'string') {
          throw new Error('Expected an OAuth state value');
        }
        await authProvider.redirectToAuthorization(
          new URL(`https://auth.example.test/authorize?state=${encodeURIComponent(state)}`)
        );
        await authProvider.saveDiscoveryState?.({
          authorizationServerUrl: 'https://auth.example.test',
        });
        await authProvider.saveTokens(
          {
            access_token: 'fresh-secret',
            issuer: 'https://auth.example.test',
            token_type: 'Bearer',
          },
          { issuer: 'https://auth.example.test' }
        );
      });
      return result;
    });
    const server = http({
      auth: { type: 'oauth-user' },
      headers: undefined,
      startup: 'authentication-required',
    });
    const runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient,
      oauthStore: createInMemoryMcpOAuthStore(),
      openExternal,
    });

    await runtime.replaceResolvedConfig(resolved(server));
    expect(openExternal).not.toHaveBeenCalled();
    await runtime.host.control({ action: 'connect', configuredServerId: server.name });
    expect(openExternal).toHaveBeenCalledTimes(1);

    await runtime.host.control({ action: 'disconnect', configuredServerId: server.name });
    expect(openExternal).toHaveBeenCalledTimes(1);
    await runtime.host.control({ action: 'reauthorize', configuredServerId: server.name });
    expect(openExternal).toHaveBeenCalledTimes(2);
    await runtime.host.close();
  });

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
        expect(Reflect.set(server.headers, 'Authorization', 'Bearer actor-mutated')).toBe(true);
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

  it('projects sanitized stdio diagnostics without persisting healthy stderr chatter', async () => {
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
      expect(
        records.some(
          (record) =>
            record.level === LogLevel.WARN && record.message === 'MCP stdio failure diagnostics'
        )
      ).toBe(false);
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
    await expect(closing).resolves.toMatchObject({ requestsSettled: 0 });
  });
});

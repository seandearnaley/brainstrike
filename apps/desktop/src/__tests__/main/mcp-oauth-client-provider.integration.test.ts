// biome-ignore-all lint/style/noExcessiveLinesPerFile: one real-network OAuth fixture keeps cross-scenario lifecycle assertions coherent.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import {
  createInMemoryMcpOAuthStore,
  createMcpOAuthClientProvider,
  createMcpOAuthStoreIdentity,
} from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import {
  Client,
  IssuerMismatchError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { runProductionMcpConformanceClient } from '../../mcp/official-conformance-client';
import { discoverToolsFromConfig } from '../../mcp/tool-discovery';
import type { ResolvedMcpServer } from '../../mcp-loader';

type OAuthHttpServer = Extract<ResolvedMcpServer, { transport: 'streamable-http' }>;

interface FakeOAuthServerOptions {
  readonly authorizationServerUrl?: () => string;
  readonly callbackMode?:
    | 'invalid-state-first'
    | 'issuer-mismatch'
    | 'issuer-missing'
    | 'issuer-normalized'
    | 'legitimate';
  readonly clientRegistration: 'cimd' | 'dcr' | 'preregistered';
  readonly expectedResourceUrl?: () => string;
  readonly insufficientScope?: boolean | number;
  readonly issParameterSupported?: boolean;
  readonly mcpTokenAccepted?: (token: string | undefined, locallyIssued: boolean) => boolean;
  readonly metadataIssuerMismatch?: boolean;
  readonly offlineAccessSupported?: boolean;
  readonly onAuthenticatedMcpRequest?: () => void;
  readonly registeredClientId?: string;
  readonly resourceMismatch?: boolean;
  readonly tokenPrefix?: string;
}

interface FakeOAuthServer {
  readonly authorizationRequests: URLSearchParams[];
  readonly close: () => Promise<void>;
  readonly dcrRequests: Readonly<Record<string, unknown>>[];
  readonly forceRefresh: () => void;
  readonly mcpRequests: Readonly<Record<string, unknown>>[];
  readonly protectedResourceRequests: readonly URL[];
  readonly refreshCount: () => number;
  readonly tokenCount: () => number;
  readonly tokenRequests: URLSearchParams[];
  readonly url: URL;
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { 'cache-control': 'no-store', location });
  response.end();
}

async function startFakeOAuthServer(options: FakeOAuthServerOptions): Promise<FakeOAuthServer> {
  const authorizationRequests: URLSearchParams[] = [];
  const dcrRequests: Readonly<Record<string, unknown>>[] = [];
  const mcpRequests: Readonly<Record<string, unknown>>[] = [];
  const protectedResourceRequests: URL[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const tokens = new Map<string, { scope: string }>();
  // Refresh tokens are bound to the client they were issued to, like a real
  // authorization server: a re-registered client cannot redeem them.
  const refreshTokens = new Map<string, { clientId: string }>();
  let nextCode = 0;
  let nextToken = 0;
  let nextRefreshToken = 0;
  let refreshCountValue = 0;
  let tokenCountValue = 0;
  let forceRefresh = false;
  let remainingInsufficientScope =
    typeof options.insufficientScope === 'number'
      ? options.insufficientScope
      : options.insufficientScope
        ? 1
        : 0;
  let baseUrl: URL;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', baseUrl);
    if (requestUrl.pathname === '/.well-known/oauth-protected-resource') {
      protectedResourceRequests.push(requestUrl);
      json(response, 200, {
        authorization_servers: [options.authorizationServerUrl?.() ?? baseUrl.href],
        bearer_methods_supported: ['header'],
        resource: options.resourceMismatch
          ? new URL('/other', baseUrl).href
          : new URL('/mcp', baseUrl).href,
        scopes_supported: ['read', 'write'],
      });
      return;
    }
    if (requestUrl.pathname === '/.well-known/oauth-authorization-server') {
      json(response, 200, {
        authorization_endpoint: new URL('/authorize', baseUrl).href,
        ...(options.issParameterSupported === false
          ? {}
          : { authorization_response_iss_parameter_supported: true }),
        client_id_metadata_document_supported: options.clientRegistration === 'cimd',
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        issuer: options.metadataIssuerMismatch ? 'https://attacker.example.test' : baseUrl.href,
        registration_endpoint:
          options.clientRegistration === 'dcr' ? new URL('/register', baseUrl).href : undefined,
        response_types_supported: ['code'],
        scopes_supported:
          options.offlineAccessSupported === false
            ? ['read', 'write']
            : ['read', 'write', 'offline_access'],
        token_endpoint: new URL('/token', baseUrl).href,
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (requestUrl.pathname === '/register' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as Readonly<Record<string, unknown>>;
      dcrRequests.push(body);
      json(response, 201, {
        application_type: 'native',
        client_id: options.registeredClientId ?? `dcr-client-${dcrRequests.length}`,
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: body['redirect_uris'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
      return;
    }
    if (requestUrl.pathname === '/authorize' && request.method === 'GET') {
      authorizationRequests.push(requestUrl.searchParams);
      const clientId = requestUrl.searchParams.get('client_id');
      const redirectUri = requestUrl.searchParams.get('redirect_uri');
      const challenge = requestUrl.searchParams.get('code_challenge');
      const state = requestUrl.searchParams.get('state');
      if (!(clientId && redirectUri && challenge && state)) {
        json(response, 400, { error: 'invalid_request' });
        return;
      }
      const code = `code-${++nextCode}`;
      codes.set(code, { challenge, clientId, redirectUri });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      if (options.callbackMode !== 'issuer-missing') {
        const issuer =
          options.callbackMode === 'issuer-mismatch'
            ? new URL('/attacker', baseUrl).href
            : options.callbackMode === 'issuer-normalized'
              ? baseUrl.href.replace(/\/$/u, '')
              : baseUrl.href;
        callback.searchParams.set('iss', issuer);
      }
      if (options.callbackMode === 'invalid-state-first') {
        const invalid = new URL(callback);
        invalid.searchParams.set('state', 'invalid-state');
        redirect(response, invalid.href);
        return;
      }
      redirect(response, callback.href);
      return;
    }
    if (requestUrl.pathname === '/token' && request.method === 'POST') {
      tokenCountValue += 1;
      const params = new URLSearchParams(await readBody(request));
      tokenRequests.push(params);
      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        const code = params.get('code');
        const record = code ? codes.get(code) : undefined;
        if (
          !record ||
          params.get('client_id') !== record.clientId ||
          params.get('redirect_uri') !== record.redirectUri ||
          params.get('resource') !==
            (options.expectedResourceUrl?.() ?? new URL('/mcp', baseUrl).href) ||
          params.get('code_verifier') === null ||
          createHash('sha256')
            .update(params.get('code_verifier') ?? '', 'ascii')
            .digest('base64url') !== record.challenge
        ) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        const token = `${options.tokenPrefix ?? 'access'}-${++nextToken}`;
        tokens.set(token, { scope: params.get('scope') ?? 'read offline_access' });
        const issuedRefreshToken = `refresh-token-${++nextRefreshToken}`;
        refreshTokens.set(issuedRefreshToken, { clientId: record.clientId });
        json(response, 200, {
          access_token: token,
          expires_in: 3600,
          refresh_token: issuedRefreshToken,
          scope: params.get('scope') ?? 'read offline_access',
          token_type: 'Bearer',
        });
        return;
      }
      if (grantType === 'refresh_token') {
        const presented = params.get('refresh_token');
        const grant = presented ? refreshTokens.get(presented) : undefined;
        if (!grant || params.get('client_id') !== grant.clientId) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        refreshCountValue += 1;
        const token = `${options.tokenPrefix ?? 'refreshed'}-${++nextToken}`;
        tokens.set(token, { scope: params.get('scope') ?? 'read offline_access' });
        const rotated = `rotated-refresh-token-${++nextRefreshToken}`;
        refreshTokens.set(rotated, { clientId: grant.clientId });
        refreshTokens.delete(presented ?? '');
        json(response, 200, {
          access_token: token,
          expires_in: 3600,
          refresh_token: rotated,
          scope: params.get('scope') ?? 'read offline_access',
          token_type: 'Bearer',
        });
        return;
      }
      json(response, 400, { error: 'unsupported_grant_type' });
      return;
    }
    if (requestUrl.pathname === '/mcp' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as Readonly<Record<string, unknown>>;
      mcpRequests.push(body);
      const token = request.headers.authorization?.replace(/^Bearer /u, '');
      const tokenRecord = token ? tokens.get(token) : undefined;
      const tokenAccepted =
        options.mcpTokenAccepted?.(token, tokenRecord !== undefined) ?? tokenRecord !== undefined;
      if (!tokenAccepted || forceRefresh) {
        forceRefresh = false;
        response.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', baseUrl).href}" scope="read"`,
        });
        response.end();
        return;
      }
      options.onAuthenticatedMcpRequest?.();
      if (remainingInsufficientScope > 0 && body['method'] === 'tools/call') {
        remainingInsufficientScope -= 1;
        response.writeHead(403, {
          'www-authenticate': `Bearer error="insufficient_scope" resource_metadata="${new URL('/.well-known/oauth-protected-resource', baseUrl).href}" scope="read write"`,
        });
        response.end();
        return;
      }
      const method = body['method'];
      const result =
        method === 'initialize'
          ? {
              capabilities: { tools: {} },
              protocolVersion: '2025-11-25',
              serverInfo: { name: 'fake-auth-server', version: '1.0.0' },
            }
          : method === 'tools/list'
            ? { tools: [] }
            : { content: [{ text: 'ok', type: 'text' }] };
      json(response, 200, { id: body['id'], jsonrpc: '2.0', result });
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanupTasks.push(close);

  return {
    authorizationRequests,
    close,
    dcrRequests,
    forceRefresh: () => {
      forceRefresh = true;
    },
    mcpRequests,
    protectedResourceRequests,
    refreshCount: () => refreshCountValue,
    tokenCount: () => tokenCountValue,
    tokenRequests,
    url: new URL('/mcp', baseUrl),
  };
}

async function createClient(
  provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>>,
  url: URL
) {
  const client = new Client({ name: 'brainstrike-oauth-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: provider,
    fetch: provider.fetch,
  });
  return { client, transport };
}

function resolvedOAuthServer(url: URL): OAuthHttpServer {
  return {
    auth: { type: 'oauth-user' },
    name: parseConfiguredMcpServerId('fake.oauth.server'),
    protocol: 'legacy',
    startup: 'authentication-required',
    transport: 'streamable-http',
    url: url.href,
  };
}

async function followAuthorizationRedirect(authorizationUrl: string): Promise<void> {
  const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = authorization.headers.get('location');
  if (!location) {
    throw new Error('fake authorization server did not redirect');
  }
  await fetch(location);
}

function trackRuntime(
  runtime: ReturnType<typeof createDesktopMcpHostRuntime>
): ReturnType<typeof createDesktopMcpHostRuntime> {
  cleanupTasks.push(async () => {
    await runtime.host.close();
  });
  return runtime;
}

function takeAuthorizationCallback(
  provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>>,
  signal: AbortSignal = new AbortController().signal
): Promise<URLSearchParams> {
  const callback = provider.takePendingAuthorizationCallback(signal);
  if (!callback) {
    throw new Error('MCP OAuth authorization callback is not pending.');
  }
  return callback;
}

async function completeAuthorization(
  provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>>,
  client: Client,
  transport: StreamableHTTPClientTransport
): Promise<void> {
  await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  const callback = await takeAuthorizationCallback(provider);
  await transport.finishAuth(callback);
  await client.close();
}

describe('desktop-main MCP OAuthClientProvider', () => {
  it('completes Connect through browser callback and token exchange in the production host', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const configured = resolvedOAuthServer(server.url);
    const runtime = trackRuntime(
      createDesktopMcpHostRuntime({
        oauthStore: createInMemoryMcpOAuthStore(),
        openExternal: followAuthorizationRedirect,
      })
    );
    await runtime.replaceResolvedConfig({ servers: [configured] });

    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: configured.name })
    ).resolves.toMatchObject({ state: 'connected' });
    expect(server.authorizationRequests).toHaveLength(1);
    expect(server.tokenCount()).toBe(1);
    expect(runtime.host.snapshot().servers[0]).toMatchObject({
      auth: { credentialState: 'stored', type: 'oauth-user' },
      state: 'connected',
    });
    await expect(runtime.host.close()).resolves.toMatchObject({
      callbacksClosed: 2,
      failures: [],
      loopbackPortsClosed: 1,
    });
  });

  it('reconnects a relaunched production host without re-registering or re-authorizing', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const configured = resolvedOAuthServer(server.url);
    const store = createInMemoryMcpOAuthStore();
    const launch = (openExternal: (authorizationUrl: string) => Promise<void>) =>
      trackRuntime(createDesktopMcpHostRuntime({ oauthStore: store, openExternal }));
    const first = launch(followAuthorizationRedirect);
    await first.replaceResolvedConfig({ servers: [configured] });
    await expect(
      first.host.control({ action: 'connect', configuredServerId: configured.name })
    ).resolves.toMatchObject({ state: 'connected' });
    await first.host.close();
    expect(server.dcrRequests).toHaveLength(1);

    // Relaunch over the same encrypted records with a stale access token: the
    // host must recover through a refresh, not a second authorization.
    server.forceRefresh();
    const relaunched = launch(async () => {
      throw new Error('browser must not open after a relaunch');
    });
    const config = { servers: [configured] };
    const committed = await relaunched.replaceResolvedConfig(config);
    // The same discovery entrypoint used during app load must reconnect; no
    // Settings control is sent on the relaunched host.
    await expect(discoverToolsFromConfig(relaunched, config, committed)).resolves.toHaveLength(1);
    expect(relaunched.host.snapshot().servers[0]?.state).toBe('connected');
    await expect(
      relaunched.host.invoke({ configuredServerId: configured.name, type: 'tools/list' })
    ).resolves.toMatchObject({ type: 'tools/list' });
    expect(server.dcrRequests).toHaveLength(1);
    expect(server.authorizationRequests).toHaveLength(1);
    expect(server.refreshCount()).toBe(1);
    await relaunched.host.close();
  });

  it('reports authentication-required when a relaunch cannot rebind its loopback port', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const configured = resolvedOAuthServer(server.url);
    const store = createInMemoryMcpOAuthStore();
    const first = trackRuntime(
      createDesktopMcpHostRuntime({ oauthStore: store, openExternal: followAuthorizationRedirect })
    );
    await first.replaceResolvedConfig({ servers: [configured] });
    await first.host.control({ action: 'connect', configuredServerId: configured.name });
    await first.host.close();
    const registeredRedirectUri = String(
      (server.dcrRequests[0]?.['redirect_uris'] as readonly string[] | undefined)?.[0]
    );

    const squatter = createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(Number(new URL(registeredRedirectUri).port), '127.0.0.1', () => resolve());
    });
    cleanupTasks.push(
      async () => await new Promise<void>((resolve) => squatter.close(() => resolve()))
    );
    server.forceRefresh();
    const relaunched = trackRuntime(
      createDesktopMcpHostRuntime({
        oauthStore: store,
        openExternal: async () => {
          throw new Error('a relaunch must not open the browser on its own');
        },
      })
    );
    await relaunched.replaceResolvedConfig({ servers: [configured] });

    await expect(
      relaunched.host.control({ action: 'connect', configuredServerId: configured.name })
    ).rejects.toMatchObject({ category: 'authentication', code: 'mcp-authentication-required' });
    expect(relaunched.host.snapshot().servers[0]).toMatchObject({
      auth: { credentialState: 'missing', type: 'oauth-user' },
      state: 'authentication-required',
    });
    await relaunched.host.close();
  });

  it('completes one request-time scope step-up through the production host', async () => {
    const server = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      insufficientScope: true,
    });
    const configured = resolvedOAuthServer(server.url);
    const runtime = trackRuntime(
      createDesktopMcpHostRuntime({
        oauthStore: createInMemoryMcpOAuthStore(),
        openExternal: followAuthorizationRedirect,
      })
    );
    await runtime.replaceResolvedConfig({ servers: [configured] });
    await runtime.host.control({ action: 'connect', configuredServerId: configured.name });

    await expect(
      runtime.host.invoke({
        arguments: {},
        configuredServerId: configured.name,
        toolName: 'write',
        type: 'tools/call',
      })
    ).resolves.toMatchObject({ result: { content: [{ text: 'ok', type: 'text' }] } });
    expect(server.authorizationRequests).toHaveLength(2);
    expect(server.authorizationRequests.at(-1)?.get('scope')).toContain('write');
    await runtime.host.close();
  });

  it('fails after the active operation exhausts its authorization redirect budget', async () => {
    const server = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      insufficientScope: 10,
    });
    const configured = resolvedOAuthServer(server.url);
    const runtime = trackRuntime(
      createDesktopMcpHostRuntime({
        oauthStore: createInMemoryMcpOAuthStore(),
        openExternal: followAuthorizationRedirect,
      })
    );
    await runtime.replaceResolvedConfig({ servers: [configured] });
    await runtime.host.control({ action: 'connect', configuredServerId: configured.name });

    await expect(
      runtime.host.invoke({
        arguments: {},
        configuredServerId: configured.name,
        toolName: 'write',
        type: 'tools/call',
      })
    ).rejects.toThrow();
    expect(server.authorizationRequests).toHaveLength(4);
    await runtime.host.close();
  });

  it('cancels a production Connect waiting for its callback and closes the loopback listener', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const configured = resolvedOAuthServer(server.url);
    let provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>> | undefined;
    const opened = Promise.withResolvers<void>();
    const runtime = trackRuntime(
      createDesktopMcpHostRuntime({
        createOAuthProvider: async (options) => {
          provider = await createMcpOAuthClientProvider(options);
          return provider;
        },
        oauthStore: createInMemoryMcpOAuthStore(),
        openExternal: async () => opened.resolve(),
      })
    );
    await runtime.replaceResolvedConfig({ servers: [configured] });
    const connecting = runtime.host.control({
      action: 'connect',
      configuredServerId: configured.name,
    });
    await opened.promise;
    const callbackUrl = provider?.redirectUrl;
    if (callbackUrl === undefined) {
      throw new Error('production host did not create its OAuth provider');
    }

    await runtime.host.control({ action: 'cancel', configuredServerId: configured.name });
    await expect(connecting).rejects.toThrow();
    await expect(fetch(callbackUrl)).rejects.toThrow();
    await expect(provider?.close()).resolves.toEqual({
      callbacksClosed: 1,
      loopbackPortsClosed: 1,
    });
    await runtime.host.close();
  });

  it('disconnects an authenticated host generation and rejects its stale callback authority', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const configured = resolvedOAuthServer(server.url);
    const store = createInMemoryMcpOAuthStore();
    let provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>> | undefined;
    const runtime = trackRuntime(
      createDesktopMcpHostRuntime({
        createOAuthProvider: async (options) => {
          provider = await createMcpOAuthClientProvider(options);
          return provider;
        },
        oauthStore: store,
        openExternal: followAuthorizationRedirect,
      })
    );
    await runtime.replaceResolvedConfig({ servers: [configured] });
    await runtime.host.control({ action: 'connect', configuredServerId: configured.name });
    const callbackUrl = provider?.redirectUrl;
    if (callbackUrl === undefined) {
      throw new Error('production host did not create its OAuth provider');
    }

    await expect(
      runtime.host.control({ action: 'disconnect', configuredServerId: configured.name })
    ).resolves.toMatchObject({ state: 'authentication-required' });
    await expect(fetch(callbackUrl)).rejects.toThrow();
    await expect(
      store.read(createMcpOAuthStoreIdentity(configured.name, configured.url))
    ).resolves.toEqual({});
    await runtime.host.close();
  });

  it('retires callback authority and credentials when configuration replaces the OAuth generation', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const configured = resolvedOAuthServer(server.url);
    const store = createInMemoryMcpOAuthStore();
    let provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>> | undefined;
    const runtime = trackRuntime(
      createDesktopMcpHostRuntime({
        createOAuthProvider: async (options) => {
          provider = await createMcpOAuthClientProvider(options);
          return provider;
        },
        oauthStore: store,
        openExternal: followAuthorizationRedirect,
      })
    );
    await runtime.replaceResolvedConfig({ servers: [configured] });
    await runtime.host.control({ action: 'connect', configuredServerId: configured.name });
    const callbackUrl = provider?.redirectUrl;
    if (callbackUrl === undefined) {
      throw new Error('production host did not create its OAuth provider');
    }

    await expect(runtime.replaceResolvedConfig({ servers: [] })).resolves.toMatchObject({
      servers: [],
    });
    await expect(fetch(callbackUrl)).rejects.toThrow();
    await expect(
      store.read(createMcpOAuthStoreIdentity(configured.name, configured.url))
    ).resolves.toEqual({});
    await runtime.host.close();
  });

  it('keeps protocol invalidation recoverable while terminal disconnect remains separate', async () => {
    const identity = {
      resourceUrl: 'https://mcp.example.test/mcp',
      scopeKey: '',
      serverId: 'recoverable-invalidation',
    } as const;
    const store = createInMemoryMcpOAuthStore();
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    const invalidateCredentials = provider.invalidateCredentials;
    if (!(invalidateCredentials && provider.saveDiscoveryState && provider.saveTokens)) {
      throw new Error('OAuth provider did not expose credential lifecycle methods.');
    }
    await provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.test' });
    await provider.saveTokens(
      { access_token: 'initial-token', token_type: 'Bearer' },
      { issuer: 'https://auth.example.test' }
    );

    await invalidateCredentials('all');

    const state = await provider.state?.();
    if (state === undefined) {
      throw new Error('OAuth provider did not expose authorization state.');
    }
    expect(state).toEqual(expect.any(String));
    await expect(store.read(identity)).resolves.toEqual({});
    await provider.close();
  });

  it('does not resurrect a refresh token response from an invalidated generation', async () => {
    const responseGate = Promise.withResolvers<Response>();
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      fetchFn: async () => await responseGate.promise,
      openExternal: async () => undefined,
      serverId: 'stale-refresh',
      serverUrl: 'https://mcp.example.test/mcp',
      store: createInMemoryMcpOAuthStore(),
    });
    if (!(provider.invalidateCredentials && provider.saveDiscoveryState && provider.saveTokens)) {
      throw new Error('OAuth provider did not expose credential lifecycle methods.');
    }
    await provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.test' });
    const refresh = provider.fetch('https://auth.example.test/token', {
      body: 'grant_type=refresh_token&refresh_token=old',
      method: 'POST',
    });
    await provider.invalidateCredentials('tokens');
    responseGate.resolve(Response.json({ access_token: 'stale-token', token_type: 'Bearer' }));
    await refresh;
    await provider.saveTokens(
      { access_token: 'stale-token', token_type: 'Bearer' },
      { issuer: 'https://auth.example.test' }
    );

    await expect(provider.tokens({ issuer: 'https://auth.example.test' })).resolves.toBeUndefined();
    await provider.close();
  });

  it('keeps flow X discovery stale across overlapping flow Y reads and saves', async () => {
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: 'overlapping-issuers',
      serverUrl: 'https://mcp.example.test/mcp',
      store: createInMemoryMcpOAuthStore(),
    });
    if (!(provider.saveDiscoveryState && provider.saveTokens)) {
      throw new Error('OAuth provider did not expose issuer persistence methods.');
    }
    const issuerX = 'https://honest-x.example.test';
    const issuerY = 'https://honest-y.example.test';
    const discoveryX = { authorizationServerUrl: issuerX };
    for (const issuer of [issuerX, issuerY]) {
      await provider.saveDiscoveryState(
        issuer === issuerX ? discoveryX : { authorizationServerUrl: issuer }
      );
      await provider.saveTokens(
        { access_token: `${issuer}-token`, token_type: 'Bearer' },
        { issuer }
      );
    }

    await provider.tokens({ issuer: issuerX });
    await provider.tokens();
    await provider.tokens({ issuer: issuerY });
    await expect(provider.discoveryState?.()).resolves.toEqual({
      authorizationServerUrl: issuerY,
    });
    await provider.saveDiscoveryState({ authorizationServerUrl: issuerY });
    await provider.saveTokens(
      { access_token: 'y-replacement', token_type: 'Bearer' },
      { issuer: issuerY }
    );
    await expect(provider.discoveryState?.()).resolves.toEqual({
      authorizationServerUrl: issuerY,
    });

    await provider.tokens({ issuer: issuerX });
    await provider.saveDiscoveryState(discoveryX);
    await expect(provider.discoveryState?.()).resolves.toBeUndefined();
    const replacementDiscovery = {
      authorizationServerUrl: issuerX,
      resourceMetadataUrl: 'https://mcp.example.test/fresh-metadata',
    };
    await provider.saveDiscoveryState(replacementDiscovery);
    await expect(provider.discoveryState?.()).resolves.toEqual(replacementDiscovery);
    await provider.saveTokens(
      { access_token: 'x-replacement', token_type: 'Bearer' },
      { issuer: issuerX }
    );

    await provider.saveDiscoveryState(discoveryX);
    await expect(provider.discoveryState?.()).resolves.toEqual(discoveryX);
    await provider.close();
  });

  it('times out an abandoned authorization callback and closes its listener', async () => {
    vi.useFakeTimers();
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: 'callback-timeout',
      serverUrl: 'https://mcp.example.test/mcp',
      store: createInMemoryMcpOAuthStore(),
    });
    try {
      if (!provider.state) {
        throw new Error('OAuth provider did not expose authorization state.');
      }
      const authorization = new URL('https://auth.example.test/authorize');
      authorization.searchParams.set('state', await provider.state());
      await provider.redirectToAuthorization(authorization);
      const callback = takeAuthorizationCallback(provider);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      await expect(callback).rejects.toThrow('authorization callback timed out');
      await expect(fetch(provider.redirectUrl)).rejects.toThrow();
    } finally {
      await provider.close();
      vi.useRealTimers();
    }
  });

  it('keeps OAuth material inside main-process state and clears it on disconnect', async () => {
    const identity = {
      resourceUrl: 'https://mcp.example.test/mcp',
      scopeKey: '',
      serverId: 'linear',
    } as const;
    const store = createInMemoryMcpOAuthStore();
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    if (!(provider.saveDiscoveryState && provider.saveTokens)) {
      throw new Error('OAuth provider did not expose persistence methods.');
    }
    await provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.test' });
    await provider.saveTokens(
      {
        access_token: 'access-secret',
        issuer: 'https://auth.example.test',
        refresh_token: 'refresh-secret',
        token_type: 'Bearer',
      },
      { issuer: 'https://auth.example.test' }
    );

    expect(JSON.stringify(provider)).not.toContain('access-secret');
    expect(JSON.stringify(provider)).not.toContain('refresh-secret');
    await provider.disconnect();
    await expect(provider.tokens({ issuer: 'https://auth.example.test' })).resolves.toBeUndefined();
    await expect(store.read(identity)).resolves.toEqual({});
  });

  it('makes cancellation terminal, closes the callback listener, and rejects stale credential saves', async () => {
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: 'linear',
      serverUrl: 'https://mcp.example.test/mcp',
      store: createInMemoryMcpOAuthStore(),
    });
    const callbackUrl = provider.redirectUrl;
    await provider.cancel();

    await expect(fetch(callbackUrl)).rejects.toThrow();
    if (!provider.saveTokens) {
      throw new Error('OAuth provider did not expose token persistence.');
    }
    await expect(
      provider.saveTokens(
        { access_token: 'stale-token', token_type: 'Bearer' },
        { issuer: 'https://auth.example.test' }
      )
    ).rejects.toThrow('provider is closed');
  });

  it.each([
    ['CIMD', 'cimd' as const, undefined],
    ['pre-registered', 'preregistered' as const, { client_id: 'pre-client' }],
    ['DCR fallback', 'dcr' as const, undefined],
  ])('supports %s registration selection', async (_label, clientRegistration, preRegistered) => {
    const server = await startFakeOAuthServer({ clientRegistration });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      clientMetadataUrl:
        clientRegistration === 'cimd' ? 'https://brainstrike.example/mcp-client.json' : undefined,
      openExternal: async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
        const location = authorization.headers.get('location');
        if (!location) {
          throw new Error('fake authorization server did not redirect');
        }
        await fetch(location);
      },
      preRegisteredClient: preRegistered,
      serverId: 'fake-auth-server',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);
    await completeAuthorization(provider, client, transport);
    const second = await createClient(provider, server.url);
    await expect(second.client.connect(second.transport)).resolves.toBeUndefined();
    await second.client.close();
    expect(server.dcrRequests).toHaveLength(clientRegistration === 'dcr' ? 1 : 0);
    if (clientRegistration === 'cimd') {
      expect(server.authorizationRequests[0]?.get('client_id')).toBe(
        'https://brainstrike.example/mcp-client.json'
      );
    }
    expect(server.authorizationRequests[0]?.get('code_challenge_method')).toBe('S256');
    if (clientRegistration === 'preregistered') {
      expect(server.authorizationRequests[0]?.get('client_id')).toBe('pre-client');
    }
    await provider.close();
  });

  it('rejects an issuer-mismatched callback before exchanging the authorization code', async () => {
    const server = await startFakeOAuthServer({
      callbackMode: 'issuer-mismatch',
      clientRegistration: 'dcr',
    });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
        const location = authorization.headers.get('location');
        if (!location) {
          throw new Error('fake authorization server did not redirect');
        }
        await fetch(location);
      },
      serverId: 'issuer-mismatch',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    const callback = await takeAuthorizationCallback(provider);
    await expect(transport.finishAuth(callback)).rejects.toBeInstanceOf(IssuerMismatchError);
    expect(server.tokenCount()).toBe(0);
    await client.close().catch(() => undefined);
    await provider.close();
  });

  it.each([
    ['advertised and present', true, 'legitimate' as const],
    ['not advertised and absent', false, 'issuer-missing' as const],
  ])('accepts iss when %s', async (_label, issParameterSupported, callbackMode) => {
    const server = await startFakeOAuthServer({
      callbackMode,
      clientRegistration: 'dcr',
      issParameterSupported,
    });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: followAuthorizationRedirect,
      serverId: 'issuer-accepted',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);

    await completeAuthorization(provider, client, transport);

    expect(server.tokenCount()).toBe(1);
    await provider.close();
  });

  it.each([
    ['advertised but missing', true, 'issuer-missing' as const],
    ['advertised but wrong', true, 'issuer-mismatch' as const],
    ['unadvertised but wrong', false, 'issuer-mismatch' as const],
    ['normalization-equivalent', true, 'issuer-normalized' as const],
  ])('rejects iss when %s before token exchange', async (_label, supported, callbackMode) => {
    const server = await startFakeOAuthServer({
      callbackMode,
      clientRegistration: 'dcr',
      issParameterSupported: supported,
    });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: followAuthorizationRedirect,
      serverId: 'issuer-rejected',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);

    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      transport.finishAuth(await takeAuthorizationCallback(provider))
    ).rejects.toBeInstanceOf(IssuerMismatchError);

    expect(server.tokenCount()).toBe(0);
    await client.close().catch(() => undefined);
    await provider.close();
  });

  it('rejects mismatched authorization-server metadata before using its endpoints', async () => {
    const server = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      metadataIssuerMismatch: true,
    });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: followAuthorizationRedirect,
      serverId: 'metadata-issuer-mismatch',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);

    await expect(client.connect(transport)).rejects.toBeInstanceOf(IssuerMismatchError);

    expect(server.authorizationRequests).toHaveLength(0);
    expect(server.dcrRequests).toHaveLength(0);
    expect(server.tokenCount()).toBe(0);
    await client.close().catch(() => undefined);
    await provider.close();
  });

  it.each([
    ['adds', true],
    ['does not add', false],
  ])('%s offline_access according to authorization-server metadata', async (_label, supported) => {
    const server = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      offlineAccessSupported: supported,
    });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: followAuthorizationRedirect,
      serverId: 'offline-access',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);

    await completeAuthorization(provider, client, transport);

    expect(server.authorizationRequests[0]?.get('scope')?.split(' ')).toEqual(
      supported ? ['read', 'offline_access'] : ['read']
    );
    await provider.close();
  });

  it('rejects protected-resource metadata that names a different canonical resource', async () => {
    const server = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      resourceMismatch: true,
    });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: 'resource-mismatch',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);
    await expect(client.connect(transport)).rejects.toThrow('protected-resource metadata');
    expect(server.authorizationRequests).toHaveLength(0);
    expect(server.dcrRequests).toHaveLength(0);
    await client.close().catch(() => undefined);
    await provider.close();
  });

  it('settles and closes the production conformance host on a resource mismatch', async () => {
    const server = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      resourceMismatch: true,
    });
    const connectionFailures: unknown[] = [];

    await expect(
      runProductionMcpConformanceClient(
        {
          protocolVersion: '2026-07-28',
          scenario: 'auth/resource-mismatch',
          serverUrl: server.url.href.replace('127.0.0.1', 'localhost'),
        },
        {
          createRuntime: (dependencies) =>
            createDesktopMcpHostRuntime({
              ...dependencies,
              onInternalError: (code, cause) => {
                if (code === 'mcp-connection-failed') {
                  connectionFailures.push(cause);
                }
              },
            }),
        }
      )
    ).rejects.toMatchObject({ code: 'mcp-connection-failed' });

    expect(server.mcpRequests.length).toBeGreaterThan(0);
    expect(server.protectedResourceRequests).toHaveLength(1);
    expect(connectionFailures).toEqual([
      expect.objectContaining({
        cause: expect.objectContaining({
          message: 'MCP OAuth protected-resource metadata does not match the MCP server URL.',
        }),
      }),
    ]);
    expect(server.authorizationRequests).toHaveLength(0);
    expect(server.dcrRequests).toHaveLength(0);
  });

  it('re-registers after a rejected bearer reveals an authorization-server migration', async () => {
    let honestOriginalResourceUrl: string | undefined;
    const honestReplacementAuthorizationServer = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      expectedResourceUrl: () => {
        if (honestOriginalResourceUrl === undefined) {
          throw new Error('honest original resource URL is not available');
        }
        return honestOriginalResourceUrl;
      },
      registeredClientId: 'honest-replacement-client',
      tokenPrefix: 'honest-replacement-token',
    });
    let migrated = false;
    const honestOriginalAuthorizationServer = await startFakeOAuthServer({
      authorizationServerUrl: () =>
        migrated
          ? new URL('/', honestReplacementAuthorizationServer.url).href
          : new URL('/', honestOriginalAuthorizationServer.url).href,
      clientRegistration: 'dcr',
      mcpTokenAccepted: (token, locallyIssued) =>
        migrated ? token?.startsWith('honest-replacement-token') === true : locallyIssued,
      onAuthenticatedMcpRequest: () => {
        migrated = true;
      },
      registeredClientId: 'honest-original-client',
      tokenPrefix: 'honest-original-token',
    });
    honestOriginalResourceUrl = honestOriginalAuthorizationServer.url.href;
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: followAuthorizationRedirect,
      serverId: 'authorization-server-migration',
      serverUrl: honestOriginalAuthorizationServer.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const initial = await createClient(provider, honestOriginalAuthorizationServer.url);
    await completeAuthorization(provider, initial.client, initial.transport);

    const migratedClient = await createClient(provider, honestOriginalAuthorizationServer.url);
    await expect(migratedClient.client.connect(migratedClient.transport)).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    await migratedClient.transport.finishAuth(await takeAuthorizationCallback(provider));
    await migratedClient.client.close().catch(() => undefined);
    const replacementClient = await createClient(provider, honestOriginalAuthorizationServer.url);
    await expect(
      replacementClient.client.connect(replacementClient.transport)
    ).resolves.toBeUndefined();
    await expect(replacementClient.client.listTools()).resolves.toEqual({ tools: [] });

    expect(honestReplacementAuthorizationServer.dcrRequests).toHaveLength(1);
    expect(honestReplacementAuthorizationServer.authorizationRequests[0]?.get('client_id')).toBe(
      'honest-replacement-client'
    );
    expect(honestReplacementAuthorizationServer.tokenRequests[0]?.get('client_id')).toBe(
      'honest-replacement-client'
    );
    expect(
      honestReplacementAuthorizationServer.authorizationRequests.some(
        (request) => request.get('client_id') === 'honest-original-client'
      )
    ).toBe(false);
    await replacementClient.client.close();
    await provider.close();
  });

  it('reuses its registration and tokens after a relaunch without opening the browser', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const store = createInMemoryMcpOAuthStore();
    const createProvider = (openExternal: (authorizationUrl: string) => Promise<void>) =>
      createMcpOAuthClientProvider({
        allowInteractiveAuthorization: true,
        openExternal,
        serverId: 'restart-session',
        serverUrl: server.url,
        store,
      });
    const first = await createProvider(async (authorizationUrl) => {
      const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = authorization.headers.get('location');
      if (!location) {
        throw new Error('fake authorization server did not redirect');
      }
      await fetch(location);
    });
    const initial = await createClient(first, server.url);
    await completeAuthorization(first, initial.client, initial.transport);
    const firstRedirectUrl = first.redirectUrl;
    await first.close();
    const authorizationCount = server.authorizationRequests.length;
    const second = await createProvider(async () => {
      throw new Error('browser must not open for a persisted MCP OAuth session');
    });
    // The relaunched provider rebinds the persisted loopback port, so the
    // registered redirect URI still resolves and the registration survives.
    expect(second.redirectUrl).toBe(firstRedirectUrl);
    expect(await second.discoveryState?.()).toBeDefined();
    await expect(second.saveResourceUrl?.(server.url.href)).resolves.toBeUndefined();
    await expect(
      second.clientInformation({ issuer: new URL('/', server.url).href })
    ).resolves.toMatchObject({ client_id: 'dcr-client-1' });
    expect(second.requiresReauthorization()).toBe(false);
    const resumed = await createClient(second, server.url);
    await expect(resumed.client.connect(resumed.transport)).resolves.toBeUndefined();
    // An expired access token must recover through a refresh under the SAME
    // client, never through a re-registration and a second browser round trip.
    server.forceRefresh();
    await expect(resumed.client.listTools()).resolves.toEqual({ tools: [] });
    expect(server.dcrRequests).toHaveLength(1);
    expect(server.refreshCount()).toBe(1);
    expect(server.authorizationRequests).toHaveLength(authorizationCount);
    await resumed.client.close();
    await second.close();
  });

  it('discards an invalid state and keeps waiting for the legitimate callback', async () => {
    const server = await startFakeOAuthServer({
      callbackMode: 'invalid-state-first',
      clientRegistration: 'dcr',
    });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
        const location = authorization.headers.get('location');
        if (!location) {
          throw new Error('fake authorization server did not redirect');
        }
        const callback = new URL(location);
        await fetch(callback);
        callback.searchParams.set('state', server.authorizationRequests[0]?.get('state') ?? '');
        await fetch(callback);
      },
      serverId: 'invalid-state',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);
    await completeAuthorization(provider, client, transport);
    await provider.close();
  });

  it('shares refresh requests and performs one bounded 401 retry', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
        const location = authorization.headers.get('location');
        if (!location) {
          throw new Error('fake authorization server did not redirect');
        }
        await fetch(location);
      },
      serverId: 'refresh-shared',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const initial = await createClient(provider, server.url);
    await completeAuthorization(provider, initial.client, initial.transport);
    const next = await createClient(provider, server.url);
    await next.client.connect(next.transport);
    server.forceRefresh();
    await expect(next.client.listTools()).resolves.toEqual({ tools: [] });
    expect(server.refreshCount()).toBe(1);
    expect(server.mcpRequests.length).toBeGreaterThanOrEqual(3);
    await next.client.close();
    await provider.close();
  });

  it('uses the authoritative 403 scope challenge for one step-up authorization', async () => {
    const server = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      insufficientScope: true,
    });
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
        const location = authorization.headers.get('location');
        if (!location) {
          throw new Error('fake authorization server did not redirect');
        }
        await fetch(location);
      },
      serverId: 'scope-step-up',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const initial = await createClient(provider, server.url);
    await completeAuthorization(provider, initial.client, initial.transport);
    const next = await createClient(provider, server.url);
    await next.client.connect(next.transport);
    await expect(next.client.callTool({ arguments: {}, name: 'write' })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    const stepUpCallback = await takeAuthorizationCallback(provider);
    await next.transport.finishAuth(stepUpCallback);
    await expect(next.client.callTool({ arguments: {}, name: 'write' })).resolves.toMatchObject({
      content: [{ text: 'ok', type: 'text' }],
    });
    expect(server.authorizationRequests.at(-1)?.get('scope')).toContain('write');
    await next.client.close();
    await provider.close();
  });
});

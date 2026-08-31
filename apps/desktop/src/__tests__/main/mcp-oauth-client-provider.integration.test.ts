import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Client,
  IssuerMismatchError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryMcpOAuthStore,
  createMcpOAuthClientProvider,
} from '../../mcp/oauth-client-provider';

interface FakeOAuthServerOptions {
  readonly callbackMode?: 'legitimate' | 'invalid-state-first' | 'issuer-mismatch';
  readonly clientRegistration: 'cimd' | 'dcr' | 'preregistered';
  readonly insufficientScope?: boolean;
  readonly resourceMismatch?: boolean;
}

interface FakeOAuthServer {
  readonly authorizationRequests: URLSearchParams[];
  readonly close: () => Promise<void>;
  readonly dcrRequests: Readonly<Record<string, unknown>>[];
  readonly forceRefresh: () => void;
  readonly mcpRequests: Readonly<Record<string, unknown>>[];
  readonly refreshCount: () => number;
  readonly tokenCount: () => number;
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
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const tokens = new Map<string, { scope: string }>();
  let nextCode = 0;
  let nextToken = 0;
  let refreshCountValue = 0;
  let tokenCountValue = 0;
  let forceRefresh = false;
  let forceInsufficientScope = options.insufficientScope ?? false;
  let baseUrl: URL;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', baseUrl);
    if (requestUrl.pathname === '/.well-known/oauth-protected-resource') {
      json(response, 200, {
        authorization_servers: [baseUrl.href],
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
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: options.clientRegistration === 'cimd',
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        issuer: baseUrl.href,
        registration_endpoint:
          options.clientRegistration === 'dcr' ? new URL('/register', baseUrl).href : undefined,
        response_types_supported: ['code'],
        scopes_supported: ['read', 'write', 'offline_access'],
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
        client_id: 'dcr-client',
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
      callback.searchParams.set(
        'iss',
        options.callbackMode === 'issuer-mismatch'
          ? new URL('/attacker', baseUrl).href
          : baseUrl.href
      );
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
      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        const code = params.get('code');
        const record = code ? codes.get(code) : undefined;
        if (
          !record ||
          params.get('client_id') !== record.clientId ||
          params.get('redirect_uri') !== record.redirectUri ||
          params.get('resource') !== new URL('/mcp', baseUrl).href ||
          params.get('code_verifier') === null ||
          createHash('sha256')
            .update(params.get('code_verifier') ?? '', 'ascii')
            .digest('base64url') !== record.challenge
        ) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        const token = `access-${++nextToken}`;
        tokens.set(token, { scope: params.get('scope') ?? 'read offline_access' });
        json(response, 200, {
          access_token: token,
          expires_in: 3600,
          refresh_token: 'refresh-token',
          scope: params.get('scope') ?? 'read offline_access',
          token_type: 'Bearer',
        });
        return;
      }
      if (grantType === 'refresh_token') {
        refreshCountValue += 1;
        const token = `refreshed-${++nextToken}`;
        tokens.set(token, { scope: params.get('scope') ?? 'read offline_access' });
        json(response, 200, {
          access_token: token,
          expires_in: 3600,
          refresh_token: 'rotated-refresh-token',
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
      if (!tokenRecord || forceRefresh) {
        forceRefresh = false;
        response.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', baseUrl).href}" scope="read"`,
        });
        response.end();
        return;
      }
      if (forceInsufficientScope && body['method'] === 'tools/call') {
        forceInsufficientScope = false;
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
    refreshCount: () => refreshCountValue,
    tokenCount: () => tokenCountValue,
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

async function completeAuthorization(
  provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>>,
  client: Client,
  transport: StreamableHTTPClientTransport
): Promise<void> {
  await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  const callback = await provider.waitForAuthorizationCallback();
  await transport.finishAuth(callback);
  await client.close();
}

describe('desktop-main MCP OAuthClientProvider', () => {
  it('keeps protocol invalidation recoverable while terminal disconnect remains separate', async () => {
    const identity = {
      resourceUrl: 'https://mcp.example.test/mcp',
      serverId: 'recoverable-invalidation',
    } as const;
    const store = createInMemoryMcpOAuthStore();
    const provider = await createMcpOAuthClientProvider({
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

  it('refuses an issuer-less token choice when persisted issuers are ambiguous', async () => {
    const identity = {
      resourceUrl: 'https://mcp.example.test/mcp',
      serverId: 'issuer-ambiguity',
    } as const;
    const store = createInMemoryMcpOAuthStore();
    await store.write(identity, {
      'https://auth-a.example.test': {
        tokens: { access_token: 'token-a', token_type: 'Bearer' },
        updatedAt: 1,
      },
      'https://auth-b.example.test': {
        tokens: { access_token: 'token-b', token_type: 'Bearer' },
        updatedAt: 2,
      },
    });
    const provider = await createMcpOAuthClientProvider({
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });

    await expect(provider.tokens()).resolves.toBeUndefined();
    await expect(provider.discoveryState?.()).resolves.toBeUndefined();
    await provider.close();
  });

  it('times out an abandoned authorization callback and closes its listener', async () => {
    vi.useFakeTimers();
    const provider = await createMcpOAuthClientProvider({
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
      const callback = provider.waitForAuthorizationCallback();

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
      serverId: 'linear',
    } as const;
    const store = createInMemoryMcpOAuthStore();
    const provider = await createMcpOAuthClientProvider({
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
    const callback = await provider.waitForAuthorizationCallback();
    await expect(transport.finishAuth(callback)).rejects.toBeInstanceOf(IssuerMismatchError);
    expect(server.tokenCount()).toBe(0);
    await client.close().catch(() => undefined);
    await provider.close();
  });

  it('rejects protected-resource metadata that names a different canonical resource', async () => {
    const server = await startFakeOAuthServer({
      clientRegistration: 'dcr',
      resourceMismatch: true,
    });
    const provider = await createMcpOAuthClientProvider({
      openExternal: async () => undefined,
      serverId: 'resource-mismatch',
      serverUrl: server.url,
      store: createInMemoryMcpOAuthStore(),
    });
    const { client, transport } = await createClient(provider, server.url);
    await expect(client.connect(transport)).rejects.toThrow('protected-resource metadata');
    await client.close().catch(() => undefined);
    await provider.close();
  });

  it('reuses persisted tokens after provider recreation without opening the browser', async () => {
    const server = await startFakeOAuthServer({ clientRegistration: 'dcr' });
    const store = createInMemoryMcpOAuthStore();
    const createProvider = (openExternal: (authorizationUrl: string) => Promise<void>) =>
      createMcpOAuthClientProvider({
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
    await first.close();
    const authorizationCount = server.authorizationRequests.length;
    const second = await createProvider(async () => {
      throw new Error('browser must not open for a persisted MCP OAuth session');
    });
    const resumed = await createClient(second, server.url);
    await expect(resumed.client.connect(resumed.transport)).resolves.toBeUndefined();
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
    const stepUpCallback = await provider.waitForAuthorizationCallback();
    await next.transport.finishAuth(stepUpCallback);
    await expect(next.client.callTool({ arguments: {}, name: 'write' })).resolves.toMatchObject({
      content: [{ text: 'ok', type: 'text' }],
    });
    expect(server.authorizationRequests.at(-1)?.get('scope')).toContain('write');
    await next.client.close();
    await provider.close();
  });
});
